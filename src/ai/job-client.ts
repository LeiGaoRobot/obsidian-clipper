import browser from '../utils/browser-polyfill';
import type { AiClientPort } from './client';
import {
	isCompleteTranscriptReadingSegment,
	parseTranslationText,
	type AiTaskOutput,
	type ReadingToken,
	type TranscriptSegment
} from './contracts';
import { AiError } from './errors';
import { transcriptJobId, type TranscriptJobIdentity, type TranscriptJobTask } from './job-identity';
import type { AiJobAttempts, AiJobStatus } from './job-store';
import {
	AI_KEEPALIVE_INTERVAL_MS,
	AI_PORT_NAME,
	deserializeAiError,
	type AiCheckpointRecord,
	type AiClientMessage,
	type AiGatewayMessage,
	type AiJobCounts,
	type JobResultItem
} from './protocol';

// Client side of durable transcript jobs. A job runs in the background gateway and outlives this
// Port: a disconnect (worker restart, Port GC) is answered with reconnect + `attach`, never with a
// new `start-job`, so a reconnect can resume a running job but never starts paid work on its own.

/** Delays before each reconnect attempt after the Port disconnects. */
export const JOB_RECONNECT_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000];
/** Consecutive reconnects without a reply from the gateway before the client gives up. */
export const MAX_RECONNECTS = JOB_RECONNECT_DELAYS_MS.length;

/** One aligned value per source segment: a translation, or a segment's reading tokens. */
export interface TranscriptJobValueMap {
	translate: string;
	reading: ReadingToken[];
}

/** Values indexed by segment id. A segment without an accepted result holds `''` or `[]`. */
export type TranscriptJobValues<T extends TranscriptJobTask = TranscriptJobTask> = TranscriptJobValueMap[T][];

export interface TranscriptJobInput {
	instruction: string;
	/** Ids must equal their index. */
	segments: TranscriptSegment[];
	identity: TranscriptJobIdentity;
}

export interface TranscriptJobProgress<T extends TranscriptJobTask = TranscriptJobTask> extends AiJobCounts {
	/** A copy of the aligned values accepted so far. */
	values: TranscriptJobValues<T>;
}

export interface TranscriptJobRetry {
	code: AiError['code'];
	status?: number;
	delayMs: number;
	attempt: number;
}

export interface TranscriptJobResult<T extends TranscriptJobTask = TranscriptJobTask> extends AiJobCounts {
	/** `incomplete`: every group finished, but some segments have no accepted result. */
	status: 'completed' | 'incomplete';
	values: TranscriptJobValues<T>;
	/** The accepted items in id order; missing ids are absent. */
	results: AiTaskOutput<T>;
	attempts: AiJobAttempts;
	/** The `incomplete` error the gateway reported, if any. */
	error?: AiError;
}

export interface RunTranscriptJobOptions<T extends TranscriptJobTask = TranscriptJobTask> {
	/** An explicit profile for this job. Omit to use task routing. */
	profileId?: string;
	/** Aborting cancels the background job, not just this client. */
	signal?: AbortSignal;
	onProgress?: (progress: TranscriptJobProgress<T>) => void;
	/** A group entered backoff after a retryable provider error. */
	onRetry?: (retry: TranscriptJobRetry) => void;
	connect?: (name: string) => AiClientPort;
	keepaliveMs?: number;
	reconnectDelaysMs?: readonly number[];
}

/** A failed or cancelled job's rejection: the job's AiError plus the attempts the run spent. */
export type TranscriptJobError = AiError & { readonly attempts?: AiJobAttempts };

/** Records the attempts a job spent on the error it rejects with, e.g. CLI timeout splits. */
export function withJobAttempts(error: AiError, attempts: AiJobAttempts | undefined): TranscriptJobError {
	if (!attempts) return error;
	return Object.assign(error, {
		attempts: { requests: attempts.requests, retries: attempts.retries, splits: attempts.splits }
	});
}

/** The attempts of a rejected transcript job, when the gateway reported them. */
export function transcriptJobAttempts(error: unknown): AiJobAttempts | undefined {
	if (!(error instanceof AiError)) return undefined;
	const attempts = (error as TranscriptJobError).attempts;
	if (!attempts || typeof attempts !== 'object') return undefined;
	const { requests, retries, splits } = attempts;
	return [requests, retries, splits].every(value => Number.isInteger(value) && value >= 0)
		? { requests, retries, splits }
		: undefined;
}

export interface TranscriptCheckpoint<T extends TranscriptJobTask = TranscriptJobTask> {
	status: AiJobStatus;
	values: TranscriptJobValues<T>;
	completedSegments: number;
	totalSegments: number;
}

export interface TranscriptCheckpointOptions {
	connect?: (name: string) => AiClientPort;
}

let requestSequence = 0;

function createRequestId(): string {
	requestSequence += 1;
	return `ai-checkpoint-${Date.now()}-${requestSequence}-${Math.random().toString(36).slice(2, 8)}`;
}

function connectToGateway(name: string): AiClientPort {
	return browser.runtime.connect({ name }) as unknown as AiClientPort;
}

function emptyValues<T extends TranscriptJobTask>(task: T, count: number): TranscriptJobValues<T> {
	return Array.from({ length: count }, () => (task === 'translate' ? '' : [])) as TranscriptJobValues<T>;
}

/**
 * Writes items onto aligned values and records their ids as accepted; items with an id outside the
 * source are ignored. An accepted reading may be `[]` (an empty segment), so `accepted`, not the
 * value, says which segments have a result.
 */
function applyItems<T extends TranscriptJobTask>(
	task: T,
	values: TranscriptJobValues<T>,
	accepted: Set<number>,
	items: unknown
): void {
	if (!Array.isArray(items)) return;
	for (const item of items as JobResultItem[]) {
		if (!item || !Number.isInteger(item.id) || item.id < 0 || item.id >= values.length) continue;
		if (task === 'translate' && 'text' in item && typeof item.text === 'string') {
			values[item.id] = item.text as TranscriptJobValueMap[T];
			accepted.add(item.id);
		} else if (task === 'reading' && 'tokens' in item && Array.isArray(item.tokens)) {
			values[item.id] = item.tokens.map(token => ({ ...token })) as TranscriptJobValueMap[T];
			accepted.add(item.id);
		}
	}
}

function copyValues<T extends TranscriptJobTask>(values: TranscriptJobValues<T>): TranscriptJobValues<T> {
	return values.map(value => (Array.isArray(value) ? value.map(token => ({ ...token })) : value)) as TranscriptJobValues<T>;
}

/**
 * The aligned values as checkpoint items. A translation counts when it is not blank; a reading
 * when its tokens reproduce the source and read every kanji (an empty segment reads as `[]`).
 */
function toResultItems<T extends TranscriptJobTask>(
	task: T,
	segments: readonly TranscriptSegment[],
	values: TranscriptJobValues<T>
): AiTaskOutput<T> {
	const items: JobResultItem[] = [];
	segments.forEach((segment, id) => {
		const value = values[id];
		if (task === 'translate') {
			if (parseTranslationText(value)) items.push({ id, text: value as string });
		} else if (Array.isArray(value) && isCompleteTranscriptReadingSegment(value, segment.text)) {
			items.push({ id, tokens: value.map(token => ({ ...token })) });
		}
	});
	return items as AiTaskOutput<T>;
}

function acceptedItems<T extends TranscriptJobTask>(
	task: T,
	values: TranscriptJobValues<T>,
	accepted: ReadonlySet<number>
): AiTaskOutput<T> {
	const items: JobResultItem[] = [];
	values.forEach((value, id) => {
		if (!accepted.has(id)) return;
		items.push(task === 'translate' ? { id, text: value as string } : { id, tokens: value as ReadingToken[] });
	});
	return items as AiTaskOutput<T>;
}

function jobIdFor(task: TranscriptJobTask, identity: TranscriptJobIdentity, segments: readonly TranscriptSegment[]): string {
	try {
		return transcriptJobId(task, identity, segments);
	} catch (error) {
		throw new AiError('provider-error', { retryable: false, detail: errorDetail(error) });
	}
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function safeDisconnect(port: AiClientPort | undefined): void {
	try {
		port?.disconnect();
	} catch {
		// Already disconnected.
	}
}

/**
 * Runs a translate or reading job over a whole transcript in the background gateway. Resolves
 * `completed` and `incomplete` with values aligned to `input.segments`; rejects `failed` with the
 * job's error, `cancelled` on abort or a background cancel, and `network` once reconnecting fails
 * `MAX_RECONNECTS` times in a row (the job itself keeps running in the background). A rejection
 * from a final `job-state` carries the run's attempts, read with `transcriptJobAttempts`.
 */
export function runTranscriptJob<T extends TranscriptJobTask>(
	task: T,
	input: TranscriptJobInput,
	options: RunTranscriptJobOptions<T> = {}
): Promise<TranscriptJobResult<T>> {
	if (options.signal?.aborted) return Promise.reject(new AiError('cancelled'));
	let jobId: string;
	try {
		jobId = jobIdFor(task, input.identity, input.segments);
	} catch (error) {
		return Promise.reject(error);
	}
	const connect = options.connect ?? connectToGateway;
	const delays = options.reconnectDelaysMs ?? JOB_RECONNECT_DELAYS_MS;
	const total = input.segments.length;

	return new Promise<TranscriptJobResult<T>>((resolve, reject) => {
		let settled = false;
		let port: AiClientPort | undefined;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		// Reconnects since the gateway last answered; reset by any message for this job.
		let reconnects = 0;
		let values = emptyValues(task, total);
		let accepted = new Set<number>();
		let counts: AiJobCounts = { completedGroups: 0, totalGroups: 0, completedSegments: 0, totalSegments: total };

		const keepalive = setInterval(() => {
			try {
				port?.postMessage({ type: 'ping' });
			} catch {
				// A closed port is reported through onDisconnect.
			}
		}, options.keepaliveMs ?? AI_KEEPALIVE_INTERVAL_MS);

		const release = (current: AiClientPort | undefined) => {
			if (!current) return;
			current.onMessage.removeListener(onMessage);
			current.onDisconnect.removeListener(onDisconnect);
			if (port === current) port = undefined;
		};
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearInterval(keepalive);
			if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
			options.signal?.removeEventListener('abort', onAbort);
			const current = port;
			release(current);
			safeDisconnect(current);
			callback();
		};
		const reportProgress = () => {
			options.onProgress?.({ ...counts, values: copyValues(values) });
		};
		const setCounts = (message: AiJobCounts) => {
			counts = {
				completedGroups: message.completedGroups,
				totalGroups: message.totalGroups,
				completedSegments: message.completedSegments,
				totalSegments: message.totalSegments
			};
		};

		const onMessage = (value: unknown) => {
			const message = value as AiGatewayMessage;
			if (!message || message.jobId !== jobId || settled) return;
			reconnects = 0;
			switch (message.type) {
				case 'job-progress':
					applyItems(task, values, accepted, message.results);
					setCounts(message);
					reportProgress();
					return;
				case 'job-state': {
					// A snapshot replaces local state: after a reconnect it holds groups finished meanwhile.
					values = emptyValues(task, total);
					accepted = new Set();
					applyItems(task, values, accepted, message.results);
					setCounts(message);
					if (message.status === 'running') {
						reportProgress();
					} else if (message.status === 'completed' || message.status === 'incomplete') {
						const status = message.status;
						const attempts = { ...message.attempts };
						const error = message.error ? deserializeAiError(message.error) : undefined;
						settle(() => resolve({
							status,
							values,
							results: acceptedItems(task, values, accepted),
							attempts,
							...counts,
							...(error ? { error } : {})
						}));
					} else if (message.status === 'cancelled') {
						settle(() => reject(withJobAttempts(new AiError('cancelled'), message.attempts)));
					} else {
						const error = message.error
							? deserializeAiError(message.error)
							: new AiError('provider-error', { detail: 'The job failed.' });
						settle(() => reject(withJobAttempts(error, message.attempts)));
					}
					return;
				}
				case 'job-retry':
					options.onRetry?.({
						code: message.code,
						...(message.status !== undefined ? { status: message.status } : {}),
						delayMs: message.delayMs,
						attempt: message.attempt
					});
					return;
				case 'error':
					// An invalid request, an unknown job on attach, or a gateway that cannot run the job.
					settle(() => reject(deserializeAiError(message.error)));
					return;
			}
		};

		const open = (message: AiClientMessage): boolean => {
			let next: AiClientPort;
			try {
				next = connect(AI_PORT_NAME);
			} catch {
				return false;
			}
			next.onMessage.addListener(onMessage);
			next.onDisconnect.addListener(onDisconnect);
			port = next;
			try {
				next.postMessage(message);
			} catch {
				release(next);
				safeDisconnect(next);
				return false;
			}
			return true;
		};

		const reconnect = () => {
			reconnectTimer = undefined;
			if (settled) return;
			if (!open({ type: 'attach', jobId })) onDisconnect();
		};

		function onDisconnect() {
			if (settled) return;
			release(port);
			if (reconnects >= delays.length) {
				settle(() => reject(new AiError('network', {
					retryable: true,
					detail: 'The extension background stopped answering. The job may still finish in the background.'
				})));
				return;
			}
			const delay = delays[reconnects];
			reconnects += 1;
			reconnectTimer = setTimeout(reconnect, delay);
		}

		function onAbort() {
			if (settled) return;
			let sent = false;
			try {
				port?.postMessage({ type: 'cancel', jobId });
				sent = Boolean(port);
			} catch {
				// The port is closed but its onDisconnect has not fired yet.
			}
			if (!sent) {
				// Between reconnects there is no live Port. Cancel on a fresh one so the background job
				// stops sending billable requests; a message posted before disconnect is still delivered.
				let fresh: AiClientPort | undefined;
				try {
					fresh = connect(AI_PORT_NAME);
					fresh.postMessage({ type: 'cancel', jobId });
				} catch {
					// Best effort: the job keeps running until it finishes or the user cancels again.
				}
				safeDisconnect(fresh);
			}
			settle(() => reject(new AiError('cancelled')));
		}

		options.signal?.addEventListener('abort', onAbort, { once: true });
		let first: AiClientPort;
		try {
			first = connect(AI_PORT_NAME);
		} catch (error) {
			settle(() => reject(new AiError('network', { detail: errorDetail(error) })));
			return;
		}
		first.onMessage.addListener(onMessage);
		first.onDisconnect.addListener(onDisconnect);
		port = first;
		try {
			first.postMessage({
				type: 'start-job',
				jobId,
				task,
				...(options.profileId ? { profileId: options.profileId } : {}),
				input: {
					instruction: input.instruction,
					segments: input.segments.map(({ id, text }) => ({ id, text })),
					identity: { namespace: input.identity.namespace, scope: input.identity.scope }
				}
			} as AiClientMessage);
		} catch (error) {
			settle(() => reject(new AiError('network', { retryable: true, detail: errorDetail(error) })));
		}
	});
}

/** One `checkpoint-*` round trip on a short-lived Port. Rejects with an AiError on transport failure. */
function exchangeCheckpoint(
	message: AiClientMessage & { requestId: string; jobId: string },
	options: TranscriptCheckpointOptions
): Promise<{ ok: boolean; record?: AiCheckpointRecord }> {
	let port: AiClientPort;
	try {
		port = (options.connect ?? connectToGateway)(AI_PORT_NAME);
	} catch (error) {
		return Promise.reject(new AiError('network', { detail: errorDetail(error) }));
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			port.onMessage.removeListener(onMessage);
			port.onDisconnect.removeListener(onDisconnect);
			safeDisconnect(port);
			callback();
		};
		const onMessage = (value: unknown) => {
			const reply = value as AiGatewayMessage;
			if (!reply) return;
			if (reply.type === 'checkpoint' && reply.requestId === message.requestId) {
				settle(() => resolve({ ok: reply.ok === true, ...(reply.record ? { record: reply.record } : {}) }));
			} else if (reply.type === 'error' && reply.jobId === message.jobId) {
				settle(() => reject(deserializeAiError(reply.error)));
			}
		};
		const onDisconnect = () => {
			settle(() => reject(new AiError('network', {
				retryable: true,
				detail: 'The extension background stopped before the checkpoint request finished.'
			})));
		};
		port.onMessage.addListener(onMessage);
		port.onDisconnect.addListener(onDisconnect);
		try {
			port.postMessage(message);
		} catch (error) {
			settle(() => reject(new AiError('network', { retryable: true, detail: errorDetail(error) })));
		}
	});
}

/**
 * Reads a transcript's stored job record without starting or resuming anything. Resolves undefined
 * when there is none. A `running` record is returned as-is; only `runTranscriptJob` attaches to it.
 */
export async function loadTranscriptCheckpoint<T extends TranscriptJobTask>(
	task: T,
	identity: TranscriptJobIdentity,
	segments: readonly TranscriptSegment[],
	options: TranscriptCheckpointOptions = {}
): Promise<TranscriptCheckpoint<T> | undefined> {
	const jobId = jobIdFor(task, identity, segments);
	const reply = await exchangeCheckpoint({ type: 'checkpoint-get', requestId: createRequestId(), jobId }, options);
	if (!reply.ok || !reply.record) return undefined;
	const values = emptyValues(task, segments.length);
	applyItems(task, values, new Set(), reply.record.results);
	return {
		status: reply.record.status,
		values,
		completedSegments: reply.record.completedSegments,
		totalSegments: reply.record.totalSegments
	};
}

/**
 * Stores aligned values as the transcript's record: `completed` when every segment has a valid
 * value, else `incomplete`. Values that would fail the task contract are left out. Resolves false
 * when the gateway refuses, for example while a job for this transcript is running.
 */
export async function saveTranscriptCheckpoint<T extends TranscriptJobTask>(
	task: T,
	identity: TranscriptJobIdentity,
	segments: readonly TranscriptSegment[],
	values: TranscriptJobValues<T>,
	options: TranscriptCheckpointOptions = {}
): Promise<boolean> {
	const jobId = jobIdFor(task, identity, segments);
	const reply = await exchangeCheckpoint({
		type: 'checkpoint-put',
		requestId: createRequestId(),
		jobId,
		task,
		identity: { namespace: identity.namespace, scope: identity.scope },
		segmentCount: segments.length,
		segments: segments.map(({ id, text }) => ({ id, text })),
		results: toResultItems(task, segments, values)
	} as AiClientMessage & { requestId: string; jobId: string }, options);
	return reply.ok;
}

/** Removes the transcript's record and cancels a running job for it. */
export async function clearTranscriptCheckpoint(
	task: TranscriptJobTask,
	identity: TranscriptJobIdentity,
	segments: readonly TranscriptSegment[],
	options: TranscriptCheckpointOptions = {}
): Promise<boolean> {
	const jobId = jobIdFor(task, identity, segments);
	const reply = await exchangeCheckpoint({ type: 'checkpoint-clear', requestId: createRequestId(), jobId }, options);
	return reply.ok;
}
