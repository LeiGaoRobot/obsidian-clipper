import type { PromptVariable } from '../types/types';
import type { CliExecutionMode } from './cli-execution-contract';
import { buildExecutionPrompt } from './cli-execution-contract';

export const NATIVE_CLI_HOST_NAME = 'com.obsidian.web_clipper';
export const NATIVE_CLI_PROTOCOL_VERSION = 2;

let nativeCliRequestSequence = 0;

export type NativeCliErrorCode =
	| 'cancelled'
	| 'cli-failed'
	| 'config'
	| 'invalid'
	| 'launch-failed'
	| 'protocol-mismatch'
	| 'response-too-large'
	| 'timeout'
	| 'unavailable';

export interface NativeCliRequest {
	type: 'executeCli';
	protocolVersion: number;
	requestId: string;
	mode: CliExecutionMode;
	prompt: string;
}

export interface NativeCliCancelRequest {
	type: 'cancelCli';
	protocolVersion: number;
	requestId: string;
}

export interface NativeCliHealthRequest {
	type: 'healthCheck';
	protocolVersion: number;
	requestId: string;
	mode: CliExecutionMode;
}

export type NativeCliHostRequest = NativeCliRequest | NativeCliCancelRequest | NativeCliHealthRequest;

export interface NativeCliHealth {
	protocolVersion: number;
	mode: CliExecutionMode;
	command: string;
}

export interface NativeCliHostResponse {
	ok: boolean;
	requestId?: string;
	stdout?: string;
	stderr?: string;
	error?: string;
	errorCode?: NativeCliErrorCode;
	details?: Record<string, unknown>;
	health?: NativeCliHealth;
}

export function createNativeCliRequestId(prefix = 'native-cli'): string {
	nativeCliRequestSequence += 1;
	return `${prefix}-${Date.now()}-${nativeCliRequestSequence}`;
}

export function isCliExecutionMode(value: unknown): value is CliExecutionMode {
	return value === 'grok' || value === 'codex';
}

export function isNativeCliRequest(value: unknown): value is NativeCliRequest {
	if (!value || typeof value !== 'object') return false;
	const request = value as Partial<NativeCliRequest>;
	return request.type === 'executeCli'
		&& request.protocolVersion === NATIVE_CLI_PROTOCOL_VERSION
		&& typeof request.requestId === 'string'
		&& request.requestId.length > 0
		&& isCliExecutionMode(request.mode)
		&& typeof request.prompt === 'string'
		&& request.prompt.length > 0;
}

export function buildNativeCliRequest(
	mode: CliExecutionMode,
	context: string,
	promptVariables: PromptVariable[],
	requestId = createNativeCliRequestId()
): NativeCliRequest {
	return {
		type: 'executeCli',
		protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
		requestId,
		mode,
		prompt: buildExecutionPrompt(context, promptVariables)
	};
}

export function buildNativeCliCancelRequest(requestId: string): NativeCliCancelRequest {
	return {
		type: 'cancelCli',
		protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
		requestId
	};
}

export function buildNativeCliHealthRequest(
	mode: CliExecutionMode,
	requestId = createNativeCliRequestId('native-cli-health')
): NativeCliHealthRequest {
	return {
		type: 'healthCheck',
		protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
		requestId,
		mode
	};
}
