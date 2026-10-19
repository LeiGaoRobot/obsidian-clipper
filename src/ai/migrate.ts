import type {
	CodexReasoningEffort,
	InterpreterExecutionMode,
	ModelConfig,
	Provider,
	ReaderSettings,
	Settings
} from '../types/types';
import { normalizeCodexModel } from '../utils/codex-model';
import { normalizeCodexReasoningEffort } from '../utils/codex-reasoning-effort';
import { findCatalogEntryByBaseUrl, getCatalogEntry } from './catalog';
import {
	deriveAiSettings,
	LEGACY_CODEX_CONNECTION_ID,
	LEGACY_GROK_CONNECTION_ID
} from './settings-view';
import type { AiSettingsBootstrapper } from './settings';
import type { AiRouting, Connection, ModelProfile } from './types';

// Storage keys, as laid out in Phase 5 decision 1. `settings.ts` owns the codec for them.
const V1_INTERPRETER_KEY = 'interpreter_settings';
const V1_READER_KEY = 'reader_settings';
const CONNECTIONS_KEY = 'ai_connections';
const CREDENTIALS_KEY = 'ai_credentials';
const MIGRATION_KEY = 'ai_migration';

/** The five v2 sync items, keyed by storage key so the bundle can be written in one `set`. */
export interface V2SyncBundle {
	ai_connections: { v: 1; items: Connection[] };
	ai_profiles: { v: 1; items: ModelProfile[] };
	ai_routing: { v: 1 } & AiRouting;
	ai_interpreter: { v: 1; enabled: boolean; autoRun: boolean };
	ai_prompt_context: { v: 1; text: string };
}

export interface V1MigrationResult {
	sync: V2SyncBundle;
	/** Non-empty v1 API keys by connection id. Device-local; never part of `sync`. */
	credentials: Record<string, string>;
}

export interface AiMigrationRecord {
	v: 1;
	status: 'bootstrapped' | 'reused';
	at: number;
	/** Manifest version of the build that wrote the record. */
	build: string;
	source: { providers: number; models: number; mode: InterpreterExecutionMode };
	/** Connection ids whose v1 key was imported on this device, ever. */
	credentials: string[];
}

export interface AiSettingsWrites {
	sync?: Record<string, unknown>;
	local?: Record<string, unknown>;
}

/** The v1 fields the migration reads, sanitized the way `loadSettings` does. */
export interface V1AiSettings {
	interpreterModel: string;
	models: ModelConfig[];
	providers: Provider[];
	interpreterEnabled: boolean;
	interpreterAutoRun: boolean;
	interpreterExecutionMode: InterpreterExecutionMode;
	interpreterCodexModel?: string;
	interpreterCodexReasoningEffort?: CodexReasoningEffort;
	defaultPromptContext: string;
	readerSettings: Pick<ReaderSettings, 'learningResponseLanguage'>;
}

export interface RawV1Settings {
	interpreter_settings?: unknown;
	reader_settings?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

/** Items that are objects with a string id, first occurrence of each id kept. */
function uniqueById(value: unknown): Record<string, unknown>[] {
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

function countWithStringId(value: unknown): number {
	return Array.isArray(value)
		? value.filter(item => isRecord(item) && typeof item.id === 'string').length
		: 0;
}

function readMode(value: unknown): InterpreterExecutionMode {
	return value === 'grok' || value === 'codex' ? value : 'api';
}

function readPresetId(provider: Record<string, unknown>): string | undefined {
	// v1 never set `presetId`; honor one only if it names a bundled preset.
	if (typeof provider.presetId === 'string' && getCatalogEntry(provider.presetId)) {
		return provider.presetId;
	}
	return findCatalogEntryByBaseUrl(provider.baseUrl)?.id;
}

/**
 * Reads the v1 AI fields from raw sync items. Like `loadSettings`, it keeps only providers and
 * models with a string id, coerces the mode to `api` unless `grok` / `codex`, and normalizes the
 * Codex model and effort. It also drops duplicate ids (first kept), coerces field types, and
 * sets `presetId` from a matching catalog base URL.
 */
export function readV1AiSettings(raw: RawV1Settings): V1AiSettings {
	const interpreter = isRecord(raw.interpreter_settings) ? raw.interpreter_settings : {};
	const reader = isRecord(raw.reader_settings) ? raw.reader_settings : {};
	const providers: Provider[] = uniqueById(interpreter.providers).map(provider => {
		const presetId = readPresetId(provider);
		return {
			id: provider.id as string,
			name: stringOr(provider.name, ''),
			baseUrl: stringOr(provider.baseUrl, ''),
			apiKey: stringOr(provider.apiKey, ''),
			// v1 treats a missing flag as "not required" everywhere it is read.
			apiKeyRequired: provider.apiKeyRequired === true,
			...(presetId ? { presetId } : {})
		};
	});
	const models: ModelConfig[] = uniqueById(interpreter.models).map(model => ({
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
		interpreterExecutionMode: readMode(interpreter.interpreterExecutionMode),
		...(codexModel ? { interpreterCodexModel: codexModel } : {}),
		...(codexEffort ? { interpreterCodexReasoningEffort: codexEffort } : {}),
		defaultPromptContext: stringOr(interpreter.defaultPromptContext, ''),
		readerSettings: { learningResponseLanguage: stringOr(reader.learningResponseLanguage, '') }
	};
}

function activeCliConnectionId(mode: InterpreterExecutionMode): string | undefined {
	if (mode === 'codex') return LEGACY_CODEX_CONNECTION_ID;
	if (mode === 'grok') return LEGACY_GROK_CONNECTION_ID;
	return undefined;
}

// Rebuilt field by field so key order, and therefore the serialized bundle, is fixed.
function toConnection(connection: Connection): Connection {
	return {
		id: connection.id,
		kind: connection.kind,
		label: connection.label,
		...(connection.presetId ? { presetId: connection.presetId } : {}),
		...(connection.baseUrl !== undefined ? { baseUrl: connection.baseUrl } : {}),
		...(connection.apiKeyRequired !== undefined ? { apiKeyRequired: connection.apiKeyRequired } : {})
	};
}

function toProfile(profile: ModelProfile): ModelProfile {
	return {
		id: profile.id,
		connectionId: profile.connectionId,
		...(profile.model ? { model: profile.model } : {}),
		label: profile.label,
		...(profile.options ? { options: { ...profile.options } } : {}),
		enabled: profile.enabled
	};
}

/**
 * Builds the v2 sync bundle and the device credentials from raw v1 items. Pure and
 * deterministic: the same input always serializes to the same bundle, so two devices that
 * bootstrap concurrently from the same v1 data write identical items.
 */
export function migrateV1(raw: RawV1Settings): V1MigrationResult {
	const v1 = readV1AiSettings(raw);
	const providerIds = new Set(v1.providers.map(provider => provider.id));
	// A model whose provider is gone could not run in v1 and would have no connection to group
	// under in Settings, so it is not carried over (and cannot become the default).
	const runnable = { ...v1, models: v1.models.filter(model => providerIds.has(model.providerId)) };
	const view = deriveAiSettings(runnable as Settings, { nativeMessaging: 'none' });

	// Only the active mode's CLI is carried over; users add another through "Add local CLI".
	const cliId = activeCliConnectionId(v1.interpreterExecutionMode);
	const keep = (connectionId: string) => providerIds.has(connectionId) || connectionId === cliId;
	const connections = view.connections.filter(connection => keep(connection.id)).map(toConnection);
	const profiles = view.profiles.filter(profile => keep(profile.connectionId)).map(toProfile);

	const { defaultProfileId, responseLanguage } = view.routing;
	return {
		sync: {
			ai_connections: { v: 1, items: connections },
			ai_profiles: { v: 1, items: profiles },
			ai_routing: {
				v: 1,
				...(defaultProfileId ? { defaultProfileId } : {}),
				taskProfiles: {},
				...(responseLanguage ? { responseLanguage } : {})
			},
			ai_interpreter: { v: 1, enabled: view.enabled, autoRun: view.interpreter.autoRun },
			ai_prompt_context: { v: 1, text: view.interpreter.defaultPromptContext }
		},
		credentials: { ...view.credentials }
	};
}

function isCredential(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/** The string-valued entries of a stored `ai_credentials` item. */
function readCredentials(value: unknown): Record<string, string> {
	const credentials: Record<string, string> = {};
	if (!isRecord(value)) return credentials;
	for (const [id, key] of Object.entries(value)) {
		if (isCredential(key)) credentials[id] = key;
	}
	return credentials;
}

function readStringList(value: unknown): string[] {
	return Array.isArray(value)
		? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
		: [];
}

/** A stored record if it is well formed; otherwise undefined. */
export function readMigrationRecord(value: unknown): AiMigrationRecord | undefined {
	if (!isRecord(value) || value.v !== 1) return undefined;
	const { status, at, build, source } = value;
	if (status !== 'bootstrapped' && status !== 'reused') return undefined;
	if (typeof at !== 'number' || typeof build !== 'string' || !isRecord(source)) return undefined;
	if (typeof source.providers !== 'number' || typeof source.models !== 'number') return undefined;
	if (source.mode !== 'api' && source.mode !== 'grok' && source.mode !== 'codex') return undefined;
	return {
		v: 1,
		status,
		at,
		build,
		source: { providers: source.providers, models: source.models, mode: source.mode },
		credentials: readStringList(value.credentials)
	};
}

function readConnectionIds(value: unknown): string[] {
	const items = isRecord(value) ? value.items : undefined;
	return uniqueById(items).map(item => item.id as string);
}

export interface CredentialImportInput {
	/** Ids of the v2 connections, in order. */
	connectionIds: readonly string[];
	/** Non-empty v1 API keys by provider id. */
	v1Credentials: Readonly<Record<string, string>>;
	/** Credentials already stored on this device. */
	localCredentials: Readonly<Record<string, string>>;
	/** `ai_migration.credentials`: ids imported on this device before. */
	importedIds: readonly string[];
}

/**
 * The v1 keys to import on this device: a v2 connection whose id has a non-empty v1 key, no
 * local credential, and was never imported here. The last rule keeps a key the user deleted in
 * the new Settings from coming back on the next load.
 */
export function importCredentials({
	connectionIds,
	v1Credentials,
	localCredentials,
	importedIds
}: CredentialImportInput): Record<string, string> {
	const imported = new Set(importedIds);
	const result: Record<string, string> = {};
	for (const id of connectionIds) {
		const key = v1Credentials[id];
		if (!isCredential(key) || isCredential(localCredentials[id]) || imported.has(id)) continue;
		result[id] = key;
	}
	return result;
}

export interface AiSettingsBootstrapperOptions {
	now?: () => number;
}

/**
 * Plans the per-device bootstrap. It returns storage writes and never performs them:
 *
 * - If sync has v1 `interpreter_settings` but no `ai_connections`, the five v2 sync keys are
 *   written from `migrateV1` (`status: 'bootstrapped'`). Without v1 data nothing is written to
 *   sync: an empty bundle written during a fresh profile's sync lag could overwrite the real v2
 *   items arriving from another device.
 * - If `ai_connections` is present it is reused and sync is not written (`status: 'reused'`).
 *   v1 changes made later by an older build are ignored, except through the credential rule.
 * - While v1 exists, keys are imported per `importCredentials` into `ai_credentials`, and their
 *   ids are appended to `ai_migration.credentials`.
 * - `ai_migration` is written when first created, on a re-bootstrap, or when a key is imported.
 */
export function createAiSettingsBootstrapper(
	{ now = Date.now }: AiSettingsBootstrapperOptions = {}
): AiSettingsBootstrapper {
	return {
		plan(rawSync, rawLocal, build) {
			const interpreter = rawSync[V1_INTERPRETER_KEY];
			const hasV1 = isRecord(interpreter);
			const hasV2 = rawSync[CONNECTIONS_KEY] !== undefined;
			if (!hasV1 && !hasV2) return undefined;

			const migration = migrateV1({
				interpreter_settings: interpreter,
				reader_settings: rawSync[V1_READER_KEY]
			});
			const bootstrap = !hasV2;
			const connectionIds = bootstrap
				? migration.sync.ai_connections.items.map(connection => connection.id)
				: readConnectionIds(rawSync[CONNECTIONS_KEY]);

			const rawRecord = rawLocal[MIGRATION_KEY];
			const previous = readMigrationRecord(rawRecord);
			// A malformed record still protects the ids it lists from being re-imported.
			const importedIds = previous?.credentials
				?? (isRecord(rawRecord) ? readStringList(rawRecord.credentials) : []);
			const localCredentials = readCredentials(rawLocal[CREDENTIALS_KEY]);
			const imports = hasV1
				? importCredentials({
					connectionIds,
					v1Credentials: migration.credentials,
					localCredentials,
					importedIds
				})
				: {};
			const importedNow = Object.keys(imports);
			const credentials = [...importedIds, ...importedNow.filter(id => !importedIds.includes(id))];

			let record: AiMigrationRecord | undefined;
			if (!previous || bootstrap) {
				const source = isRecord(interpreter) ? interpreter : {};
				record = {
					v: 1,
					status: bootstrap ? 'bootstrapped' : 'reused',
					at: now(),
					build,
					source: {
						providers: countWithStringId(source.providers),
						models: countWithStringId(source.models),
						mode: readMode(source.interpreterExecutionMode)
					},
					credentials
				};
			} else if (importedNow.length > 0) {
				record = { ...previous, credentials };
			}

			const local: Record<string, unknown> = {};
			if (importedNow.length > 0) local[CREDENTIALS_KEY] = { ...localCredentials, ...imports };
			if (record) local[MIGRATION_KEY] = record;

			const writes: AiSettingsWrites = {};
			if (bootstrap) writes.sync = { ...migration.sync };
			if (Object.keys(local).length > 0) writes.local = local;
			return writes.sync || writes.local ? writes : undefined;
		}
	};
}

/** The bootstrapper the browser store uses. */
export const aiSettingsBootstrapper: AiSettingsBootstrapper = createAiSettingsBootstrapper();
