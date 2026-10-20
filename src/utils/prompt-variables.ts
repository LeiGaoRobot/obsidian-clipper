// Prompt variables (`{{"…"}}` and `{{prompt:"…"}}`) as the template compiler, the popup
// Interpreter and the CLI read them. Pure: no DOM, storage or browser imports.

/**
 * One prompt variable. Group 1 is the prompt text and group 2 the filter chain with its leading
 * `|`, if any. Both may span lines. Not global: use `createPromptVariableRegex` to scan or replace.
 */
export const PROMPT_VARIABLE_PATTERN = /{{(?:prompt:)?"([\s\S]*?)"(\|[\s\S]*?)?}}/;

/** A fresh global regex over `PROMPT_VARIABLE_PATTERN`, so no `lastIndex` is shared between scans. */
export function createPromptVariableRegex(): RegExp {
	return new RegExp(PROMPT_VARIABLE_PATTERN.source, 'g');
}

/** A prompt response as text: strings as they are, nothing as `''`, anything else as indented JSON. */
export function stringifyValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return '';
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
