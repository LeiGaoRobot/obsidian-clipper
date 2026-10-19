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

export interface AiTaskOutputs {
	interpret: Record<string, string>;
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
	const candidates = [text.trim(), stripCodeFence(text), ...extractJsonObjects(text)];
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

function parseInterpret(text: string, input: AiTaskInputs['interpret']): Record<string, string> {
	const keys = input.prompts.map(prompt => prompt.key);
	const objects = parseJsonCandidates(text).filter(isRecord);
	if (objects.length === 0) throw badResponse(text, 'The reply did not contain a JSON object.');
	let best: Record<string, unknown> | undefined;
	let bestCount = 0;
	for (const object of objects) {
		const count = keys.filter(key => Object.prototype.hasOwnProperty.call(object, key)).length;
		if (count === keys.length) {
			return Object.fromEntries(keys.map(key => [key, stringifyValue(object[key])]));
		}
		if (count > bestCount) {
			best = object;
			bestCount = count;
		}
	}
	if (!best) throw badResponse(text, `The reply did not answer any of: ${keys.join(', ')}.`);
	const missing = keys.filter(key => !Object.prototype.hasOwnProperty.call(best, key));
	throw new AiError('incomplete', { detail: `The reply did not answer: ${missing.join(', ')}.` });
}

function findItems(text: string, field: string): unknown[] | undefined {
	for (const value of parseJsonCandidates(text)) {
		if (Array.isArray(value)) return value;
		if (isRecord(value) && Array.isArray(value[field])) return value[field] as unknown[];
	}
	return undefined;
}

function requestedIds(segments: TranscriptSegment[]): Set<number> {
	return new Set(segments.map(segment => segment.id));
}

function parseTranslations(text: string, input: AiTaskInputs['translate']): TranscriptSegment[] {
	const items = findItems(text, 'translations');
	if (!items) throw badResponse(text, 'The reply did not contain a translations list.');
	const wanted = requestedIds(input.segments);
	const seen = new Set<number>();
	const translations: TranscriptSegment[] = [];
	for (const item of items) {
		if (!isRecord(item) || typeof item.text !== 'string') continue;
		const id = Number(item.id);
		const translation = item.text.trim();
		if (!Number.isInteger(id) || !wanted.has(id) || seen.has(id) || !translation) continue;
		seen.add(id);
		translations.push({ id, text: translation });
	}
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
	const items = findItems(text, 'readings');
	if (!items) throw badResponse(text, 'The reply did not contain a readings list.');
	const wanted = requestedIds(input.segments);
	const seen = new Set<number>();
	const readings: SegmentReading[] = [];
	for (const item of items) {
		if (!isRecord(item)) continue;
		const id = Number(item.id);
		const tokens = parseTokens(item.tokens);
		if (!Number.isInteger(id) || !wanted.has(id) || seen.has(id) || !tokens) continue;
		seen.add(id);
		readings.push({ id, tokens });
	}
	if (readings.length === 0) throw badResponse(text, 'The reply contained no reading for a requested segment.');
	return readings;
}

/**
 * Validates a model reply against the task contract. Transcript tasks return only valid items
 * for requested segment ids; callers treat absent segments as missing, never as complete.
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
