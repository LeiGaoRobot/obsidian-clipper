import { executeApiCall, type AppIdentity } from './adapters/http';
import { checkCliHealth, runCliPrompt } from './adapters/native-cli';
import { isStructuredOutputRejection, type StructuredOutputMode } from './capabilities';
import { isCliKind } from './connection-kind';
import {
	outputSpec,
	parseOutput,
	renderCliPrompt,
	renderMessages,
	type AiTaskInput,
	type AiTaskOutput,
	type ReadingToken
} from './contracts';
import { createAiDiagnostics, type AiDiagnostics } from './diagnostics';
import { AiError, toAiError } from './errors';
import { hashSegments, parseJobId, transcriptJobId, type TranscriptJobTask } from './job-identity';
import {
	createJobRunner,
	isEmptySourceSegment,
	type JobConnection,
	type JobDetach,
	type JobListener,
	type JobRunnerDeps
} from './job-runner';
import { createAiJobStore, type AiJobRecord, type AiJobStore } from './job-store';
import {
	AI_PORT_NAME,
	isAiClientMessage,
	sanitizeCheckpointPut,
	sanitizeJobInput,
	sanitizeTaskInput,
	serializeAiError,
	type AiCheckpointMessage,
	type AiClientMessage,
	type AiGatewayMessage,
	type AiProgressPhase
} from './protocol';
import { effectiveStructuredOutput, resolveProfile } from './resolve';
import { createConnectionStatusStore, type ConnectionStatusStore } from './settings';
import { runConnectionTest, statusFromTestResult, type ConnectionTestDeps } from './test-connection';
import type {
	AiDiagnosticEntry,
	AiSettingsView,
	AiTask,
	ApiConnectionKind,
	CliConnectionKind,
	Connection,
	ConnectionKind
} from './types';

export interface AiPortLike {
	name: string;
	postMessage(message: unknown): void;
	onMessage: { addListener(listener: (message: unknown) => void): void };
	onDisconnect: { addListener(listener: () => void): void };
}

export interface AiGatewayDeps {
	/** The current AI settings view, re-read on every call. It carries the Native Messaging support. */
	loadAiSettings: () => Promise<AiSettingsView>;
	app: () => AppIdentity;
	executeApi?: typeof executeApiCall;
	executeCli?: typeof runCliPrompt;
	/**
	 * Per-device connection status (`ai_connection_status`): Test results and structured-output
	 * downgrades. Omit for an in-memory store that lasts as long as the worker.
	 */
	connectionStatus?: ConnectionStatusStore;
	/** The redacted Diagnostics log. Omit for an in-memory log. */
	diagnostics?: AiDiagnostics;
	/** The Host health check of a CLI Test. Defaults to Native Messaging. */
	checkCliHealth?: ConnectionTestDeps['health'];
	/** The fetch of a Test's model listing. Defaults to the global fetch. */
	fetchImpl?: typeof fetch;
	now?: () => number;
	/**
	 * Called while any job is unfinished. In Chrome, an extension API call resets the service
	 * worker's idle timer; a pending fetch does not, so batch jobs need this once their caller is gone.
	 */
	keepAlive?: () => void;
	keepAliveIntervalMs?: number;
	/** How long a finished job's outcome stays available to `attach`. */
	retainMs?: number;
	/** Durable transcript job records. Omit for an in-memory store that lasts as long as the worker. */
	jobStore?: AiJobStore;
	/** Timer, randomness, and heartbeat overrides for the job runner, for tests. */
	jobTiming?: Pick<JobRunnerDeps, 'random' | 'setTimeout' | 'clearTimeout' | 'heartbeatMs'>;
}

export interface AiExecuteOptions {
	/** An explicit profile. Omit to use task routing. */
	profileId?: string;
	signal: AbortSignal;
	onProgress?: (phase: Exclude<AiProgressPhase, 'started'>, receivedChars?: number) => void;
}

// Interactive tasks are pointless once their UI is gone. Single-call batch tasks finish so their
// outcome can be replayed to an `attach` within the retention window. Durable transcript jobs are
// never cancelled by a disconnect; they are checkpointed and replayed from the job store.
const CANCEL_ON_DETACH: ReadonlySet<AiTask> = new Set<AiTask>(['interpret', 'edit', 'explain']);
const RECEIVE_PROGRESS_INTERVAL_MS = 500;
const DEFAULT_RETAIN_MS = 60_000;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;

type Outcome = Extract<AiGatewayMessage, { type: 'result' | 'error' }>;

interface Job {
	id: string;
	task: AiTask;
	controller: AbortController;
	listeners: Set<AiPortLike>;
	startedAt: number;
	outcome?: Outcome;
}

/** What a single call used, filled in as it runs, for its Diagnostics entry. */
interface ExecuteInfo {
	connection?: Connection;
	structuredMode?: StructuredOutputMode;
	fallback?: true;
}

interface TestRun {
	controller: AbortController;
	port: AiPortLike;
}

interface PortState {
	/** Durable job listeners of this port, by job id. */
	durable: Map<string, JobDetach>;
	closed: boolean;
}

export interface AiGateway {
	handlePort(port: AiPortLike): void;
	/**
	 * Worker start: removes Phase 3 Reader checkpoints and the Phase 3 structured-output cache,
	 * resumes recent `running` jobs, and marks older ones `incomplete`. Idempotent. An `attach` or `start-job` that arrives first is safe:
	 * the runner runs one job per id.
	 */
	init(): Promise<{ resumed: string[]; expired: string[] }>;
	/** Single-call jobs without an outcome and durable jobs running in this worker. For tests and diagnostics. */
	activeJobIds(): string[];
}

function invalidRequest(jobId: string): AiGatewayMessage {
	return {
		type: 'error',
		jobId,
		error: serializeAiError(new AiError('provider-error', { detail: 'Invalid AI request.' }))
	};
}

function post(port: AiPortLike, message: AiGatewayMessage): void {
	try {
		port.postMessage(message);
	} catch {
		// The port closed between the check and the send; onDisconnect cleans up.
	}
}

export function createAiGateway(deps: AiGatewayDeps): AiGateway {
	const jobs = new Map<string, Job>();
	const now = deps.now ?? Date.now;
	const executeApi = deps.executeApi ?? executeApiCall;
	const executeCli = deps.executeCli ?? runCliPrompt;
	const retainMs = deps.retainMs ?? DEFAULT_RETAIN_MS;
	const store = deps.jobStore ?? createAiJobStore();
	const statusStore = deps.connectionStatus ?? createConnectionStatusStore();
	const diagnostics = deps.diagnostics ?? createAiDiagnostics();
	const tests = new Map<string, TestRun>();
	// Durable job ids this gateway started, attached, or resumed; pruned once they stop running.
	const durableIds = new Set<string>();
	const ports = new WeakMap<AiPortLike, PortState>();
	let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
	let initPromise: Promise<{ resumed: string[]; expired: string[] }> | undefined;

	const activeDurableIds = () => {
		for (const id of durableIds) {
			if (!runner.isActive(id)) durableIds.delete(id);
		}
		return Array.from(durableIds);
	};
	const hasUnfinishedJobs = () => tests.size > 0
		|| Array.from(jobs.values()).some(job => !job.outcome)
		|| activeDurableIds().length > 0;
	const updateKeepAlive = () => {
		if (!deps.keepAlive) return;
		if (hasUnfinishedJobs()) {
			keepAliveTimer ??= setInterval(() => {
				// A durable job ends without telling the gateway when no port listens, so each tick checks.
				if (!hasUnfinishedJobs()) {
					updateKeepAlive();
					return;
				}
				try {
					deps.keepAlive?.();
				} catch {
					// Best effort; the next tick tries again.
				}
			}, deps.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS);
		} else if (keepAliveTimer) {
			clearInterval(keepAliveTimer);
			keepAliveTimer = undefined;
		}
	};
	const trackDurable = (jobId: string) => {
		durableIds.add(jobId);
		updateKeepAlive();
	};

	const broadcast = (job: Job, message: AiGatewayMessage) => {
		job.listeners.forEach(port => post(port, message));
	};

	const progress = (job: Job, phase: AiProgressPhase, receivedChars?: number) => {
		if (job.outcome) return;
		broadcast(job, {
			type: 'progress',
			jobId: job.id,
			phase,
			elapsedMs: now() - job.startedAt,
			...(receivedChars !== undefined ? { receivedChars } : {})
		});
	};

	const finish = (job: Job, outcome: Outcome) => {
		if (job.outcome) return;
		job.outcome = outcome;
		broadcast(job, outcome);
		updateKeepAlive();
		setTimeout(() => {
			if (jobs.get(job.id) === job) jobs.delete(job.id);
		}, retainMs);
	};

	// Settings are re-read on every call, so a model, key, or routing change applies to the next request.
	const resolveTask = (view: AiSettingsView, task: AiTask, profileId: string | undefined) => {
		const resolved = resolveProfile(view, task, profileId ? { profileId } : {});
		if (!resolved.ok) throw resolved.error;
		return resolved;
	};

	const resolveConnection = async (task: TranscriptJobTask, profileId: string | undefined): Promise<JobConnection> => {
		const { connection } = resolveTask(await deps.loadAiSettings(), task, profileId);
		return {
			kind: connection.kind,
			id: connection.id,
			...(connection.maxConcurrency !== undefined ? { maxConcurrency: connection.maxConcurrency } : {})
		};
	};

	/** One model request for a task: resolve, render, run with structured output where supported, parse. */
	const executeTask = async (
		task: AiTask,
		input: AiTaskInput,
		options: AiExecuteOptions,
		info: ExecuteInfo = {}
	): Promise<{ output: unknown; connectionKind: ConnectionKind }> => {
		const { profile, connection, credential } = resolveTask(await deps.loadAiSettings(), task, options.profileId);
		info.connection = connection;
		const { signal, onProgress } = options;
		if (signal.aborted) throw new AiError('cancelled', { connectionId: connection.id });
		const spec = outputSpec(task, input);
		// This device's override (Test, downgrade), then the connection's detected mode, then the default.
		const mode: StructuredOutputMode = spec
			? effectiveStructuredOutput(connection, await statusStore.get(connection.id))
			: 'none';
		if (spec) info.structuredMode = mode;
		const parse = (text: string) => {
			try {
				return parseOutput(task, input, text);
			} catch (error) {
				const aiError = toAiError(error);
				throw new AiError(aiError.code, { connectionId: connection.id, retryable: aiError.retryable, detail: aiError.detail });
			}
		};

		// A rejected structured-output parameter is not billed; retry once with prompt rules only, and
		// remember the downgrade on this device only after the retry succeeds. A later Test overwrites it.
		const withFallback = async (run: (structuredMode: StructuredOutputMode) => Promise<string>) => {
			try {
				return await run(mode);
			} catch (error) {
				const aiError = toAiError(error, connection.id);
				if (mode === 'none' || signal.aborted || !isStructuredOutputRejection(aiError)) throw aiError;
				const text = await run('none');
				info.fallback = true;
				await statusStore.update(connection.id, current => ({ ...(current ?? {}), structuredOutput: 'none' }))
					.catch(() => undefined);
				return text;
			}
		};

		if (isCliKind(connection.kind)) {
			const stdout = await withFallback(structuredMode => executeCli({
				kind: connection.kind as CliConnectionKind,
				...(profile.model ? { model: profile.model } : {}),
				...(profile.options?.reasoningEffort ? { effort: profile.options.reasoningEffort } : {}),
				prompt: renderCliPrompt(task, input),
				...(spec && structuredMode === 'json_schema' ? { outputSchema: spec.schema } : {})
			}, {
				connectionId: connection.id,
				signal,
				onHeartbeat: () => onProgress?.('heartbeat')
			}));
			return { output: parse(stdout), connectionKind: connection.kind };
		}

		let lastReceiveProgress: number | undefined;
		const runApi = (structuredMode: StructuredOutputMode) => executeApi({
			kind: connection.kind as ApiConnectionKind,
			baseUrl: connection.baseUrl ?? '',
			model: profile.model ?? '',
			...(credential ? { credential } : {}),
			messages: renderMessages(task, input),
			...(spec && structuredMode !== 'none' ? { structured: { ...spec, mode: structuredMode } } : {}),
			...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
			app: deps.app()
		}, {
			connectionId: connection.id,
			signal,
			...(connection.timeoutMs ? { idleTimeoutMs: connection.timeoutMs } : {}),
			onReceive: receivedChars => {
				if (!onProgress) return;
				const time = now();
				if (lastReceiveProgress !== undefined && time - lastReceiveProgress < RECEIVE_PROGRESS_INTERVAL_MS) return;
				lastReceiveProgress = time;
				onProgress('receiving', receivedChars);
			}
		});

		const text = await withFallback(runApi);
		return { output: parse(text), connectionKind: connection.kind };
	};

	const runner = createJobRunner({
		store,
		resolveConnection,
		execute: async <T extends TranscriptJobTask>(
			task: T,
			input: AiTaskInput<T>,
			options: { profileId?: string; signal: AbortSignal }
		) => {
			const result = await executeTask(task, input, options);
			return { output: result.output as AiTaskOutput<T>, connectionKind: result.connectionKind };
		},
		now,
		recordDiagnostics: entry => {
			void diagnostics.record(entry);
		},
		...deps.jobTiming
	});

	const recordCall = (task: AiDiagnosticEntry['task'], startedAt: number, info: ExecuteInfo, error?: AiError) => {
		if (!info.connection) return;
		void diagnostics.record({
			at: now(),
			task,
			kind: info.connection.kind,
			connectionId: info.connection.id,
			durationMs: Math.max(0, now() - startedAt),
			outcome: !error ? 'ok' : error.code === 'cancelled' ? 'cancelled' : 'error',
			...(error ? { code: error.code } : {}),
			...(error?.status !== undefined ? { status: error.status } : {}),
			...(info.structuredMode ? { structuredMode: info.structuredMode } : {}),
			...(info.fallback ? { fallback: true as const } : {})
		});
	};

	// One start-job or checkpoint operation at a time per job id, so a checkpoint-put cannot
	// overwrite a record that a concurrent start-job is turning into a running job.
	const serials = new Map<string, Promise<void>>();
	const serial = <R>(jobId: string, operation: () => Promise<R>): Promise<R> => {
		const result = (serials.get(jobId) ?? Promise.resolve()).then(operation);
		const tail = result.then(() => undefined, () => undefined);
		serials.set(jobId, tail);
		void tail.then(() => {
			if (serials.get(jobId) === tail) serials.delete(jobId);
		});
		return result;
	};

	const start = (port: AiPortLike, jobId: string, task: AiTask, rawInput: unknown, profileId?: string) => {
		const input = sanitizeTaskInput(task, rawInput);
		if (!input) {
			post(port, invalidRequest(jobId));
			return;
		}
		if (jobs.has(jobId)) {
			post(port, {
				type: 'error',
				jobId,
				error: serializeAiError(new AiError('provider-error', { detail: 'A job with this ID already exists.' }))
			});
			return;
		}
		const job: Job = {
			id: jobId,
			task,
			controller: new AbortController(),
			listeners: new Set([port]),
			startedAt: now()
		};
		jobs.set(jobId, job);
		updateKeepAlive();
		progress(job, 'started');
		const info: ExecuteInfo = {};
		executeTask(task, input, {
			...(profileId ? { profileId } : {}),
			signal: job.controller.signal,
			onProgress: (phase, receivedChars) => progress(job, phase, receivedChars)
		}, info).then(
			result => {
				finish(job, { type: 'result', jobId, ...result });
				recordCall(task, job.startedAt, info);
			},
			error => {
				const aiError = job.controller.signal.aborted ? new AiError('cancelled') : toAiError(error);
				finish(job, { type: 'error', jobId, error: serializeAiError(aiError) });
				recordCall(task, job.startedAt, info, aiError);
			}
		);
	};

	/** A connection Test, after an explicit click. The credential is read here, never sent by the client. */
	const startTest = (port: AiPortLike, jobId: string, connectionId: string) => {
		if (tests.has(jobId) || jobs.has(jobId)) {
			post(port, {
				type: 'error',
				jobId,
				error: serializeAiError(new AiError('provider-error', { detail: 'A job with this ID already exists.' }))
			});
			return;
		}
		const run: TestRun = { controller: new AbortController(), port };
		tests.set(jobId, run);
		updateKeepAlive();
		const startedAt = now();
		let connection: Connection | undefined;
		const record = (outcome: AiDiagnosticEntry['outcome'], fields: Partial<AiDiagnosticEntry> = {}) => {
			if (!connection) return;
			void diagnostics.record({
				at: now(),
				task: 'test',
				kind: connection.kind,
				connectionId: connection.id,
				durationMs: Math.max(0, now() - startedAt),
				outcome,
				...fields
			});
		};
		void (async () => {
			try {
				const view = await deps.loadAiSettings();
				connection = view.connections.find(item => item.id === connectionId);
				if (!connection) throw new AiError('not-configured', { reason: 'connection-missing', connectionId });
				const credential = view.credentials[connectionId]?.trim() ? view.credentials[connectionId] : undefined;
				const result = await runConnectionTest({
					connection,
					profiles: view.profiles.filter(profile => profile.connectionId === connectionId && profile.enabled),
					...(credential ? { credential } : {}),
					nativeMessaging: view.nativeMessaging
				}, {
					app: deps.app(),
					executeApi,
					executeCli,
					health: deps.checkCliHealth ?? ((kind, options) => checkCliHealth(kind, options)),
					...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
					now
				}, {
					signal: run.controller.signal,
					onStep: (step, profileId) => post(port, { type: 'test-step', jobId, step, ...(profileId ? { profileId } : {}) })
				});
				// Status is per device: only this gateway creates entries; Settings may delete them.
				await statusStore.update(connectionId, previous => statusFromTestResult(result, previous)).catch(error => {
					console.warn('[ai] The connection status was not saved:', error instanceof Error ? error.message : String(error));
				});
				record(result.state === 'ok' ? 'ok' : 'error', {
					...(result.error ? { code: result.error.code } : {}),
					...(result.error?.status !== undefined ? { status: result.error.status } : {}),
					...(result.structuredOutput ? { structuredMode: result.structuredOutput } : {})
				});
				post(port, { type: 'test-result', jobId, result });
			} catch (error) {
				const aiError = run.controller.signal.aborted ? new AiError('cancelled', { connectionId }) : toAiError(error, connectionId);
				record(aiError.code === 'cancelled' ? 'cancelled' : 'error', {
					code: aiError.code,
					...(aiError.status !== undefined ? { status: aiError.status } : {})
				});
				post(port, { type: 'error', jobId, error: serializeAiError(aiError) });
			} finally {
				tests.delete(jobId);
				updateKeepAlive();
			}
		})();
	};

	const detach = (port: AiPortLike) => {
		// A Test is interactive: it stops when its Settings page goes away.
		for (const run of tests.values()) {
			if (run.port === port) run.controller.abort();
		}
		for (const job of jobs.values()) {
			if (!job.listeners.delete(port)) continue;
			if (!job.outcome && job.listeners.size === 0 && CANCEL_ON_DETACH.has(job.task)) {
				job.controller.abort();
			}
		}
		// Durable jobs keep running without listeners; the port only stops receiving their events.
		const state = ports.get(port);
		if (!state) return;
		state.closed = true;
		state.durable.forEach(stop => stop());
		state.durable.clear();
	};

	const attachSingle = (port: AiPortLike, jobId: string) => {
		const job = jobs.get(jobId);
		if (!job) {
			post(port, {
				type: 'error',
				jobId,
				error: serializeAiError(new AiError('provider-error', {
					retryable: true,
					detail: 'The job is no longer running.'
				}))
			});
			return;
		}
		job.listeners.add(port);
		post(port, job.outcome ?? {
			type: 'progress',
			jobId: job.id,
			phase: 'started',
			elapsedMs: now() - job.startedAt
		});
	};

	const durableListener = (port: AiPortLike, state: PortState, jobId: string): JobListener => event => {
		post(port, event);
		if (event.type === 'job-state' && event.status !== 'running') {
			state.durable.delete(jobId);
			updateKeepAlive();
		}
	};

	// Replaces an earlier listener of the same port and job, so a repeated attach is not doubled.
	const releaseDurable = (state: PortState, jobId: string) => {
		state.durable.get(jobId)?.();
		state.durable.delete(jobId);
	};

	const registerDurable = (state: PortState, jobId: string, stop: JobDetach) => {
		trackDurable(jobId);
		if (state.closed || !runner.isActive(jobId)) {
			stop();
			return;
		}
		state.durable.set(jobId, stop);
	};

	const startJob = (port: AiPortLike, state: PortState, message: Extract<AiClientMessage, { type: 'start-job' }>) => {
		const { jobId, task, profileId } = message;
		const input = sanitizeJobInput(message.input);
		let expected: string | undefined;
		try {
			expected = input ? transcriptJobId(task, input.identity, input.segments) : undefined;
		} catch {
			expected = undefined;
		}
		if (!input || expected !== jobId) {
			post(port, invalidRequest(jobId));
			return;
		}
		void serial(jobId, async () => {
			releaseDurable(state, jobId);
			const stop = await runner.start(jobId, task, input, profileId, durableListener(port, state, jobId));
			registerDurable(state, jobId, stop);
		}).catch(error => post(port, { type: 'error', jobId, error: serializeAiError(toAiError(error)) }));
	};

	const attachDurable = async (port: AiPortLike, state: PortState, jobId: string) => {
		releaseDurable(state, jobId);
		let stop: JobDetach | undefined;
		try {
			stop = await runner.attach(jobId, durableListener(port, state, jobId));
		} catch (error) {
			post(port, { type: 'error', jobId, error: serializeAiError(toAiError(error)) });
			return;
		}
		if (stop) {
			registerDurable(state, jobId, stop);
			return;
		}
		// No record: perhaps a single-call job that happens to use a job-shaped id.
		attachSingle(port, jobId);
	};

	const reply = (port: AiPortLike, message: AiCheckpointMessage) => post(port, message);

	const checkpointGet = (port: AiPortLike, requestId: string, jobId: string) => {
		// Reads only: never starts, resumes, or attaches, so a Reader restore makes no request.
		void serial(jobId, () => runner.get(jobId)).then(
			snapshot => reply(port, {
				type: 'checkpoint',
				requestId,
				jobId,
				ok: true,
				...(snapshot ? {
					record: {
						status: snapshot.status,
						results: snapshot.results,
						completedSegments: snapshot.completedSegments,
						totalSegments: snapshot.totalSegments
					}
				} : {})
			}),
			() => reply(port, { type: 'checkpoint', requestId, jobId, ok: false })
		);
	};

	const checkpointClear = (port: AiPortLike, requestId: string, jobId: string) => {
		void serial(jobId, async () => {
			await runner.cancel(jobId);
			await store.remove(jobId);
		}).then(
			() => reply(port, { type: 'checkpoint', requestId, jobId, ok: true }),
			() => reply(port, { type: 'checkpoint', requestId, jobId, ok: false })
		).finally(updateKeepAlive);
	};

	const checkpointPut = (port: AiPortLike, raw: unknown) => {
		const message = sanitizeCheckpointPut(raw);
		if (!message) {
			post(port, invalidRequest(String((raw as { jobId?: unknown }).jobId ?? '')));
			return;
		}
		const { requestId, jobId, task, identity, segmentCount, segments } = message;
		let expected: string | undefined;
		try {
			expected = transcriptJobId(task, identity, segments);
		} catch {
			expected = undefined;
		}
		if (expected !== jobId) {
			post(port, invalidRequest(jobId));
			return;
		}
		void serial(jobId, async () => {
			// A running job owns its record; a manual save would race its checkpoints.
			if (runner.isActive(jobId)) return false;
			const existing = await store.get(jobId);
			if (existing?.status === 'running') return false;
			const texts = segments.map(segment => segment.text);
			const segmentHash = hashSegments(identity.scope, texts);
			const same = existing !== undefined
				&& existing.task === task
				&& existing.segmentCount === segmentCount
				&& existing.segmentHash === segmentHash;
			// Empty sources are complete without a result item, as in the runner.
			const emptyIds = new Set(texts.flatMap((text, id) => (isEmptySourceSegment(task, text) ? [id] : [])));
			const results: Record<string, string | ReadingToken[]> = {};
			for (const item of message.results) {
				if (emptyIds.has(item.id)) continue;
				results[item.id] = 'text' in item ? item.text : item.tokens;
			}
			const complete = Object.keys(results).length + emptyIds.size === segmentCount;
			const timestamp = now();
			const record: AiJobRecord = {
				v: 1,
				id: jobId,
				task,
				identity: { ...identity },
				segmentCount,
				segmentHash,
				...(same && existing.profileId ? { profileId: existing.profileId } : {}),
				status: complete ? 'completed' : 'incomplete',
				results,
				attempts: same ? { ...existing.attempts } : { requests: 0, retries: 0, splits: 0 },
				...(same && existing.cliPromptChars !== undefined ? { cliPromptChars: existing.cliPromptChars } : {}),
				createdAt: same ? existing.createdAt : timestamp,
				updatedAt: timestamp
			};
			// The source texts let a later snapshot count empty segments; a later start-job (Continue
			// remaining) rewrites the input with its instruction before any request.
			const storedInput = same ? await store.getInput(jobId) : undefined;
			await store.putInput(jobId, { instruction: storedInput?.instruction ?? '', segments: texts });
			await store.put(record);
			return true;
		}).then(
			ok => reply(port, { type: 'checkpoint', requestId, jobId, ok }),
			() => reply(port, { type: 'checkpoint', requestId, jobId, ok: false })
		);
	};

	return {
		handlePort(port) {
			if (port.name !== AI_PORT_NAME) return;
			const state: PortState = { durable: new Map(), closed: false };
			ports.set(port, state);
			port.onMessage.addListener(message => {
				if (!isAiClientMessage(message)) {
					const jobId = (message as { jobId?: unknown } | null)?.jobId;
					post(port, invalidRequest(typeof jobId === 'string' ? jobId : ''));
					return;
				}
				switch (message.type) {
					case 'ping':
						return;
					case 'start':
						start(port, message.jobId, message.task, message.input, message.profileId);
						return;
					case 'start-job':
						startJob(port, state, message);
						return;
					case 'test':
						startTest(port, message.jobId, message.connectionId);
						return;
					case 'cancel':
						tests.get(message.jobId)?.controller.abort();
						jobs.get(message.jobId)?.controller.abort();
						if (parseJobId(message.jobId)) {
							// Queued behind a pending start-job of this id, so a cancel sent right after it applies.
							const { jobId } = message;
							void serial(jobId, () => runner.cancel(jobId)).catch(() => undefined).finally(updateKeepAlive);
						}
						return;
					case 'attach':
						if (parseJobId(message.jobId)) void attachDurable(port, state, message.jobId);
						else attachSingle(port, message.jobId);
						return;
					case 'checkpoint-get':
						checkpointGet(port, message.requestId, message.jobId);
						return;
					case 'checkpoint-clear':
						checkpointClear(port, message.requestId, message.jobId);
						return;
					case 'checkpoint-put':
						checkpointPut(port, message);
						return;
				}
			});
			port.onDisconnect.addListener(() => detach(port));
		},
		init() {
			initPromise ??= (async () => {
				// Best effort: a leftover Phase 3 key only wastes storage.
				await store.removeLegacyCheckpoints().catch(() => undefined);
				await statusStore.removeLegacyCache().catch(() => undefined);
				const outcome = await runner.resumeRunning();
				outcome.resumed.forEach(trackDurable);
				return outcome;
			})();
			return initPromise;
		},
		activeJobIds() {
			return [
				...Array.from(tests.keys()),
				...Array.from(jobs.values()).filter(job => !job.outcome).map(job => job.id),
				...activeDurableIds()
			];
		}
	};
}
