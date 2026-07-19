import browser from './browser-polyfill';

export const TRANSCRIPT_CHECKPOINT_STORAGE_PREFIX = 'languageLearningTranscriptCheckpointV1:';
const MAX_CHECKPOINTS = 20;

interface StoredTranscriptCheckpoint {
	id: string;
	namespace: string;
	scope: string;
	segments: string[];
	value: unknown;
	updatedAt: number;
}

interface StorageAreaLike {
	get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
	set(values: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
}

const memoryCheckpoints = new Map<string, StoredTranscriptCheckpoint>();

function getSessionStorage(): StorageAreaLike | undefined {
	const direct = (browser.storage as unknown as { session?: StorageAreaLike }).session;
	if (typeof location === 'undefined' || !browser.runtime?.getURL) return direct;
	try {
		const extensionOrigin = new URL(browser.runtime.getURL('')).origin;
		if (location.origin === extensionOrigin) return direct;
	} catch {
		return direct;
	}
	if (!browser.runtime?.sendMessage) return direct;
	return {
		async get(keys) {
			const response = await browser.runtime.sendMessage({
				action: 'transcriptCheckpointStorage',
				operation: 'get',
				keys: keys ?? null
			}) as { success?: boolean; values?: Record<string, unknown> };
			if (!response?.success || !response.values) throw new Error('Session checkpoint storage is unavailable.');
			return response.values;
		},
		async set(values) {
			const response = await browser.runtime.sendMessage({
				action: 'transcriptCheckpointStorage',
				operation: 'set',
				values
			}) as { success?: boolean };
			if (!response?.success) throw new Error('Session checkpoint storage is unavailable.');
		},
		async remove(keys) {
			const response = await browser.runtime.sendMessage({
				action: 'transcriptCheckpointStorage',
				operation: 'remove',
				keys
			}) as { success?: boolean };
			if (!response?.success) throw new Error('Session checkpoint storage is unavailable.');
		}
	};
}

function hashText(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function checkpointId(namespace: string, scope: string, segments: string[]): string {
	return `${namespace}:${hashText(JSON.stringify([scope, segments]))}`;
}

function checkpointStorageKey(id: string): string {
	return `${TRANSCRIPT_CHECKPOINT_STORAGE_PREFIX}${id}`;
}

function isStoredCheckpoint(value: unknown): value is StoredTranscriptCheckpoint {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<StoredTranscriptCheckpoint>;
	return typeof candidate.id === 'string'
		&& typeof candidate.namespace === 'string'
		&& typeof candidate.scope === 'string'
		&& Array.isArray(candidate.segments)
		&& candidate.segments.every(segment => typeof segment === 'string')
		&& typeof candidate.updatedAt === 'number';
}

function sameCheckpoint(
	entry: StoredTranscriptCheckpoint,
	namespace: string,
	scope: string,
	segments: string[]
): boolean {
	return entry.namespace === namespace
		&& entry.scope === scope
		&& entry.segments.length === segments.length
		&& entry.segments.every((segment, index) => segment === segments[index]);
}

function overlapsSegments(entry: StoredTranscriptCheckpoint, segments: string[]): boolean {
	const targetSegments = new Set(segments);
	return entry.segments.some(segment => targetSegments.has(segment));
}

function pruneMemoryCheckpoints(): void {
	const entries = Array.from(memoryCheckpoints.entries())
		.sort(([, left], [, right]) => right.updatedAt - left.updatedAt);
	entries.slice(MAX_CHECKPOINTS).forEach(([key]) => memoryCheckpoints.delete(key));
}

async function pruneStoredCheckpoints(storage: StorageAreaLike): Promise<void> {
	const values = await storage.get(null);
	const entries = Object.entries(values)
		.filter(([key, value]) => key.startsWith(TRANSCRIPT_CHECKPOINT_STORAGE_PREFIX) && isStoredCheckpoint(value))
		.sort(([, left], [, right]) => (
			(right as StoredTranscriptCheckpoint).updatedAt - (left as StoredTranscriptCheckpoint).updatedAt
		));
	const excessKeys = entries.slice(MAX_CHECKPOINTS).map(([key]) => key);
	if (excessKeys.length > 0) await storage.remove(excessKeys);
}

export interface SessionTranscriptCheckpointStore<T> {
	load(segments: string[]): Promise<T | undefined>;
	save(segments: string[], value: T): Promise<void>;
	clear(segments: string[]): Promise<void>;
}

export function createSessionTranscriptCheckpointStore<T>(
	namespace: string,
	scope: string,
	clone: (value: T) => T
): SessionTranscriptCheckpointStore<T> {
	return {
		async load(segments) {
			const id = checkpointId(namespace, scope, segments);
			const key = checkpointStorageKey(id);
			const storage = getSessionStorage();
			if (storage) {
				try {
					const stored = (await storage.get(key))[key];
					if (isStoredCheckpoint(stored) && sameCheckpoint(stored, namespace, scope, segments)) {
						return clone(stored.value as T);
					}
					return undefined;
				} catch {
					// Session storage is not available in every browser target.
				}
			}
			const memoryEntry = memoryCheckpoints.get(key);
			return memoryEntry && sameCheckpoint(memoryEntry, namespace, scope, segments)
				? clone(memoryEntry.value as T)
				: undefined;
		},
		async save(segments, value) {
			const id = checkpointId(namespace, scope, segments);
			const key = checkpointStorageKey(id);
			const entry: StoredTranscriptCheckpoint = {
				id,
				namespace,
				scope,
				segments: [...segments],
				value: clone(value),
				updatedAt: Date.now()
			};
			const storage = getSessionStorage();
			if (storage) {
				try {
					await storage.set({ [key]: entry });
					await pruneStoredCheckpoints(storage);
					memoryCheckpoints.delete(key);
					return;
				} catch {
					// Fall through to the per-page memory checkpoint.
				}
			}
			memoryCheckpoints.set(key, entry);
			pruneMemoryCheckpoints();
		},
		async clear(segments) {
			const memoryKeys = Array.from(memoryCheckpoints.entries())
				.filter(([, entry]) => (
					entry.namespace === namespace
					&& entry.scope === scope
					&& overlapsSegments(entry, segments)
				))
				.map(([key]) => key);
			memoryKeys.forEach(key => memoryCheckpoints.delete(key));
			const storage = getSessionStorage();
			if (!storage) return;
			try {
				const values = await storage.get(null);
				const storageKeys = Object.entries(values)
					.filter(([key, value]) => (
						key.startsWith(TRANSCRIPT_CHECKPOINT_STORAGE_PREFIX)
						&& isStoredCheckpoint(value)
						&& value.namespace === namespace
						&& value.scope === scope
						&& overlapsSegments(value, segments)
					))
					.map(([key]) => key);
				if (storageKeys.length > 0) await storage.remove(storageKeys);
			} catch {
				// Clearing the in-memory fallback is still safe and deterministic.
			}
		}
	};
}
