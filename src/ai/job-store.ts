import type { ReadingToken } from './contracts';
import type { TranscriptJobIdentity, TranscriptJobTask } from './job-identity';
import type { SerializedAiError } from './protocol';

// Durable transcript job records in `storage.session`. The storage area is injected so this module
// stays free of browser runtime imports; without one the store keeps records in memory, which
// lasts only as long as the service worker.

export const AI_JOB_KEY_PREFIX = 'aiJob:';
/** Phase 3 Reader checkpoints; removed once on gateway init, never migrated. */
export const LEGACY_CHECKPOINT_KEY_PREFIX = 'languageLearningTranscriptCheckpointV1:';
export const MAX_JOB_RECORDS = 20;

export type AiJobStatus = 'running' | 'completed' | 'incomplete' | 'failed' | 'cancelled';

export interface AiJobAttempts {
	requests: number;
	retries: number;
	splits: number;
}

export interface AiJobRecord {
	v: 1;
	id: string;
	task: TranscriptJobTask;
	identity: TranscriptJobIdentity;
	segmentCount: number;
	segmentHash: string;
	profileId?: string;
	status: AiJobStatus;
	/** Accepted items by segment id. */
	results: Record<string, string | ReadingToken[]>;
	attempts: AiJobAttempts;
	/** The current CLI group budget after timeout splits. */
	cliPromptChars?: number;
	error?: SerializedAiError;
	createdAt: number;
	updatedAt: number;
}

export interface StorageAreaLike {
	get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
	set(values: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
}

export interface AiJobStore {
	/** Waits for this job's queued writes, then reads it. Malformed records read as undefined. */
	get(jobId: string): Promise<AiJobRecord | undefined>;
	/** Queues a whole-record write after this job's earlier writes; prunes old records. */
	put(record: AiJobRecord): Promise<void>;
	remove(jobId: string): Promise<void>;
	list(): Promise<AiJobRecord[]>;
	removeLegacyCheckpoints(): Promise<void>;
}

const TASKS: ReadonlySet<string> = new Set<TranscriptJobTask>(['translate', 'reading']);
const STATUSES: ReadonlySet<string> = new Set<AiJobStatus>(['running', 'completed', 'incomplete', 'failed', 'cancelled']);

export function aiJobStorageKey(jobId: string): string {
	return `${AI_JOB_KEY_PREFIX}${jobId}`;
}

function isCount(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isAiJobRecord(value: unknown): value is AiJobRecord {
	if (!isRecord(value)) return false;
	const { identity, attempts, results } = value;
	return value.v === 1
		&& typeof value.id === 'string'
		&& TASKS.has(value.task as string)
		&& STATUSES.has(value.status as string)
		&& isRecord(identity) && typeof identity.namespace === 'string' && typeof identity.scope === 'string'
		&& isCount(value.segmentCount)
		&& typeof value.segmentHash === 'string'
		&& isRecord(results)
		&& isRecord(attempts) && isCount(attempts.requests) && isCount(attempts.retries) && isCount(attempts.splits)
		&& typeof value.createdAt === 'number'
		&& typeof value.updatedAt === 'number';
}

function isQuotaError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === 'QuotaExceededError' || /quota/i.test(error.message);
}

function createMemoryArea(): StorageAreaLike {
	const values = new Map<string, unknown>();
	// Clone like the real storage areas, so a caller mutating its record cannot reach the stored copy.
	const clone = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
	return {
		async get(keys) {
			const wanted = keys === undefined || keys === null
				? Array.from(values.keys())
				: (Array.isArray(keys) ? keys : [keys]).filter(key => values.has(key));
			return Object.fromEntries(wanted.map(key => [key, clone(values.get(key))]));
		},
		async set(entries) {
			Object.entries(entries).forEach(([key, value]) => values.set(key, clone(value)));
		},
		async remove(keys) {
			(Array.isArray(keys) ? keys : [keys]).forEach(key => values.delete(key));
		}
	};
}

export function createAiJobStore(area: StorageAreaLike = createMemoryArea()): AiJobStore {
	const queues = new Map<string, Promise<void>>();
	// Ids written by this store instance. The number of records grows only on a first write,
	// so pruning runs then instead of reading every record on each checkpoint.
	const written = new Set<string>();

	const enqueue = (jobId: string, write: () => Promise<void>): Promise<void> => {
		const result = (queues.get(jobId) ?? Promise.resolve()).then(write);
		const tail = result.catch(() => undefined);
		queues.set(jobId, tail);
		void tail.then(() => {
			if (queues.get(jobId) === tail) queues.delete(jobId);
		});
		return result;
	};

	const list = async (): Promise<AiJobRecord[]> => {
		const values = await area.get(null);
		return Object.entries(values)
			.filter(([key, value]) => key.startsWith(AI_JOB_KEY_PREFIX) && isAiJobRecord(value))
			.map(([, value]) => value as AiJobRecord);
	};

	// Oldest first: non-running records, then running ones, which only go when more than the limit run.
	const evictionOrder = (records: AiJobRecord[], keepId: string): AiJobRecord[] => {
		const candidates = records.filter(record => record.id !== keepId);
		const byAge = (left: AiJobRecord, right: AiJobRecord) => left.updatedAt - right.updatedAt;
		return [
			...candidates.filter(record => record.status !== 'running').sort(byAge),
			...candidates.filter(record => record.status === 'running').sort(byAge)
		];
	};

	const prune = async (keepId: string) => {
		const records = await list();
		const excess = records.length - MAX_JOB_RECORDS;
		if (excess <= 0) return;
		const evicted = evictionOrder(records, keepId).slice(0, excess).map(record => record.id);
		evicted.forEach(id => written.delete(id));
		if (evicted.length > 0) await area.remove(evicted.map(aiJobStorageKey));
	};

	const write = async (record: AiJobRecord) => {
		const values = { [aiJobStorageKey(record.id)]: record };
		try {
			await area.set(values);
		} catch (error) {
			if (!isQuotaError(error)) throw error;
			const oldest = evictionOrder(await list(), record.id).find(candidate => candidate.status !== 'running');
			if (!oldest) throw error;
			written.delete(oldest.id);
			await area.remove(aiJobStorageKey(oldest.id));
			await area.set(values);
		}
	};

	return {
		async get(jobId) {
			await queues.get(jobId);
			const value = (await area.get(aiJobStorageKey(jobId)))[aiJobStorageKey(jobId)];
			return isAiJobRecord(value) && value.id === jobId ? value : undefined;
		},
		put(record) {
			return enqueue(record.id, async () => {
				await write(record);
				if (written.has(record.id)) return;
				written.add(record.id);
				// Best effort: the record itself is stored, and the next new job prunes again.
				await prune(record.id).catch(() => undefined);
			});
		},
		remove(jobId) {
			return enqueue(jobId, async () => {
				written.delete(jobId);
				await area.remove(aiJobStorageKey(jobId));
			});
		},
		list,
		async removeLegacyCheckpoints() {
			const keys = Object.keys(await area.get(null)).filter(key => key.startsWith(LEGACY_CHECKPOINT_KEY_PREFIX));
			if (keys.length > 0) await area.remove(keys);
		}
	};
}
