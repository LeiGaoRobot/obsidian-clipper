export interface CliArgumentsRequest {
	mode: 'grok' | 'codex';
	prompt: string;
	model?: string;
	effort?: string;
	/** Codex only: path to a JSON Schema file for `--output-schema`. Grok ignores it. */
	outputSchemaPath?: string;
}

export function buildCliArguments(request: CliArgumentsRequest): { args: string[]; input: string };
