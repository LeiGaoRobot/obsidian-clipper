import { PRESET_KINDS } from './preset-kinds';
import { CLI_CONNECTION_KINDS, type CliConnectionKind, type ConnectionKind } from './types';

export interface ConnectionKindSource {
	// Optional because imported or legacy stored providers may omit them.
	name?: string;
	baseUrl?: string;
	presetId?: string;
}

function kindFromUrl(baseUrl = ''): ConnectionKind | undefined {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return undefined;
	}
	const host = url.hostname.toLowerCase();
	if (host === 'api.anthropic.com') return 'anthropic';
	if (host.endsWith('.openai.azure.com')) return 'azure-openai';
	if (host === 'huggingface.co' || host.endsWith('.huggingface.co')) return 'huggingface';
	if (host === 'api.perplexity.ai') return 'perplexity';
	// Ollama's native chat endpoint. Its /v1 endpoint is OpenAI-compatible.
	if (url.pathname.replace(/\/+$/, '') === '/api/chat') return 'ollama';
	return undefined;
}

// v1's provider-name rules, in their branch order. Still the last guess before `openai-compatible`
// for migrated v1 providers and custom connections without a preset.
function kindFromLegacyRules({ name = '', baseUrl = '' }: ConnectionKindSource): ConnectionKind | undefined {
	const lowerName = name.toLowerCase();
	if (lowerName.includes('hugging')) return 'huggingface';
	if (baseUrl.includes('openai.azure.com')) return 'azure-openai';
	if (lowerName.includes('anthropic')) return 'anthropic';
	if (lowerName.includes('perplexity')) return 'perplexity';
	if (lowerName.includes('ollama')) return 'ollama';
	return undefined;
}

export function inferConnectionKind(source: ConnectionKindSource): ConnectionKind {
	const presetKind = source.presetId
		? PRESET_KINDS[source.presetId]
		: undefined;
	return presetKind
		?? kindFromUrl(source.baseUrl)
		// Parity with v1: a provider named "Ollama" still uses the native wire format even on
		// Ollama's OpenAI-compatible /v1 path. The Phase 2 adapter should prefer the path.
		?? kindFromLegacyRules(source)
		?? 'openai-compatible';
}

export function isCliKind(kind: ConnectionKind): kind is CliConnectionKind {
	return (CLI_CONNECTION_KINDS as readonly string[]).includes(kind);
}
