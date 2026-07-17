import type { PromptVariable } from '../types/types';
import { applyFilters } from './filters';

export type CliExecutionMode = 'grok' | 'codex';

const PROMPT_PATTERN = /{{(?:prompt:)?"([\s\S]*?)"(\|.*?)?}}/;

function createPromptRegex(): RegExp {
	return new RegExp(PROMPT_PATTERN.source, 'g');
}

export function collectPromptVariables(values: string[]): PromptVariable[] {
	const promptMap = new Map<string, PromptVariable>();

	for (const value of values) {
		const promptRegex = createPromptRegex();
		let match: RegExpExecArray | null;
		while ((match = promptRegex.exec(value)) !== null) {
			const prompt = match[1];
			if (!promptMap.has(prompt)) {
				promptMap.set(prompt, {
					key: `prompt_${promptMap.size + 1}`,
					prompt,
					filters: match[2] || ''
				});
			}
		}
	}

	return Array.from(promptMap.values());
}

function stringifyResponse(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return '';
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function replacePromptVariables(
	value: string,
	promptVariables: PromptVariable[],
	responses: Record<string, unknown>,
	currentUrl: string
): string {
	return value.replace(createPromptRegex(), (match, promptText: string, filters = '') => {
		const variable = promptVariables.find(item => item.prompt === promptText);
		if (!variable || !Object.prototype.hasOwnProperty.call(responses, variable.key)) {
			return match;
		}

		const response = stringifyResponse(responses[variable.key]);
		return filters ? applyFilters(response, filters.slice(1), currentUrl) : response;
	});
}

function extractJsonObjects(value: string): string[] {
	const objects: string[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === '\\') {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}

		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === '{') {
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

function parseJsonOutputs(output: string): unknown[] {
	const candidates = [output.trim(), ...extractJsonObjects(output)];
	const parsed: unknown[] = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			parsed.push(JSON.parse(candidate));
		} catch {
			// Try the next JSON object when the CLI added progress text or a code fence.
		}
	}
	return parsed;
}

export function parsePromptResponses(
	output: string,
	promptVariables: PromptVariable[]
): Record<string, unknown> {
	const parsedValues = parseJsonOutputs(output);
	for (const parsed of parsedValues) {
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

		const parsedObject = parsed as Record<string, unknown>;
		const responseObject = parsedObject.prompts_responses;
		const responses = responseObject && typeof responseObject === 'object' && !Array.isArray(responseObject)
			? responseObject as Record<string, unknown>
			: parsedObject;
		if (!promptVariables.every(variable => Object.prototype.hasOwnProperty.call(responses, variable.key))) {
			continue;
		}

		return promptVariables.reduce<Record<string, unknown>>((result, variable) => {
			result[variable.key] = responses[variable.key];
			return result;
		}, {});
	}

	if (parsedValues.length === 0) {
		throw new Error('CLI response did not contain valid JSON.');
	}
	throw new Error(`CLI response is missing ${promptVariables[0]?.key || 'prompt response'}.`);
}

export function buildExecutionPrompt(context: string, promptVariables: PromptVariable[]): string {
	const prompts = promptVariables.reduce<Record<string, string>>((result, variable) => {
		result[variable.key] = variable.prompt;
		return result;
	}, {});

	return [
		'You are the Obsidian Web Clipper template interpreter.',
		'Return exactly one JSON object with a "prompts_responses" object. Use every requested key exactly once. Do not include markdown fences, explanations, tool output, or any other text.',
		'Page content:',
		context,
		'Prompt variables:',
		JSON.stringify(prompts, null, 2)
	].join('\n\n');
}
