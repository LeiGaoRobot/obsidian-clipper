import type { ReadingToken } from './contracts';
import type { TranscriptJobIdentity, TranscriptJobTask } from './job-identity';
import type { SerializedAiError } from './protocol';

// Durable transcript job records in `storage.session`. The storage area is injected so this module
// stays free of browser runtime imports; without one the store keeps records in memory, which
// lasts only as long as the service worker.

export const AI_JOB_KEY_PREFIX = 'aiJob:';
/** A job's source input, written once when it starts so a resumed job can rebuild its groups. */
export const AI_JOB_INPUT_KEY_PREFIX = 'aiJobInput:';
/** Phase 3 Reader checkpoints; removed once on gateway init, never migrated. */
export const LEGACY_CHECKPOINT_KEY_PREFIX = 'languageLearningTranscriptCheckpointV1:';
export const MAX_JOB_RECORDS = 20;
/**
 * The largest write, in JSON characters, worth evicting another job for. Chrome's
 * `storage.session` holds 10 MB (10,485,760 bytes) for all of the extension's keys together, and
 * a character of a Chinese translation or a Japanese reading takes up to 3 bytes, so a value of
 * 4M characters needs at least 40% of the area and may not fit even when it is empty. Such a
 * value that hits the quota is rejected at once instead of evicting other jobs to make room.
 */
export const MAX_JOB_RECORD_CHARS = 4_000_000;

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

/** What a job needs to rebuild its requests; segment ids are the array indexes. */
export interface AiJobStoredInput {
	instruction: string;
	segments: string[];
}

export interface StorageAreaLike {
	get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
	set(values: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
}

/**
 * A write that cannot fit in the storage quota: larger than `MAX_JOB_RECORD_CHARS`, or still over
 * the quota after evicting another record. The store then rejects every later `put` of that job
 * without writing or evicting, until the job is removed.
 */
export class AiJobUnstorableError extends Error {
	constructor() {
		super('The job record does not fit in the storage quota.');
		this.name = 'AiJobUnstorableError';
	}
}

export function isAiJobUnstorableError(error: unknown): error is AiJobUnstorableError {
	return error instanceof Error && error.name === 'AiJobUnstorableError';
}

export interface AiJobStore {
	/** Waits for this job's queued writes, then reads it. Malformed records read as undefined. */
	get(jobId: string): Promise<AiJobRecord | undefined>;
	/**
	 * Queues a whole-record write after this job's earlier writes; prunes old records. Rejects with
	 * `AiJobUnstorableError` when the record cannot fit in the quota.
	 */
	put(record: AiJobRecord): Promise<void>;
	/** Removes the record and its stored input, and forgets that the record was unstorable. */
	remove(jobId: string): Promise<void>;
	/** Queues the job's input write; it lives as long as the record and is evicted with it. */
	putInput(jobId: string, input: AiJobStoredInput): Promise<void>;
	/** Waits for this job's queued writes, then reads its input. Malformed inputs read as undefined. */
	getInput(jobId: string): Promise<AiJobStoredInput | undefined>;
	list(): Promise<AiJobRecord[]>;
	removeLegacyCheckpoints(): Promise<void>;
}

const TASKS: ReadonlySet<string> = new Set<TranscriptJobTask>(['translate', 'reading']);
const STATUSES: ReadonlySet<string> = new Set<AiJobStatus>(['running', 'completed', 'incomplete', 'failed', 'cancelled']);

export function aiJobStorageKey(jobId: string): string {
	return `${AI_JOB_KEY_PREFIX}${jobId}`;
}

export function aiJobInputStorageKey(jobId: string): string {
	return `${AI_JOB_INPUT_KEY_PREFIX}${jobId}`;
}

function isStoredInput(value: unknown): value is AiJobStoredInput {
	return isRecord(value)
		&& typeof value.instruction === 'string'
		&& Array.isArray(value.segments)
		&& value.segments.every(segment => typeof segment === 'string');
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
	// Jobs whose record did not fit even after an eviction. Records only grow while a job runs, so
	// later writes would fail the same way; they are rejected without evicting anything else.
	const unstorable = new Set<string>();

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
		if (evicted.length > 0) await removeKeys(evicted);
	};

	// Inputs first, so a record never outlives the input a resume would need.
	const removeKeys = async (jobIds: string[]) => {
		await area.remove(jobIds.map(aiJobInputStorageKey));
		await area.remove(jobIds.map(aiJobStorageKey));
	};

	// `record` writes mark their job unstorable when they cannot fit; input writes only reject.
	const write = async (jobId: string, values: Record<string, unknown>, record: boolean) => {
		if (record && unstorable.has(jobId)) throw new AiJobUnstorableError();
		try {
			await area.set(values);
		} catch (error) {
			if (!isQuotaError(error)) throw error;
			const giveUp = () => {
				if (record) unstorable.add(jobId);
				return new AiJobUnstorableError();
			};
			// Evicting cannot make room for a value this large; keep the other jobs instead.
			if (JSON.stringify(values).length > MAX_JOB_RECORD_CHARS) throw giveUp();
			const oldest = evictionOrder(await list(), jobId).find(candidate => candidate.status !== 'running');
			if (!oldest) throw error;
			written.delete(oldest.id);
			await area.remove(aiJobInputStorageKey(oldest.id));
			await area.remove(aiJobStorageKey(oldest.id));
			try {
				await area.set(values);
			} catch (retryError) {
				throw isQuotaError(retryError) ? giveUp() : retryError;
			}
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
				await write(record.id, { [aiJobStorageKey(record.id)]: record }, true);
				if (written.has(record.id)) return;
				written.add(record.id);
				// Best effort: the record itself is stored, and the next new job prunes again.
				await prune(record.id).catch(() => undefined);
			});
		},
		remove(jobId) {
			return enqueue(jobId, async () => {
				written.delete(jobId);
				unstorable.delete(jobId);
				await removeKeys([jobId]);
			});
		},
		putInput(jobId, input) {
			const copy: AiJobStoredInput = { instruction: input.instruction, segments: [...input.segments] };
			return enqueue(jobId, () => write(jobId, { [aiJobInputStorageKey(jobId)]: copy }, false));
		},
		async getInput(jobId) {
			await queues.get(jobId);
			const value = (await area.get(aiJobInputStorageKey(jobId)))[aiJobInputStorageKey(jobId)];
			return isStoredInput(value) ? value : undefined;
		},
		list,
		async removeLegacyCheckpoints() {
			const keys = Object.keys(await area.get(null)).filter(key => key.startsWith(LEGACY_CHECKPOINT_KEY_PREFIX));
			if (keys.length > 0) await area.remove(keys);
		}
	};
}
