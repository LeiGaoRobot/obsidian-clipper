import type { CodexReasoningEffort } from '../types/types';
import { CODEX_REASONING_EFFORTS } from '../../native-host/cli-invocation.mjs';

export { CODEX_REASONING_EFFORTS };

export function normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
	return typeof value === 'string'
		&& (CODEX_REASONING_EFFORTS as readonly string[]).includes(value)
		? value as CodexReasoningEffort
		: undefined;
}
