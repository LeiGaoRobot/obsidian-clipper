import type { AiTaskInput, AiTaskOutput, ReadingToken, TranscriptSegment } from './contracts';
import { isCliKind } from './connection-kind';
import { AiError, RETRYABLE_PROVIDER_STATUSES, toAiError } from './errors';
import { hashSegments, type TranscriptJobTask } from './job-identity';
import {
	CLI_GROUP_BUDGET_FLOORS,
	isEmptySourceSegment,
	maxConcurrencyFor,
	TRANSCRIPT_GROUP_BUDGETS,
	transcriptGroupBudget
} from './job-limits';
import { isAiJobUnstorableError, type AiJobRecord, type AiJobStatus, type AiJobStore, type AiJobStoredInput } from './job-store';
import {
	serializeAiError,
	type AiJobInput,
	type AiJobProgressMessage,
	type AiJobRetryMessage,
	type AiJobStateMessage,
	type JobResultItem
} from './protocol';
import type { AiDiagnosticEntry, ConnectionKind } from './types';

// Durable transcript jobs: one job runs a whole transcript task as groups in a bounded pool,
// checkpoints every finished group through serialized store writes, retries rate limits and
// transient provider errors, splits CLI groups on timeout, and resumes `running` records after
// the service worker restarts. Pure: storage, model calls, clock, randomness, and timers are
// injected, so the module is DOM-free and safe in an MV3 service worker.

// ---------------------------------------------------------------------------------------------
// Policy (group budgets, budget floors, and concurrency defaults are in job-limits.ts)

/** CLI timeout splits per run. */
export const MAX_SPLITS = 3;
/** Retries of one group. */
export const MAX_GROUP_RETRIES = 2;
/** The upper bound of `jobRetryBudget`. */
export const MAX_JOB_RETRIES = 8;
export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_MAX_BACKOFF_MS = 30_000;
/** A `Retry-After` longer than this is not waited out; the job fails with that error. */
export const RETRY_AFTER_MAX_MS = 60_000;
/** On gateway init, `running` records updated within this window resume; older ones end `incomplete`. */
export const RESUME_WINDOW_MS = 10 * 60_000;
/** How often a running job refreshes its record's `updatedAt`. */
export const JOB_HEARTBEAT_MS = 20_000;

/** Retries a run may spend across all its groups: `min(8, 2 + floor(groups / 2))`. */
export function jobRetryBudget(groups: number): number {
	return Math.min(MAX_JOB_RETRIES, 2 + Math.floor(groups / 2));
}

export interface JobConnection {
	kind: ConnectionKind;
	/** The connection's id, for the Diagnostics entry. */
	id?: string;
	/** `Connection.maxConcurrency`; defaults apply when absent or not a positive integer. */
	maxConcurrency?: number;
}

/** `rate-limited` (never `quota`), and `provider-error` with a transient status. */
export function isRetryableGroupError(error: AiError): boolean {
	if (error.code === 'rate-limited') return true;
	return error.code === 'provider-error' && error.status !== undefined && RETRYABLE_PROVIDER_STATUSES.includes(error.status);
}

/**
 * The backoff before retry `attempt` (1-based): `min(30 s, 1 s × 2^(attempt-1)) × (0.5 + random())`,
 * never shorter than the provider's `Retry-After`.
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | undefined, random: () => number): number {
	const backoff = Math.min(RETRY_MAX_BACKOFF_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)) * (0.5 + random());
	return Math.round(Math.max(retryAfterMs ?? 0, backoff));
}

export interface TranscriptPromptGroup {
	segments: TranscriptSegment[];
	sourceChars: number;
}

// Groups segments under a prompt-size budget. Each segment keeps its source index as a stable
// id and stays atomic, so one oversized segment may exceed the budget on its own.
export function buildTranscriptPromptGroups(
	segments: string[],
	instruction: string,
	maxPromptChars: number = TRANSCRIPT_GROUP_BUDGETS.api.translate,
	includeSegment: (index: number) => boolean = () => true
): TranscriptPromptGroup[] {
	const promptGroups: TranscriptPromptGroup[] = [];
	let current: TranscriptSegment[] = [];
	let currentSourceChars = 0;
	let currentLength = instruction.length;
	segments.forEach((text, id) => {
		if (!includeSegment(id)) return;
		const segment = { id, text };
		const length = JSON.stringify(segment).length + 1;
		if (current.length > 0 && currentLength + length > maxPromptChars) {
			promptGroups.push({ segments: current, sourceChars: currentSourceChars });
			current = [];
			currentSourceChars = 0;
			currentLength = instruction.length;
		}
		current.push(segment);
		currentSourceChars += text.length;
		currentLength += length;
	});
	if (current.length > 0) promptGroups.push({ segments: current, sourceChars: currentSourceChars });
	return promptGroups;
}

/** Each item adds a small JSON wrapper around its translation. */
export function translationMaxTokens(group: TranscriptPromptGroup): number {
	return Math.min(8000, Math.max(1600, Math.ceil(group.sourceChars * 1.2 + group.segments.length * 15)));
}

/** Token objects cost more output than the source text they annotate. */
export function readingMaxTokens(group: TranscriptPromptGroup): number {
	return Math.min(16000, Math.max(2000, Math.ceil(group.sourceChars * 5)));
}

export function transcriptGroupMaxTokens(task: TranscriptJobTask, group: TranscriptPromptGroup): number {
	return task === 'translate' ? translationMaxTokens(group) : readingMaxTokens(group);
}

// ---------------------------------------------------------------------------------------------
// Runner

export interface JobExecuteResult<T extends TranscriptJobTask = TranscriptJobTask> {
	/** Already validated by the task contract; the runner still accepts only requested ids. */
	output: AiTaskOutput<T>;
	connectionKind: ConnectionKind;
}

export interface JobRunnerDeps {
	store: AiJobStore;
	/**
	 * The connection the next request of this task and profile would use. Called before the first
	 * plan and before each dispatch, so a settings change applies at the next group. Rejects with an
	 * AiError (e.g. `not-configured`), which fails the job.
	 */
	resolveConnection(task: TranscriptJobTask, profileId: string | undefined): Promise<JobConnection>;
	/** One group request through the gateway's execute path; re-reads settings on each call. */
	execute<T extends TranscriptJobTask>(
		task: T,
		input: AiTaskInput<T>,
		options: { profileId?: string; signal: AbortSignal }
	): Promise<JobExecuteResult<T>>;
	now?: () => number;
	random?: () => number;
	setTimeout?: (callback: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
	heartbeatMs?: number;
	/**
	 * Receives one redacted entry per run that leaves `running`, with its group and retry counts;
	 * never one per group. Not called when no connection was ever resolved.
	 */
	recordDiagnostics?: (entry: AiDiagnosticEntry) => void;
}

export type JobRunnerEvent = AiJobStateMessage | AiJobProgressMessage | AiJobRetryMessage;
export type JobListener = (event: JobRunnerEvent) => void;
/** Stops a listener from receiving further events of a job. */
export type JobDetach = () => void;

export interface JobRunner {
	/**
	 * Starts a job from a user's `start-job`. `input` is sanitized and `jobId` already verified
	 * against it. When the job is running, attaches instead; when a record of the same transcript
	 * exists, reuses its results and plans only the missing ids. The listener receives a `job-state`
	 * snapshot, then `job-progress` / `job-retry`, then a final `job-state`.
	 */
	start(
		jobId: string,
		task: TranscriptJobTask,
		input: AiJobInput,
		profileId: string | undefined,
		listener: JobListener
	): Promise<JobDetach>;
	/**
	 * Attaches to a job: a live job sends its snapshot and later events; a `running` record with no
	 * live job resumes first; any other record sends its final `job-state` once. Undefined when no
	 * record exists.
	 */
	attach(jobId: string, listener: JobListener): Promise<JobDetach | undefined>;
	/** Cancels a live job or a `running` record. True when something was cancelled. */
	cancel(jobId: string): Promise<boolean>;
	/** Resumes a `running` record with no live job. Idempotent; true when the job is live afterwards. */
	resume(jobId: string): Promise<boolean>;
	/** Gateway init: resumes recent `running` records, marks older ones `incomplete`. */
	resumeRunning(): Promise<{ resumed: string[]; expired: string[] }>;
	/** A full snapshot of a live job or a stored record. */
	get(jobId: string): Promise<AiJobStateMessage | undefined>;
	/** True while a job runs in this worker. */
	isActive(jobId: string): boolean;
}

interface GroupOutcome {
	ok: boolean;
	items: JobResultItem[];
}

interface Job {
	id: string;
	task: TranscriptJobTask;
	record: AiJobRecord;
	input: AiJobStoredInput;
	emptyIds: Set<number>;
	/** Ids whose results listeners have seen: earlier results, empty sources, and emitted groups. */
	emitted: Set<number>;
	listeners: Set<JobListener>;
	/** Aborts in-flight requests and backoff; only cancel uses it. */
	cancelController: AbortController;
	/** Aborts backoff after a fatal error, without touching in-flight requests. */
	stopController: AbortController;
	cancelled: boolean;
	finished: boolean;
	fatal?: AiError;
	replan: boolean;
	completedGroups: number;
	totalGroups: number;
	retriesThisRun: number;
	retryBudget: number;
	/** The latest checkpoint; the store applies a job's writes in call order. */
	writes: Promise<void>;
	/** False once the store rejected the record as unstorable: no further checkpoints are sent. */
	durable: boolean;
	/** One warning per job when a checkpoint is rejected. */
	warned: boolean;
	/** Set when the job starts to settle; the job keeps its id until the final write lands. */
	settling?: Promise<void>;
	heartbeat?: unknown;
	/** When this run launched, for the Diagnostics duration. */
	startedAt: number;
	/** The connection last resolved for this run. */
	connection?: JobConnection;
}

const NOT_OK: GroupOutcome = { ok: false, items: [] };

function cloneRecord(record: AiJobRecord): AiJobRecord {
	return { ...record, results: { ...record.results }, attempts: { ...record.attempts } };
}

function resultItem(task: TranscriptJobTask, id: number, value: string | ReadingToken[]): JobResultItem {
	return task === 'translate' ? { id, text: value as string } : { id, tokens: value as ReadingToken[] };
}

function resultItems(task: TranscriptJobTask, results: AiJobRecord['results'], ids?: Set<number>): JobResultItem[] {
	return Object.keys(results)
		.map(Number)
		.filter(id => !ids || ids.has(id))
		.sort((left, right) => left - right)
		.map(id => resultItem(task, id, results[id]));
}

function emptyIdsOf(task: TranscriptJobTask, segments: readonly string[]): Set<number> {
	const ids = new Set<number>();
	segments.forEach((text, id) => {
		if (isEmptySourceSegment(task, text)) ids.add(id);
	});
	return ids;
}

function countComplete(record: AiJobRecord, emptyIds: Set<number>): number {
	let count = emptyIds.size;
	for (const key of Object.keys(record.results)) {
		if (!emptyIds.has(Number(key))) count += 1;
	}
	return count;
}

function inputMatches(record: AiJobRecord, input: AiJobStoredInput): boolean {
	return input.segments.length === record.segmentCount
		&& hashSegments(record.identity.scope, input.segments) === record.segmentHash;
}

function sleep(
	ms: number,
	signals: AbortSignal[],
	setTimer: (callback: () => void, ms: number) => unknown,
	clearTimer: (handle: unknown) => void
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signals.some(signal => signal.aborted)) {
			reject(new AiError('cancelled'));
			return;
		}
		const cleanup = () => signals.forEach(signal => signal.removeEventListener('abort', onAbort));
		const onAbort = () => {
			clearTimer(handle);
			cleanup();
			reject(new AiError('cancelled'));
		};
		const handle = setTimer(() => {
			cleanup();
			resolve();
		}, ms);
		signals.forEach(signal => signal.addEventListener('abort', onAbort, { once: true }));
	});
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
	const { store } = deps;
	const now = deps.now ?? (() => Date.now());
	const random = deps.random ?? Math.random;
	const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms));
	const clearTimer = deps.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
	const heartbeatMs = deps.heartbeatMs ?? JOB_HEARTBEAT_MS;

	const jobs = new Map<string, Job>();
	// One pending start or resume per job id, so init, attach, and start-job never run a job twice.
	const locks = new Map<string, Promise<Job | undefined>>();

	const emit = (job: Job, event: JobRunnerEvent) => {
		if (job.cancelled || job.finished) return;
		for (const listener of Array.from(job.listeners)) {
			try {
				listener(event);
			} catch {
				// A failing listener (a closed Port) must not stop the job.
			}
		}
	};

	const checkpoint = (job: Job) => {
		job.record.updatedAt = now();
		if (!job.durable) return;
		// Queued in the store at once, so a later read of this id waits for it; the store applies a
		// job's writes in call order. A failed write loses durability, not the job: the next
		// checkpoint carries every result again, unless the record can never fit.
		job.writes = store.put(cloneRecord(job.record)).catch(error => {
			if (isAiJobUnstorableError(error)) job.durable = false;
			if (job.warned) return;
			job.warned = true;
			console.warn(`[ai] A transcript ${job.task} job checkpoint was not saved${job.durable ? '' : '; the job continues without saving progress'}.`);
		});
	};

	const snapshot = (job: Job, full: boolean): AiJobStateMessage => {
		const { record } = job;
		const complete = full ? countComplete(record, job.emptyIds) : job.emitted.size;
		return {
			type: 'job-state',
			jobId: job.id,
			status: record.status,
			completedGroups: job.completedGroups,
			totalGroups: job.totalGroups,
			completedSegments: complete,
			totalSegments: record.segmentCount,
			results: resultItems(job.task, record.results, full ? undefined : job.emitted),
			attempts: { ...record.attempts },
			...(record.error ? { error: record.error } : {})
		};
	};

	const recordSnapshot = (record: AiJobRecord, input: AiJobStoredInput | undefined): AiJobStateMessage => {
		const emptyIds = input && inputMatches(record, input) ? emptyIdsOf(record.task, input.segments) : new Set<number>();
		return {
			type: 'job-state',
			jobId: record.id,
			status: record.status,
			completedGroups: 0,
			totalGroups: 0,
			completedSegments: countComplete(record, emptyIds),
			totalSegments: record.segmentCount,
			results: resultItems(record.task, record.results),
			attempts: { ...record.attempts },
			...(record.error ? { error: record.error } : {})
		};
	};

	const isComplete = (job: Job) => countComplete(job.record, job.emptyIds) === job.record.segmentCount;
	const stopped = (job: Job) => job.cancelled || job.fatal !== undefined;

	const fail = (job: Job, error: AiError) => {
		if (job.fatal) return;
		job.fatal = error;
		job.stopController.abort();
	};

	const stopHeartbeat = (job: Job) => {
		if (job.heartbeat !== undefined) clearTimer(job.heartbeat);
		job.heartbeat = undefined;
	};

	const startHeartbeat = (job: Job) => {
		const beat = () => {
			job.heartbeat = setTimer(() => {
				if (job.cancelled || job.finished || !job.durable) return;
				checkpoint(job);
				beat();
			}, heartbeatMs);
		};
		beat();
	};

	const recordDiagnostics = (job: Job, status: Exclude<AiJobStatus, 'running'>, error?: AiError) => {
		const connection = job.connection;
		if (!deps.recordDiagnostics || !connection?.id) return;
		try {
			deps.recordDiagnostics({
				at: now(),
				task: job.task,
				kind: connection.kind,
				connectionId: connection.id,
				durationMs: Math.max(0, now() - job.startedAt),
				outcome: status === 'completed' ? 'ok' : status === 'cancelled' ? 'cancelled' : 'error',
				...(status !== 'completed' && error ? { code: error.code } : {}),
				...(status !== 'completed' && error?.status !== undefined ? { status: error.status } : {}),
				groups: job.totalGroups,
				retries: job.retriesThisRun
			});
		} catch {
			// Diagnostics never change a job's outcome.
		}
	};

	// The job keeps its id until its final write lands, so a start, attach, or cancel of the same id
	// waits for `settling` and then reads the final record instead of a stale one.
	const settle = (job: Job, status: Exclude<AiJobStatus, 'running'>, error?: AiError): Promise<void> => {
		if (job.settling) return job.settling;
		stopHeartbeat(job);
		job.record.status = status;
		if (error) job.record.error = serializeAiError(error);
		else delete job.record.error;
		checkpoint(job);
		recordDiagnostics(job, status, error);
		job.settling = (async () => {
			await job.writes;
			// The stored record is an older `running` one; left behind, an attach would resume it.
			if (!job.durable) await store.remove(job.id).catch(() => undefined);
			const listeners = Array.from(job.listeners);
			const final = snapshot(job, true);
			job.finished = true;
			job.listeners.clear();
			if (jobs.get(job.id) === job) jobs.delete(job.id);
			for (const listener of listeners) {
				try {
					listener(final);
				} catch {
					// Ignored as in emit.
				}
			}
		})();
		return job.settling;
	};

	const missingLateResults = (
		record: AiJobRecord,
		accepted: Array<[number, string | ReadingToken[]]>
	): Array<[number, string | ReadingToken[]]> => accepted.filter(([id]) => (
		Number.isInteger(id) && id >= 0 && id < record.segmentCount && !(id in record.results)
	));

	// With no live job of the id, the late result goes into the stored record as it is now: a newer
	// job may have completed it, and a removed record stays removed.
	const keepStoredLateResults = async (jobId: string, accepted: Array<[number, string | ReadingToken[]]>) => {
		for (;;) {
			const pending = locks.get(jobId);
			if (pending) await pending.catch(() => undefined);
			const live = jobs.get(jobId);
			if (live && !live.settling) {
				addLateResults(live, accepted, true);
				return;
			}
			if (live) {
				await live.settling;
				continue;
			}
			const stored = await store.get(jobId);
			// A job started meanwhile owns the record; hand the result to it.
			if (jobs.has(jobId) || locks.has(jobId)) continue;
			if (!stored || stored.status === 'completed') return;
			const missing = missingLateResults(stored, accepted);
			if (missing.length === 0) return;
			const next = cloneRecord(stored);
			for (const [id, value] of missing) next.results[id] = value;
			next.updatedAt = now();
			await store.put(next).catch(() => undefined);
			return;
		}
	};

	// Adds the missing ids to a job's record. A newer job reports them, because its own group for
	// these ids will skip them; a cancelled job reports nothing.
	const addLateResults = (target: Job, accepted: Array<[number, string | ReadingToken[]]>, report: boolean) => {
		const missing = missingLateResults(target.record, accepted).filter(([id]) => !target.emptyIds.has(id));
		if (missing.length === 0) return;
		const items: JobResultItem[] = [];
		for (const [id, value] of missing) {
			target.record.results[id] = value;
			if (target.emitted.has(id)) continue;
			target.emitted.add(id);
			items.push(resultItem(target.task, id, value));
		}
		checkpoint(target);
		if (!report || items.length === 0) return;
		emit(target, {
			type: 'job-progress',
			jobId: target.id,
			completedGroups: target.completedGroups,
			totalGroups: target.totalGroups,
			completedSegments: target.emitted.size,
			totalSegments: target.record.segmentCount,
			results: items
		});
	};

	// A result that arrives after cancel (Safari cannot abort a sendNativeMessage) is still billed,
	// so it is kept: in the cancelled job while it settles, in a newer live job of the same id, or in
	// the stored record.
	const keepLateResults = (job: Job, accepted: Array<[number, string | ReadingToken[]]>) => {
		const live = jobs.get(job.id);
		if (live === job) addLateResults(job, accepted, false);
		else if (live && !live.settling) addLateResults(live, accepted, true);
		else void keepStoredLateResults(job.id, accepted);
	};

	const accept = (job: Job, group: TranscriptPromptGroup, output: AiTaskOutput<TranscriptJobTask>): GroupOutcome => {
		const requested = new Set(group.segments.map(segment => segment.id));
		const accepted: Array<[number, string | ReadingToken[]]> = [];
		for (const item of output as Array<{ id: number; text?: unknown; tokens?: unknown }>) {
			if (!item || !requested.has(item.id)) continue;
			requested.delete(item.id);
			if (job.task === 'translate') {
				if (typeof item.text === 'string' && item.text.trim()) accepted.push([item.id, item.text]);
			} else if (Array.isArray(item.tokens)) {
				accepted.push([item.id, (item.tokens as ReadingToken[]).map(token => ({ ...token }))]);
			}
		}
		if (job.cancelled) {
			keepLateResults(job, accepted);
			return NOT_OK;
		}
		const items: JobResultItem[] = [];
		for (const [id, value] of accepted) {
			if (id in job.record.results) continue;
			job.record.results[id] = value;
			items.push(resultItem(job.task, id, value));
		}
		checkpoint(job);
		return { ok: true, items };
	};

	const requestSplit = (job: Job, kind: ConnectionKind, error: AiError) => {
		if (job.replan) return;
		const floor = CLI_GROUP_BUDGET_FLOORS[job.task];
		const current = transcriptGroupBudget(kind, job.task, job.record.cliPromptChars);
		if (current > floor && job.record.attempts.splits < MAX_SPLITS) {
			job.record.cliPromptChars = Math.max(floor, Math.floor(current / 2));
			job.record.attempts.splits += 1;
			job.replan = true;
			checkpoint(job);
			return;
		}
		fail(job, error);
	};

	const retryDelay = (job: Job, error: AiError, attempt: number): number | undefined => {
		if (!isRetryableGroupError(error) || attempt >= MAX_GROUP_RETRIES) return undefined;
		if (job.retriesThisRun >= job.retryBudget) return undefined;
		if (error.retryAfterMs !== undefined && error.retryAfterMs > RETRY_AFTER_MAX_MS) return undefined;
		return retryDelayMs(attempt + 1, error.retryAfterMs, random);
	};

	const runGroup = async (job: Job, group: TranscriptPromptGroup, kind: ConnectionKind): Promise<GroupOutcome> => {
		const input = {
			instruction: job.input.instruction,
			segments: group.segments,
			maxTokens: transcriptGroupMaxTokens(job.task, group)
		};
		for (let attempt = 0; ; attempt += 1) {
			job.record.attempts.requests += 1;
			try {
				const result = await deps.execute(job.task, input, {
					...(job.record.profileId ? { profileId: job.record.profileId } : {}),
					signal: job.cancelController.signal
				});
				return accept(job, group, result.output);
			} catch (thrown) {
				if (job.cancelled) return NOT_OK;
				const error = toAiError(thrown);
				if (isCliKind(kind) && error.code === 'timeout') {
					requestSplit(job, kind, error);
					return NOT_OK;
				}
				const delayMs = retryDelay(job, error, attempt);
				if (delayMs === undefined || stopped(job)) {
					fail(job, error);
					return NOT_OK;
				}
				job.retriesThisRun += 1;
				job.record.attempts.retries += 1;
				checkpoint(job);
				emit(job, {
					type: 'job-retry',
					jobId: job.id,
					code: error.code,
					...(error.status !== undefined ? { status: error.status } : {}),
					delayMs,
					attempt: attempt + 1
				});
				try {
					await sleep(delayMs, [job.cancelController.signal, job.stopController.signal], setTimer, clearTimer);
				} catch {
					return NOT_OK;
				}
				if (stopped(job)) return NOT_OK;
			}
		}
	};

	const planGroups = (job: Job, kind: ConnectionKind) => buildTranscriptPromptGroups(
		job.input.segments,
		job.input.instruction,
		transcriptGroupBudget(kind, job.task, job.record.cliPromptChars),
		id => !(id in job.record.results) && !job.emptyIds.has(id)
	);

	const runPool = async (job: Job, groups: TranscriptPromptGroup[], first: JobConnection) => {
		const outcomes: Array<GroupOutcome | undefined> = [];
		let nextToEmit = 0;
		// Progress goes out in source order: a group that finishes early waits for earlier ones.
		const flush = () => {
			while (nextToEmit < groups.length && outcomes[nextToEmit]) {
				const outcome = outcomes[nextToEmit] as GroupOutcome;
				nextToEmit += 1;
				if (!outcome.ok) continue;
				job.completedGroups += 1;
				outcome.items.forEach(item => job.emitted.add(item.id));
				emit(job, {
					type: 'job-progress',
					jobId: job.id,
					completedGroups: job.completedGroups,
					totalGroups: job.totalGroups,
					completedSegments: job.emitted.size,
					totalSegments: job.record.segmentCount,
					results: outcome.items
				});
			}
		};
		const running = new Set<Promise<void>>();
		let connection = first;
		let next = 0;
		while (next < groups.length && !stopped(job) && !job.replan) {
			if (next > 0) {
				try {
					connection = await deps.resolveConnection(job.task, job.record.profileId);
					job.connection = connection;
				} catch (error) {
					fail(job, toAiError(error));
					break;
				}
				if (stopped(job) || job.replan) break;
			}
			if (running.size >= maxConcurrencyFor(connection)) {
				await Promise.race(running);
				continue;
			}
			const index = next;
			next += 1;
			const tracked: Promise<void> = runGroup(job, groups[index], connection.kind)
				.catch(error => {
					fail(job, toAiError(error));
					return NOT_OK;
				})
				.then(outcome => {
					outcomes[index] = outcome;
					flush();
				})
				.finally(() => running.delete(tracked));
			running.add(tracked);
		}
		await Promise.all(running);
		// Groups never dispatched are dropped; a re-plan rebuilds them from the missing ids.
	};

	const run = async (job: Job) => {
		startHeartbeat(job);
		let firstPlan = true;
		try {
			while (!stopped(job)) {
				let connection: JobConnection;
				try {
					connection = await deps.resolveConnection(job.task, job.record.profileId);
					job.connection = connection;
				} catch (error) {
					fail(job, toAiError(error));
					break;
				}
				if (stopped(job)) break;
				const groups = planGroups(job, connection.kind);
				job.replan = false;
				job.totalGroups = job.completedGroups + groups.length;
				if (firstPlan) {
					firstPlan = false;
					job.retryBudget = jobRetryBudget(groups.length);
					emit(job, snapshot(job, false));
				}
				if (groups.length === 0) break;
				await runPool(job, groups, connection);
				if (!job.replan) break;
			}
		} catch (error) {
			fail(job, toAiError(error));
		}
		if (job.cancelled) return;
		if (job.fatal) await settle(job, 'failed', job.fatal);
		else if (isComplete(job)) await settle(job, 'completed');
		else await settle(job, 'incomplete', new AiError('incomplete'));
	};

	const launch = (record: AiJobRecord, input: AiJobStoredInput, listener?: JobListener): Job => {
		const emptyIds = emptyIdsOf(record.task, input.segments);
		// Results for empty sources are implicit; a stray stored one is dropped.
		emptyIds.forEach(id => delete record.results[id]);
		const job: Job = {
			id: record.id,
			task: record.task,
			record,
			input,
			emptyIds,
			emitted: new Set([...emptyIds, ...Object.keys(record.results).map(Number)]),
			listeners: new Set(listener ? [listener] : []),
			cancelController: new AbortController(),
			stopController: new AbortController(),
			cancelled: false,
			finished: false,
			replan: false,
			completedGroups: 0,
			totalGroups: 0,
			retriesThisRun: 0,
			retryBudget: 0,
			writes: Promise.resolve(),
			durable: true,
			warned: false,
			startedAt: now()
		};
		jobs.set(job.id, job);
		checkpoint(job);
		void run(job);
		return job;
	};

	/** Runs `factory` under the job's lock unless a live job exists or another start/resume is pending. */
	const obtain = async (jobId: string, factory: () => Promise<Job | undefined>): Promise<Job | undefined> => {
		for (;;) {
			const live = jobs.get(jobId);
			if (live?.settling) {
				// Proceed against the final record once it is written.
				await live.settling;
				continue;
			}
			if (live) return live;
			const pending = locks.get(jobId);
			if (!pending) break;
			await pending.catch(() => undefined);
		}
		const promise: Promise<Job | undefined> = factory().finally(() => {
			if (locks.get(jobId) === promise) locks.delete(jobId);
		});
		locks.set(jobId, promise);
		return promise;
	};

	// An expired or unresumable `running` record ends without an error: nothing failed, it stopped.
	const markIncomplete = async (record: AiJobRecord) => {
		const next: AiJobRecord = { ...cloneRecord(record), status: 'incomplete', updatedAt: now() };
		delete next.error;
		await store.put(next);
	};

	const resumeFactory = (jobId: string, listener?: JobListener, maxAgeMs?: number) => async (): Promise<Job | undefined> => {
		const record = await store.get(jobId);
		if (!record || record.status !== 'running') return undefined;
		if (maxAgeMs !== undefined && now() - record.updatedAt > maxAgeMs) {
			await markIncomplete(record);
			return undefined;
		}
		const input = await store.getInput(jobId);
		if (!input || !inputMatches(record, input)) {
			await markIncomplete(record);
			return undefined;
		}
		return launch(record, input, listener);
	};

	const addListener = (job: Job, listener: JobListener, created: boolean): JobDetach => {
		if (!created) {
			job.listeners.add(listener);
			try {
				listener(snapshot(job, false));
			} catch {
				// Ignored as in emit.
			}
		}
		return () => {
			job.listeners.delete(listener);
		};
	};

	return {
		async start(jobId, task, input, profileId, listener) {
			let created = false;
			const texts = input.segments.map(segment => segment.text);
			const segmentHash = hashSegments(input.identity.scope, texts);
			const job = await obtain(jobId, async () => {
				const existing = await store.get(jobId);
				const sameTranscript = existing !== undefined
					&& existing.task === task
					&& existing.segmentCount === texts.length
					&& existing.segmentHash === segmentHash;
				const storedInput: AiJobStoredInput = { instruction: input.instruction, segments: texts };
				created = true;
				if (sameTranscript && existing.status === 'running') {
					// A running record with no live job: the worker restarted. Resume it as it was.
					await store.putInput(jobId, storedInput);
					return launch(existing, storedInput, listener);
				}
				const timestamp = now();
				const record: AiJobRecord = {
					v: 1,
					id: jobId,
					task,
					identity: { ...input.identity },
					segmentCount: texts.length,
					segmentHash,
					...(profileId ? { profileId } : {}),
					status: 'running',
					// Continue remaining: earlier accepted results stay, and only missing ids are planned.
					results: sameTranscript ? { ...existing.results } : {},
					attempts: { requests: 0, retries: 0, splits: 0 },
					...(sameTranscript && existing.cliPromptChars !== undefined ? { cliPromptChars: existing.cliPromptChars } : {}),
					createdAt: sameTranscript ? existing.createdAt : timestamp,
					updatedAt: timestamp
				};
				await store.putInput(jobId, storedInput);
				return launch(record, storedInput, listener);
			});
			if (!job) throw new AiError('provider-error', { detail: 'The job could not be started.' });
			return addListener(job, listener, created);
		},

		async attach(jobId, listener) {
			let created = false;
			const job = await obtain(jobId, () => {
				created = true;
				return resumeFactory(jobId, listener)();
			});
			if (job) return addListener(job, listener, created);
			const record = await store.get(jobId);
			if (!record) return undefined;
			listener(recordSnapshot(record, await store.getInput(jobId)));
			return () => undefined;
		},

		async cancel(jobId) {
			await locks.get(jobId)?.catch(() => undefined);
			const job = jobs.get(jobId);
			if (job?.settling) {
				// Already ending: its final record stands, and a terminal record is never overwritten.
				await job.settling;
				return false;
			}
			if (job) {
				// Terminal at once: progress stops, and a group that cannot be aborted (Safari) only
				// checkpoints its late result.
				job.cancelled = true;
				job.cancelController.abort();
				await settle(job, 'cancelled', new AiError('cancelled'));
				return true;
			}
			const record = await store.get(jobId);
			if (record?.status !== 'running') return false;
			await store.put({
				...cloneRecord(record),
				status: 'cancelled',
				error: serializeAiError(new AiError('cancelled')),
				updatedAt: now()
			});
			return true;
		},

		async resume(jobId) {
			const job = await obtain(jobId, resumeFactory(jobId));
			return Boolean(job && jobs.get(jobId) === job);
		},

		async resumeRunning() {
			const resumed: string[] = [];
			const expired: string[] = [];
			const records = (await store.list()).filter(record => record.status === 'running' && !jobs.has(record.id));
			await Promise.all(records.map(async record => {
				const recent = now() - record.updatedAt <= RESUME_WINDOW_MS;
				const job = await obtain(record.id, resumeFactory(record.id, undefined, RESUME_WINDOW_MS));
				if (job) resumed.push(record.id);
				else if (!recent) expired.push(record.id);
			}));
			return { resumed: resumed.sort(), expired: expired.sort() };
		},

		async get(jobId) {
			const job = jobs.get(jobId);
			if (job) return snapshot(job, true);
			const record = await store.get(jobId);
			return record ? recordSnapshot(record, await store.getInput(jobId)) : undefined;
		},

		isActive(jobId) {
			return jobs.has(jobId);
		}
	};
}
