import type { PromptVariable } from '../types/types';
import type { CliExecutionMode } from './cli-execution-contract';
import { buildExecutionPrompt } from './cli-execution-contract';
import { MAX_CODEX_MODEL_CHARS, normalizeCodexModel } from './codex-model';

export const NATIVE_CLI_HOST_NAME = 'com.obsidian.web_clipper';
export const NATIVE_CLI_PROTOCOL_VERSION = 3;

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
	model?: string;
}

export interface NativeCliRequestOptions {
	requestId?: string;
	model?: string;
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
	const validModel = request.model === undefined || (
		request.mode === 'codex'
		&& typeof request.model === 'string'
		&& request.model === request.model.trim()
		&& request.model.length > 0
		&& request.model.length <= MAX_CODEX_MODEL_CHARS
	);
	return request.type === 'executeCli'
		&& request.protocolVersion === NATIVE_CLI_PROTOCOL_VERSION
		&& typeof request.requestId === 'string'
		&& request.requestId.length > 0
		&& isCliExecutionMode(request.mode)
		&& typeof request.prompt === 'string'
		&& request.prompt.length > 0
		&& validModel;
}

export function buildNativeCliRequest(
	mode: CliExecutionMode,
	context: string,
	promptVariables: PromptVariable[],
	options: NativeCliRequestOptions = {}
): NativeCliRequest {
	const model = normalizeCodexModel(options.model);
	if (options.model !== undefined && !model) {
		throw new TypeError('Codex model must be a non-empty string of at most 200 characters.');
	}
	if (model && mode !== 'codex') {
		throw new TypeError('Codex model overrides require Codex execution mode.');
	}
	return {
		type: 'executeCli',
		protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
		requestId: options.requestId ?? createNativeCliRequestId(),
		mode,
		prompt: buildExecutionPrompt(context, promptVariables),
		...(model ? { model } : {})
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
