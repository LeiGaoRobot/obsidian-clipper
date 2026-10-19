export interface CliArgumentsRequest {
	mode: 'grok' | 'codex';
	prompt: string;
	model?: string;
	effort?: string;
}

export function buildCliArguments(request: CliArgumentsRequest): { args: string[]; input: string };
