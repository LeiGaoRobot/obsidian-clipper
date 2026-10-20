import type { CodexReasoningEffort, ReaderSettings } from '../types/types';
import { normalizeCodexModel } from '../utils/codex-model';
import { normalizeCodexReasoningEffort } from '../utils/codex-reasoning-effort';

// The v1 AI settings as derived mode and the migration read them. Pure and JSON-free: the Popup
// and Reader reach this module through `settings.ts`, so it must not import the catalog
// (`providers.json`). `migrate.ts` adds the catalog `presetId` for the bootstrap.

/** v1 `interpreter_settings.interpreterExecutionMode`: which engine ran every task. v2 routes per task. */
export type V1ExecutionMode = 'api' | 'grok' | 'codex';

/** A v1 `interpreter_settings.providers` entry: an API connection with its key. */
export interface V1Provider {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	apiKeyRequired?: boolean;
	presetId?: string;
}

/** A v1 `interpreter_settings.models` entry: a model of a provider. */
export interface V1ModelConfig {
	id: string;
	providerId: string;
	providerModelId: string;
	name: string;
	enabled: boolean;
}

/** The v1 fields the migration and `deriveAiSettings` read, sanitized the way v1 loaded them. */
export interface V1AiSettings {
	interpreterModel: string;
	models: V1ModelConfig[];
	providers: V1Provider[];
	interpreterEnabled: boolean;
	interpreterAutoRun: boolean;
	interpreterExecutionMode: V1ExecutionMode;
	interpreterCodexModel?: string;
	interpreterCodexReasoningEffort?: CodexReasoningEffort;
	defaultPromptContext: string;
	readerSettings: Pick<ReaderSettings, 'learningResponseLanguage'>;
}

export interface RawV1Settings {
	interpreter_settings?: unknown;
	reader_settings?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

/** Items that are objects with a string id, first occurrence of each id kept. */
export function uniqueById(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const items: Record<string, unknown>[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.id !== 'string' || seen.has(item.id)) continue;
		seen.add(item.id);
		items.push(item);
	}
	return items;
}

export function readV1ExecutionMode(value: unknown): V1ExecutionMode {
	return value === 'grok' || value === 'codex' ? value : 'api';
}

/**
 * Reads the v1 AI fields from raw sync items. Like v1's `loadSettings`, it keeps only providers and
 * models with a string id, coerces the mode to `api` unless `grok` / `codex`, and normalizes the
 * Codex model and effort. It also drops duplicate ids (first kept) and coerces field types. No
 * provider carries a `presetId`: the migration sets one from the catalog, and a derived view
 * infers the same kind without it.
 */
export function readV1AiSettings(raw: RawV1Settings): V1AiSettings {
	const interpreter = isRecord(raw.interpreter_settings) ? raw.interpreter_settings : {};
	const reader = isRecord(raw.reader_settings) ? raw.reader_settings : {};
	const providers: V1Provider[] = uniqueById(interpreter.providers).map(provider => ({
		id: provider.id as string,
		name: stringOr(provider.name, ''),
		baseUrl: stringOr(provider.baseUrl, ''),
		apiKey: stringOr(provider.apiKey, ''),
		// v1 treats a missing flag as "not required" everywhere it is read.
		apiKeyRequired: provider.apiKeyRequired === true
	}));
	const models: V1ModelConfig[] = uniqueById(interpreter.models).map(model => ({
		id: model.id as string,
		providerId: stringOr(model.providerId, ''),
		providerModelId: stringOr(model.providerModelId, ''),
		name: stringOr(model.name, ''),
		// v1 filters enabled models by truthiness.
		enabled: Boolean(model.enabled)
	}));
	const codexModel = normalizeCodexModel(interpreter.interpreterCodexModel);
	const codexEffort = normalizeCodexReasoningEffort(interpreter.interpreterCodexReasoningEffort);
	return {
		interpreterModel: stringOr(interpreter.interpreterModel, ''),
		models,
		providers,
		interpreterEnabled: booleanOr(interpreter.interpreterEnabled, false),
		interpreterAutoRun: booleanOr(interpreter.interpreterAutoRun, false),
		interpreterExecutionMode: readV1ExecutionMode(interpreter.interpreterExecutionMode),
		...(codexModel ? { interpreterCodexModel: codexModel } : {}),
		...(codexEffort ? { interpreterCodexReasoningEffort: codexEffort } : {}),
		defaultPromptContext: stringOr(interpreter.defaultPromptContext, ''),
		readerSettings: { learningResponseLanguage: stringOr(reader.learningResponseLanguage, '') }
	};
}
