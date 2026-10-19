import browser from '../utils/browser-polyfill';
import { AiError } from './errors';
import {
	AI_KEEPALIVE_INTERVAL_MS,
	AI_PORT_NAME,
	deserializeAiError,
	type AiGatewayMessage,
	type AiProgressPhase
} from './protocol';
import type { AiTaskInput, AiTaskOutput } from './contracts';
import type { AiTask, ConnectionKind } from './types';

export interface AiClientPort {
	postMessage(message: unknown): void;
	disconnect(): void;
	onMessage: {
		addListener(listener: (message: unknown) => void): void;
		removeListener(listener: (message: unknown) => void): void;
	};
	onDisconnect: {
		addListener(listener: () => void): void;
		removeListener(listener: () => void): void;
	};
}

export interface AiProgress {
	phase: AiProgressPhase;
	elapsedMs: number;
	receivedChars?: number;
}

export interface AiTaskResult<T extends AiTask = AiTask> {
	output: AiTaskOutput<T>;
	connectionKind: ConnectionKind;
}

export interface RunAiTaskOptions {
	/** An explicit profile for this run. Omit to use task routing. */
	profileId?: string;
	signal?: AbortSignal;
	onProgress?: (progress: AiProgress) => void;
	connect?: (name: string) => AiClientPort;
	keepaliveMs?: number;
}

let jobSequence = 0;

function createJobId(task: AiTask): string {
	jobSequence += 1;
	return `ai-${task}-${Date.now()}-${jobSequence}-${Math.random().toString(36).slice(2, 8)}`;
}

function connectToGateway(name: string): AiClientPort {
	return browser.runtime.connect({ name }) as unknown as AiClientPort;
}

/** Runs one AI task through the background gateway. Rejects with an AiError. */
export function runAiTask<T extends AiTask>(
	task: T,
	input: AiTaskInput<T>,
	options: RunAiTaskOptions = {}
): Promise<AiTaskResult<T>> {
	if (options.signal?.aborted) return Promise.reject(new AiError('cancelled'));
	const jobId = createJobId(task);
	let port: AiClientPort;
	try {
		port = (options.connect ?? connectToGateway)(AI_PORT_NAME);
	} catch (error) {
		return Promise.reject(new AiError('network', {
			detail: error instanceof Error ? error.message : String(error)
		}));
	}

	return new Promise<AiTaskResult<T>>((resolve, reject) => {
		let settled = false;
		const keepalive = setInterval(() => {
			try {
				port.postMessage({ type: 'ping' });
			} catch {
				// A closed port is reported through onDisconnect.
			}
		}, options.keepaliveMs ?? AI_KEEPALIVE_INTERVAL_MS);

		const cleanup = () => {
			clearInterval(keepalive);
			port.onMessage.removeListener(onMessage);
			port.onDisconnect.removeListener(onDisconnect);
			options.signal?.removeEventListener('abort', onAbort);
			try {
				port.disconnect();
			} catch {
				// Already disconnected.
			}
		};
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onMessage = (value: unknown) => {
			const message = value as AiGatewayMessage;
			if (!message || message.jobId !== jobId) return;
			if (message.type === 'progress') {
				options.onProgress?.({
					phase: message.phase,
					elapsedMs: message.elapsedMs,
					...(message.receivedChars !== undefined ? { receivedChars: message.receivedChars } : {})
				});
			} else if (message.type === 'result') {
				// The gateway validated the output against the task contract.
				settle(() => resolve({ output: message.output as AiTaskOutput<T>, connectionKind: message.connectionKind }));
			} else if (message.type === 'error') {
				settle(() => reject(deserializeAiError(message.error)));
			}
		};
		const onDisconnect = () => {
			settle(() => reject(new AiError('network', {
				retryable: true,
				detail: 'The extension background stopped before the request finished.'
			})));
		};
		const onAbort = () => {
			if (settled) return;
			try {
				port.postMessage({ type: 'cancel', jobId });
			} catch {
				// The gateway also cancels interactive jobs when their port disconnects.
			}
			settle(() => reject(new AiError('cancelled')));
		};

		port.onMessage.addListener(onMessage);
		port.onDisconnect.addListener(onDisconnect);
		options.signal?.addEventListener('abort', onAbort, { once: true });
		try {
			port.postMessage({
				type: 'start',
				jobId,
				task,
				...(options.profileId ? { profileId: options.profileId } : {}),
				input
			});
		} catch (error) {
			settle(() => reject(new AiError('network', {
				retryable: true,
				detail: error instanceof Error ? error.message : String(error)
			})));
		}
	});
}
