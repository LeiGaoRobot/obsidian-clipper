import type { Settings } from '../types/types';
import { executeApiCall, type AppIdentity } from './adapters/http';
import { runCliPrompt } from './adapters/native-cli';
import {
	isStructuredOutputRejection,
	probeStructuredOutput,
	type StructuredOutputCache,
	type StructuredOutputMode
} from './capabilities';
import { isCliKind } from './connection-kind';
import {
	outputSpec,
	parseOutput,
	renderCliPrompt,
	renderMessages,
	type AiTaskInput
} from './contracts';
import { AiError, toAiError } from './errors';
import {
	AI_PORT_NAME,
	isAiClientMessage,
	sanitizeTaskInput,
	serializeAiError,
	type AiGatewayMessage,
	type AiProgressPhase
} from './protocol';
import { resolveProfile } from './resolve';
import { deriveAiSettings } from './settings-view';
import type { AiTask, ApiConnectionKind, CliConnectionKind, ConnectionKind, NativeMessagingSupport } from './types';

export interface AiPortLike {
	name: string;
	postMessage(message: unknown): void;
	onMessage: { addListener(listener: (message: unknown) => void): void };
	onDisconnect: { addListener(listener: () => void): void };
}

export interface AiGatewayDeps {
	loadSettings: () => Promise<Settings>;
	nativeMessaging: () => NativeMessagingSupport;
	app: () => AppIdentity;
	executeApi?: typeof executeApiCall;
	executeCli?: typeof runCliPrompt;
	/** Remembers a structured-output downgrade per connection. Omit to always use the default. */
	structuredOutput?: StructuredOutputCache;
	now?: () => number;
	/**
	 * Called while any job is unfinished. In Chrome, an extension API call resets the service
	 * worker's idle timer; a pending fetch does not, so batch jobs need this once their caller is gone.
	 */
	keepAlive?: () => void;
	keepAliveIntervalMs?: number;
	/** How long a finished job's outcome stays available to `attach`. */
	retainMs?: number;
}

// Interactive tasks are pointless once their UI is gone. Batch tasks finish so their outcome can be
// replayed to an `attach` within the retention window (Phase 4 adds durable reattach).
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

export interface AiGateway {
	handlePort(port: AiPortLike): void;
	/** For tests and diagnostics. */
	activeJobIds(): string[];
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
	let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

	const hasUnfinishedJobs = () => Array.from(jobs.values()).some(job => !job.outcome);
	const updateKeepAlive = () => {
		if (!deps.keepAlive) return;
		if (hasUnfinishedJobs()) {
			keepAliveTimer ??= setInterval(() => {
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

	const execute = async (
		job: Job,
		input: AiTaskInput,
		profileId: string | undefined
	): Promise<{ output: unknown; connectionKind: ConnectionKind }> => {
		const view = deriveAiSettings(await deps.loadSettings(), { nativeMessaging: deps.nativeMessaging() });
		const resolved = resolveProfile(view, job.task, profileId ? { profileId } : {});
		if (!resolved.ok) throw resolved.error;
		const { profile, connection, credential } = resolved;
		const signal = job.controller.signal;
		if (signal.aborted) throw new AiError('cancelled', { connectionId: connection.id });
		const spec = outputSpec(job.task, input);
		const mode: StructuredOutputMode = spec
			? await probeStructuredOutput(connection, deps.structuredOutput)
			: 'none';
		const parse = (text: string) => {
			try {
				return parseOutput(job.task, input, text);
			} catch (error) {
				const aiError = toAiError(error);
				throw new AiError(aiError.code, { connectionId: connection.id, retryable: aiError.retryable, detail: aiError.detail });
			}
		};

		// A rejected structured-output parameter is not billed; retry once with prompt rules only, and
		// remember the downgrade only after the retry succeeds.
		const withFallback = async (run: (structuredMode: StructuredOutputMode) => Promise<string>) => {
			try {
				return await run(mode);
			} catch (error) {
				const aiError = toAiError(error, connection.id);
				if (mode === 'none' || signal.aborted || !isStructuredOutputRejection(aiError)) throw aiError;
				const text = await run('none');
				await deps.structuredOutput?.set(connection.id, connection.baseUrl, 'none');
				return text;
			}
		};

		if (isCliKind(connection.kind)) {
			const stdout = await withFallback(structuredMode => executeCli({
				kind: connection.kind as CliConnectionKind,
				...(profile.model ? { model: profile.model } : {}),
				...(profile.options?.reasoningEffort ? { effort: profile.options.reasoningEffort } : {}),
				prompt: renderCliPrompt(job.task, input),
				...(spec && structuredMode === 'json_schema' ? { outputSchema: spec.schema } : {})
			}, {
				connectionId: connection.id,
				signal,
				onHeartbeat: () => progress(job, 'heartbeat')
			}));
			return { output: parse(stdout), connectionKind: connection.kind };
		}

		let lastReceiveProgress: number | undefined;
		const runApi = (structuredMode: StructuredOutputMode) => executeApi({
			kind: connection.kind as ApiConnectionKind,
			baseUrl: connection.baseUrl ?? '',
			model: profile.model ?? '',
			...(credential ? { credential } : {}),
			messages: renderMessages(job.task, input),
			...(spec && structuredMode !== 'none' ? { structured: { ...spec, mode: structuredMode } } : {}),
			...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
			app: deps.app()
		}, {
			connectionId: connection.id,
			signal,
			...(connection.timeoutMs ? { idleTimeoutMs: connection.timeoutMs } : {}),
			onReceive: receivedChars => {
				const time = now();
				if (lastReceiveProgress !== undefined && time - lastReceiveProgress < RECEIVE_PROGRESS_INTERVAL_MS) return;
				lastReceiveProgress = time;
				progress(job, 'receiving', receivedChars);
			}
		});

		const text = await withFallback(runApi);
		return { output: parse(text), connectionKind: connection.kind };
	};

	const start = (port: AiPortLike, jobId: string, task: AiTask, rawInput: unknown, profileId?: string) => {
		const input = sanitizeTaskInput(task, rawInput);
		if (!input) {
			post(port, {
				type: 'error',
				jobId,
				error: serializeAiError(new AiError('provider-error', { detail: 'Invalid AI request.' }))
			});
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
		execute(job, input, profileId).then(
			result => finish(job, { type: 'result', jobId, ...result }),
			error => {
				const aiError = job.controller.signal.aborted ? new AiError('cancelled') : toAiError(error);
				finish(job, { type: 'error', jobId, error: serializeAiError(aiError) });
			}
		);
	};

	const detach = (port: AiPortLike) => {
		for (const job of jobs.values()) {
			if (!job.listeners.delete(port)) continue;
			if (!job.outcome && job.listeners.size === 0 && CANCEL_ON_DETACH.has(job.task)) {
				job.controller.abort();
			}
		}
	};

	return {
		handlePort(port) {
			if (port.name !== AI_PORT_NAME) return;
			port.onMessage.addListener(message => {
				if (!isAiClientMessage(message)) {
					const jobId = (message as { jobId?: unknown } | null)?.jobId;
					post(port, {
						type: 'error',
						jobId: typeof jobId === 'string' ? jobId : '',
						error: serializeAiError(new AiError('provider-error', { detail: 'Invalid AI request.' }))
					});
					return;
				}
				switch (message.type) {
					case 'ping':
						return;
					case 'start':
						start(port, message.jobId, message.task, message.input, message.profileId);
						return;
					case 'cancel':
						jobs.get(message.jobId)?.controller.abort();
						return;
					case 'attach': {
						const job = jobs.get(message.jobId);
						if (!job) {
							post(port, {
								type: 'error',
								jobId: message.jobId,
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
						return;
					}
				}
			});
			port.onDisconnect.addListener(() => detach(port));
		},
		activeJobIds() {
			return Array.from(jobs.values()).filter(job => !job.outcome).map(job => job.id);
		}
	};
}
