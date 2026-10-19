import type { PromptVariable } from '../types/types';
import { parseOutput, renderCliPrompt, type PromptItem } from '../ai/contracts';
import { AiError } from '../ai/errors';
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

/**
 * Parses CLI stdout against the interpret contract and returns responses by prompt key. The CLI
 * has no way to mark an unanswered prompt in its output, so a partial reply is rejected.
 */
export function parsePromptResponses(
	output: string,
	promptVariables: PromptVariable[]
): Record<string, unknown> {
	const { responses, missing } = parseOutput('interpret', { context: '', prompts: toPromptItems(promptVariables) }, output);
	if (missing.length > 0) {
		throw new AiError('incomplete', { detail: `The reply did not answer: ${missing.join(', ')}.` });
	}
	return responses;
}

/** The single CLI prompt for interpret, shared by the Native Host path and `src/cli.ts`. */
export function buildExecutionPrompt(context: string, promptVariables: PromptVariable[]): string {
	return renderCliPrompt('interpret', { context, prompts: toPromptItems(promptVariables) });
}

function toPromptItems(promptVariables: PromptVariable[]): PromptItem[] {
	return promptVariables.map(({ key, prompt }) => ({ key, prompt }));
}
