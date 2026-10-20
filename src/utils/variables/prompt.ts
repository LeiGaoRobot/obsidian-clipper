import { PROMPT_VARIABLE_PATTERN } from '../prompt-variables';

/**
 * A prompt variable is not resolved by the compiler. With `keep`, the whole variable is returned so
 * that whoever runs the prompts (the popup Interpreter, the CLI's `--execution-mode`) finds and
 * fills it, and the popup fields still show it; otherwise it compiles to nothing.
 */
export function processPrompt(match: string, keep: boolean): string {
	if (!keep) return '';
	if (!PROMPT_VARIABLE_PATTERN.test(match)) {
		console.error('Invalid prompt format:', match);
	}
	return match;
}
