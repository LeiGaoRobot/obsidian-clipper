import { afterEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('./debug', () => ({ debugLog: vi.fn() }));
vi.mock('./storage-utils', () => ({
	generalSettings: {
		providers: [{
			id: 'provider-1',
			name: 'OpenAI-compatible',
			baseUrl: 'https://model.example/v1/chat/completions',
			apiKey: 'test-key',
			apiKeyRequired: true
		}]
	}
}));

import { sendToLLM } from './llm-client';

describe('LLM client', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		fetchMock.mockReset();
	});

	test('uses the configured Interpreter provider without DOM dependencies', async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({
			choices: [{
				message: {
					content: JSON.stringify({
						prompts_responses: { prompt_1: 'smoke-ok' }
					})
				}
			}]
		}), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const result = await sendToLLM(
			'smoke context',
			'',
			[{ key: 'prompt_1', prompt: 'Return smoke.' }],
			{
				id: 'model-1',
				providerId: 'provider-1',
				providerModelId: 'test-model',
				name: 'Test model',
				enabled: true
			},
			{ maxTokens: 3200, cooldownMs: 0 }
		);

		const request = fetchMock.mock.calls[0][1] as RequestInit;
		expect(JSON.parse(request.body as string)).toMatchObject({
			model: 'test-model',
			max_tokens: 3200
		});
		expect(result.promptResponses).toEqual([{
			key: 'prompt_1',
			prompt: 'Return smoke.',
			user_response: 'smoke-ok'
		}]);
	});

	test('aborts a provider request when the configured timeout expires', async () => {
		vi.useFakeTimers();
		let requestSignal: AbortSignal | undefined;
		fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_, reject) => {
			requestSignal = init.signal as AbortSignal;
			requestSignal.addEventListener('abort', () => reject(new Error('aborted')));
		}));
		vi.stubGlobal('fetch', fetchMock);

		const request = sendToLLM(
			'smoke context',
			'',
			[{ key: 'prompt_1', prompt: 'Return smoke.' }],
			{
				id: 'model-1',
				providerId: 'provider-1',
				providerModelId: 'test-model',
				name: 'Test model',
				enabled: true
			},
			{ cooldownMs: 0, timeoutMs: 50 }
		);

		const rejection = expect(request).rejects.toThrow('timed out');
		await vi.advanceTimersByTimeAsync(50);
		await rejection;
		expect(requestSignal?.aborted).toBe(true);
	});

	test('aborts a provider request when the caller cancels it', async () => {
		const abortController = new AbortController();
		let requestSignal: AbortSignal | undefined;
		fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_, reject) => {
			requestSignal = init.signal as AbortSignal;
			requestSignal.addEventListener('abort', () => reject(new Error('aborted')));
		}));
		vi.stubGlobal('fetch', fetchMock);

		const request = sendToLLM(
			'smoke context',
			'',
			[{ key: 'prompt_1', prompt: 'Return smoke.' }],
			{
				id: 'model-1',
				providerId: 'provider-1',
				providerModelId: 'test-model',
				name: 'Test model',
				enabled: true
			},
			{ cooldownMs: 0, signal: abortController.signal }
		);

		abortController.abort();
		await expect(request).rejects.toThrow('cancelled');
		expect(requestSignal?.aborted).toBe(true);
	});
});
