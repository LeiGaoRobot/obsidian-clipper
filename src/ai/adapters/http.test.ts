import { afterEach, describe, expect, test, vi } from 'vitest';
import { ENVELOPE_SYSTEM_PROMPT } from '../prompt-envelope';
import type { ApiConnectionKind } from '../types';
import { buildApiRequest, executeApiCall, type ApiPromptCall } from './http';

const app = { name: 'PagePick for Obsidian', homepageUrl: 'https://home.example' };
const prompts = [{ key: 'prompt_1', prompt: 'Summarize' }];
const payload = '{"prompts":{"prompt_1":"Summarize"}}';

function call(kind: ApiConnectionKind, overrides: Partial<ApiPromptCall> = {}): ApiPromptCall {
	return {
		kind,
		baseUrl: 'https://model.example/v1/chat/completions',
		model: 'model-x',
		credential: 'key',
		context: 'Page',
		prompts,
		app,
		...overrides
	};
}

const encoder = new TextEncoder();

function streamResponse(chunks: string[], contentType: string, status = 200): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		}
	});
	return new Response(body, { status, headers: { 'content-type': contentType } });
}

describe('buildApiRequest', () => {
	const chat = [
		{ role: 'system', content: ENVELOPE_SYSTEM_PROMPT },
		{ role: 'user', content: 'Page' },
		{ role: 'user', content: payload }
	];

	test('keeps the OpenAI-compatible request and only sends max_tokens when requested', () => {
		expect(buildApiRequest(call('openai-compatible'))).toEqual({
			url: 'https://model.example/v1/chat/completions',
			headers: {
				'Content-Type': 'application/json',
				'HTTP-Referer': app.homepageUrl,
				'X-Title': app.name,
				'Authorization': 'Bearer key'
			},
			body: { model: 'model-x', messages: chat, stream: true }
		});
		expect(buildApiRequest(call('openai-compatible', { maxTokens: 3200 })).body.max_tokens).toBe(3200);
	});

	test('keeps the Anthropic request shape and headers', () => {
		const request = buildApiRequest(call('anthropic', { baseUrl: 'https://api.anthropic.com/v1/messages' }));
		expect(request.headers).toEqual({
			'Content-Type': 'application/json',
			'x-api-key': 'key',
			'anthropic-version': '2023-06-01',
			'anthropic-dangerous-direct-browser-access': 'true'
		});
		expect(request.body).toEqual({
			model: 'model-x',
			max_tokens: 1600,
			messages: [{ role: 'user', content: 'Page' }, { role: 'user', content: payload }],
			temperature: 0.5,
			system: ENVELOPE_SYSTEM_PROMPT,
			stream: true
		});
	});

	test('keeps the Azure, Hugging Face, Perplexity, and Ollama differences', () => {
		const azure = buildApiRequest(call('azure-openai'));
		expect(azure.headers['api-key']).toBe('key');
		expect(azure.body).toEqual({ messages: chat, max_tokens: 1600, stream: true });

		const hf = buildApiRequest(call('huggingface', { baseUrl: 'https://hf.example/models/{model-id}/chat' }));
		expect(hf.url).toBe('https://hf.example/models/model-x/chat');
		expect(hf.body).toMatchObject({ model: 'model-x', max_tokens: 1600, stream: true });

		const perplexity = buildApiRequest(call('perplexity'));
		expect(perplexity.body).toMatchObject({ temperature: 0.3, max_tokens: 1600 });
		expect((perplexity.body.messages as Array<{ content: string }>)[1].content)
			.toBe(`\n\t\t\t\t\t\t"Page"\n\t\t\t\t\t\t"${payload}"`);

		const ollama = buildApiRequest(call('ollama', { credential: undefined }));
		expect(ollama.headers).toEqual({ 'Content-Type': 'application/json' });
		expect(ollama.body).toEqual({
			model: 'model-x', messages: chat, format: 'json', num_ctx: 120000, temperature: 0.5, stream: true
		});
	});

	test('sends an empty bearer token for keyless connections, like v1', () => {
		expect(buildApiRequest(call('openai-compatible', { credential: undefined })).headers.Authorization)
			.toBe('Bearer ');
	});
});

describe('executeApiCall', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test('accumulates OpenAI SSE deltas split across chunk boundaries', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
			'data: {"choices":[{"delta":{"content":"{\\"prompts_"}}]}\n\ndata: {"choi',
			'ces":[{"delta":{"content":"responses\\":{}}"}}]}\n\n',
			'data: [DONE]\n\n'
		], 'text/event-stream'));
		const received: number[] = [];
		const text = await executeApiCall(call('openai-compatible'), { fetchImpl, onReceive: chars => received.push(chars) });
		expect(text).toBe('{"prompts_responses":{}}');
		expect(received[received.length - 1]).toBe(text.length);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://model.example/v1/chat/completions');
		expect(JSON.parse(init.body).stream).toBe(true);
	});

	test('reads Anthropic text deltas and ignores other events', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
			'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{ \\"a\\": 1 }"}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n'
		], 'text/event-stream'));
		await expect(executeApiCall(call('anthropic'), { fetchImpl })).resolves.toBe('{"a":1}');
	});

	test('reads Ollama NDJSON', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
			'{"message":{"content":"{\\"a\\":"},"done":false}\n{"message":{"content":"2}"},',
			'"done":false}\n{"done":true}\n'
		], 'application/x-ndjson'));
		await expect(executeApiCall(call('ollama'), { fetchImpl })).resolves.toBe('{"a":2}');
	});

	test('falls back to a complete JSON body when the endpoint ignores streaming', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			choices: [{ message: { content: 'plain' } }]
		}), { status: 200, headers: { 'content-type': 'application/json' } }));
		await expect(executeApiCall(call('openai-compatible'), { fetchImpl })).resolves.toBe('plain');
	});

	test('detects SSE served without an event-stream content type', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response(
			'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n',
			{ status: 200, headers: { 'content-type': 'text/plain' } }
		));
		await expect(executeApiCall(call('openai-compatible'), { fetchImpl })).resolves.toBe('ok');
	});

	test('surfaces an error event inside the stream', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
			'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
		], 'text/event-stream'));
		await expect(executeApiCall(call('anthropic'), { fetchImpl, connectionId: 'c' }))
			.rejects.toMatchObject({ code: 'rate-limited', detail: 'Overloaded', connectionId: 'c' });
	});

	test('rejects an unreadable JSON body as a bad response', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>', {
			status: 200, headers: { 'content-type': 'application/json' }
		}));
		await expect(executeApiCall(call('openai-compatible'), { fetchImpl })).rejects.toMatchObject({ code: 'bad-response' });
	});

	test.each([
		[401, 'auth'],
		[404, 'model-unavailable'],
		[429, 'rate-limited'],
		[503, 'provider-error']
	])('classifies HTTP %i as %s', async (status, code) => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status }));
		await expect(executeApiCall(call('openai-compatible'), { fetchImpl, connectionId: 'c' }))
			.rejects.toMatchObject({ code, status, connectionId: 'c' });
	});

	test('explains an Ollama origin rejection', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 }));
		const error = await executeApiCall(call('ollama'), { fetchImpl }).catch(value => value);
		expect(error).toMatchObject({ code: 'provider-error', status: 403 });
		expect(error.detail).toContain('OLLAMA_ORIGINS');
	});

	test('maps a failed fetch to a network error', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		await expect(executeApiCall(call('openai-compatible'), { fetchImpl })).rejects.toMatchObject({ code: 'network' });
	});

	test('times out when no byte arrives within the idle window', async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
		}));
		const result = executeApiCall(call('openai-compatible'), { fetchImpl: fetchImpl as unknown as typeof fetch, idleTimeoutMs: 1000 }).catch(error => error);
		await vi.advanceTimersByTimeAsync(1001);
		expect(await result).toMatchObject({ code: 'timeout', retryable: true });
	});

	test('keeps a steadily streaming response alive past the idle window', async () => {
		vi.useFakeTimers();
		let push: ((text: string) => void) | undefined;
		let close: (() => void) | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				push = text => controller.enqueue(encoder.encode(text));
				close = () => controller.close();
			}
		});
		const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
		const result = executeApiCall(call('openai-compatible'), { fetchImpl, idleTimeoutMs: 1000 });
		for (let index = 0; index < 5; index++) {
			await vi.advanceTimersByTimeAsync(800);
			push?.(`data: {"choices":[{"delta":{"content":"${index}"}}]}\n\n`);
		}
		close?.();
		await expect(result).resolves.toBe('01234');
	});

	test('enforces the hard cap even while bytes keep arriving', async () => {
		vi.useFakeTimers();
		let push: ((text: string) => void) | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				push = text => controller.enqueue(encoder.encode(text));
			}
		});
		const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
			init?.signal?.addEventListener('abort', () => push = undefined);
			return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
		});
		const result = executeApiCall(call('openai-compatible'), { fetchImpl: fetchImpl as unknown as typeof fetch, idleTimeoutMs: 1000, hardTimeoutMs: 3000 })
			.catch(error => error);
		for (let index = 0; index < 5; index++) {
			await vi.advanceTimersByTimeAsync(700);
			push?.('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
		}
		expect(await result).toMatchObject({ code: 'timeout' });
	});

	test('reports a caller abort as cancellation', async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
		}));
		const result = executeApiCall(call('openai-compatible'), { fetchImpl: fetchImpl as unknown as typeof fetch, signal: controller.signal });
		controller.abort();
		await expect(result).rejects.toMatchObject({ code: 'cancelled' });
		const aborted = new AbortController();
		aborted.abort();
		await expect(executeApiCall(call('openai-compatible'), { fetchImpl: fetchImpl as unknown as typeof fetch, signal: aborted.signal }))
			.rejects.toMatchObject({ code: 'cancelled' });
	});
});
