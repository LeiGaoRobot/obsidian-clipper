import type { ConnectionKind } from './types';

/**
 * Kept apart from `catalog.ts` so modules that only infer a kind do not bundle `providers.json`.
 *
 * Wire protocol of each bundled preset. Presets not listed here are OpenAI-compatible;
 * `catalog.test.ts` asserts every `providers.json` entry is listed.
 */
export const PRESET_KINDS: Readonly<Record<string, ConnectionKind>> = Object.freeze({
	anthropic: 'anthropic',
	'azure-openai': 'azure-openai',
	huggingface: 'huggingface',
	ollama: 'ollama',
	perplexity: 'perplexity',
	deepseek: 'openai-compatible',
	'google-gemini': 'openai-compatible',
	meta: 'openai-compatible',
	openai: 'openai-compatible',
	openrouter: 'openai-compatible',
	xai: 'openai-compatible'
});
