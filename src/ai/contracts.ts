import { AiError } from './errors';
import type { AiTask } from './types';

// Output contracts: what each task returns, how the model is told, and how a reply is validated.
// Feature modules write the instructions; this module owns the output shape. DOM-free so the
// service worker and the Node CLI can both import it.

export interface PromptItem {
	key: string;
	prompt: string;
}

export interface TranscriptSegment {
	id: number;
	text: string;
}

export interface ReadingToken {
	text: string;
	reading: string;
}

export interface SegmentReading {
	id: number;
	tokens: ReadingToken[];
}

interface Budget {
	maxTokens?: number;
}

export interface AiTaskInputs {
	interpret: Budget & { context: string; prompts: PromptItem[] };
	edit: Budget & { instruction: string; content: string };
	explain: Budget & { instruction: string; content: string };
	translate: Budget & { instruction: string; segments: TranscriptSegment[] };
	reading: Budget & { instruction: string; segments: TranscriptSegment[] };
}

/**
 * Answers by prompt key. `missing` lists requested keys the reply left out, in prompt order;
 * callers must treat those prompts as unanswered, never as complete.
 */
export interface InterpretOutput {
	responses: Record<string, string>;
	missing: string[];
}

export interface AiTaskOutputs {
	interpret: InterpretOutput;
	edit: string;
	explain: string;
	translate: TranscriptSegment[];
	reading: SegmentReading[];
}

export type AiTaskInput<T extends AiTask = AiTask> = AiTaskInputs[T];
export type AiTaskOutput<T extends AiTask = AiTask> = AiTaskOutputs[T];

export interface RenderedMessages {
	system: string;
	user: string;
}

export type JsonSchema = Record<string, unknown>;

export interface StructuredOutputSpec {
	name: string;
	schema: JsonSchema;
}

const MAX_DETAIL_CHARS = 2000;
const JSON_ONLY = 'Return only the JSON object, with no code fence, explanation, or other text.';

export function isTextTask(task: AiTask): task is 'edit' | 'explain' {
	return task === 'edit' || task === 'explain';
}

export function renderMessages<T extends AiTask>(task: T, input: AiTaskInput<T>): RenderedMessages {
	switch (task) {
		case 'interpret': {
			const { context, prompts } = input as AiTaskInputs['interpret'];
			const keys = prompts.map(prompt => prompt.key).join(', ');
			return {
				system: [
					'You are the template interpreter for Obsidian Web Clipper. Answer each prompt using the page content.',
					`Respond with one JSON object whose keys are exactly: ${keys}. Each value is a concise Markdown string answering that prompt.`,
					JSON_ONLY
				].join('\n'),
				user: [
					'Page content:',
					context,
					'Prompts:',
					JSON.stringify(Object.fromEntries(prompts.map(prompt => [prompt.key, prompt.prompt])), null, 2)
				].join('\n\n')
			};
		}
		case 'edit':
		case 'explain': {
			const { instruction, content } = input as AiTaskInputs['edit'];
			return {
				system: `${instruction.trim()}\nReply with the result only, without an introduction or closing remarks.`,
				user: content
			};
		}
		case 'translate': {
			const { instruction, segments } = input as AiTaskInputs['translate'];
			return {
				system: [
					instruction.trim(),
					'Respond with one JSON object of the form {"translations":[{"id":0,"text":"…"}]}.',
					'Include every segment id from the input exactly once, and keep each id with its own segment.',
					JSON_ONLY
				].join('\n'),
				user: JSON.stringify({ segments })
			};
		}
		case 'reading': {
			const { instruction, segments } = input as AiTaskInputs['reading'];
			return {
				system: [
					instruction.trim(),
					'Respond with one JSON object of the form {"readings":[{"id":0,"tokens":[{"text":"…","reading":"…"}]}]}.',
					'Include every segment id from the input exactly once.',
					JSON_ONLY
				].join('\n'),
				user: JSON.stringify({ segments })
			};
		}
	}
	throw new TypeError(`Unknown AI task: ${String(task)}`);
}

/** A single prompt for CLIs, which take no separate system message. */
export function renderCliPrompt<T extends AiTask>(task: T, input: AiTaskInput<T>): string {
	const { system, user } = renderMessages(task, input);
	return `${system}\n\n${user}`;
}

function strictObject(properties: Record<string, JsonSchema>): JsonSchema {
	return {
		type: 'object',
		properties,
		required: Object.keys(properties),
		additionalProperties: false
	};
}

/** The strict-subset JSON schema for a task, or undefined for text tasks. */
export function outputSpec<T extends AiTask>(task: T, input: AiTaskInput<T>): StructuredOutputSpec | undefined {
	switch (task) {
		case 'interpret': {
			const { prompts } = input as AiTaskInputs['interpret'];
			return {
				name: 'interpret_responses',
				schema: strictObject(Object.fromEntries(prompts.map(prompt => [prompt.key, { type: 'string' }])))
			};
		}
		case 'translate':
			return {
				name: 'transcript_translations',
				schema: strictObject({
					translations: {
						type: 'array',
						items: strictObject({ id: { type: 'integer' }, text: { type: 'string' } })
					}
				})
			};
		case 'reading':
			return {
				name: 'transcript_readings',
				schema: strictObject({
					readings: {
						type: 'array',
						items: strictObject({
							id: { type: 'integer' },
							tokens: {
								type: 'array',
								items: strictObject({ text: { type: 'string' }, reading: { type: 'string' } })
							}
						})
					}
				})
			};
		default:
			return undefined;
	}
}

/** Returns every top-level JSON object embedded in text, in order. */
export function extractJsonObjects(value: string): string[] {
	const objects: string[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
		} else if (character === '{') {
			if (depth === 0) start = index;
			depth++;
		} else if (character === '}' && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				objects.push(value.slice(start, index + 1));
				start = -1;
			}
		}
	}
	return objects;
}

function stripCodeFence(value: string): string {
	const match = value.trim().match(/^```[\w-]*\s*\n?([\s\S]*?)\n?```$/);
	return match ? match[1].trim() : value.trim();
}

/** Parses the reply as JSON, falling back to JSON objects embedded in prose or a code fence. */
export function parseJsonCandidates(text: string): unknown[] {
	// Rescanning from the first brace recovers objects hidden by a stray quote in leading prose.
	const firstBrace = text.indexOf('{');
	const candidates = [
		text.trim(),
		stripCodeFence(text),
		...extractJsonObjects(text),
		...(firstBrace > 0 ? extractJsonObjects(text.slice(firstBrace)) : [])
	];
	const parsed: unknown[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		try {
			parsed.push(JSON.parse(candidate));
		} catch {
			// Try the next candidate when the model added text around the JSON.
		}
	}
	return parsed;
}

function badResponse(text: string, reason: string): AiError {
	const sample = text.trim().slice(0, MAX_DETAIL_CHARS);
	return new AiError('bad-response', { detail: sample ? `${reason}\n${sample}` : reason });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringifyValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return '';
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function parseInterpret(text: string, input: AiTaskInputs['interpret']): InterpretOutput {
	const keys = input.prompts.map(prompt => prompt.key);
	const objects = parseJsonCandidates(text).filter(isRecord);
	if (objects.length === 0) throw badResponse(text, 'The reply did not contain a JSON object.');
	const answered = (object: Record<string, unknown>) =>
		keys.filter(key => Object.prototype.hasOwnProperty.call(object, key));
	// The object answering the most prompts wins; the first one wins ties.
	let best: Record<string, unknown> | undefined;
	let bestKeys: string[] = [];
	for (const object of objects) {
		const present = answered(object);
		if (present.length > bestKeys.length) {
			best = object;
			bestKeys = present;
			if (present.length === keys.length) break;
		}
	}
	if (!best) throw badResponse(text, `The reply did not answer any of: ${keys.join(', ')}.`);
	const answer = best;
	return {
		responses: Object.fromEntries(bestKeys.map(key => [key, stringifyValue(answer[key])])),
		missing: keys.filter(key => !bestKeys.includes(key))
	};
}

function itemLists(text: string, field: string): unknown[][] {
	const lists: unknown[][] = [];
	// A reply cut off by the output limit still holds complete items before the cut. Salvage them
	// from the last list in the reply, so an echoed shape example earlier in the text is skipped.
	const fieldIndex = text.lastIndexOf(`"${field}"`);
	const listStart = fieldIndex >= 0 ? fieldIndex : text.indexOf('[');
	if (listStart >= 0) {
		const salvaged: unknown[] = [];
		for (const object of extractJsonObjects(text.slice(listStart))) {
			try {
				salvaged.push(JSON.parse(object));
			} catch {
				// Skip an object that is not valid JSON.
			}
		}
		lists.push(salvaged);
	}
	for (const value of parseJsonCandidates(text)) {
		if (Array.isArray(value)) lists.push(value);
		else if (isRecord(value) && Array.isArray(value[field])) lists.push(value[field] as unknown[]);
	}
	return lists;
}

function segmentId(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isInteger(value)) return value;
	if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
	return undefined;
}

/** Keeps valid, requested, first-seen items from the reply list that yields the most of them. */
function parseSegmentItems<T extends { id: number }>(
	text: string,
	segments: TranscriptSegment[],
	field: string,
	parseItem: (item: Record<string, unknown>, id: number) => T | undefined
): T[] | undefined {
	const wanted = new Set(segments.map(segment => segment.id));
	const lists = itemLists(text, field);
	let best: T[] | undefined;
	for (const list of lists) {
		const seen = new Set<number>();
		const items: T[] = [];
		for (const item of list) {
			if (!isRecord(item)) continue;
			const id = segmentId(item.id);
			if (id === undefined || !wanted.has(id) || seen.has(id)) continue;
			const parsed = parseItem(item, id);
			if (!parsed) continue;
			seen.add(id);
			items.push(parsed);
		}
		// Later lists win ties, so a complete parse is preferred over the salvaged list.
		if (!best || items.length >= best.length) best = items;
	}
	return lists.length > 0 ? best : undefined;
}

function parseTranslations(text: string, input: AiTaskInputs['translate']): TranscriptSegment[] {
	const translations = parseSegmentItems(text, input.segments, 'translations', (item, id) => {
		const translation = typeof item.text === 'string' ? item.text.trim() : '';
		return translation ? { id, text: translation } : undefined;
	});
	if (!translations) throw badResponse(text, 'The reply did not contain a translations list.');
	if (translations.length === 0) throw badResponse(text, 'The reply contained no translation for a requested segment.');
	return translations;
}

function parseTokens(value: unknown): ReadingToken[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const tokens: ReadingToken[] = [];
	for (const item of value) {
		// Older prompts used [text, reading] tuples; accept them when a model still answers that way.
		const candidate = Array.isArray(item) && item.length === 2 ? { text: item[0], reading: item[1] } : item;
		if (!isRecord(candidate) || typeof candidate.text !== 'string' || typeof candidate.reading !== 'string' || !candidate.text) {
			return undefined;
		}
		tokens.push({ text: candidate.text, reading: candidate.reading });
	}
	return tokens;
}

function parseReadings(text: string, input: AiTaskInputs['reading']): SegmentReading[] {
	const readings = parseSegmentItems(text, input.segments, 'readings', (item, id) => {
		const tokens = parseTokens(item.tokens);
		return tokens ? { id, tokens } : undefined;
	});
	if (!readings) throw badResponse(text, 'The reply did not contain a readings list.');
	if (readings.length === 0) throw badResponse(text, 'The reply contained no reading for a requested segment.');
	return readings;
}

/**
 * Validates a model reply against the task contract. Interpret returns the answered keys with the
 * missing ones listed; transcript tasks return only valid items for requested segment ids. Callers
 * treat missing keys and absent segments as unanswered, never as complete.
 */
export function parseOutput<T extends AiTask>(task: T, input: AiTaskInput<T>, text: string): AiTaskOutput<T> {
	switch (task) {
		case 'interpret':
			return parseInterpret(text, input as AiTaskInputs['interpret']) as AiTaskOutput<T>;
		case 'edit':
		case 'explain': {
			const result = text.trim();
			if (!result) throw badResponse(text, 'The model returned an empty response.');
			return result as AiTaskOutput<T>;
		}
		case 'translate':
			return parseTranslations(text, input as AiTaskInputs['translate']) as AiTaskOutput<T>;
		case 'reading':
			return parseReadings(text, input as AiTaskInputs['reading']) as AiTaskOutput<T>;
	}
	throw new TypeError(`Unknown AI task: ${String(task)}`);
}
