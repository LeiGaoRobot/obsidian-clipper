import { describe, expect, test } from 'vitest';
import { MAX_CODEX_MODEL_CHARS, normalizeCodexModel } from './codex-model';

describe('Codex model setting', () => {
	test('trims a configured model ID', () => {
		expect(normalizeCodexModel('  gpt-5.6-sol  ')).toBe('gpt-5.6-sol');
	});

	test('treats blank, non-string, and oversized values as absent', () => {
		expect(normalizeCodexModel('   ')).toBeUndefined();
		expect(normalizeCodexModel(null)).toBeUndefined();
		expect(normalizeCodexModel('x'.repeat(MAX_CODEX_MODEL_CHARS + 1))).toBeUndefined();
	});
});
