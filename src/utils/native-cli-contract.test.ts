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
		expect(buildNativeCliRequest('codex', 'Page content', prompts, { requestId: 'request-1' })).toEqual({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-1',
			mode: 'codex',
			prompt: buildExecutionPrompt('Page content', prompts)
		});
		expect(NATIVE_CLI_HOST_NAME).toBe('com.obsidian.web_clipper');
	});

	test('adds a trimmed model only to Codex requests', () => {
		const prompts = [{ key: 'prompt_1', prompt: 'Summarize this', filters: '' }];
		expect(buildNativeCliRequest('codex', 'Page content', prompts, {
			requestId: 'request-model',
			model: '  gpt-5.6-sol  '
		})).toMatchObject({
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-model',
			mode: 'codex',
			model: 'gpt-5.6-sol'
		});
	});

	test('uses protocol v5 and adds canonical effort only to Codex requests', () => {
		expect(NATIVE_CLI_PROTOCOL_VERSION).toBe(5);
		expect(buildNativeCliRequest('codex', 'Context', [], {
			requestId: 'request-effort',
			effort: 'max'
		})).toMatchObject({
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			mode: 'codex',
			effort: 'max'
		});
	});

	test('rejects invalid or non-Codex effort overrides', () => {
		expect(() => buildNativeCliRequest('codex', 'Context', [], {
			effort: 'extreme' as never
		})).toThrow('Codex reasoning effort must be a supported value.');
		expect(() => buildNativeCliRequest('grok', 'Context', [], {
			effort: 'high'
		})).toThrow('Codex reasoning effort overrides require Codex execution mode.');
	});

	test('rejects invalid model overrides', () => {
		expect(() => buildNativeCliRequest('codex', 'Context', [], { model: '   ' }))
			.toThrow('Codex model must be a non-empty string of at most 200 characters.');
		expect(() => buildNativeCliRequest('codex', 'Context', [], { model: 'x'.repeat(201) }))
			.toThrow('Codex model must be a non-empty string of at most 200 characters.');
		expect(() => buildNativeCliRequest('grok', 'Context', [], { model: 'gpt-5.6-sol' }))
			.toThrow('Codex model overrides require Codex execution mode.');
	});

	test('rejects malformed or empty host requests', () => {
		expect(isNativeCliRequest({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-1',
			mode: 'grok',
			prompt: 'prompt'
		})).toBe(true);
		expect(isNativeCliRequest({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-model',
			mode: 'codex',
			prompt: 'prompt',
			model: 'gpt-5.6-sol'
		})).toBe(true);
		expect(isNativeCliRequest({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-model',
			mode: 'grok',
			prompt: 'prompt',
			model: 'gpt-5.6-sol'
		})).toBe(false);
		expect(isNativeCliRequest({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-model',
			mode: 'codex',
			prompt: 'prompt',
			model: ' gpt-5.6-sol '
		})).toBe(false);
		expect(isNativeCliRequest({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-model',
			mode: 'codex',
			prompt: 'prompt',
			model: ''
		})).toBe(false);
		expect(isNativeCliRequest({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-model',
			mode: 'codex',
			prompt: 'prompt',
			model: 'x'.repeat(201)
		})).toBe(false);
		expect(isNativeCliRequest({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-effort',
			mode: 'codex',
			prompt: 'prompt',
			effort: 'extreme'
		})).toBe(false);
		expect(isNativeCliRequest({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-effort',
			mode: 'grok',
			prompt: 'prompt',
			effort: 'high'
		})).toBe(false);
		expect(isNativeCliRequest({ type: 'executeCli', mode: 'api', prompt: 'prompt' })).toBe(false);
		expect(isNativeCliRequest({ type: 'executeCli', mode: 'codex', prompt: '' })).toBe(false);
	});

	test.each(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
		('accepts %s at the extension boundary', effort => {
			expect(isNativeCliRequest({
				type: 'executeCli',
				protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
				requestId: `request-${effort}`,
				mode: 'codex',
				prompt: 'prompt',
				effort
			})).toBe(true);
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
