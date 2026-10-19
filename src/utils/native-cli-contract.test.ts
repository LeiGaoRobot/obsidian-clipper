import { describe, expect, test } from 'vitest';
import { buildExecutionPrompt } from './cli-execution-contract';
import {
	buildNativeCliCancelRequest,
	buildNativeCliHealthRequest,
	buildNativeCliPromptRequest,
	buildNativeCliRequest,
	isNativeCliRequest,
	MAX_OUTPUT_SCHEMA_CHARS,
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

	describe('output schema', () => {
		const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
		const executeRequest = {
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-schema',
			mode: 'codex',
			prompt: 'prompt'
		};

		test('builds a request from an already rendered prompt', () => {
			expect(buildNativeCliPromptRequest('codex', 'Rendered prompt', {
				requestId: 'request-prompt',
				model: 'gpt-5.6-sol',
				effort: 'high',
				outputSchema: schema
			})).toEqual({
				type: 'executeCli',
				protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
				requestId: 'request-prompt',
				mode: 'codex',
				prompt: 'Rendered prompt',
				model: 'gpt-5.6-sol',
				effort: 'high',
				outputSchema: schema
			});
			expect(buildNativeCliPromptRequest('grok', 'Rendered prompt', { requestId: 'request-grok' })).toEqual({
				type: 'executeCli',
				protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
				requestId: 'request-grok',
				mode: 'grok',
				prompt: 'Rendered prompt'
			});
		});

		test('keeps the context builder delegating to the rendered-prompt builder', () => {
			const prompts = [{ key: 'prompt_1', prompt: 'Summarize this', filters: '' }];
			expect(buildNativeCliRequest('codex', 'Page content', prompts, { requestId: 'request-1', effort: 'low' }))
				.toEqual(buildNativeCliPromptRequest('codex', buildExecutionPrompt('Page content', prompts), {
					requestId: 'request-1',
					effort: 'low'
				}));
		});

		test('rejects invalid or non-Codex output schemas', () => {
			expect(() => buildNativeCliPromptRequest('grok', 'prompt', { outputSchema: schema }))
				.toThrow(new TypeError('Output schemas require Codex execution mode.'));
			expect(() => buildNativeCliPromptRequest('codex', 'prompt', { outputSchema: [] as never }))
				.toThrow('Output schema must be a JSON object.');
			expect(() => buildNativeCliPromptRequest('codex', 'prompt', {
				outputSchema: { description: 'x'.repeat(MAX_OUTPUT_SCHEMA_CHARS) }
			})).toThrow('Output schema must serialize to at most 20000 characters.');
			expect(() => buildNativeCliPromptRequest('grok', 'prompt', { model: 'gpt-5.6-sol' }))
				.toThrow('Codex model overrides require Codex execution mode.');
		});

		test('validates output schemas at the extension boundary', () => {
			const padding = MAX_OUTPUT_SCHEMA_CHARS - JSON.stringify({ description: '' }).length;
			expect(isNativeCliRequest({ ...executeRequest, outputSchema: schema })).toBe(true);
			expect(isNativeCliRequest({ ...executeRequest, outputSchema: { description: 'x'.repeat(padding) } })).toBe(true);
			expect(isNativeCliRequest({ ...executeRequest, mode: 'grok', outputSchema: schema })).toBe(false);
			expect(isNativeCliRequest({ ...executeRequest, outputSchema: [schema] })).toBe(false);
			expect(isNativeCliRequest({ ...executeRequest, outputSchema: null })).toBe(false);
			expect(isNativeCliRequest({ ...executeRequest, outputSchema: 'schema' })).toBe(false);
			expect(isNativeCliRequest({
				...executeRequest,
				outputSchema: { description: 'x'.repeat(padding + 1) }
			})).toBe(false);
		});
	});
});