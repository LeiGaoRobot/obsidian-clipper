import browser from './browser-polyfill';
import {
	NATIVE_CLI_HOST_NAME,
	NATIVE_CLI_PROTOCOL_VERSION,
	NativeCliErrorCode,
	NativeCliHealth,
	NativeCliHostResponse,
	NativeCliRequest,
	NativeCliHeartbeat,
	buildNativeCliCancelRequest,
	isNativeCliHeartbeat,
	buildNativeCliHealthRequest
} from './native-cli-contract';
import { isCancellation, raceWithRequestCancellation, throwIfRequestAborted } from '../ai/abort';
import { AiError } from '../ai/errors';

interface NativePortLike {
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

const NATIVE_CLI_HEALTH_TIMEOUT_MS = 5000;
const NATIVE_CLI_CANCEL_CLEANUP_MS = 3000;

export class NativeCliUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NativeCliUnavailableError';
	}
}

export class NativeCliExecutionError extends Error {
	code: NativeCliErrorCode;
	details?: Record<string, unknown>;

	constructor(code: NativeCliErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = 'NativeCliExecutionError';
		this.code = code;
		this.details = details;
	}
}

function responseError(response: NativeCliHostResponse): Error {
	if (response.errorCode === 'cancelled') return new AiError('cancelled');
	return new NativeCliExecutionError(
		response.errorCode || 'cli-failed',
		response.error || response.stderr || 'The local CLI failed to execute.',
		response.details
	);
}

function sendThroughNativePort(
	request: NativeCliRequest | ReturnType<typeof buildNativeCliHealthRequest>,
	signal?: AbortSignal,
	timeoutMs?: number,
	onHeartbeat?: (heartbeat: NativeCliHeartbeat) => void
): Promise<NativeCliHostResponse> {
	throwIfRequestAborted(signal);
	const runtime = browser.runtime as typeof browser.runtime & {
		connectNative?: (application: string) => NativePortLike;
	};
	if (typeof runtime.connectNative !== 'function') {
		throw new NativeCliUnavailableError('Native Messaging ports are not available in this browser.');
	}

	let port: NativePortLike;
	try {
		port = runtime.connectNative(NATIVE_CLI_HOST_NAME);
	} catch (error) {
		throw new NativeCliUnavailableError(error instanceof Error ? error.message : String(error));
	}

	return new Promise((resolve, reject) => {
		let callerSettled = false;
		let aborted = false;
		let responseTimer: ReturnType<typeof setTimeout> | undefined;
		let abortCleanupTimer: ReturnType<typeof setTimeout> | undefined;
		const disconnectErrorMessage = () => (browser.runtime as typeof browser.runtime & {
			lastError?: { message?: string };
		}).lastError?.message;
		const consumeDisconnectError = () => {
			void disconnectErrorMessage();
			port.onDisconnect.removeListener(consumeDisconnectError);
		};
		const cleanup = () => {
			if (responseTimer) clearTimeout(responseTimer);
			if (abortCleanupTimer) clearTimeout(abortCleanupTimer);
			port.onMessage.removeListener(onMessage);
			port.onDisconnect.removeListener(onDisconnect);
			port.onDisconnect.addListener(consumeDisconnectError);
			signal?.removeEventListener('abort', onAbort);
			try {
				port.disconnect();
			} catch {
				port.onDisconnect.removeListener(consumeDisconnectError);
				// The browser may already have closed the native port.
			}
		};
		const settle = (callback: () => void) => {
			if (callerSettled) return;
			callerSettled = true;
			cleanup();
			callback();
		};
		const onMessage = (value: unknown) => {
			if (isNativeCliHeartbeat(value)) {
				if (value.requestId === request.requestId && !callerSettled) onHeartbeat?.(value);
				return;
			}
			const response = value as NativeCliHostResponse;
			if (!response) return;
			if (response.requestId !== request.requestId) {
				if (response.requestId == null) {
					settle(() => reject(new NativeCliExecutionError(
						'protocol-mismatch',
						'The installed Native Messaging Host uses an incompatible protocol.',
						{ protocolVersion: NATIVE_CLI_PROTOCOL_VERSION }
					)));
				}
				return;
			}
			if (aborted) {
				cleanup();
				return;
			}
			settle(() => {
				if (response.ok) resolve(response);
				else reject(responseError(response));
			});
		};
		const onDisconnect = () => {
			const errorMessage = disconnectErrorMessage();
			if (aborted) {
				cleanup();
				return;
			}
			settle(() => reject(new NativeCliUnavailableError(
				errorMessage || 'The Native Messaging Host disconnected.'
			)));
		};
		const onAbort = () => {
			if (callerSettled) return;
			aborted = true;
			callerSettled = true;
			try {
				port.postMessage(buildNativeCliCancelRequest(request.requestId));
			} catch {
				cleanup();
				return;
			}
			abortCleanupTimer = setTimeout(cleanup, NATIVE_CLI_CANCEL_CLEANUP_MS);
			reject(new AiError('cancelled'));
		};

		port.onMessage.addListener(onMessage);
		port.onDisconnect.addListener(onDisconnect);
		signal?.addEventListener('abort', onAbort, { once: true });
		if (timeoutMs) {
			responseTimer = setTimeout(() => {
				settle(() => reject(new NativeCliExecutionError(
					'protocol-mismatch',
					'The installed Native Messaging Host did not respond using the current protocol.',
					{ protocolVersion: NATIVE_CLI_PROTOCOL_VERSION }
				)));
			}, timeoutMs);
		}
		port.postMessage(request);
	});
}

export async function sendNativeCliRequest(
	request: NativeCliRequest,
	signal?: AbortSignal,
	onHeartbeat?: (heartbeat: NativeCliHeartbeat) => void
): Promise<NativeCliHostResponse> {
	throwIfRequestAborted(signal);
	const runtime = browser.runtime as typeof browser.runtime & {
		connectNative?: (application: string) => NativePortLike;
	};
	try {
		let response: NativeCliHostResponse;
		if (typeof runtime.connectNative === 'function') {
			response = await sendThroughNativePort(
				onHeartbeat ? { ...request, heartbeat: true } : request,
				signal,
				undefined,
				onHeartbeat
			);
		} else {
			if (typeof browser.runtime.sendNativeMessage !== 'function') {
				throw new NativeCliUnavailableError('Native Messaging is not available in this browser.');
			}
			// One-shot messages take the first Host reply as the response, so never request heartbeats.
			const { heartbeat: _heartbeat, ...oneShotRequest } = request;
			response = await raceWithRequestCancellation(
				browser.runtime.sendNativeMessage(NATIVE_CLI_HOST_NAME, oneShotRequest) as Promise<NativeCliHostResponse>,
				signal
			);
			if (!response || response.ok !== true) throw responseError(response || { ok: false });
		}
		return response;
	} catch (error) {
		if (isCancellation(error) || error instanceof NativeCliExecutionError || error instanceof NativeCliUnavailableError) {
			throw error;
		}
		throw new NativeCliUnavailableError(error instanceof Error ? error.message : String(error));
	}
}

export interface NativeCliHealthResult {
	health: NativeCliHealth;
	/** `message` when the browser offers only one-shot messages (Safari), which cannot be cancelled. */
	transport: 'port' | 'message';
}

/**
 * Asks the Host to check itself and the CLI's command, without running a prompt. Uses a port where
 * the browser has one, else one one-shot message (Safari). An old Host that never answers fails
 * as a protocol mismatch after a few seconds.
 */
export async function checkNativeCliHealth(mode: 'grok' | 'codex', signal?: AbortSignal): Promise<NativeCliHealthResult> {
	const request = buildNativeCliHealthRequest(mode);
	const runtime = browser.runtime as typeof browser.runtime & {
		connectNative?: (application: string) => NativePortLike;
	};
	if (typeof runtime.connectNative === 'function') {
		const response = await sendThroughNativePort(request, signal, NATIVE_CLI_HEALTH_TIMEOUT_MS);
		if (!response.ok || !response.health) throw responseError(response);
		return { health: response.health, transport: 'port' };
	}
	throwIfRequestAborted(signal);
	if (typeof browser.runtime.sendNativeMessage !== 'function') {
		throw new NativeCliUnavailableError('Native Messaging is not available in this browser.');
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new NativeCliExecutionError(
			'protocol-mismatch',
			'The installed Native Messaging Host did not respond using the current protocol.',
			{ protocolVersion: NATIVE_CLI_PROTOCOL_VERSION }
		)), NATIVE_CLI_HEALTH_TIMEOUT_MS);
	});
	try {
		let response: NativeCliHostResponse | undefined;
		try {
			response = await raceWithRequestCancellation(
				Promise.race([
					browser.runtime.sendNativeMessage(NATIVE_CLI_HOST_NAME, request) as Promise<NativeCliHostResponse>,
					timeout
				]),
				signal
			);
		} catch (error) {
			if (isCancellation(error) || error instanceof NativeCliExecutionError) throw error;
			throw new NativeCliUnavailableError(error instanceof Error ? error.message : String(error));
		}
		if (!response || typeof response !== 'object') throw responseError({ ok: false });
		if (response.requestId == null && !response.health) {
			throw new NativeCliExecutionError(
				'protocol-mismatch',
				'The installed Native Messaging Host uses an incompatible protocol.',
				{ protocolVersion: NATIVE_CLI_PROTOCOL_VERSION }
			);
		}
		if (!response.ok || !response.health) throw responseError(response);
		return { health: response.health, transport: 'message' };
	} finally {
		if (timer) clearTimeout(timer);
	}
}
