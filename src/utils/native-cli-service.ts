import browser from './browser-polyfill';
import type { PromptVariable } from '../types/types';
import {
	NATIVE_CLI_HOST_NAME,
	NATIVE_CLI_PROTOCOL_VERSION,
	NativeCliErrorCode,
	NativeCliHealth,
	NativeCliHostResponse,
	NativeCliRequest,
	buildNativeCliCancelRequest,
	buildNativeCliHealthRequest,
	buildNativeCliRequest
} from './native-cli-contract';
import { parsePromptResponses } from './cli-execution-contract';
import {
	RequestCancelledError,
	isRequestCancelled,
	raceWithRequestCancellation,
	throwIfRequestAborted
} from './request-cancellation';

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

export const NATIVE_CLI_LAST_RUN_STORAGE_KEY = 'nativeCliLastRunStatus';
const NATIVE_CLI_HEALTH_TIMEOUT_MS = 5000;
const NATIVE_CLI_CANCEL_CLEANUP_MS = 3000;

export interface NativeCliLastRunStatus {
	mode: 'grok' | 'codex';
	status: 'cancelled' | 'failed' | 'success';
	errorCode?: NativeCliErrorCode;
	finishedAt: number;
}

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
	if (response.errorCode === 'cancelled') return new RequestCancelledError();
	return new NativeCliExecutionError(
		response.errorCode || 'cli-failed',
		response.error || response.stderr || 'The local CLI failed to execute.',
		response.details
	);
}

async function recordLastRun(status: NativeCliLastRunStatus): Promise<void> {
	const storage = (browser as unknown as { storage?: {
		session?: { set(values: Record<string, unknown>): Promise<void> };
	} }).storage?.session;
	try {
		await storage?.set({ [NATIVE_CLI_LAST_RUN_STORAGE_KEY]: status });
	} catch {
		// Diagnostics must never change the request outcome.
	}
}

function sendThroughNativePort(
	request: NativeCliRequest | ReturnType<typeof buildNativeCliHealthRequest>,
	signal?: AbortSignal,
	timeoutMs?: number
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
		const cleanup = () => {
			if (responseTimer) clearTimeout(responseTimer);
			if (abortCleanupTimer) clearTimeout(abortCleanupTimer);
			port.onMessage.removeListener(onMessage);
			port.onDisconnect.removeListener(onDisconnect);
			signal?.removeEventListener('abort', onAbort);
			try {
				port.disconnect();
			} catch {
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
			if (aborted) {
				cleanup();
				return;
			}
			settle(() => reject(new NativeCliUnavailableError('The Native Messaging Host disconnected.')));
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
			reject(new RequestCancelledError());
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
	signal?: AbortSignal
): Promise<NativeCliHostResponse> {
	throwIfRequestAborted(signal);
	const runtime = browser.runtime as typeof browser.runtime & {
		connectNative?: (application: string) => NativePortLike;
	};
	try {
		let response: NativeCliHostResponse;
		if (typeof runtime.connectNative === 'function') {
			response = await sendThroughNativePort(request, signal);
		} else {
			if (typeof browser.runtime.sendNativeMessage !== 'function') {
				throw new NativeCliUnavailableError('Native Messaging is not available in this browser.');
			}
			response = await raceWithRequestCancellation(
				browser.runtime.sendNativeMessage(NATIVE_CLI_HOST_NAME, request) as Promise<NativeCliHostResponse>,
				signal
			);
			if (!response || response.ok !== true) throw responseError(response || { ok: false });
		}
		await recordLastRun({ mode: request.mode, status: 'success', finishedAt: Date.now() });
		return response;
	} catch (error) {
		const cancelled = isRequestCancelled(error);
		await recordLastRun({
			mode: request.mode,
			status: cancelled ? 'cancelled' : 'failed',
			errorCode: error instanceof NativeCliExecutionError ? error.code : undefined,
			finishedAt: Date.now()
		});
		if (cancelled || error instanceof NativeCliExecutionError || error instanceof NativeCliUnavailableError) {
			throw error;
		}
		throw new NativeCliUnavailableError(error instanceof Error ? error.message : String(error));
	}
}

export async function checkNativeCliHealth(mode: 'grok' | 'codex'): Promise<NativeCliHealth> {
	const request = buildNativeCliHealthRequest(mode);
	const response = await sendThroughNativePort(request, undefined, NATIVE_CLI_HEALTH_TIMEOUT_MS);
	if (!response.ok || !response.health) throw responseError(response);
	return response.health;
}

export async function executeNativeCliForPrompts(
	mode: 'grok' | 'codex',
	context: string,
	promptVariables: PromptVariable[],
	signal?: AbortSignal
): Promise<Record<string, unknown>> {
	const response = await sendNativeCliRequest(
		buildNativeCliRequest(mode, context, promptVariables),
		signal
	);
	return parsePromptResponses(response.stdout || '', promptVariables);
}
