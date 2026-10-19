import { AI_ERROR_CODES, type AiErrorCode } from './errors';
import type { StorageAreaLike } from './job-store';
import { AI_DIAGNOSTICS_KEY } from './settings';
import { AI_TASKS, type AiDiagnosticEntry, type ConnectionKind } from './types';

// The redacted Diagnostics log (decision 12): a ring buffer of the last model runs and Tests in
// `storage.session`, shown under Settings → AI → Diagnostics. Entries are built from a fixed field
// list, so a prompt, content, key, or job id can never reach storage. DOM-free; the session area
// is injected and falls back to memory.

export const MAX_DIAGNOSTIC_ENTRIES = 100;

export interface StoredDiagnostics {
	v: 1;
	entries: AiDiagnosticEntry[];
}

export interface AiDiagnostics {
	/** Appends one entry, dropping the oldest past `MAX_DIAGNOSTIC_ENTRIES`. Never rejects. */
	record(entry: AiDiagnosticEntry): Promise<void>;
	/** Oldest first. */
	list(): Promise<AiDiagnosticEntry[]>;
	clear(): Promise<void>;
}

const KINDS: ReadonlySet<string> = new Set<ConnectionKind>([
	'openai-compatible', 'azure-openai', 'anthropic', 'ollama', 'huggingface', 'perplexity', 'cli-codex', 'cli-grok'
]);
const TASKS: ReadonlySet<string> = new Set<string>([...AI_TASKS, 'test']);
const OUTCOMES: ReadonlySet<string> = new Set(['ok', 'error', 'cancelled']);
const MODES: ReadonlySet<string> = new Set(['json_schema', 'json_object', 'none']);

function count(value: unknown): number | undefined {
	return Number.isInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A copy holding only the entry's own fields, or undefined when a required field is invalid. */
export function sanitizeDiagnosticEntry(value: unknown): AiDiagnosticEntry | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const raw = value as Record<string, unknown>;
	const at = finite(raw.at);
	const durationMs = finite(raw.durationMs);
	if (at === undefined || durationMs === undefined) return undefined;
	if (!TASKS.has(raw.task as string) || !KINDS.has(raw.kind as string) || !OUTCOMES.has(raw.outcome as string)) return undefined;
	if (typeof raw.connectionId !== 'string' || !raw.connectionId || raw.connectionId.length > 200) return undefined;
	const code = (AI_ERROR_CODES as readonly string[]).includes(raw.code as string) ? raw.code as AiErrorCode : undefined;
	const status = count(raw.status);
	const groups = count(raw.groups);
	const retries = count(raw.retries);
	return {
		at,
		task: raw.task as AiDiagnosticEntry['task'],
		kind: raw.kind as ConnectionKind,
		connectionId: raw.connectionId,
		durationMs: Math.round(durationMs),
		outcome: raw.outcome as AiDiagnosticEntry['outcome'],
		...(code ? { code } : {}),
		...(status !== undefined && status > 0 ? { status } : {}),
		...(MODES.has(raw.structuredMode as string) ? { structuredMode: raw.structuredMode as AiDiagnosticEntry['structuredMode'] } : {}),
		...(raw.fallback === true ? { fallback: true as const } : {}),
		...(groups !== undefined ? { groups } : {}),
		...(retries !== undefined ? { retries } : {})
	};
}

/** The stored log, oldest first; invalid entries are dropped. */
export function decodeDiagnostics(value: unknown): AiDiagnosticEntry[] {
	const entries = value && typeof value === 'object' ? (value as { entries?: unknown }).entries : undefined;
	if (!Array.isArray(entries)) return [];
	return entries
		.map(sanitizeDiagnosticEntry)
		.filter((entry): entry is AiDiagnosticEntry => entry !== undefined)
		.slice(-MAX_DIAGNOSTIC_ENTRIES);
}

export function createAiDiagnostics(session?: StorageAreaLike): AiDiagnostics {
	let memory: AiDiagnosticEntry[] = [];
	// After a failed session write the log continues in memory for the rest of this worker.
	let area = session;
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = queue.then(operation);
		queue = result.catch(() => undefined);
		return result;
	};
	const read = async (): Promise<AiDiagnosticEntry[]> => {
		if (!area) return [...memory];
		try {
			return decodeDiagnostics((await area.get(AI_DIAGNOSTICS_KEY))[AI_DIAGNOSTICS_KEY]);
		} catch {
			return [...memory];
		}
	};
	const write = async (entries: AiDiagnosticEntry[]) => {
		memory = entries;
		if (!area) return;
		try {
			await area.set({ [AI_DIAGNOSTICS_KEY]: { v: 1, entries } satisfies StoredDiagnostics });
		} catch {
			area = undefined;
		}
	};
	return {
		record(entry) {
			const clean = sanitizeDiagnosticEntry(entry);
			if (!clean) return Promise.resolve();
			return serial(async () => {
				const entries = await read();
				entries.push(clean);
				await write(entries.slice(-MAX_DIAGNOSTIC_ENTRIES));
			}).catch(() => undefined);
		},
		list() {
			return serial(read);
		},
		clear() {
			return serial(async () => {
				memory = [];
				await area?.remove(AI_DIAGNOSTICS_KEY).catch(() => undefined);
			});
		}
	};
}
