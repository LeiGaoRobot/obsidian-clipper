import type { AiError } from './errors';
import type { Connection, ConnectionKind, StructuredOutputSupport } from './types';

// Structured-output capability per connection. `json_schema` is each kind's strongest mechanism
// (OpenAI response_format, Anthropic forced tool, Ollama format schema, Codex --output-schema);
// `json_object` is plain JSON mode; `none` relies on prompt rules and the tolerant parser.

export type StructuredOutputMode = Exclude<StructuredOutputSupport, 'unknown'>;

export const STRUCTURED_OUTPUT_STORAGE_KEY = 'ai_structured_output';

function hostOf(baseUrl: string | undefined): string {
	try {
		return baseUrl ? new URL(baseUrl).hostname.toLowerCase() : '';
	} catch {
		return '';
	}
}

/** The mode used until a probe or a provider rejection says otherwise. */
export function defaultStructuredOutputMode(kind: ConnectionKind, baseUrl?: string): StructuredOutputMode {
	switch (kind) {
		case 'openai-compatible':
			// Many compatible servers accept JSON mode but not schemas; OpenAI itself accepts both.
			return hostOf(baseUrl) === 'api.openai.com' ? 'json_schema' : 'json_object';
		case 'azure-openai':
		case 'anthropic':
		case 'ollama':
		case 'cli-codex':
			return 'json_schema';
		case 'huggingface':
		case 'perplexity':
		case 'cli-grok':
			return 'none';
	}
}

export interface StructuredOutputCache {
	get(connectionId: string, baseUrl: string | undefined): Promise<StructuredOutputMode | undefined>;
	set(connectionId: string, baseUrl: string | undefined, mode: StructuredOutputMode): Promise<void>;
}

export interface KeyValueArea {
	get(key: string): Promise<Record<string, unknown>>;
	set(values: Record<string, unknown>): Promise<void>;
}

type CacheEntries = Record<string, { baseUrl: string; mode: StructuredOutputMode }>;

const MODES: ReadonlySet<string> = new Set<StructuredOutputMode>(['json_schema', 'json_object', 'none']);
const MAX_CACHE_ENTRIES = 50;

/** A cache in an extension storage area. Entries for a changed base URL are ignored. */
export function createStructuredOutputCache(area: KeyValueArea): StructuredOutputCache {
	const read = async (): Promise<CacheEntries> => {
		try {
			const value = (await area.get(STRUCTURED_OUTPUT_STORAGE_KEY))[STRUCTURED_OUTPUT_STORAGE_KEY];
			return value && typeof value === 'object' && !Array.isArray(value) ? value as CacheEntries : {};
		} catch {
			return {};
		}
	};
	let writes = Promise.resolve();
	return {
		async get(connectionId, baseUrl) {
			const entry = (await read())[connectionId];
			return entry && entry.baseUrl === (baseUrl ?? '') && MODES.has(entry.mode) ? entry.mode : undefined;
		},
		set(connectionId, baseUrl, mode) {
			// Serialize read-modify-write so two finishing jobs cannot drop each other's entry.
			writes = writes.then(async () => {
				const entries = await read();
				delete entries[connectionId];
				entries[connectionId] = { baseUrl: baseUrl ?? '', mode };
				const ids = Object.keys(entries);
				ids.slice(0, Math.max(0, ids.length - MAX_CACHE_ENTRIES)).forEach(id => delete entries[id]);
				await area.set({ [STRUCTURED_OUTPUT_STORAGE_KEY]: entries });
			}).catch(() => undefined);
			return writes;
		}
	};
}

export function createMemoryStructuredOutputCache(): StructuredOutputCache {
	const values = new Map<string, unknown>();
	return createStructuredOutputCache({
		async get(key) {
			return values.has(key) ? { [key]: values.get(key) } : {};
		},
		async set(entries) {
			Object.entries(entries).forEach(([key, value]) => values.set(key, value));
		}
	});
}

/**
 * Phase 3 stub for the Settings Test probe: returns the cached or default mode without a request.
 * Phase 5 replaces this with a real probe.
 */
export async function probeStructuredOutput(
	connection: Pick<Connection, 'id' | 'kind' | 'baseUrl'>,
	cache?: StructuredOutputCache
): Promise<StructuredOutputMode> {
	return (await cache?.get(connection.id, connection.baseUrl))
		?? defaultStructuredOutputMode(connection.kind, connection.baseUrl);
}

const STRUCTURED_REJECTION = /response_format|json_schema|json_object|input_schema|tool_choice|\btools?\b|\bformat\b|\bschema\b/i;

/**
 * A 400 or 422 that names the structured-output parameter, or a Codex CLI that does not know
 * --output-schema: retry once without structured output.
 */
export function isStructuredOutputRejection(error: AiError): boolean {
	const detail = error.detail ?? '';
	if (error.status === 400 || error.status === 422) return STRUCTURED_REJECTION.test(detail);
	return error.status === undefined && error.nativeCode === 'cli-failed' && /output-schema/i.test(detail);
}
