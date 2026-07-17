import type { PromptVariable } from '../types/types';
import type { CliExecutionMode } from './cli-execution-contract';
import { buildExecutionPrompt } from './cli-execution-contract';

export const NATIVE_CLI_HOST_NAME = 'com.obsidian.web_clipper';

export interface NativeCliRequest {
	type: 'executeCli';
	mode: CliExecutionMode;
	prompt: string;
}

export interface NativeCliHostResponse {
	ok: boolean;
	stdout?: string;
	stderr?: string;
	error?: string;
}

export function isCliExecutionMode(value: unknown): value is CliExecutionMode {
	return value === 'grok' || value === 'codex';
}

export function isNativeCliRequest(value: unknown): value is NativeCliRequest {
	if (!value || typeof value !== 'object') return false;
	const request = value as Partial<NativeCliRequest>;
	return request.type === 'executeCli'
		&& isCliExecutionMode(request.mode)
		&& typeof request.prompt === 'string'
		&& request.prompt.length > 0;
}

export function buildNativeCliRequest(
	mode: CliExecutionMode,
	context: string,
	promptVariables: PromptVariable[]
): NativeCliRequest {
	return {
		type: 'executeCli',
		mode,
		prompt: buildExecutionPrompt(context, promptVariables)
	};
}
