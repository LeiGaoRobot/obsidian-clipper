import type { CodexReasoningEffort } from '../types/types';
import type { CliExecutionMode } from './cli-execution-contract';
import { normalizeCodexModel } from './codex-model';
import { normalizeCodexReasoningEffort } from './codex-reasoning-effort';
import { MAX_OUTPUT_SCHEMA_CHARS, NATIVE_CLI_PROTOCOL_VERSION } from '../../native-host/cli-invocation.mjs';

export { MAX_OUTPUT_SCHEMA_CHARS, NATIVE_CLI_PROTOCOL_VERSION };
/** Matches `HOST_NAME` in `scripts/install-native-host.mjs`; a parity test keeps them equal. */
export const NATIVE_CLI_HOST_NAME = 'com.obsidian.web_clipper';

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
	effort?: CodexReasoningEffort;
	/** Codex only: JSON Schema the Host passes to `codex exec --output-schema`. */
	outputSchema?: Record<string, unknown>;
	/** Ask the Host for periodic heartbeats. Only valid on a connected port. */
	heartbeat?: boolean;
}

export interface NativeCliHeartbeat {
	type: 'heartbeat';
	requestId: string;
	elapsedMs: number;
}

export function isNativeCliHeartbeat(value: unknown): value is NativeCliHeartbeat {
	return Boolean(value)
		&& typeof value === 'object'
		&& (value as { type?: unknown }).type === 'heartbeat'
		&& typeof (value as { requestId?: unknown }).requestId === 'string';
}

export interface NativeCliPromptRequestOptions {
	requestId?: string;
	model?: string;
	effort?: CodexReasoningEffort;
	/** Codex only. */
	outputSchema?: Record<string, unknown>;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function outputSchemaError(mode: CliExecutionMode, outputSchema: unknown): string | null {
	if (mode !== 'codex') return 'Output schemas require Codex execution mode.';
	if (!isPlainObject(outputSchema)) return 'Output schema must be a JSON object.';
	if (JSON.stringify(outputSchema).length > MAX_OUTPUT_SCHEMA_CHARS) {
		return `Output schema must serialize to at most ${MAX_OUTPUT_SCHEMA_CHARS} characters.`;
	}
	return null;
}

/** Builds an `executeCli` request from an already rendered prompt. */
export function buildNativeCliPromptRequest(
	mode: CliExecutionMode,
	prompt: string,
	options: NativeCliPromptRequestOptions = {}
): NativeCliRequest {
	const model = normalizeCodexModel(options.model);
	if (options.model !== undefined && !model) {
		throw new TypeError('Codex model must be a non-empty string of at most 200 characters.');
	}
	if (model && mode !== 'codex') {
		throw new TypeError('Codex model overrides require Codex execution mode.');
	}
	const effort = normalizeCodexReasoningEffort(options.effort);
	if (options.effort !== undefined && !effort) {
		throw new TypeError('Codex reasoning effort must be a supported value.');
	}
	if (effort && mode !== 'codex') {
		throw new TypeError('Codex reasoning effort overrides require Codex execution mode.');
	}
	if (options.outputSchema !== undefined) {
		const error = outputSchemaError(mode, options.outputSchema);
		if (error) throw new TypeError(error);
	}
	return {
		type: 'executeCli',
		protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
		requestId: options.requestId ?? createNativeCliRequestId(),
		mode,
		prompt,
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
		...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {})
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
