import type { CodexReasoningEffort } from '../types/types';

export const CODEX_REASONING_EFFORTS = [
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra'
] as const satisfies readonly CodexReasoningEffort[];

export function normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
	return typeof value === 'string'
		&& (CODEX_REASONING_EFFORTS as readonly string[]).includes(value)
		? value as CodexReasoningEffort
		: undefined;
}
