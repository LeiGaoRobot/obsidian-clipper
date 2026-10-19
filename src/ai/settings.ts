import type { ReaderSettings, Settings } from '../types/types';
import { normalizeCodexModel } from '../utils/codex-model';
import { normalizeCodexReasoningEffort } from '../utils/codex-reasoning-effort';
import { AI_ERROR_CODES } from './errors';
import type { AiErrorCode } from './errors';
import type { StorageAreaLike } from './job-store';
import { deriveAiSettings } from './settings-view';
import { AI_TASKS } from './types';
import type {
	AiRouting,
	AiSettingsView,
	AiTask,
	Connection,
	ConnectionKind,
	ConnectionModelCheck,
	ConnectionStatus,
	ModelProfile,
	ModelProfileOptions,
	NativeMessagingSupport,
	StructuredOutputSupport
} from './types';

// v2 AI settings storage (Phase 5, decisions 1–3): one versioned sync item per concern, API keys
// and per-device state in `storage.local`. The storage areas are injected, so this module has no
// browser runtime import and is safe in the MV3 service worker.

export const AI_CONNECTIONS_KEY = 'ai_connections';
export const AI_PROFILES_KEY = 'ai_profiles';
export const AI_ROUTING_KEY = 'ai_routing';
export const AI_INTERPRETER_KEY = 'ai_interpreter';
export const AI_PROMPT_CONTEXT_KEY = 'ai_prompt_context';
export const AI_CREDENTIALS_KEY = 'ai_credentials';
export const AI_MIGRATION_KEY = 'ai_migration';
export const AI_CONNECTION_STATUS_KEY = 'ai_connection_status';
export const AI_DIAGNOSTICS_KEY = 'ai_diagnostics';
/** The Phase 3 structured-output cache in `storage.local`; folded into the status, removed on gateway init. */
export const LEGACY_STRUCTURED_OUTPUT_KEY = 'ai_structured_output';
/** v1 items read for derived mode and the bootstrap. Never written by this module. */
export const V1_INTERPRETER_SETTINGS_KEY = 'interpreter_settings';
export const V1_READER_SETTINGS_KEY = 'reader_settings';

export const AI_SYNC_KEYS = [
	AI_CONNECTIONS_KEY,
	AI_PROFILES_KEY,
	AI_ROUTING_KEY,
	AI_INTERPRETER_KEY,
	AI_PROMPT_CONTEXT_KEY
] as const;
export const AI_LOCAL_KEYS = [AI_CREDENTIALS_KEY, AI_MIGRATION_KEY, AI_CONNECTION_STATUS_KEY] as const;
export const AI_SESSION_KEYS = [AI_DIAGNOSTICS_KEY] as const;

export type AiSyncKey = typeof AI_SYNC_KEYS[number];
export type AiLocalKey = typeof AI_LOCAL_KEYS[number];
export type AiSessionKey = typeof AI_SESSION_KEYS[number];
export type AiStorageKey = AiSyncKey | AiLocalKey | AiSessionKey;
export type AiStorageAreaName = 'sync' | 'local' | 'session';

/**
 * Whether `load()` bootstraps v2 from v1 when no `ai_connections` item exists. It was off in 5a, so
 * every reader could move to the store with no behavior change; the 5b switch commit turned it on.
 */
export const AI_V2_BOOTSTRAP = true;

/** `chrome.storage.sync.QUOTA_BYTES_PER_ITEM`; Firefox enforces the same limit. */
export const SYNC_QUOTA_BYTES_PER_ITEM = 8192;

// --- Stored shapes (decision 1) ------------------------------------------------------------------

export interface StoredConnections { v: 1; items: Connection[] }
export interface StoredProfiles { v: 1; items: ModelProfile[] }
export type StoredRouting = { v: 1 } & AiRouting;
export interface StoredInterpreter { v: 1; enabled: boolean; autoRun: boolean }
export interface StoredPromptContext { v: 1; text: string }

/** The five v2 sync items, keyed by storage key so they can be written in one `set`. */
export interface AiSyncItems {
	ai_connections: StoredConnections;
	ai_profiles: StoredProfiles;
	ai_routing: StoredRouting;
	ai_interpreter: StoredInterpreter;
	ai_prompt_context: StoredPromptContext;
}

export interface AiInterpreterToggles {
	enabled: boolean;
	autoRun: boolean;
}

/** The one place for v2 AI defaults. A key that is absent or fails to decode uses these. */
export const AI_SETTINGS_DEFAULTS: {
	readonly enabled: boolean;
	readonly autoRun: boolean;
	readonly defaultPromptContext: string;
	readonly connections: readonly Connection[];
	readonly profiles: readonly ModelProfile[];
	readonly taskProfiles: Readonly<Partial<Record<AiTask, string>>>;
} = Object.freeze({
	enabled: false,
	autoRun: false,
	defaultPromptContext: '',
	connections: Object.freeze([]),
	profiles: Object.freeze([]),
	taskProfiles: Object.freeze({})
});

// --- Sanitizers ----------------------------------------------------------------------------------

const CONNECTION_KINDS: Record<ConnectionKind, true> = {
	'openai-compatible': true,
	'azure-openai': true,
	anthropic: true,
	ollama: true,
	huggingface: true,
	perplexity: true,
	'cli-codex': true,
	'cli-grok': true
};

const STRUCTURED_OUTPUT_VALUES: readonly StructuredOutputSupport[] = ['json_schema', 'json_object', 'none', 'unknown'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVersioned(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && value.v === 1;
}

function isConnectionKind(value: unknown): value is ConnectionKind {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONNECTION_KINDS, value);
}

function isId(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}

// Record keys that would change an object's prototype when assigned.
function isSafeMapKey(key: string): boolean {
	return key !== '__proto__';
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	return items.filter(item => {
		if (seen.has(item.id)) return false;
		seen.add(item.id);
		return true;
	});
}

/** Rebuilt field by field, so unknown fields (such as a stray `apiKey`) never reach sync. */
function sanitizeConnection(raw: unknown): Connection | undefined {
	if (!isRecord(raw) || !isId(raw.id) || !isConnectionKind(raw.kind)) return undefined;
	const structuredOutput = STRUCTURED_OUTPUT_VALUES.find(value => value === raw.structuredOutput);
	const maxConcurrency = positiveInteger(raw.maxConcurrency);
	const timeoutMs = positiveNumber(raw.timeoutMs);
	return {
		id: raw.id,
		kind: raw.kind,
		label: typeof raw.label === 'string' ? raw.label : '',
		...(isId(raw.presetId) ? { presetId: raw.presetId } : {}),
		...(typeof raw.baseUrl === 'string' ? { baseUrl: raw.baseUrl } : {}),
		...(typeof raw.apiKeyRequired === 'boolean' ? { apiKeyRequired: raw.apiKeyRequired } : {}),
		...(structuredOutput ? { structuredOutput } : {}),
		...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {})
	};
}

export function sanitizeConnections(items: readonly unknown[]): Connection[] {
	return uniqueById(items.map(sanitizeConnection).filter((item): item is Connection => !!item));
}

function sanitizeProfileOptions(raw: unknown): ModelProfileOptions | undefined {
	if (!isRecord(raw)) return undefined;
	const reasoningEffort = normalizeCodexReasoningEffort(raw.reasoningEffort);
	const maxOutputTokens = positiveInteger(raw.maxOutputTokens);
	const temperature = finiteNumber(raw.temperature);
	const options: ModelProfileOptions = {
		...(reasoningEffort ? { reasoningEffort } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		...(temperature !== undefined ? { temperature } : {})
	};
	return Object.keys(options).length > 0 ? options : undefined;
}

function sanitizeProfile(raw: unknown, codexConnectionIds: ReadonlySet<string>): ModelProfile | undefined {
	if (!isRecord(raw) || !isId(raw.id) || !isId(raw.connectionId)) return undefined;
	// Codex profiles get the same model normalization v1 applied to `interpreterCodexModel`.
	const model = codexConnectionIds.has(raw.connectionId)
		? normalizeCodexModel(raw.model)
		: (typeof raw.model === 'string' && raw.model !== '' ? raw.model : undefined);
	const options = sanitizeProfileOptions(raw.options);
	return {
		id: raw.id,
		connectionId: raw.connectionId,
		...(model ? { model } : {}),
		label: typeof raw.label === 'string' ? raw.label : '',
		...(options ? { options } : {}),
		enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true
	};
}

/**
 * Sanitizes profiles. `connections` is used only to apply the Codex model normalization to
 * profiles of a `cli-codex` connection; without it every profile keeps its model string.
 */
export function sanitizeProfiles(items: readonly unknown[], connections: readonly Connection[] = []): ModelProfile[] {
	const codexIds = new Set(connections.filter(item => item.kind === 'cli-codex').map(item => item.id));
	return uniqueById(
		items.map(item => sanitizeProfile(item, codexIds)).filter((item): item is ModelProfile => !!item)
	);
}

export function sanitizeRouting(raw: unknown): AiRouting {
	const source = isRecord(raw) ? raw : {};
	const taskProfiles: Partial<Record<AiTask, string>> = {};
	const rawTasks = isRecord(source.taskProfiles) ? source.taskProfiles : {};
	for (const task of AI_TASKS) {
		const profileId = rawTasks[task];
		if (isId(profileId)) taskProfiles[task] = profileId;
	}
	const responseLanguage = typeof source.responseLanguage === 'string' ? source.responseLanguage.trim() : '';
	return {
		...(isId(source.defaultProfileId) ? { defaultProfileId: source.defaultProfileId } : {}),
		taskProfiles,
		...(responseLanguage ? { responseLanguage } : {})
	};
}

// --- Per-key decoders ----------------------------------------------------------------------------

// Each decoder returns its default for an absent, unversioned, or malformed item, independently of
// the other keys, so one corrupt item cannot blank the whole configuration.
function decodeSafely<T>(decode: () => T, fallback: () => T): T {
	try {
		return decode();
	} catch {
		return fallback();
	}
}

export function decodeConnections(value: unknown): Connection[] {
	return decodeSafely(
		() => (isVersioned(value) && Array.isArray(value.items) ? sanitizeConnections(value.items) : []),
		() => []
	);
}

export function decodeProfiles(value: unknown, connections: readonly Connection[] = []): ModelProfile[] {
	return decodeSafely(
		() => (isVersioned(value) && Array.isArray(value.items) ? sanitizeProfiles(value.items, connections) : []),
		() => []
	);
}

export function decodeRouting(value: unknown): AiRouting {
	return decodeSafely(
		() => (isVersioned(value) ? sanitizeRouting(value) : { taskProfiles: {} }),
		() => ({ taskProfiles: {} })
	);
}

export function decodeInterpreter(value: unknown): AiInterpreterToggles {
	const defaults = () => ({ enabled: AI_SETTINGS_DEFAULTS.enabled, autoRun: AI_SETTINGS_DEFAULTS.autoRun });
	return decodeSafely(() => {
		if (!isVersioned(value)) return defaults();
		return {
			enabled: typeof value.enabled === 'boolean' ? value.enabled : AI_SETTINGS_DEFAULTS.enabled,
			autoRun: typeof value.autoRun === 'boolean' ? value.autoRun : AI_SETTINGS_DEFAULTS.autoRun
		};
	}, defaults);
}

export function decodePromptContext(value: unknown): string {
	return decodeSafely(
		() => (isVersioned(value) && typeof value.text === 'string' ? value.text : AI_SETTINGS_DEFAULTS.defaultPromptContext),
		() => AI_SETTINGS_DEFAULTS.defaultPromptContext
	);
}

/** `{ [connectionId]: apiKey }`; blank keys are dropped. */
export function decodeCredentials(value: unknown): Record<string, string> {
	return decodeSafely(() => {
		const credentials: Record<string, string> = {};
		if (!isRecord(value)) return credentials;
		for (const [id, key] of Object.entries(value)) {
			if (isId(id) && isSafeMapKey(id) && typeof key === 'string' && key.trim()) credentials[id] = key;
		}
		return credentials;
	}, () => ({}));
}

function decodeModelChecks(value: unknown): ConnectionModelCheck[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value
		.filter((item): item is Record<string, unknown> => isRecord(item))
		.filter(item => isId(item.profileId) && typeof item.model === 'string' && typeof item.listed === 'boolean')
		.map(item => ({ profileId: item.profileId as string, model: item.model as string, listed: item.listed as boolean }));
}

function decodeStatusEntry(raw: unknown): ConnectionStatus | undefined {
	if (!isRecord(raw)) return undefined;
	const tested = (raw.state === 'ok' || raw.state === 'failing') && finiteNumber(raw.testedAt) !== undefined;
	const code = (AI_ERROR_CODES as readonly string[]).includes(raw.code as string) ? raw.code as AiErrorCode : undefined;
	const status = positiveInteger(raw.status);
	const models = decodeModelChecks(raw.models);
	const structuredOutput = raw.structuredOutput === 'json_schema'
		|| raw.structuredOutput === 'json_object'
		|| raw.structuredOutput === 'none'
		? raw.structuredOutput
		: undefined;
	const entry: ConnectionStatus = {
		...(tested ? { state: raw.state as 'ok' | 'failing', testedAt: raw.testedAt as number } : {}),
		...(code ? { code } : {}),
		...(status !== undefined ? { status } : {}),
		...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
		...(models ? { models } : {}),
		...(structuredOutput ? { structuredOutput } : {})
	};
	return tested || structuredOutput ? entry : undefined;
}

/** `{ [connectionId]: ConnectionStatus }`; entries without a test result or a mode are dropped. */
export function decodeConnectionStatus(value: unknown): Record<string, ConnectionStatus> {
	return decodeSafely(() => {
		const statuses: Record<string, ConnectionStatus> = {};
		if (!isRecord(value)) return statuses;
		for (const [id, raw] of Object.entries(value)) {
			const entry = isId(id) && isSafeMapKey(id) ? decodeStatusEntry(raw) : undefined;
			if (entry) statuses[id] = entry;
		}
		return statuses;
	}, () => ({}));
}

/** Decodes the v2 items read from sync and local storage into the view every reader uses. */
export function decodeAiSettings(
	sync: Record<string, unknown>,
	local: Record<string, unknown>,
	nativeMessaging: NativeMessagingSupport
): AiSettingsView {
	const connections = decodeConnections(sync[AI_CONNECTIONS_KEY]);
	const interpreter = decodeInterpreter(sync[AI_INTERPRETER_KEY]);
	return {
		enabled: interpreter.enabled,
		connections,
		profiles: decodeProfiles(sync[AI_PROFILES_KEY], connections),
		routing: decodeRouting(sync[AI_ROUTING_KEY]),
		interpreter: {
			autoRun: interpreter.autoRun,
			defaultPromptContext: decodePromptContext(sync[AI_PROMPT_CONTEXT_KEY])
		},
		credentials: decodeCredentials(local[AI_CREDENTIALS_KEY]),
		nativeMessaging
	};
}

// --- Encoders ------------------------------------------------------------------------------------

// Encoders run the same sanitizers as the decoders, so `decode(encode(x))` round-trips and
// nothing outside the schema is written.
export function encodeConnections(items: readonly Connection[]): StoredConnections {
	return { v: 1, items: sanitizeConnections(items) };
}

export function encodeProfiles(items: readonly ModelProfile[], connections: readonly Connection[] = []): StoredProfiles {
	return { v: 1, items: sanitizeProfiles(items, connections) };
}

export function encodeRouting(routing: AiRouting): StoredRouting {
	return { v: 1, ...sanitizeRouting(routing) };
}

export function encodeInterpreter({ enabled, autoRun }: AiInterpreterToggles): StoredInterpreter {
	return { v: 1, enabled: enabled === true, autoRun: autoRun === true };
}

export function encodePromptContext(text: string): StoredPromptContext {
	return { v: 1, text: typeof text === 'string' ? text : '' };
}

export function encodeCredentials(credentials: Record<string, string>): Record<string, string> {
	return decodeCredentials(credentials);
}

/** The five sync items for a view. Credentials are never part of it. */
export function encodeAiSettingsSync(view: AiSettingsView): AiSyncItems {
	return {
		[AI_CONNECTIONS_KEY]: encodeConnections(view.connections),
		[AI_PROFILES_KEY]: encodeProfiles(view.profiles, view.connections),
		[AI_ROUTING_KEY]: encodeRouting(view.routing),
		[AI_INTERPRETER_KEY]: encodeInterpreter({ enabled: view.enabled, autoRun: view.interpreter.autoRun }),
		[AI_PROMPT_CONTEXT_KEY]: encodePromptContext(view.interpreter.defaultPromptContext)
	};
}

/**
 * The five sync items of a fresh v2 configuration, from `AI_SETTINGS_DEFAULTS`. A response
 * language (the v1 Reader setting, which can exist without any other v1 AI item) is kept.
 */
export function defaultAiSyncItems(responseLanguage?: string): AiSyncItems {
	return {
		[AI_CONNECTIONS_KEY]: encodeConnections(AI_SETTINGS_DEFAULTS.connections),
		[AI_PROFILES_KEY]: encodeProfiles(AI_SETTINGS_DEFAULTS.profiles),
		[AI_ROUTING_KEY]: encodeRouting({
			taskProfiles: { ...AI_SETTINGS_DEFAULTS.taskProfiles },
			...(responseLanguage ? { responseLanguage } : {})
		}),
		[AI_INTERPRETER_KEY]: encodeInterpreter({ enabled: AI_SETTINGS_DEFAULTS.enabled, autoRun: AI_SETTINGS_DEFAULTS.autoRun }),
		[AI_PROMPT_CONTEXT_KEY]: encodePromptContext(AI_SETTINGS_DEFAULTS.defaultPromptContext)
	};
}

// --- Quota ---------------------------------------------------------------------------------------

export type AiSettingsStorageErrorReason = 'item-too-large' | 'total-quota' | 'write-rate';

export interface AiSettingsStorageErrorDetails {
	key?: string;
	bytes?: number;
	cause?: unknown;
}

/** A storage write the browser refused, or would refuse, for quota reasons. Shown in Settings. */
export class AiSettingsStorageError extends Error {
	readonly reason: AiSettingsStorageErrorReason;
	readonly key?: string;
	readonly bytes?: number;
	readonly cause?: unknown;

	constructor(reason: AiSettingsStorageErrorReason, details: AiSettingsStorageErrorDetails = {}) {
		super(details.key ? `AI settings write refused (${reason}): ${details.key}` : `AI settings write refused (${reason})`);
		this.name = 'AiSettingsStorageError';
		this.reason = reason;
		if (details.key !== undefined) this.key = details.key;
		if (details.bytes !== undefined) this.bytes = details.bytes;
		if (details.cause !== undefined) this.cause = details.cause;
	}
}

export function isAiSettingsStorageError(error: unknown): error is AiSettingsStorageError {
	return error instanceof Error && error.name === 'AiSettingsStorageError';
}

function errorMessage(error: unknown): string {
	if (typeof error === 'string') return error;
	if (isRecord(error) || error instanceof Error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === 'string') return message;
	}
	return '';
}

/**
 * Maps a storage runtime error to a quota reason. Chrome reports `QUOTA_BYTES_PER_ITEM quota
 * exceeded`, `QUOTA_BYTES quota exceeded`, `MAX_ITEMS quota exceeded`, and
 * `MAX_WRITE_OPERATIONS_PER_MINUTE` / `_PER_HOUR` (and `MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE`
 * on old builds). Firefox reports a generic `QuotaExceededError`; since the per-item size is checked
 * before every sync write, that is treated as the total quota.
 */
export function storageErrorReason(error: unknown): AiSettingsStorageErrorReason | undefined {
	const message = errorMessage(error);
	if (message.includes('QUOTA_BYTES_PER_ITEM')) return 'item-too-large';
	if (/MAX_(SUSTAINED_)?WRITE_OPERATIONS_PER_(MINUTE|HOUR)/.test(message)) return 'write-rate';
	if (message.includes('QUOTA_BYTES') || message.includes('MAX_ITEMS') || message.includes('QuotaExceededError')) {
		return 'total-quota';
	}
	return undefined;
}

/** The mapped error, or the original error when it is not a quota failure. */
export function toAiSettingsStorageError(error: unknown, key?: string): unknown {
	if (isAiSettingsStorageError(error)) return error;
	const reason = storageErrorReason(error);
	return reason ? new AiSettingsStorageError(reason, { key, cause: error }) : error;
}

function utf8Length(text: string): number {
	let bytes = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
			&& text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
			bytes += 4;
			index++;
		} else bytes += 3;
	}
	return bytes;
}

/**
 * The size Chrome charges against `QUOTA_BYTES_PER_ITEM` for `{ [key]: value }`: the UTF-8 length
 * of the key plus the UTF-8 length of the value serialized by Chromium's JSON writer
 * (`key.size() + json.size()` in the sync quota enforcer). JS `JSON.stringify` matches that
 * writer except that Chromium also escapes `<` as `<` and U+2028 / U+2029 as ` ` /
 * ` `; those escapes are added here so the estimate is never below Chrome's count. (JS
 * escapes lone surrogates as `\uXXXX` where Chrome writes U+FFFD, which only over-counts.)
 */
export function syncItemBytes(key: string, value: unknown): number {
	const json = JSON.stringify(value) ?? '';
	let escapeOverhead = 0;
	for (let index = 0; index < json.length; index++) {
		const code = json.charCodeAt(index);
		if (code === 0x3c) escapeOverhead += 5; // "<" (1 byte) → "<" (6 bytes)
		else if (code === 0x2028 || code === 0x2029) escapeOverhead += 3; // 3 bytes → 6 bytes
	}
	return utf8Length(key) + utf8Length(json) + escapeOverhead;
}

/** Throws `AiSettingsStorageError('item-too-large')` when the item exceeds 8,192 bytes. */
export function assertSyncItemSize(key: string, value: unknown): void {
	const bytes = syncItemBytes(key, value);
	if (bytes > SYNC_QUOTA_BYTES_PER_ITEM) {
		throw new AiSettingsStorageError('item-too-large', { key, bytes });
	}
}

// --- v1 for derived mode -------------------------------------------------------------------------

/** The v1 fields `deriveAiSettings` reads. */
export type V1AiSettings = Pick<Settings,
	| 'interpreterModel'
	| 'models'
	| 'providers'
	| 'interpreterEnabled'
	| 'interpreterAutoRun'
	| 'interpreterExecutionMode'
	| 'interpreterCodexModel'
	| 'interpreterCodexReasoningEffort'
	| 'defaultPromptContext'
> & { readerSettings: Pick<ReaderSettings, 'learningResponseLanguage'> };

/**
 * Reads the raw v1 `interpreter_settings` and `reader_settings` items the way `loadSettings` does:
 * providers and models must be objects with a string id, the mode is `api` unless `grok` / `codex`,
 * and the Codex model and effort are normalized. Values of the wrong type read as their defaults.
 */
export function sanitizeV1AiSettings(interpreterSettings: unknown, readerSettings: unknown): V1AiSettings {
	const interpreter = isRecord(interpreterSettings) ? interpreterSettings : {};
	const reader = isRecord(readerSettings) ? readerSettings : {};
	const withStringId = (value: unknown) => Array.isArray(value)
		? value.filter(item => isRecord(item) && typeof item.id === 'string')
		: [];
	const mode = interpreter.interpreterExecutionMode;
	return {
		interpreterModel: typeof interpreter.interpreterModel === 'string' ? interpreter.interpreterModel : '',
		models: withStringId(interpreter.models) as Settings['models'],
		providers: withStringId(interpreter.providers) as Settings['providers'],
		interpreterEnabled: typeof interpreter.interpreterEnabled === 'boolean' ? interpreter.interpreterEnabled : false,
		interpreterAutoRun: typeof interpreter.interpreterAutoRun === 'boolean' ? interpreter.interpreterAutoRun : false,
		interpreterExecutionMode: mode === 'grok' || mode === 'codex' ? mode : 'api',
		interpreterCodexModel: normalizeCodexModel(interpreter.interpreterCodexModel),
		interpreterCodexReasoningEffort: normalizeCodexReasoningEffort(interpreter.interpreterCodexReasoningEffort),
		defaultPromptContext: typeof interpreter.defaultPromptContext === 'string' ? interpreter.defaultPromptContext : '',
		readerSettings: {
			learningResponseLanguage: typeof reader.learningResponseLanguage === 'string' ? reader.learningResponseLanguage : ''
		}
	};
}

/** The trimmed v1 Reader response language, as the migration copies it to `ai_routing`. */
function v1ResponseLanguage(readerSettings: unknown): string | undefined {
	const language = isRecord(readerSettings) && typeof readerSettings.learningResponseLanguage === 'string'
		? readerSettings.learningResponseLanguage.trim()
		: '';
	return language || undefined;
}

// --- Store ---------------------------------------------------------------------------------------

/** Pure planner for the v1 → v2 bootstrap (implemented in `migrate.ts`). */
export interface AiSettingsBootstrapper {
	// Given the raw sync and local items read by load(), return the writes to apply (or nothing).
	plan(
		rawSync: Record<string, unknown>,
		rawLocal: Record<string, unknown>,
		build: string
	): { sync?: Record<string, unknown>; local?: Record<string, unknown> } | undefined;
}

export interface StorageChangeLike {
	oldValue?: unknown;
	newValue?: unknown;
}

export type StorageChangedListener = (changes: Record<string, StorageChangeLike>, areaName: string) => void;

/** The add / remove listener shape of `browser.storage.onChanged`. */
export interface StorageChangedEventLike {
	addListener(listener: StorageChangedListener): void;
	removeListener(listener: StorageChangedListener): void;
}

export interface AiSettingsChange {
	area: AiStorageAreaName;
	/** The AI keys that changed in this event, in the order of `AI_*_KEYS`. */
	keys: AiStorageKey[];
}

export interface AiSettingsStoreOptions {
	sync: StorageAreaLike;
	local: StorageAreaLike;
	/** Reserved for diagnostics (5c); only observed here. */
	session?: StorageAreaLike;
	onChanged?: StorageChangedEventLike;
	nativeMessaging: NativeMessagingSupport | (() => NativeMessagingSupport);
	/** Whether `load()` runs the bootstrapper. Pass `AI_V2_BOOTSTRAP`. */
	bootstrap: boolean;
	bootstrapper?: AiSettingsBootstrapper;
	/** Manifest version, passed to the bootstrapper. */
	build?: string;
}

export interface AiSettingsSnapshot {
	view: AiSettingsView;
	/**
	 * `stored` when sync has `ai_connections`; `derived` when it does not, and the view is computed
	 * from v1 (or is the defaults when no v1 item exists either).
	 */
	mode: 'stored' | 'derived';
	connectionStatus: Record<string, ConnectionStatus>;
	/** Why the bootstrap writes failed; the view then reflects only what is actually stored. */
	bootstrapError?: unknown;
}

/**
 * Every write resolves `true` when it was written and `false` when it was skipped: the store is
 * read-only until v2 exists (derived mode), and a delete of something absent writes nothing.
 * Quota failures reject with `AiSettingsStorageError`.
 */
export interface AiSettingsStore {
	load(): Promise<AiSettingsView>;
	loadSnapshot(): Promise<AiSettingsSnapshot>;
	saveConnections(items: readonly Connection[]): Promise<boolean>;
	saveProfiles(items: readonly ModelProfile[]): Promise<boolean>;
	saveRouting(routing: AiRouting): Promise<boolean>;
	saveInterpreter(settings: AiInterpreterToggles): Promise<boolean>;
	savePromptContext(text: string): Promise<boolean>;
	setCredential(connectionId: string, apiKey: string): Promise<boolean>;
	deleteCredential(connectionId: string): Promise<boolean>;
	deleteConnectionStatus(connectionIds: string | readonly string[]): Promise<boolean>;
	/**
	 * Makes sure v2 exists before a Settings write, for a user action only. Resolves `true` when
	 * `ai_connections` is stored afterwards. A pending v1 migration runs first (its failure
	 * rejects); only when neither v1 nor v2 exists (a fresh install) does it write the sync items
	 * that are absent, from `AI_SETTINGS_DEFAULTS`, in one `set`. It never overwrites a stored item,
	 * and a store without the bootstrapper (Popup, Reader) never creates v2 and resolves `false`.
	 */
	ensureV2(): Promise<boolean>;
	/** Reports which AI keys changed, per area. Returns the unsubscribe function. */
	observe(listener: (change: AiSettingsChange) => void): () => void;
}

const SYNC_READ_KEYS: string[] = [...AI_SYNC_KEYS, V1_INTERPRETER_SETTINGS_KEY, V1_READER_SETTINGS_KEY];
const OBSERVED_KEYS: Record<AiStorageAreaName, readonly AiStorageKey[]> = {
	sync: AI_SYNC_KEYS,
	local: AI_LOCAL_KEYS,
	session: AI_SESSION_KEYS
};

function nonEmpty(items: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	return items && Object.keys(items).length > 0 ? items : undefined;
}

export function createAiSettingsStore(options: AiSettingsStoreOptions): AiSettingsStore {
	const { sync, local, onChanged } = options;
	const bootstrapper = options.bootstrap ? options.bootstrapper : undefined;
	const build = options.build ?? '';
	const nativeMessaging = () => (
		typeof options.nativeMessaging === 'function' ? options.nativeMessaging() : options.nativeMessaging
	);
	// Bootstrap loads run one at a time so a second load sees the first one's writes.
	let loadQueue: Promise<unknown> = Promise.resolve();
	// Local read-modify-write updates (credentials, status) run one at a time in this context.
	let localQueue: Promise<unknown> = Promise.resolve();

	async function setMapped(area: StorageAreaLike, items: Record<string, unknown>): Promise<void> {
		try {
			await area.set(items);
		} catch (error) {
			const keys = Object.keys(items);
			throw toAiSettingsStorageError(error, keys.length === 1 ? keys[0] : undefined);
		}
	}

	async function readSnapshot(): Promise<AiSettingsSnapshot> {
		const [rawSync, rawLocal] = await Promise.all([sync.get(SYNC_READ_KEYS), local.get([...AI_LOCAL_KEYS])]);
		let syncState: Record<string, unknown> = { ...rawSync };
		let localState: Record<string, unknown> = { ...rawLocal };
		let bootstrapError: unknown;

		if (bootstrapper) {
			try {
				const plan = bootstrapper.plan(rawSync, rawLocal, build);
				const syncWrites = nonEmpty(plan?.sync);
				const localWrites = nonEmpty(plan?.local);
				// Sync first: if the bundle cannot be written, the migration record is not either,
				// so the next load tries again.
				if (syncWrites) {
					for (const [key, value] of Object.entries(syncWrites)) assertSyncItemSize(key, value);
					await setMapped(sync, syncWrites);
					syncState = { ...syncState, ...syncWrites };
				}
				if (localWrites) {
					await setMapped(local, localWrites);
					localState = { ...localState, ...localWrites };
				}
			} catch (error) {
				bootstrapError = error;
			}
		}

		const support = nativeMessaging();
		const connectionStatus = decodeConnectionStatus(localState[AI_CONNECTION_STATUS_KEY]);
		const errorField = bootstrapError !== undefined ? { bootstrapError } : {};
		if (syncState[AI_CONNECTIONS_KEY] !== undefined) {
			return { view: decodeAiSettings(syncState, localState, support), mode: 'stored', connectionStatus, ...errorField };
		}
		if (!isRecord(syncState[V1_INTERPRETER_SETTINGS_KEY])) {
			// Neither v2 nor v1 AI settings: a fresh install. Show what `ensureV2` would create, not
			// the legacy CLI connections a derived view always lists.
			return { view: freshView(syncState, localState, support), mode: 'derived', connectionStatus, ...errorField };
		}
		const v1 = sanitizeV1AiSettings(syncState[V1_INTERPRETER_SETTINGS_KEY], syncState[V1_READER_SETTINGS_KEY]);
		return {
			// deriveAiSettings reads only the fields in V1AiSettings.
			view: deriveAiSettings(v1 as Settings, { nativeMessaging: support }),
			mode: 'derived',
			connectionStatus,
			...errorField
		};
	}

	function loadSnapshot(): Promise<AiSettingsSnapshot> {
		if (!bootstrapper) return readSnapshot();
		const result = loadQueue.then(readSnapshot);
		loadQueue = result.catch(() => undefined);
		return result;
	}

	/**
	 * The stored connections when v2 exists, else undefined (derived mode: write nothing). While
	 * bootstrapping, a write before the first load runs the bootstrap first, so a write can never
	 * create a partial v2 that would stop the migration.
	 */
	async function storedConnections(): Promise<Connection[] | undefined> {
		let raw = (await sync.get(AI_CONNECTIONS_KEY))[AI_CONNECTIONS_KEY];
		if (raw === undefined && bootstrapper) {
			const snapshot = await loadSnapshot();
			raw = (await sync.get(AI_CONNECTIONS_KEY))[AI_CONNECTIONS_KEY];
			if (raw === undefined && snapshot.bootstrapError !== undefined) throw snapshot.bootstrapError;
		}
		return raw === undefined ? undefined : decodeConnections(raw);
	}

	async function saveSyncItem(key: AiSyncKey, encode: (connections: Connection[]) => unknown): Promise<boolean> {
		const connections = await storedConnections();
		if (!connections) return false;
		const value = encode(connections);
		assertSyncItemSize(key, value);
		await setMapped(sync, { [key]: value });
		return true;
	}

	function updateLocal<T>(
		key: AiLocalKey,
		decode: (value: unknown) => Record<string, T>,
		update: (current: Record<string, T>) => Record<string, T> | undefined
	): Promise<boolean> {
		const run = async () => {
			if (!(await storedConnections())) return false;
			const current = decode((await local.get(key))[key]);
			const next = update(current);
			if (!next) return false;
			await setMapped(local, { [key]: next });
			return true;
		};
		const result = localQueue.then(run);
		localQueue = result.catch(() => undefined);
		return result;
	}

	function requireId(connectionId: unknown): string {
		if (!isId(connectionId)) throw new TypeError('A connection id is required.');
		return connectionId;
	}

	function freshView(
		syncState: Record<string, unknown>,
		localState: Record<string, unknown>,
		support: NativeMessagingSupport
	): AiSettingsView {
		const view = decodeAiSettings(syncState, localState, support);
		const language = v1ResponseLanguage(syncState[V1_READER_SETTINGS_KEY]);
		if (syncState[AI_ROUTING_KEY] !== undefined || !language) return view;
		return { ...view, routing: { ...view.routing, responseLanguage: language } };
	}

	function ensureV2(): Promise<boolean> {
		if (!bootstrapper) return Promise.resolve(false);
		const run = async (): Promise<boolean> => {
			// Runs the v1 migration when v1 exists, so a fresh v2 can never skip it.
			const snapshot = await readSnapshot();
			if (snapshot.mode === 'stored') return true;
			if (snapshot.bootstrapError !== undefined) throw snapshot.bootstrapError;
			const raw = await sync.get(SYNC_READ_KEYS);
			if (raw[AI_CONNECTIONS_KEY] !== undefined) return true;
			// v1 that the bootstrapper did not migrate is left to it; nothing is created over it.
			if (isRecord(raw[V1_INTERPRETER_SETTINGS_KEY])) return false;
			const writes: Record<string, unknown> = {};
			const defaults = defaultAiSyncItems(v1ResponseLanguage(raw[V1_READER_SETTINGS_KEY]));
			for (const [key, value] of Object.entries(defaults)) {
				if (raw[key] === undefined) writes[key] = value;
			}
			for (const [key, value] of Object.entries(writes)) assertSyncItemSize(key, value);
			await setMapped(sync, writes);
			return true;
		};
		// Queued with bootstrap loads, so a concurrent load cannot interleave with the writes.
		const result = loadQueue.then(run);
		loadQueue = result.catch(() => undefined);
		return result;
	}

	async function deleteCredential(connectionId: string): Promise<boolean> {
		const id = requireId(connectionId);
		return updateLocal(AI_CREDENTIALS_KEY, decodeCredentials, current => {
			if (!Object.prototype.hasOwnProperty.call(current, id)) return undefined;
			const next = { ...current };
			delete next[id];
			return next;
		});
	}

	return {
		async load() {
			return (await loadSnapshot()).view;
		},
		loadSnapshot,
		saveConnections(items) {
			return saveSyncItem(AI_CONNECTIONS_KEY, () => encodeConnections(items));
		},
		saveProfiles(items) {
			return saveSyncItem(AI_PROFILES_KEY, connections => encodeProfiles(items, connections));
		},
		saveRouting(routing) {
			return saveSyncItem(AI_ROUTING_KEY, () => encodeRouting(routing));
		},
		saveInterpreter(settings) {
			return saveSyncItem(AI_INTERPRETER_KEY, () => encodeInterpreter(settings));
		},
		savePromptContext(text) {
			return saveSyncItem(AI_PROMPT_CONTEXT_KEY, () => encodePromptContext(text));
		},
		async setCredential(connectionId, apiKey) {
			const id = requireId(connectionId);
			const key = typeof apiKey === 'string' ? apiKey.trim() : '';
			if (!key) return deleteCredential(id);
			return updateLocal(AI_CREDENTIALS_KEY, decodeCredentials, current => (
				current[id] === key ? undefined : { ...current, [id]: key }
			));
		},
		deleteCredential,
		ensureV2,
		async deleteConnectionStatus(connectionIds) {
			const ids = (typeof connectionIds === 'string' ? [connectionIds] : [...connectionIds]).map(requireId);
			return updateLocal(AI_CONNECTION_STATUS_KEY, decodeConnectionStatus, current => {
				const present = ids.filter(id => Object.prototype.hasOwnProperty.call(current, id));
				if (present.length === 0) return undefined;
				const next = { ...current };
				for (const id of present) delete next[id];
				return next;
			});
		},
		observe(listener) {
			if (!onChanged) return () => {};
			const handler: StorageChangedListener = (changes, areaName) => {
				const watched = (OBSERVED_KEYS as Record<string, readonly AiStorageKey[] | undefined>)[areaName];
				if (!watched || !isRecord(changes)) return;
				const keys = watched.filter(key => Object.prototype.hasOwnProperty.call(changes, key));
				if (keys.length > 0) listener({ area: areaName as AiStorageAreaName, keys });
			};
			onChanged.addListener(handler);
			return () => onChanged.removeListener(handler);
		}
	};
}

// --- Connection status (gateway side) -------------------------------------------------------------

/**
 * The gateway's access to `ai_connection_status` in `storage.local`. Only the gateway creates
 * entries (a Test result, a structured-output downgrade); the Settings store only deletes them.
 */
export interface ConnectionStatusStore {
	get(connectionId: string): Promise<ConnectionStatus | undefined>;
	/**
	 * Read-modify-write of one entry, serialized in this context; `undefined` removes it. Rejects
	 * when the write fails.
	 */
	update(
		connectionId: string,
		update: (current: ConnectionStatus | undefined) => ConnectionStatus | undefined
	): Promise<void>;
	/** Removes the Phase 3 `ai_structured_output` cache. */
	removeLegacyCache(): Promise<void>;
}

/** A status store over `local`; without an area it keeps the entries in memory. */
export function createConnectionStatusStore(local?: StorageAreaLike): ConnectionStatusStore {
	let memory: Record<string, ConnectionStatus> = {};
	let queue: Promise<unknown> = Promise.resolve();
	const read = async (): Promise<Record<string, ConnectionStatus>> => {
		if (!local) return { ...memory };
		return decodeConnectionStatus((await local.get(AI_CONNECTION_STATUS_KEY))[AI_CONNECTION_STATUS_KEY]);
	};
	return {
		async get(connectionId) {
			try {
				return (await read())[connectionId];
			} catch {
				return undefined;
			}
		},
		update(connectionId, update) {
			const run = async () => {
				if (!isId(connectionId) || !isSafeMapKey(connectionId)) return;
				const current = await read();
				const next = update(current[connectionId]);
				const entries = { ...current };
				if (next) entries[connectionId] = next;
				else if (connectionId in entries) delete entries[connectionId];
				else return;
				if (local) await local.set({ [AI_CONNECTION_STATUS_KEY]: entries });
				else memory = entries;
			};
			const result = queue.then(run);
			queue = result.catch(() => undefined);
			return result;
		},
		async removeLegacyCache() {
			await local?.remove(LEGACY_STRUCTURED_OUTPUT_KEY);
		}
	};
}
