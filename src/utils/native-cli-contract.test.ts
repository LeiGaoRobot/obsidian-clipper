import { describe, expect, test } from 'vitest';
import { buildExecutionPrompt } from './cli-execution-contract';
import {
	buildNativeCliRequest,
	isNativeCliRequest,
	NATIVE_CLI_HOST_NAME
} from './native-cli-contract';

describe('Native CLI contract', () => {
	test('builds a host request without provider credentials', () => {
		const prompts = [{ key: 'prompt_1', prompt: 'Summarize this', filters: '' }];
		expect(buildNativeCliRequest('codex', 'Page content', prompts)).toEqual({
			type: 'executeCli',
			mode: 'codex',
			prompt: buildExecutionPrompt('Page content', prompts)
		});
		expect(NATIVE_CLI_HOST_NAME).toBe('com.obsidian.web_clipper');
	});

	test('rejects malformed or empty host requests', () => {
		expect(isNativeCliRequest({ type: 'executeCli', mode: 'grok', prompt: 'prompt' })).toBe(true);
		expect(isNativeCliRequest({ type: 'executeCli', mode: 'api', prompt: 'prompt' })).toBe(false);
		expect(isNativeCliRequest({ type: 'executeCli', mode: 'codex', prompt: '' })).toBe(false);
	});
});
