import browser from './browser-polyfill';
import type { PromptVariable } from '../types/types';
import { buildNativeCliRequest, NATIVE_CLI_HOST_NAME } from './native-cli-contract';
import type { NativeCliHostResponse, NativeCliRequest } from './native-cli-contract';
import { parsePromptResponses } from './cli-execution-contract';

export class NativeCliUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NativeCliUnavailableError';
	}
}

export async function sendNativeCliRequest(request: NativeCliRequest): Promise<NativeCliHostResponse> {
	if (typeof browser.runtime.sendNativeMessage !== 'function') {
		throw new NativeCliUnavailableError('Native Messaging is not available in this browser.');
	}

	let response: NativeCliHostResponse;
	try {
		response = await browser.runtime.sendNativeMessage(NATIVE_CLI_HOST_NAME, request) as NativeCliHostResponse;
	} catch (error) {
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
	promptVariables: PromptVariable[]
): Promise<Record<string, unknown>> {
	const response = await sendNativeCliRequest(buildNativeCliRequest(mode, context, promptVariables));
	return parsePromptResponses(response.stdout || '', promptVariables);
}
