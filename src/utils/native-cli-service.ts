import browser from './browser-polyfill';
import type { PromptVariable } from '../types/types';
import { buildNativeCliRequest, NATIVE_CLI_HOST_NAME } from './native-cli-contract';
import type { NativeCliHostResponse, NativeCliRequest } from './native-cli-contract';
import { parsePromptResponses } from './cli-execution-contract';
import { isRequestCancelled, raceWithRequestCancellation } from './request-cancellation';

export class NativeCliUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NativeCliUnavailableError';
	}
}

export async function sendNativeCliRequest(
	request: NativeCliRequest,
	signal?: AbortSignal
): Promise<NativeCliHostResponse> {
	if (typeof browser.runtime.sendNativeMessage !== 'function') {
		throw new NativeCliUnavailableError('Native Messaging is not available in this browser.');
	}

	let response: NativeCliHostResponse;
	try {
		response = await raceWithRequestCancellation(
			browser.runtime.sendNativeMessage(NATIVE_CLI_HOST_NAME, request) as Promise<NativeCliHostResponse>,
			signal
		);
	} catch (error) {
		if (isRequestCancelled(error)) throw error;
		throw new NativeCliUnavailableError(error instanceof Error ? error.message : String(error));
	}

	if (!response || response.ok !== true) {
		throw new Error(response?.error || response?.stderr || 'The local CLI failed to execute.');
	}
	return response;
}

export async function executeNativeCliForPrompts(
	mode: 'grok' | 'codex',
	context: string,
	promptVariables: PromptVariable[],
	signal?: AbortSignal
): Promise<Record<string, unknown>> {
	const response = await sendNativeCliRequest(buildNativeCliRequest(mode, context, promptVariables), signal);
	return parsePromptResponses(response.stdout || '', promptVariables);
}
