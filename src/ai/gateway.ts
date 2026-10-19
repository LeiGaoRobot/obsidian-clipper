import type { Settings } from '../types/types';
import { executeApiCall, type AppIdentity } from './adapters/http';
import { executeCliCall } from './adapters/native-cli';
import { isCliKind } from './connection-kind';
import { AiError, toAiError } from './errors';
import { parseEnvelopeResponse } from './prompt-envelope';
import {
	AI_PORT_NAME,
	isAiClientMessage,
	serializeAiError,
	type AiGatewayMessage,
	type AiProgressPhase,
	type PromptsInput
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
	executeCli?: typeof executeCliCall;
	now?: () => number;
	/** How long a finished job's outcome stays available to `attach`. */
	retainMs?: number;
}

// Interactive tasks are pointless once their UI is gone; batch tasks finish like v1 background requests did.
const CANCEL_ON_DETACH: ReadonlySet<AiTask> = new Set<AiTask>(['interpret', 'edit', 'explain']);
const RECEIVE_PROGRESS_INTERVAL_MS = 500;
const DEFAULT_RETAIN_MS = 60_000;

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
	const executeCli = deps.executeCli ?? executeCliCall;
	const retainMs = deps.retainMs ?? DEFAULT_RETAIN_MS;

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
		setTimeout(() => {
			if (jobs.get(job.id) === job) jobs.delete(job.id);
		}, retainMs);
	};

	const execute = async (
		job: Job,
		input: PromptsInput,
		profileId: string | undefined
	): Promise<{ responses: Record<string, unknown>; connectionKind: ConnectionKind }> => {
		const view = deriveAiSettings(await deps.loadSettings(), { nativeMessaging: deps.nativeMessaging() });
		const resolved = resolveProfile(view, job.task, profileId ? { profileId } : {});
		if (!resolved.ok) throw resolved.error;
		const { profile, connection, credential } = resolved;
		const signal = job.controller.signal;
		if (signal.aborted) throw new AiError('cancelled', { connectionId: connection.id });

		if (isCliKind(connection.kind)) {
			const responses = await executeCli({
				kind: connection.kind as CliConnectionKind,
				...(profile.model ? { model: profile.model } : {}),
				...(profile.options?.reasoningEffort ? { effort: profile.options.reasoningEffort } : {}),
				context: input.context,
				prompts: input.prompts
			}, {
				connectionId: connection.id,
				signal,
				onHeartbeat: () => progress(job, 'heartbeat')
			});
			return { responses, connectionKind: connection.kind };
		}

		let lastReceiveProgress: number | undefined;
		const text = await executeApi({
			kind: connection.kind as ApiConnectionKind,
			baseUrl: connection.baseUrl ?? '',
			model: profile.model ?? '',
			...(credential ? { credential } : {}),
			context: input.context,
			prompts: input.prompts,
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
		const { promptResponses } = parseEnvelopeResponse(text, input.prompts);
		if (promptResponses.length === 0) {
			throw new AiError('bad-response', {
				connectionId: connection.id,
				detail: text.slice(0, 2000) || 'The model returned an empty response.'
			});
		}
		return {
			responses: Object.fromEntries(promptResponses.map(item => [item.key, item.user_response])),
			connectionKind: connection.kind
		};
	};

	const start = (port: AiPortLike, jobId: string, task: AiTask, input: PromptsInput, profileId?: string) => {
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
						if (job.outcome) post(port, job.outcome);
						else progress(job, 'started');
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
