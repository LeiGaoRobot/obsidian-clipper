import { findCatalogEntryByBaseUrl, getCatalogEntry } from './catalog';
import {
	deriveAiSettings,
	LEGACY_CODEX_CONNECTION_ID,
	LEGACY_GROK_CONNECTION_ID
} from './settings-view';
import { AI_SYNC_KEYS, type AiSettingsBootstrapper } from './settings';
import type { AiRouting, Connection, ModelProfile } from './types';
import {
	isRecord,
	readV1AiSettings,
	readV1ExecutionMode,
	uniqueById,
	type RawV1Settings,
	type V1AiSettings,
	type V1ExecutionMode
} from './v1-settings';

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
	source: { providers: number; models: number; mode: V1ExecutionMode };
	/** Connection ids whose v1 key was imported on this device, ever. */
	credentials: string[];
}

export interface AiSettingsWrites {
	sync?: Record<string, unknown>;
	local?: Record<string, unknown>;
	/**
	 * v1 keys to import into `ai_credentials`, by connection id: only the delta, never the whole
	 * item. The store merges them into a fresh read of `ai_credentials` right before its write and
	 * skips any id that already has a key, so a key saved meanwhile by another context is kept.
	 */
	credentials?: Record<string, string>;
}

function countWithStringId(value: unknown): number {
	return Array.isArray(value)
		? value.filter(item => isRecord(item) && typeof item.id === 'string').length
		: 0;
}

function readPresetId(provider: Record<string, unknown>): string | undefined {
	// v1 never set `presetId`; honor one only if it names a bundled preset.
	if (typeof provider.presetId === 'string' && getCatalogEntry(provider.presetId)) {
		return provider.presetId;
	}
	return findCatalogEntryByBaseUrl(provider.baseUrl)?.id;
}

/**
 * `readV1AiSettings` with each provider's `presetId` set from the catalog: a bundled preset the
 * provider names, else the preset whose base URL it matches.
 */
function readV1AiSettingsWithPresets(raw: RawV1Settings): V1AiSettings {
	const v1 = readV1AiSettings(raw);
	const interpreter = isRecord(raw.interpreter_settings) ? raw.interpreter_settings : {};
	// The same providers, in the same order, as `readV1AiSettings` keeps.
	const rawProviders = uniqueById(interpreter.providers);
	return {
		...v1,
		providers: v1.providers.map((provider, index) => {
			const presetId = readPresetId(rawProviders[index]);
			return presetId ? { ...provider, presetId } : provider;
		})
	};
}

function activeCliConnectionId(mode: V1ExecutionMode): string | undefined {
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
	const v1 = readV1AiSettingsWithPresets(raw);
	const providerIds = new Set(v1.providers.map(provider => provider.id));
	// A model whose provider is gone could not run in v1 and would have no connection to group
	// under in Settings, so it is not carried over (and cannot become the default).
	const runnable = { ...v1, models: v1.models.filter(model => providerIds.has(model.providerId)) };
	const view = deriveAiSettings(runnable, { nativeMessaging: 'none' });

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
 * - If sync has v1 `interpreter_settings` but no `ai_connections`, the v2 sync keys are written
 *   from `migrateV1` (`status: 'bootstrapped'`), but only the ones that are absent. Any present v2
 *   item counts as v2 and is never overwritten: a partial v2 is most likely another device's
 *   bootstrap or later edits still arriving through sync, and those must win. Filling only the
 *   gaps (as `ensureV2` does) is safer than skipping the migration, which would leave this device
 *   read-only until `ai_connections` arrives, and if it never does, for good. Without v1 data
 *   nothing is written to sync: an empty bundle written during a fresh profile's sync lag could
 *   overwrite the real v2 items arriving from another device.
 * - If `ai_connections` is present it is reused and sync is not written (`status: 'reused'`).
 *   v1 changes made later by an older build are ignored, except through the credential rule.
 * - While v1 exists, keys are imported per `importCredentials` (returned as `credentials`, the
 *   delta for the store to merge), and their ids are appended to `ai_migration.credentials`.
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
			// Without v1 there is nothing to migrate, and a partial v2 is left for `ensureV2`.
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
						mode: readV1ExecutionMode(source.interpreterExecutionMode)
					},
					credentials
				};
			} else if (importedNow.length > 0) {
				record = { ...previous, credentials };
			}

			const local: Record<string, unknown> = {};
			if (record) local[MIGRATION_KEY] = record;

			const writes: AiSettingsWrites = {};
			if (bootstrap) {
				const bundle: Record<string, unknown> = { ...migration.sync };
				const absent = Object.fromEntries(AI_SYNC_KEYS
					.filter(key => rawSync[key] === undefined)
					.map(key => [key, bundle[key]]));
				if (Object.keys(absent).length > 0) writes.sync = absent;
			}
			if (Object.keys(local).length > 0) writes.local = local;
			if (importedNow.length > 0) writes.credentials = imports;
			return writes.sync || writes.local || writes.credentials ? writes : undefined;
		}
	};
}

/** The bootstrapper the browser store uses. */
export const aiSettingsBootstrapper: AiSettingsBootstrapper = createAiSettingsBootstrapper();
