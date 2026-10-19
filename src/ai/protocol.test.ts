import { describe, expect, test } from 'vitest';
import { AiError } from './errors';
import { deserializeAiError, isAiClientMessage, serializeAiError } from './protocol';

const input = { context: 'Text', prompts: [{ key: 'prompt_1', prompt: 'Summarize' }] };

describe('AI port protocol', () => {
	test('round-trips errors', () => {
		const error = new AiError('not-configured', { reason: 'no-profile', connectionId: 'provider-a' });
		const restored = deserializeAiError(serializeAiError(error));
		expect(restored).toBeInstanceOf(AiError);
		expect(restored).toMatchObject({ code: 'not-configured', reason: 'no-profile', connectionId: 'provider-a', retryable: false });
	});

	test('round-trips the Host code and timeout limit', () => {
		const error = new AiError('timeout', { nativeCode: 'timeout', timeoutSeconds: 300, detail: 'slow' });
		expect(deserializeAiError(serializeAiError(error))).toMatchObject({ code: 'timeout', nativeCode: 'timeout', timeoutSeconds: 300 });
	});

	test('maps unknown error payloads to provider errors', () => {
		expect(deserializeAiError({ code: 'mystery', detail: 'x' })).toMatchObject({ code: 'provider-error', detail: 'x' });
		expect(deserializeAiError(null)).toMatchObject({ code: 'provider-error' });
	});

	test('accepts well-formed client messages', () => {
		expect(isAiClientMessage({ type: 'ping' })).toBe(true);
		expect(isAiClientMessage({ type: 'cancel', jobId: 'job' })).toBe(true);
		expect(isAiClientMessage({ type: 'attach', jobId: 'job' })).toBe(true);
		expect(isAiClientMessage({ type: 'start', jobId: 'job', task: 'translate', input })).toBe(true);
		expect(isAiClientMessage({ type: 'start', jobId: 'job', task: 'edit', profileId: 'model-a', input: { ...input, maxTokens: 4000 } })).toBe(true);
	});

	test('rejects malformed client messages', () => {
		const start = { type: 'start', jobId: 'job', task: 'interpret', input };
		expect(isAiClientMessage(null)).toBe(false);
		expect(isAiClientMessage({ type: 'other' })).toBe(false);
		expect(isAiClientMessage({ type: 'cancel', jobId: '' })).toBe(false);
		expect(isAiClientMessage({ type: 'cancel', jobId: 'x'.repeat(201) })).toBe(false);
		expect(isAiClientMessage({ ...start, task: 'chat' })).toBe(false);
		expect(isAiClientMessage({ ...start, profileId: 3 })).toBe(false);
		expect(isAiClientMessage({ ...start, input: { ...input, prompts: [] } })).toBe(false);
		expect(isAiClientMessage({ ...start, input: { ...input, prompts: [{ key: '', prompt: 'x' }] } })).toBe(false);
		expect(isAiClientMessage({ ...start, input: { ...input, context: 'x'.repeat(750_001) } })).toBe(false);
		expect(isAiClientMessage({
			...start,
			input: { context: 'x'.repeat(700_000), prompts: [{ key: 'prompt_1', prompt: 'y'.repeat(50_001) }] }
		})).toBe(false);
		expect(isAiClientMessage({ ...start, input: { ...input, maxTokens: 1.5 } })).toBe(false);
		expect(isAiClientMessage({ ...start, input: { ...input, maxTokens: 0 } })).toBe(false);
	});
});
