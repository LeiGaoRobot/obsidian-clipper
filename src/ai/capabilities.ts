import type { AiError } from './errors';
import type { ConnectionKind, StructuredOutputSupport } from './types';

// Structured-output capability per connection. `json_schema` is each kind's strongest mechanism
// (OpenAI response_format, Anthropic forced tool, Ollama format schema, Codex --output-schema);
// `json_object` is plain JSON mode; `none` relies on prompt rules and the tolerant parser. A Test
// detects the mode and a provider rejection downgrades it, both per connection (`resolve.ts`,
// `effectiveStructuredOutput`).

export type StructuredOutputMode = Exclude<StructuredOutputSupport, 'unknown'>;

function hostOf(baseUrl: string | undefined): string {
	try {
		return baseUrl ? new URL(baseUrl).hostname.toLowerCase() : '';
	} catch {
		return '';
	}
}

/** The mode used until a Test or a provider rejection says otherwise. */
export function defaultStructuredOutputMode(kind: ConnectionKind, baseUrl?: string): StructuredOutputMode {
	switch (kind) {
		case 'openai-compatible':
			// Many compatible servers accept JSON mode but not schemas; OpenAI itself accepts both.
			return hostOf(baseUrl) === 'api.openai.com' ? 'json_schema' : 'json_object';
		case 'azure-openai':
		case 'anthropic':
		case 'ollama':
		case 'cli-codex':
			return 'json_schema';
		case 'huggingface':
		case 'perplexity':
		case 'cli-grok':
			return 'none';
	}
}

const STRUCTURED_REJECTION = /response_format|json_schema|json_object|input_schema|tool_choice|\btools?\b|\bformat\b|\bschema\b/i;

/**
 * A 400 or 422 that names the structured-output parameter, or a Codex CLI that does not know
 * --output-schema: retry once without structured output.
 */
export function isStructuredOutputRejection(error: AiError): boolean {
	const detail = error.detail ?? '';
	if (error.status === 400 || error.status === 422) return STRUCTURED_REJECTION.test(detail);
	return error.status === undefined && error.nativeCode === 'cli-failed' && /output-schema/i.test(detail);
}
