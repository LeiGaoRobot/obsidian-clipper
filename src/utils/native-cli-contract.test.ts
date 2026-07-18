import { describe, expect, test } from 'vitest';
import { buildExecutionPrompt } from './cli-execution-contract';
import {
	buildNativeCliCancelRequest,
	buildNativeCliHealthRequest,
	buildNativeCliRequest,
	isNativeCliRequest,
	NATIVE_CLI_HOST_NAME,
	NATIVE_CLI_PROTOCOL_VERSION
} from './native-cli-contract';

describe('Native CLI contract', () => {
	test('builds a host request without provider credentials', () => {
		const prompts = [{ key: 'prompt_1', prompt: 'Summarize this', filters: '' }];
		expect(buildNativeCliRequest('codex', 'Page content', prompts, 'request-1')).toEqual({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-1',
			mode: 'codex',
			prompt: buildExecutionPrompt('Page content', prompts)
		});
		expect(NATIVE_CLI_HOST_NAME).toBe('com.obsidian.web_clipper');
	});

	test('rejects malformed or empty host requests', () => {
		expect(isNativeCliRequest({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-1',
			mode: 'grok',
			prompt: 'prompt'
		})).toBe(true);
		expect(isNativeCliRequest({ type: 'executeCli', mode: 'api', prompt: 'prompt' })).toBe(false);
		expect(isNativeCliRequest({ type: 'executeCli', mode: 'codex', prompt: '' })).toBe(false);
	});

	test('builds cancellation and health requests on the versioned host protocol', () => {
		expect(buildNativeCliCancelRequest('request-1')).toEqual({
			type: 'cancelCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-1'
		});
		expect(buildNativeCliHealthRequest('grok', 'health-1')).toEqual({
			type: 'healthCheck',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'health-1',
			mode: 'grok'
		});
	});
});
