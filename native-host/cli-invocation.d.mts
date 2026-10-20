export declare const NATIVE_CLI_PROTOCOL_VERSION: 5;
export declare const DEFAULT_TIMEOUT_MS: 120_000;
export declare const MAX_CODEX_MODEL_CHARS: 200;
export declare const MAX_OUTPUT_SCHEMA_CHARS: 20_000;
/** Declared `as const`: `CodexReasoningEffort` is derived from it and must not widen to `string`. */
export declare const CODEX_REASONING_EFFORTS: readonly ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface CliArgumentsRequest {
	mode: 'grok' | 'codex';
	prompt: string;
	model?: string;
	effort?: string;
	/** Codex only: path to a JSON Schema file for `--output-schema`. Grok ignores it. */
	outputSchemaPath?: string;
}

export function buildCliArguments(request: CliArgumentsRequest): { args: string[]; input: string };
