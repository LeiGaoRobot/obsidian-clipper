import { describe, expect, test } from 'vitest';
import {
	createMemoryStructuredOutputCache,
	createStructuredOutputCache,
	defaultStructuredOutputMode,
	isStructuredOutputRejection,
	probeStructuredOutput,
	STRUCTURED_OUTPUT_STORAGE_KEY
} from './capabilities';
import { AiError } from './errors';

describe('structured output capabilities', () => {
	test('picks a default mode per kind and URL', () => {
		expect(defaultStructuredOutputMode('openai-compatible', 'https://api.openai.com/v1/chat/completions')).toBe('json_schema');
		expect(defaultStructuredOutputMode('openai-compatible', 'https://api.deepseek.com/v1/chat/completions')).toBe('json_object');
		expect(defaultStructuredOutputMode('openai-compatible', 'not a url')).toBe('json_object');
		expect(defaultStructuredOutputMode('anthropic')).toBe('json_schema');
		expect(defaultStructuredOutputMode('ollama')).toBe('json_schema');
		expect(defaultStructuredOutputMode('azure-openai')).toBe('json_schema');
		expect(defaultStructuredOutputMode('cli-codex')).toBe('json_schema');
		expect(defaultStructuredOutputMode('perplexity')).toBe('none');
		expect(defaultStructuredOutputMode('huggingface')).toBe('none');
		expect(defaultStructuredOutputMode('cli-grok')).toBe('none');
	});

	test('caches a mode per connection and ignores it after the base URL changes', async () => {
		const cache = createMemoryStructuredOutputCache();
		await cache.set('c1', 'https://a.example/v1', 'none');
		expect(await cache.get('c1', 'https://a.example/v1')).toBe('none');
		expect(await cache.get('c1', 'https://b.example/v1')).toBeUndefined();
		expect(await cache.get('c2', 'https://a.example/v1')).toBeUndefined();
	});

	test('serializes concurrent writes to the storage area', async () => {
		const state: Record<string, unknown> = {};
		const cache = createStructuredOutputCache({
			async get(key) {
				await Promise.resolve();
				return { [key]: state[key] };
			},
			async set(values) {
				await Promise.resolve();
				Object.assign(state, values);
			}
		});
		await Promise.all([cache.set('c1', 'u1', 'none'), cache.set('c2', 'u2', 'json_object')]);
		expect(state[STRUCTURED_OUTPUT_STORAGE_KEY]).toEqual({
			c1: { baseUrl: 'u1', mode: 'none' },
			c2: { baseUrl: 'u2', mode: 'json_object' }
		});
	});

	test('tolerates a corrupt or failing storage area', async () => {
		const cache = createStructuredOutputCache({
			async get() {
				return { [STRUCTURED_OUTPUT_STORAGE_KEY]: { c1: { baseUrl: '', mode: 'bogus' } } };
			},
			async set() {
				throw new Error('quota');
			}
		});
		expect(await cache.get('c1', undefined)).toBeUndefined();
		await expect(cache.set('c1', undefined, 'none')).resolves.toBeUndefined();
	});

	test('the probe stub returns the cached mode, else the default, without a request', async () => {
		const cache = createMemoryStructuredOutputCache();
		const connection = { id: 'c1', kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/v1/messages' };
		expect(await probeStructuredOutput(connection, cache)).toBe('json_schema');
		await cache.set('c1', connection.baseUrl, 'none');
		expect(await probeStructuredOutput(connection, cache)).toBe('none');
	});

	test('recognizes a 400 that rejects the structured-output parameter', () => {
		expect(isStructuredOutputRejection(new AiError('provider-error', {
			status: 400,
			detail: '{"error":{"message":"Invalid parameter: response_format.type json_schema"}}'
		}))).toBe(true);
		expect(isStructuredOutputRejection(new AiError('provider-error', { status: 400, detail: 'max_tokens too large' }))).toBe(false);
		expect(isStructuredOutputRejection(new AiError('provider-error', { status: 500, detail: 'response_format' }))).toBe(false);
	});
});
