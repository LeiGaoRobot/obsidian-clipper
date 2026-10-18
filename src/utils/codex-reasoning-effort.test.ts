import { describe, expect, test } from 'vitest';
import {
	CODEX_REASONING_EFFORTS,
	normalizeCodexReasoningEffort
} from './codex-reasoning-effort';

describe('Codex reasoning effort setting', () => {
	test('accepts every supported effort value', () => {
		expect(CODEX_REASONING_EFFORTS).toEqual([
			'minimal',
			'low',
			'medium',
			'high',
			'xhigh',
			'max',
			'ultra'
		]);
		for (const effort of CODEX_REASONING_EFFORTS) {
			expect(normalizeCodexReasoningEffort(effort)).toBe(effort);
		}
	});

	test('treats absent, padded, and unknown values as unset', () => {
		expect(normalizeCodexReasoningEffort(undefined)).toBeUndefined();
		expect(normalizeCodexReasoningEffort('')).toBeUndefined();
		expect(normalizeCodexReasoningEffort(' high ')).toBeUndefined();
		expect(normalizeCodexReasoningEffort('extreme')).toBeUndefined();
		expect(normalizeCodexReasoningEffort(1)).toBeUndefined();
	});
});
