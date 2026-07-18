import browser from './browser-polyfill';
import type { PromptVariable } from '../types/types';
import { getMessage } from './i18n';
import { buildNativeCliRequest, type NativeCliErrorCode } from './native-cli-contract';
import { parsePromptResponses } from './cli-execution-contract';

interface NativeCliBackgroundResponse {
	success: boolean;
	stdout?: string;
	error?: string;
	errorCode?: NativeCliErrorCode | 'failed';
	errorDetails?: Record<string, unknown>;
}

export async function executeNativeCli(
	mode: 'grok' | 'codex',
	context: string,
	promptVariables: PromptVariable[]
): Promise<Record<string, unknown>> {
	const response = await browser.runtime.sendMessage({
		action: 'nativeCliRequest',
		request: buildNativeCliRequest(mode, context, promptVariables)
	}) as NativeCliBackgroundResponse;

	if (!response?.success) {
		if (response?.errorCode === 'unavailable') {
			throw new Error(getMessage('nativeCliUnavailable'));
		}
		throw new Error(response?.error || getMessage('nativeCliFailed'));
	}

	return parsePromptResponses(response.stdout || '', promptVariables);
}
