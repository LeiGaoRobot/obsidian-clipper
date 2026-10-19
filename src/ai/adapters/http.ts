import type { PromptVariable } from '../../types/types';
import { AiError, classifyHttpStatus, toAiError } from '../errors';
import { buildEnvelopePayload, ENVELOPE_SYSTEM_PROMPT } from '../prompt-envelope';
import type { ApiConnectionKind } from '../types';

export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
// MV3 terminates a service-worker event that runs longer than five minutes.
export const DEFAULT_HARD_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_TOKENS = 1600;

export interface AppIdentity {
	name: string;
	homepageUrl: string;
}

export interface ApiPromptCall {
	kind: ApiConnectionKind;
	baseUrl: string;
	model: string;
	credential?: string;
	context: string;
	prompts: PromptVariable[];
	maxTokens?: number;
	app: AppIdentity;
}

export interface ApiRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/**
 * Builds the provider request. Bodies and headers match the v1 llm-client.ts branches
 * exactly, except that every kind now asks for a streamed response.
 */
export function buildApiRequest(call: ApiPromptCall): ApiRequest {
	const maxTokens = call.maxTokens ?? DEFAULT_MAX_TOKENS;
	const payload = buildEnvelopePayload(call.prompts);
	const key = call.credential ?? '';
	const json = { 'Content-Type': 'application/json' };
	const attribution = { 'HTTP-Referer': call.app.homepageUrl, 'X-Title': call.app.name };
	const chatMessages = [
		{ role: 'system', content: ENVELOPE_SYSTEM_PROMPT },
		{ role: 'user', content: `${call.context}` },
		{ role: 'user', content: payload }
	];

	switch (call.kind) {
		case 'huggingface':
			return {
				url: call.baseUrl.replace('{model-id}', call.model),
				headers: { ...json, 'Authorization': `Bearer ${key}` },
				body: { model: call.model, messages: chatMessages, max_tokens: maxTokens, stream: true }
			};
		case 'azure-openai':
			return {
				url: call.baseUrl,
				headers: { ...json, 'api-key': key },
				body: { messages: chatMessages, max_tokens: maxTokens, stream: true }
			};
		case 'anthropic':
			return {
				url: call.baseUrl,
				headers: {
					...json,
					'x-api-key': key,
					'anthropic-version': '2023-06-01',
					'anthropic-dangerous-direct-browser-access': 'true'
				},
				body: {
					model: call.model,
					max_tokens: maxTokens,
					messages: [
						{ role: 'user', content: `${call.context}` },
						{ role: 'user', content: payload }
					],
					temperature: 0.5,
					system: ENVELOPE_SYSTEM_PROMPT,
					stream: true
				}
			};
		case 'perplexity':
			return {
				url: call.baseUrl,
				headers: { ...json, ...attribution, 'Authorization': `Bearer ${key}` },
				body: {
					model: call.model,
					max_tokens: maxTokens,
					messages: [
						{ role: 'system', content: ENVELOPE_SYSTEM_PROMPT },
						{ role: 'user', content: `
						"${call.context}"
						"${payload}"` }
					],
					temperature: 0.3,
					stream: true
				}
			};
		case 'ollama':
			return {
				url: call.baseUrl,
				headers: json,
				body: {
					model: call.model,
					messages: chatMessages,
					format: 'json',
					num_ctx: 120000,
					temperature: 0.5,
					stream: true
				}
			};
		case 'openai-compatible':
			return {
				url: call.baseUrl,
				headers: { ...json, ...attribution, 'Authorization': `Bearer ${key}` },
				body: {
					model: call.model,
					messages: chatMessages,
					...(call.maxTokens ? { max_tokens: maxTokens } : {}),
					stream: true
				}
			};
	}
}

// v1 re-serialized Anthropic and Ollama JSON content so the envelope parser saw normalized JSON.
function finalizeText(kind: ApiConnectionKind, text: string): string {
	if (kind !== 'anthropic' && kind !== 'ollama') return text;
	try {
		return JSON.stringify(JSON.parse(text));
	} catch {
		return text;
	}
}

function parseJsonBody(kind: ApiConnectionKind, text: string): string {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new AiError('bad-response', { detail: 'The provider response was not valid JSON.' });
	}
	return parseCompleteResponse(kind, data);
}

/** Extracts the model text from a complete, non-streamed response body (v1 behavior). */
export function parseCompleteResponse(kind: ApiConnectionKind, data: any): string {
	if (kind === 'anthropic') {
		const text = data?.content?.[0]?.text;
		return text ? finalizeText(kind, text) : JSON.stringify(data);
	}
	if (kind === 'ollama') {
		const text = data?.message?.content;
		return text ? finalizeText(kind, text) : JSON.stringify(data);
	}
	return data?.choices?.[0]?.message?.content || JSON.stringify(data);
}

function streamEventError(event: any): AiError | undefined {
	const error = event?.error;
	if (!error) return undefined;
	const detail = typeof error === 'string' ? error : error.message || JSON.stringify(error);
	const overloaded = typeof error === 'object' && /overloaded|rate_limit/i.test(String(error.type || error.code || ''));
	return new AiError(overloaded ? 'rate-limited' : 'provider-error', { detail });
}

/** Returns the text delta carried by one parsed stream event. */
export function streamEventText(kind: ApiConnectionKind, event: any): string {
	const error = streamEventError(event);
	if (error) throw error;
	if (kind === 'anthropic') {
		return event?.type === 'content_block_delta' && event.delta?.type === 'text_delta'
			? String(event.delta.text ?? '')
			: '';
	}
	if (kind === 'ollama') return String(event?.message?.content ?? '');
	return String(event?.choices?.[0]?.delta?.content ?? '');
}

type StreamFormat = 'sse' | 'ndjson' | 'json';

function formatFromContentType(contentType: string): StreamFormat | undefined {
	if (contentType.includes('text/event-stream')) return 'sse';
	if (contentType.includes('ndjson')) return 'ndjson';
	if (contentType.includes('application/json')) return 'json';
	return undefined;
}

/** Incrementally splits a byte stream into complete lines. */
class LineBuffer {
	private pending = '';

	push(chunk: string): string[] {
		this.pending += chunk;
		const lines = this.pending.split(/\r?\n/);
		this.pending = lines.pop() ?? '';
		return lines;
	}

	flush(): string[] {
		const rest = this.pending;
		this.pending = '';
		return rest ? [rest] : [];
	}
}

function parseJsonLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		throw new AiError('bad-response', { detail: `Unreadable stream event: ${line.slice(0, 200)}` });
	}
}

/** Accumulates streamed text. Returns false once the stream signals completion. */
function consumeLine(kind: ApiConnectionKind, format: StreamFormat, line: string, append: (text: string) => void): boolean {
	const trimmed = line.trim();
	if (!trimmed) return true;
	if (format === 'sse') {
		if (!trimmed.startsWith('data:')) return true;
		const data = trimmed.slice(5).trim();
		if (data === '[DONE]') return false;
		// Proxies inject keepalive or comment-like events; skip anything that is not a JSON event.
		if (!data.startsWith('{')) return true;
		append(streamEventText(kind, parseJsonLine(data)));
		return true;
	}
	append(streamEventText(kind, parseJsonLine(trimmed)));
	return true;
}

/** Parses a fully buffered body whose format the content type did not reveal. */
function parseBufferedBody(kind: ApiConnectionKind, text: string): string {
	const trimmed = text.trim();
	let format: StreamFormat = 'json';
	if (trimmed.startsWith('data:')) format = 'sse';
	else if (trimmed.includes('\n') && trimmed.split('\n').every(line => !line.trim() || line.trim().startsWith('{'))) {
		try {
			JSON.parse(trimmed);
		} catch {
			format = 'ndjson';
		}
	}
	if (format === 'json') return parseJsonBody(kind, text);
	let output = '';
	for (const line of text.split(/\r?\n/)) {
		if (!consumeLine(kind, format, line, part => { output += part; })) break;
	}
	return finalizeText(kind, output);
}

export interface ApiCallOptions {
	connectionId?: string;
	signal?: AbortSignal;
	idleTimeoutMs?: number;
	hardTimeoutMs?: number;
	/** Called as streamed text arrives, with the total characters received so far. */
	onReceive?: (receivedChars: number) => void;
	fetchImpl?: typeof fetch;
}

const OLLAMA_ORIGIN_HINT = 'Ollama cannot process requests originating from a browser extension without setting OLLAMA_ORIGINS. '
	+ 'See instructions at https://help.obsidian.md/web-clipper/interpreter';

/** Sends one prompt call and returns the model's complete text. */
export async function executeApiCall(call: ApiPromptCall, options: ApiCallOptions = {}): Promise<string> {
	const context = options.connectionId ? { connectionId: options.connectionId } : {};
	if (options.signal?.aborted) throw new AiError('cancelled', context);
	const request = buildApiRequest(call);
	const controller = new AbortController();
	const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
	const hardTimeoutMs = Math.max(1, options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS);
	let timeoutError: AiError | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const stop = () => {
		controller.abort();
		// Not every body stream errors on abort; cancelling the reader always ends read().
		void activeReader?.cancel().catch(() => {});
	};
	const expire = (detail: string, timeoutSeconds: number) => {
		timeoutError = new AiError('timeout', { ...context, detail, timeoutSeconds });
		stop();
	};
	const resetIdleTimer = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(
			() => expire(
				`No response from the provider for ${Math.ceil(idleTimeoutMs / 1000)} seconds.`,
				Math.ceil(idleTimeoutMs / 1000)
			),
			idleTimeoutMs
		);
	};
	const hardTimer = setTimeout(
		() => expire(
			`The provider did not finish within ${Math.ceil(hardTimeoutMs / 1000)} seconds.`,
			Math.ceil(hardTimeoutMs / 1000)
		),
		hardTimeoutMs
	);
	const abortFromCaller = () => stop();
	options.signal?.addEventListener('abort', abortFromCaller, { once: true });
	resetIdleTimer();

	// Buffered bodies are still read chunk by chunk, so a slow but steady response keeps the idle timer alive.
	const readBodyText = async (body: ReadableStream<Uint8Array>): Promise<string> => {
		const reader = body.getReader();
		activeReader = reader;
		const decoder = new TextDecoder();
		let text = '';
		while (true) {
			const { value, done } = await reader.read();
			resetIdleTimer();
			if (done) return text + decoder.decode();
			text += decoder.decode(value, { stream: true });
		}
	};

	const fail = (error: unknown): never => {
		if (timeoutError) throw timeoutError;
		if (options.signal?.aborted) throw new AiError('cancelled', context);
		throw error instanceof AiError
			? (error.connectionId || !options.connectionId
				? error
				: new AiError(error.code, { ...context, retryable: error.retryable, status: error.status, detail: error.detail }))
			: toAiError(error, options.connectionId);
	};

	try {
		const response = await (options.fetchImpl ?? fetch)(request.url, {
			method: 'POST',
			headers: request.headers,
			body: JSON.stringify(request.body),
			signal: controller.signal
		});
		resetIdleTimer();
		if (!response.ok) {
			const errorText = await response.text().catch(() => '');
			if (call.kind === 'ollama' && response.status === 403) {
				throw new AiError('provider-error', { ...context, status: 403, detail: OLLAMA_ORIGIN_HINT });
			}
			throw classifyHttpStatus(response.status, errorText, { ...context, kind: call.kind });
		}

		const format = formatFromContentType(response.headers.get('content-type') || '');
		if (!response.body || format === undefined || format === 'json') {
			const text = response.body ? await readBodyText(response.body) : await response.text();
			options.onReceive?.(text.length);
			if (timeoutError || options.signal?.aborted) return fail(undefined);
			return format === 'json'
				? parseJsonBody(call.kind, text)
				: parseBufferedBody(call.kind, text);
		}

		const reader = response.body.getReader();
		activeReader = reader;
		const decoder = new TextDecoder();
		const lines = new LineBuffer();
		let output = '';
		const append = (text: string) => {
			if (!text) return;
			output += text;
			options.onReceive?.(output.length);
		};
		let finished = false;
		while (!finished) {
			const { value, done } = await reader.read();
			resetIdleTimer();
			const chunkLines = done ? lines.flush() : lines.push(decoder.decode(value, { stream: true }));
			for (const line of chunkLines) {
				if (!consumeLine(call.kind, format, line, append)) {
					// [DONE] arrived: release the connection without waiting for the server to close it.
					void reader.cancel().catch(() => {});
					finished = true;
					break;
				}
			}
			if (done) finished = true;
		}
		if (timeoutError || options.signal?.aborted) return fail(undefined);
		return finalizeText(call.kind, output);
	} catch (error) {
		return fail(error);
	} finally {
		if (idleTimer) clearTimeout(idleTimer);
		clearTimeout(hardTimer);
		options.signal?.removeEventListener('abort', abortFromCaller);
	}
}
