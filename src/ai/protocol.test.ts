import { describe, expect, test } from 'vitest';
import { AiError } from './errors';
import {
	deserializeAiError,
	isAiClientMessage,
	sanitizeJobInput,
	sanitizeCheckpointPut,
	sanitizeJobResults,
	sanitizeTaskInput,
	serializeAiError
} from './protocol';

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

	test('round-trips the provider Retry-After delay', () => {
		const error = new AiError('rate-limited', { status: 429, retryAfterMs: 7000 });
		expect(serializeAiError(error)).toMatchObject({ retryAfterMs: 7000 });
		expect(deserializeAiError(serializeAiError(error))).toMatchObject({ code: 'rate-limited', status: 429, retryAfterMs: 7000 });
		expect(serializeAiError(new AiError('rate-limited'))).not.toHaveProperty('retryAfterMs');
		expect(deserializeAiError({ code: 'rate-limited', retryAfterMs: '7' })).not.toHaveProperty('retryAfterMs');
	});

	test('maps unknown error payloads to provider errors', () => {
		expect(deserializeAiError({ code: 'mystery', detail: 'x' })).toMatchObject({ code: 'provider-error', detail: 'x' });
		expect(deserializeAiError(null)).toMatchObject({ code: 'provider-error' });
	});

	test('accepts well-formed client messages for every task', () => {
		const segments = [{ id: 0, text: 'Hola' }, { id: 1, text: 'Adiós' }];
		expect(isAiClientMessage({ type: 'ping' })).toBe(true);
		expect(isAiClientMessage({ type: 'cancel', jobId: 'job' })).toBe(true);
		expect(isAiClientMessage({ type: 'attach', jobId: 'job' })).toBe(true);
		expect(isAiClientMessage({ type: 'start', jobId: 'job', task: 'interpret', input })).toBe(true);
		expect(isAiClientMessage({ type: 'start', jobId: 'job', task: 'edit', profileId: 'model-a', input: { instruction: 'Fix.', content: 'x', maxTokens: 4000 } })).toBe(true);
		expect(isAiClientMessage({ type: 'start', jobId: 'job', task: 'explain', input: { instruction: 'Explain.', content: 'x' } })).toBe(true);
		expect(isAiClientMessage({ type: 'start', jobId: 'job', task: 'translate', input: { instruction: 'Translate.', segments } })).toBe(true);
		expect(isAiClientMessage({ type: 'start', jobId: 'job', task: 'reading', input: { instruction: 'Annotate.', segments } })).toBe(true);
	});

	test('rejects malformed client messages', () => {
		const start = { type: 'start', jobId: 'job', task: 'interpret', input };
		const translate = { type: 'start', jobId: 'job', task: 'translate', input: { instruction: 'T.', segments: [{ id: 0, text: 'a' }] } };
		expect(isAiClientMessage(null)).toBe(false);
		expect(isAiClientMessage({ type: 'other' })).toBe(false);
		expect(isAiClientMessage({ type: 'cancel', jobId: '' })).toBe(false);
		expect(isAiClientMessage({ type: 'cancel', jobId: 'x'.repeat(201) })).toBe(false);
		expect(isAiClientMessage({ ...start, task: 'chat' })).toBe(false);
		expect(isAiClientMessage({ ...start, profileId: 3 })).toBe(false);
		expect(isAiClientMessage({ ...start, input: { ...input, prompts: [] } })).toBe(false);
		expect(isAiClientMessage({ ...start, input: { ...input, prompts: [{ key: '', prompt: 'x' }] } })).toBe(false);
		expect(isAiClientMessage({ ...start, input: { ...input, prompts: [input.prompts[0], input.prompts[0]] } })).toBe(false);
		expect(isAiClientMessage({ ...start, input: { ...input, context: 'x'.repeat(750_001) } })).toBe(false);
		expect(isAiClientMessage({
			...start,
			input: { context: 'x'.repeat(700_000), prompts: [{ key: 'prompt_1', prompt: 'y'.repeat(50_001) }] }
		})).toBe(false);
		expect(isAiClientMessage({ ...start, input: { ...input, maxTokens: 1.5 } })).toBe(false);
		expect(isAiClientMessage({ ...start, input: { ...input, maxTokens: 0 } })).toBe(false);
		expect(isAiClientMessage({ ...start, task: 'edit' })).toBe(false);
		expect(isAiClientMessage({ ...translate, input: { instruction: ' ', segments: [{ id: 0, text: 'a' }] } })).toBe(false);
		expect(isAiClientMessage({ ...translate, input: { instruction: 'T.', segments: [] } })).toBe(false);
		expect(isAiClientMessage({ ...translate, input: { instruction: 'T.', segments: [{ id: 0, text: 'a' }, { id: 0, text: 'b' }] } })).toBe(false);
		expect(isAiClientMessage({ ...translate, input: { instruction: 'T.', segments: [{ id: -1, text: 'a' }] } })).toBe(false);
		expect(isAiClientMessage({ ...translate, input: { instruction: 'T.', segments: [{ id: 0.5, text: 'a' }] } })).toBe(false);
	});

	test('accepts a test message with a string connection id and rejects any other', () => {
		expect(isAiClientMessage({ type: 'test', jobId: 'test-1', connectionId: 'openai' })).toBe(true);
		expect(isAiClientMessage({ type: 'test', jobId: 'test-1' })).toBe(false);
		expect(isAiClientMessage({ type: 'test', jobId: 'test-1', connectionId: 7 })).toBe(false);
		expect(isAiClientMessage({ type: 'test', jobId: 'test-1', connectionId: '' })).toBe(false);
		expect(isAiClientMessage({ type: 'test', jobId: 'test-1', connectionId: { id: 'openai' } })).toBe(false);
		expect(isAiClientMessage({ type: 'test', connectionId: 'openai' })).toBe(false);
	});

	test('copies only contract fields from a task input', () => {
		expect(sanitizeTaskInput('translate', {
			instruction: 'T.',
			segments: [{ id: 0, text: 'a', start: 12 }],
			apiKey: 'leak'
		})).toEqual({ instruction: 'T.', segments: [{ id: 0, text: 'a' }] });
		expect(sanitizeTaskInput('interpret', { context: 'c', prompts: [{ key: 'k', prompt: 'p', filters: '|x' }], maxTokens: 10 }))
			.toEqual({ context: 'c', prompts: [{ key: 'k', prompt: 'p' }], maxTokens: 10 });
	});

	describe('durable jobs', () => {
		const identity = { namespace: 'transcript-translation', scope: 'video-1' };
		const jobInput = { instruction: 'Translate.', segments: [{ id: 0, text: 'Hola' }, { id: 1, text: 'Adiós' }], identity };
		const startJob = { type: 'start-job', jobId: 'job:translate:transcript-translation:abc', task: 'translate', input: jobInput };
		const put = {
			type: 'checkpoint-put',
			requestId: 'request-1',
			jobId: 'job:translate:transcript-translation:abc',
			task: 'translate',
			identity,
			segmentCount: 2,
			segments: jobInput.segments,
			results: [{ id: 1, text: 'Goodbye' }]
		};
		const readingPut = {
			...put,
			task: 'reading',
			segments: [{ id: 0, text: '雨です' }, { id: 1, text: '' }],
			results: [{ id: 0, tokens: [{ text: '雨', reading: 'あめ' }, { text: 'です', reading: '' }] }, { id: 1, tokens: [] }]
		};

		test('accepts a well-formed start-job for both transcript tasks', () => {
			expect(isAiClientMessage(startJob)).toBe(true);
			expect(isAiClientMessage({ ...startJob, task: 'reading', profileId: 'model-a' })).toBe(true);
		});

		test('rejects a start-job with a bad task, id, segments, size, or identity', () => {
			const segments = (texts: string[]) => texts.map((text, id) => ({ id, text }));
			expect(isAiClientMessage({ ...startJob, task: 'interpret' })).toBe(false);
			expect(isAiClientMessage({ ...startJob, jobId: '' })).toBe(false);
			expect(isAiClientMessage({ ...startJob, profileId: 3 })).toBe(false);
			expect(isAiClientMessage({ ...startJob, input: undefined })).toBe(false);
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, instruction: ' ' } })).toBe(false);
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, segments: [] } })).toBe(false);
			// Segment ids must equal their index.
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, segments: [{ id: 1, text: 'a' }, { id: 0, text: 'b' }] } })).toBe(false);
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, segments: [{ id: 0, text: 'a' }, { id: 2, text: 'b' }] } })).toBe(false);
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, segments: segments(Array(20_001).fill('a')) } })).toBe(false);
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, segments: segments(Array(5000).fill('a')) } })).toBe(true);
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, segments: segments(['x'.repeat(1_500_000)]) } })).toBe(false);
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, identity: undefined } })).toBe(false);
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, identity: { namespace: '', scope: 's' } } })).toBe(false);
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, identity: { namespace: 'n', scope: ' ' } } })).toBe(false);
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, identity: { namespace: 'n'.repeat(101), scope: 's' } } })).toBe(false);
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, identity: { namespace: 'n', scope: 's'.repeat(501) } } })).toBe(false);
			expect(isAiClientMessage({ ...startJob, input: { ...jobInput, identity: { namespace: 'n', scope: 7 } } })).toBe(false);
		});

		test('copies only job fields from a job input', () => {
			expect(sanitizeJobInput({
				...jobInput,
				segments: [{ id: 0, text: 'a', start: 12 }],
				identity: { ...identity, profile: 'x' },
				maxTokens: 10,
				apiKey: 'leak'
			})).toEqual({ instruction: 'Translate.', segments: [{ id: 0, text: 'a' }], identity });
			expect(sanitizeJobInput({ ...jobInput, identity: { namespace: 'n'.repeat(100), scope: 's'.repeat(100) } })).toBeDefined();
		});

		test('accepts checkpoint-get and checkpoint-clear with a request id and a job id', () => {
			for (const type of ['checkpoint-get', 'checkpoint-clear']) {
				expect(isAiClientMessage({ type, requestId: 'request-1', jobId: 'job-1' })).toBe(true);
				expect(isAiClientMessage({ type, requestId: '', jobId: 'job-1' })).toBe(false);
				expect(isAiClientMessage({ type, requestId: 'request-1' })).toBe(false);
				expect(isAiClientMessage({ type, requestId: 'request-1', jobId: 'x'.repeat(201) })).toBe(false);
			}
		});

		test('accepts checkpoint-put items valid under the task contract', () => {
			expect(isAiClientMessage(put)).toBe(true);
			expect(isAiClientMessage({ ...put, results: [] })).toBe(true);
			expect(isAiClientMessage(readingPut)).toBe(true);
		});

		test('rejects checkpoint-put with malformed fields or items', () => {
			expect(isAiClientMessage({ ...put, requestId: undefined })).toBe(false);
			expect(isAiClientMessage({ ...put, task: 'edit' })).toBe(false);
			expect(isAiClientMessage({ ...put, identity: { namespace: 'n' } })).toBe(false);
			expect(isAiClientMessage({ ...put, segmentCount: 0 })).toBe(false);
			expect(isAiClientMessage({ ...put, segmentCount: 20_001 })).toBe(false);
			expect(isAiClientMessage({ ...put, segmentCount: 1.5 })).toBe(false);
			expect(isAiClientMessage({ ...put, results: undefined })).toBe(false);
			expect(isAiClientMessage({ ...put, results: [{ id: 2, text: 'x' }] })).toBe(false);
			expect(isAiClientMessage({ ...put, results: [{ id: -1, text: 'x' }] })).toBe(false);
			expect(isAiClientMessage({ ...put, results: [{ id: 0, text: 'a' }, { id: 0, text: 'b' }] })).toBe(false);
			expect(isAiClientMessage({ ...put, results: [{ id: 0, text: ' ' }] })).toBe(false);
			expect(isAiClientMessage({ ...put, results: [{ id: 0, tokens: [{ text: 'a', reading: '' }] }] })).toBe(false);
			expect(isAiClientMessage({ ...readingPut, results: [{ id: 0, text: 'Rain' }] })).toBe(false);
			expect(isAiClientMessage({ ...readingPut, results: [{ id: 0, tokens: [{ text: '雨', reading: '' }] }] })).toBe(false);
			expect(isAiClientMessage({ ...readingPut, results: [{ id: 0, tokens: [{ text: '', reading: 'x' }] }] })).toBe(false);
			expect(isAiClientMessage({ ...readingPut, results: [{ id: 0, tokens: [{ text: 'a' }] }] })).toBe(false);
		});

		test('rejects checkpoint-put segments that are missing, misaligned, or not the counted ones', () => {
			expect(isAiClientMessage({ ...put, segments: undefined })).toBe(false);
			expect(isAiClientMessage({ ...put, segments: [{ id: 0, text: 'Hola' }] })).toBe(false);
			expect(isAiClientMessage({ ...put, segments: [{ id: 1, text: 'Hola' }, { id: 0, text: 'Adiós' }] })).toBe(false);
			expect(isAiClientMessage({ ...put, segments: [{ id: 0, text: 'Hola' }, { id: 1, text: 2 }] })).toBe(false);
			expect(isAiClientMessage({ ...put, segments: [{ id: 0, text: 'x'.repeat(1_500_001) }, { id: 1, text: '' }] })).toBe(false);
		});

		test('checks checkpoint-put readings against their source text', () => {
			// Self-consistent tokens that spell something other than the source.
			expect(isAiClientMessage({ ...readingPut, results: [{ id: 0, tokens: [{ text: '雪', reading: 'ゆき' }] }] })).toBe(false);
			// An empty reading only stands for an empty source.
			expect(isAiClientMessage({ ...readingPut, results: [{ id: 0, tokens: [] }] })).toBe(false);
			expect(isAiClientMessage({ ...readingPut, results: [{ id: 1, tokens: [{ text: 'a', reading: '' }] }] })).toBe(false);
		});

		test('copies only checkpoint-put fields', () => {
			expect(sanitizeCheckpointPut({
				...readingPut,
				extra: 'x',
				identity: { ...identity, apiKey: 'leak' },
				segments: [{ id: 0, text: '雨です', start: 1 }, { id: 1, text: '' }]
			})).toEqual({
				type: 'checkpoint-put',
				requestId: 'request-1',
				jobId: readingPut.jobId,
				task: 'reading',
				identity,
				segmentCount: 2,
				segments: [{ id: 0, text: '雨です' }, { id: 1, text: '' }],
				results: readingPut.results
			});
		});

		test('copies only contract fields from checkpoint results', () => {
			expect(sanitizeJobResults('translate', 2, [{ id: 0, text: ' Hello ', extra: 1 }])).toEqual([{ id: 0, text: 'Hello' }]);
			expect(sanitizeJobResults('reading', 1, [{ id: 0, tokens: [{ text: '雨', reading: 'あめ', note: 'x' }] }]))
				.toEqual([{ id: 0, tokens: [{ text: '雨', reading: 'あめ' }] }]);
		});
	});
});
