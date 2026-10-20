import { describe, expect, test } from 'vitest';
import { defaultStructuredOutputMode, isStructuredOutputRejection } from './capabilities';
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

	test('recognizes a 400 that rejects the structured-output parameter', () => {
		expect(isStructuredOutputRejection(new AiError('provider-error', {
			status: 400,
			detail: '{"error":{"message":"Invalid parameter: response_format.type json_schema"}}'
		}))).toBe(true);
		expect(isStructuredOutputRejection(new AiError('provider-error', { status: 400, detail: 'max_tokens too large' }))).toBe(false);
		expect(isStructuredOutputRejection(new AiError('provider-error', { status: 500, detail: 'response_format' }))).toBe(false);
		expect(isStructuredOutputRejection(new AiError('provider-error', { status: 422, detail: 'json_schema is not supported' }))).toBe(true);
		expect(isStructuredOutputRejection(new AiError('provider-error', { status: 400, detail: 'unsupported output tooling' }))).toBe(false);
		expect(isStructuredOutputRejection(new AiError('provider-error', {
			nativeCode: 'cli-failed',
			detail: "codex CLI failed: error: unexpected argument '--output-schema' found"
		}))).toBe(true);
		expect(isStructuredOutputRejection(new AiError('provider-error', { nativeCode: 'cli-failed', detail: 'codex CLI failed: auth' }))).toBe(false);
	});
});
