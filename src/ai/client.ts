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
import type { AiTask, AiTestResult, AiTestStep, ConnectionKind } from './types';

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

export interface GatewayRequestOptions {
	signal?: AbortSignal;
	connect?: (name: string) => AiClientPort;
	keepaliveMs?: number;
}

type Settlement<R> = { value: R } | { error: AiError };

/**
 * Opens a Port, sends `start`, and settles on the message `handle` maps to a value or an error.
 * Pings keep the service worker alive; an abort sends `cancel`; a disconnect rejects.
 */
function gatewayRequest<R>(
	jobId: string,
	start: Record<string, unknown>,
	options: GatewayRequestOptions,
	handle: (message: AiGatewayMessage) => Settlement<R> | undefined
): Promise<R> {
	if (options.signal?.aborted) return Promise.reject(new AiError('cancelled'));
	let port: AiClientPort;
	try {
		port = (options.connect ?? connectToGateway)(AI_PORT_NAME);
	} catch (error) {
		return Promise.reject(new AiError('network', {
			detail: error instanceof Error ? error.message : String(error)
		}));
	}

	return new Promise<R>((resolve, reject) => {
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
			const outcome = handle(message);
			if (!outcome) return;
			if ('error' in outcome) settle(() => reject(outcome.error));
			else settle(() => resolve(outcome.value));
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
			port.postMessage(start);
		} catch (error) {
			settle(() => reject(new AiError('network', {
				retryable: true,
				detail: error instanceof Error ? error.message : String(error)
			})));
		}
	});
}

/** Runs one AI task through the background gateway. Rejects with an AiError. */
export function runAiTask<T extends AiTask>(
	task: T,
	input: AiTaskInput<T>,
	options: RunAiTaskOptions = {}
): Promise<AiTaskResult<T>> {
	const jobId = createJobId(task);
	return gatewayRequest<AiTaskResult<T>>(jobId, {
		type: 'start',
		jobId,
		task,
		...(options.profileId ? { profileId: options.profileId } : {}),
		input
	}, options, message => {
		if (message.type === 'progress') {
			options.onProgress?.({
				phase: message.phase,
				elapsedMs: message.elapsedMs,
				...(message.receivedChars !== undefined ? { receivedChars: message.receivedChars } : {})
			});
			return undefined;
		}
		// The gateway validated the output against the task contract.
		if (message.type === 'result') return { value: { output: message.output as AiTaskOutput<T>, connectionKind: message.connectionKind } };
		if (message.type === 'error') return { error: deserializeAiError(message.error) };
		return undefined;
	});
}

export interface TestConnectionOptions extends GatewayRequestOptions {
	onStep?: (step: AiTestStep, profileId?: string) => void;
}

/**
 * Removes the connection's entry from this device's `ai_connection_status` through the gateway,
 * which serializes every write of that key. Sends no model request. Rejects with an AiError.
 */
export function clearConnectionStatus(connectionId: string, options: GatewayRequestOptions = {}): Promise<void> {
	jobSequence += 1;
	const jobId = `ai-status-${Date.now()}-${jobSequence}-${Math.random().toString(36).slice(2, 8)}`;
	return gatewayRequest<void>(jobId, { type: 'status-clear', jobId, connectionId }, options, message => {
		if (message.type === 'status-cleared') return { value: undefined };
		if (message.type === 'error') return { error: deserializeAiError(message.error) };
		return undefined;
	});
}

/**
 * Tests a connection through the background gateway, which reads its key from device storage:
 * the message carries only the connection id. Call it only from an explicit user action; it may
 * send a minimal billable request. Rejects with an AiError (`cancelled` on abort).
 */
export function testConnection(connectionId: string, options: TestConnectionOptions = {}): Promise<AiTestResult> {
	jobSequence += 1;
	const jobId = `ai-test-${Date.now()}-${jobSequence}-${Math.random().toString(36).slice(2, 8)}`;
	return gatewayRequest<AiTestResult>(jobId, { type: 'test', jobId, connectionId }, options, message => {
		if (message.type === 'test-step') {
			options.onStep?.(message.step, message.profileId);
			return undefined;
		}
		if (message.type === 'test-result') return { value: message.result };
		if (message.type === 'error') return { error: deserializeAiError(message.error) };
		return undefined;
	});
}
