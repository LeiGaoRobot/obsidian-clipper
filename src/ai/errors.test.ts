import { describe, expect, test } from 'vitest';
import { AI_ERROR_CODES, AiError, aiErrorOptions, classifyHttpStatus, isAiError, toAiError, withAiErrorContext } from './errors';

function nativeError(name: string, code?: string, message = 'native failure') {
	return Object.assign(new Error(message), { name, ...(code ? { code } : {}) });
}

describe('AiError', () => {
	test('carries a code, default retryability, and optional context', () => {
		const error = new AiError('rate-limited', { connectionId: 'c1', status: 429, detail: 'slow down' });
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('AiError');
		expect(error).toMatchObject({ code: 'rate-limited', retryable: true, connectionId: 'c1', status: 429 });
		expect(error.message).toBe('slow down');
		expect(new AiError('auth').retryable).toBe(false);
		expect(new AiError('auth', { retryable: true }).retryable).toBe(true);
		expect(isAiError(error)).toBe(true);
		expect(isAiError(new Error('x'))).toBe(false);
	});

	test('lists every code once', () => {
		expect(new Set(AI_ERROR_CODES).size).toBe(AI_ERROR_CODES.length);
	});

	test('carries the optional task, profile, and recovery only when given', () => {
		const error = new AiError('timeout', { task: 'translate', profileId: 'codex-default', recovery: 'continue-remaining' });
		expect(error).toMatchObject({ task: 'translate', profileId: 'codex-default', recovery: 'continue-remaining' });
		const plain = new AiError('timeout');
		expect(plain).not.toHaveProperty('task');
		expect(plain).not.toHaveProperty('profileId');
		expect(plain).not.toHaveProperty('recovery');
	});

	test('aiErrorOptions rebuilds an equal error', () => {
		const error = new AiError('rate-limited', {
			connectionId: 'c1',
			status: 429,
			detail: 'slow down',
			retryAfterMs: 5000,
			task: 'explain',
			profileId: 'gpt'
		});
		expect({ ...new AiError(error.code, aiErrorOptions(error)) }).toEqual({ ...error });
	});
});

describe('withAiErrorContext', () => {
	test('fills a missing task and profile on a copy, keeping every other field', () => {
		const error = new AiError('auth', { status: 401, connectionId: 'openai', detail: 'invalid key' });
		const tagged = withAiErrorContext(error, { task: 'explain', profileId: 'gpt' });
		expect(tagged).not.toBe(error);
		expect(tagged).toBeInstanceOf(AiError);
		expect(tagged).toMatchObject({
			code: 'auth',
			status: 401,
			connectionId: 'openai',
			detail: 'invalid key',
			retryable: false,
			task: 'explain',
			profileId: 'gpt'
		});
		expect(error).not.toHaveProperty('task');
	});

	test('never overwrites what the error already names', () => {
		const error = new AiError('quota', { task: 'translate', profileId: 'codex' });
		expect(withAiErrorContext(error, { task: 'reading', profileId: 'gpt' })).toBe(error);
		const taskOnly = new AiError('not-configured', { task: 'translate' });
		expect(withAiErrorContext(taskOnly, { task: 'reading', profileId: 'gpt' })).toMatchObject({ task: 'translate', profileId: 'gpt' });
	});

	test('returns the same error when there is nothing to add', () => {
		const error = new AiError('network');
		expect(withAiErrorContext(error, {})).toBe(error);
	});
});

describe('toAiError', () => {
	test('passes an AiError through unchanged', () => {
		const error = new AiError('quota');
		expect(toAiError(error)).toBe(error);
	});

	test.each([
		['AbortError', undefined, 'cancelled'],
		['RequestCancelledError', undefined, 'cancelled'],
		['NativeCliUnavailableError', undefined, 'host-missing'],
		['NativeCliExecutionError', 'timeout', 'timeout'],
		['NativeCliExecutionError', 'unavailable', 'host-missing'],
		['NativeCliExecutionError', 'protocol-mismatch', 'host-outdated'],
		['NativeCliExecutionError', 'config', 'cli-missing'],
		['NativeCliExecutionError', 'launch-failed', 'cli-missing'],
		['NativeCliExecutionError', 'response-too-large', 'bad-response'],
		['NativeCliExecutionError', 'cancelled', 'cancelled'],
		['NativeCliExecutionError', 'cli-failed', 'provider-error'],
		['NativeCliExecutionError', 'invalid', 'provider-error'],
		['LanguageLearningRequestError', 'failed', 'provider-error'],
		['LanguageLearningRequestError', 'timeout', 'timeout']
	])('maps %s(%s) to %s', (name, code, expected) => {
		const error = toAiError(nativeError(name, code, 'CLI said no'));
		expect(error.code).toBe(expected);
		expect(error.detail).toBe('CLI said no');
	});

	test('keeps the Host code and timeout limit from a Native Messaging error', () => {
		const native = Object.assign(nativeError('NativeCliExecutionError', 'timeout', 'codex CLI timed out'), {
			details: { mode: 'codex', timeoutSeconds: 120 }
		});
		expect(toAiError(native)).toMatchObject({ code: 'timeout', nativeCode: 'timeout', timeoutSeconds: 120 });
		expect(toAiError(nativeError('NativeCliExecutionError', 'cli-failed', 'exit 1')))
			.toMatchObject({ code: 'provider-error', nativeCode: 'cli-failed' });
	});

	test.each([
		'Failed to fetch',
		'NetworkError when attempting to fetch resource.',
		'Load failed'
	])('maps the fetch failure "%s" to a network error', message => {
		expect(toAiError(new TypeError(message)).code).toBe('network');
	});

	test('does not report programming TypeErrors as network problems', () => {
		const error = toAiError(new TypeError("Cannot read properties of undefined (reading 'content')"));
		expect(error).toMatchObject({ code: 'provider-error', retryable: false });
		expect(toAiError(new TypeError('Codex model must be 200 characters or fewer.')).code).toBe('provider-error');
	});

	test('maps unknown values to a non-retryable provider error', () => {
		const error = toAiError('boom');
		expect(error).toMatchObject({ code: 'provider-error', retryable: false, detail: 'boom' });
		expect(toAiError(new Error('odd')).code).toBe('provider-error');
	});
});

describe('classifyHttpStatus', () => {
	test.each([
		[401, '', 'auth', false],
		[403, '', 'auth', false],
		[404, '', 'model-unavailable', false],
		[408, '', 'timeout', true],
		[429, '{"error":{"type":"rate_limit_error"}}', 'rate-limited', true],
		[429, '{"error":{"code":"insufficient_quota"}}', 'quota', false],
		[429, 'You exceeded your current quota, please check your plan and billing details.', 'quota', false],
		[500, '', 'provider-error', true],
		[502, '', 'provider-error', true],
		[503, '', 'provider-error', true],
		[504, '', 'provider-error', true],
		[529, '', 'provider-error', true],
		[400, 'bad request', 'provider-error', false],
		[402, 'Payment required', 'quota', false]
	])('maps %i to %s', (status, body, code, retryable) => {
		const error = classifyHttpStatus(status, body, { connectionId: 'conn' });
		expect(error).toMatchObject({ code, retryable, status, connectionId: 'conn' });
	});

	test('treats an Ollama 403 as an origin problem, not a rejected key', () => {
		expect(classifyHttpStatus(403, 'Forbidden', { kind: 'ollama' }).code).toBe('provider-error');
		expect(classifyHttpStatus(403, 'Forbidden', { kind: 'openai-compatible' }).code).toBe('auth');
	});

	test('carries a parsed Retry-After when the response had one', () => {
		expect(classifyHttpStatus(429, '', {}, { retryAfterMs: 7000 })).toMatchObject({ code: 'rate-limited', retryAfterMs: 7000 });
		expect(classifyHttpStatus(503, '', {}, { retryAfterMs: 1000 }).retryAfterMs).toBe(1000);
		expect('retryAfterMs' in classifyHttpStatus(429, '')).toBe(false);
		expect('retryAfterMs' in classifyHttpStatus(429, '', {}, { retryAfterMs: undefined })).toBe(false);
		expect(new AiError('rate-limited', { retryAfterMs: 0 }).retryAfterMs).toBe(0);
	});

	test('bounds a large response body in the detail', () => {
		const error = classifyHttpStatus(502, '<html>' + 'x'.repeat(10_000));
		expect(error.detail!.length).toBeLessThanOrEqual(2001);
	});
});
