import { describe, expect, test } from 'vitest';
import {
	buildNativeCliCancelRequest,
	buildNativeCliHealthRequest,
	buildNativeCliPromptRequest,
	MAX_OUTPUT_SCHEMA_CHARS,
	NATIVE_CLI_HOST_NAME,
	NATIVE_CLI_PROTOCOL_VERSION
} from './native-cli-contract';

describe('Native CLI contract', () => {
	test('builds a host request without provider credentials', () => {
		expect(buildNativeCliPromptRequest('codex', 'Rendered prompt', { requestId: 'request-1' })).toEqual({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-1',
			mode: 'codex',
			prompt: 'Rendered prompt'
		});
		expect(NATIVE_CLI_HOST_NAME).toBe('com.obsidian.web_clipper');
	});

	test('adds a trimmed model only to Codex requests', () => {
		expect(buildNativeCliPromptRequest('codex', 'Rendered prompt', {
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
		expect(buildNativeCliPromptRequest('codex', 'Context', {
			requestId: 'request-effort',
			effort: 'max'
		})).toMatchObject({
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			mode: 'codex',
			effort: 'max'
		});
	});

	test('rejects invalid or non-Codex effort overrides', () => {
		expect(() => buildNativeCliPromptRequest('codex', 'Context', {
			effort: 'extreme' as never
		})).toThrow('Codex reasoning effort must be a supported value.');
		expect(() => buildNativeCliPromptRequest('grok', 'Context', {
			effort: 'high'
		})).toThrow('Codex reasoning effort overrides require Codex execution mode.');
	});

	test('rejects invalid model overrides', () => {
		expect(() => buildNativeCliPromptRequest('codex', 'Context', { model: '   ' }))
			.toThrow('Codex model must be a non-empty string of at most 200 characters.');
		expect(() => buildNativeCliPromptRequest('codex', 'Context', { model: 'x'.repeat(201) }))
			.toThrow('Codex model must be a non-empty string of at most 200 characters.');
		expect(() => buildNativeCliPromptRequest('grok', 'Context', { model: 'gpt-5.6-sol' }))
			.toThrow('Codex model overrides require Codex execution mode.');
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

		test('accepts a schema that serializes to exactly the limit', () => {
			const padding = MAX_OUTPUT_SCHEMA_CHARS - JSON.stringify({ description: '' }).length;
			const outputSchema = { description: 'x'.repeat(padding) };
			expect(buildNativeCliPromptRequest('codex', 'prompt', { outputSchema })).toMatchObject({ outputSchema });
		});
	});
});