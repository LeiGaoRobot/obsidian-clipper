import { AiError, classifyHttpStatus, toAiError } from '../errors';
import type { ApiConnectionKind, Connection } from '../types';

// Model listing for a connection Test (D3): a free GET that checks the key and the profiles'
// model ids before any billable request. DOM-free; statically imported into the service worker.

export const DEFAULT_LISTING_TIMEOUT_MS = 15_000;
/** At most this many listed ids are returned with a Test result. */
export const MAX_LISTED_MODELS = 200;

export interface ModelListRequest {
	url: string;
	headers: Record<string, string>;
}

// Kinds whose provider offers a model listing. Azure lists deployments under a different API,
// and Hugging Face and Perplexity have none; those are checked with a 1-token completion.
const LISTING_KINDS: ReadonlySet<ApiConnectionKind> = new Set<ApiConnectionKind>(['openai-compatible', 'anthropic', 'ollama']);

// Chat path suffix → listing path. `/v1/chat/completions` (Ollama's OpenAI path too) lists at
// `/v1/models`; Gemini's `/v1beta/chat/completions` at `/v1beta/models`.
const LISTING_PATHS: ReadonlyArray<readonly [string, string]> = [
	['/chat/completions', '/models'],
	['/v1/messages', '/v1/models'],
	['/api/chat', '/api/tags']
];

const GEMINI_HOST = 'generativelanguage.googleapis.com';

function parseUrl(baseUrl: string | undefined): URL | undefined {
	// Catalog templates such as `{resource-name}` must be filled in first.
	if (!baseUrl || /[{}]/.test(baseUrl)) return undefined;
	try {
		const url = new URL(baseUrl.trim());
		return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
	} catch {
		return undefined;
	}
}

function isApiKind(kind: Connection['kind']): kind is ApiConnectionKind {
	return !kind.startsWith('cli-');
}

/**
 * The listing URL for a connection's chat URL, keeping its query string, or undefined when the
 * kind has no listing or the path has no known chat suffix (the Test then uses a probe).
 */
export function modelListUrl(connection: Pick<Connection, 'kind' | 'baseUrl'>): string | undefined {
	if (!isApiKind(connection.kind) || !LISTING_KINDS.has(connection.kind)) return undefined;
	const url = parseUrl(connection.baseUrl);
	if (!url) return undefined;
	const path = url.pathname.replace(/\/+$/, '');
	const match = LISTING_PATHS.find(([suffix]) => path.endsWith(suffix));
	if (!match) return undefined;
	url.pathname = path.slice(0, path.length - match[0].length) + match[1];
	// The first page must hold every model a profile might name; both default to small pages.
	if (connection.kind === 'anthropic' && !url.searchParams.has('limit')) url.searchParams.set('limit', '1000');
	if (url.hostname === GEMINI_HOST && !url.searchParams.has('pageSize')) url.searchParams.set('pageSize', '1000');
	return url.toString();
}

/** The listing request with the kind's credential header, as `buildApiRequest` sends it. */
export function buildModelListRequest(
	connection: Pick<Connection, 'kind' | 'baseUrl'>,
	credential?: string
): ModelListRequest | undefined {
	const url = modelListUrl(connection);
	if (!url) return undefined;
	const key = credential ?? '';
	if (connection.kind === 'ollama') return { url, headers: {} };
	if (connection.kind === 'anthropic') {
		return {
			url,
			headers: {
				'x-api-key': key,
				'anthropic-version': '2023-06-01',
				'anthropic-dangerous-direct-browser-access': 'true'
			}
		};
	}
	// Gemini's native listing takes the key in its own header; an API key sent as a Bearer token
	// is read as an OAuth token there and rejected.
	if (new URL(url).hostname === GEMINI_HOST) return { url, headers: { 'x-goog-api-key': key } };
	return { url, headers: { Authorization: `Bearer ${key}` } };
}

function idsOf(items: unknown, field: 'id' | 'name'): string[] {
	if (!Array.isArray(items)) return [];
	return items.flatMap(item => {
		const value = item && typeof item === 'object' ? (item as Record<string, unknown>)[field] : undefined;
		return typeof value === 'string' && value.trim() ? [value.trim()] : [];
	});
}

/** Model ids from `data[].id` (OpenAI, Anthropic), `models[].name` (Gemini, Ollama), or `models[].id`. */
export function parseModelList(data: unknown): string[] {
	if (!data || typeof data !== 'object') return [];
	const body = data as { data?: unknown; models?: unknown };
	const ids = [
		...idsOf(body.data, 'id'),
		...idsOf(body.models, 'name').map(name => name.replace(/^models\//, '')),
		...idsOf(body.models, 'id')
	];
	return [...new Set(ids)];
}

/** Whether a profile's model id is among the listed ids. Ollama lists untagged models as `:latest`. */
export function isModelListed(model: string, listed: readonly string[]): boolean {
	const id = model.trim();
	if (!id) return false;
	return listed.includes(id) || (!id.includes(':') && listed.includes(`${id}:latest`));
}

export interface FetchModelListOptions {
	kind: ApiConnectionKind;
	connectionId?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

/** Sends the listing request. Rejects with an AiError classified like a completion error. */
export async function fetchModelList(request: ModelListRequest, options: FetchModelListOptions): Promise<string[]> {
	const context = options.connectionId ? { connectionId: options.connectionId } : {};
	if (options.signal?.aborted) throw new AiError('cancelled', context);
	const controller = new AbortController();
	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_LISTING_TIMEOUT_MS);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const abort = () => controller.abort();
	options.signal?.addEventListener('abort', abort, { once: true });
	try {
		const response = await (options.fetchImpl ?? fetch)(request.url, {
			method: 'GET',
			headers: request.headers,
			signal: controller.signal
		});
		if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw classifyHttpStatus(response.status, body, { ...context, kind: options.kind });
		}
		let data: unknown;
		try {
			data = await response.json();
		} catch {
			throw new AiError('bad-response', { ...context, detail: 'The model listing was not valid JSON.' });
		}
		return parseModelList(data);
	} catch (error) {
		if (options.signal?.aborted) throw new AiError('cancelled', context);
		if (timedOut) {
			throw new AiError('timeout', {
				...context,
				detail: `The model listing did not answer within ${Math.ceil(timeoutMs / 1000)} seconds.`,
				timeoutSeconds: Math.ceil(timeoutMs / 1000)
			});
		}
		throw toAiError(error, options.connectionId);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', abort);
	}
}
