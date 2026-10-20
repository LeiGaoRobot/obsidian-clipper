import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StorageAreaLike } from '../../ai/job-store';
import {
	createAiSettingsStore,
	createConnectionStatusStore,
	encodeConnections,
	encodeInterpreter,
	encodeProfiles,
	encodePromptContext,
	encodeRouting,
	type AiSettingsBootstrapper,
	type AiSettingsStore,
	type StorageChangeLike,
	type StorageChangedListener
} from '../../ai/settings';
import type { AiRouting, Connection, ConnectionStatus, ModelProfile, NativeMessagingSupport } from '../../ai/types';
import type { NativeCliInstallEnvironment } from './native-cli';

// Test support for the AI settings section: the real store over in-memory storage areas (so
// writes, quota mapping, and `observe` behave as in the browser) and the real settings.html.

function clone<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

export interface MemoryArea extends StorageAreaLike {
	name: 'sync' | 'local' | 'session';
	data: Record<string, unknown>;
	/** The next `set` rejects with this error. */
	failNextSet?: unknown;
	sets: Record<string, unknown>[];
}

export interface FakeOnChanged {
	addListener(listener: StorageChangedListener): void;
	removeListener(listener: StorageChangedListener): void;
	emit(changes: Record<string, StorageChangeLike>, area: string): void;
	listeners: Set<StorageChangedListener>;
}

function createOnChanged(): FakeOnChanged {
	const listeners = new Set<StorageChangedListener>();
	return {
		listeners,
		addListener: listener => listeners.add(listener),
		removeListener: listener => listeners.delete(listener),
		emit: (changes, area) => {
			for (const listener of [...listeners]) listener(changes, area);
		}
	};
}

function createMemoryArea(name: MemoryArea['name'], initial: Record<string, unknown>, onChanged: FakeOnChanged): MemoryArea {
	const area: MemoryArea = {
		name,
		data: clone(initial),
		sets: [],
		async get(keys) {
			const list = keys == null ? Object.keys(area.data) : Array.isArray(keys) ? keys : [keys];
			const result: Record<string, unknown> = {};
			for (const key of list) if (area.data[key] !== undefined) result[key] = clone(area.data[key]);
			return result;
		},
		async set(values) {
			if (area.failNextSet !== undefined) {
				const error = area.failNextSet;
				area.failNextSet = undefined;
				throw error;
			}
			area.sets.push(clone(values));
			const changes: Record<string, StorageChangeLike> = {};
			for (const [key, value] of Object.entries(values)) {
				changes[key] = { oldValue: clone(area.data[key]), newValue: clone(value) };
				area.data[key] = clone(value);
			}
			onChanged.emit(changes, name);
		},
		async remove(keys) {
			for (const key of Array.isArray(keys) ? keys : [keys]) delete area.data[key];
		}
	};
	return area;
}

export interface FakeSettings {
	connections?: Connection[];
	profiles?: ModelProfile[];
	routing?: AiRouting;
	enabled?: boolean;
	autoRun?: boolean;
	promptContext?: string;
	credentials?: Record<string, string>;
	status?: Record<string, ConnectionStatus>;
	nativeMessaging?: NativeMessagingSupport;
	/** Leave v2 absent so the store is in derived mode. */
	derived?: boolean;
	/** Raw v1 sync items (`interpreter_settings`, `reader_settings`) to seed. */
	v1?: Record<string, unknown>;
	/** Makes the store a bootstrapping one, as the Settings page's is. */
	bootstrapper?: AiSettingsBootstrapper;
	/** Seeds `storage.session`, which only the Diagnostics panel reads. */
	session?: Record<string, unknown>;
}

export interface FakeStore {
	store: AiSettingsStore;
	sync: MemoryArea;
	local: MemoryArea;
	session: MemoryArea;
	onChanged: FakeOnChanged;
	/** The gateway's `status-clear` over `local`, as the Settings page's controller sends it. */
	clearConnectionStatus: (connectionId: string) => Promise<void>;
}

export function createFakeStore(settings: FakeSettings = {}): FakeStore {
	const onChanged = createOnChanged();
	const syncData: Record<string, unknown> = settings.derived ? { ...(settings.v1 ?? {}) } : {
		...(settings.v1 ?? {}),
		ai_connections: encodeConnections(settings.connections ?? []),
		ai_profiles: encodeProfiles(settings.profiles ?? [], settings.connections ?? []),
		ai_routing: encodeRouting(settings.routing ?? { taskProfiles: {} }),
		ai_interpreter: encodeInterpreter({ enabled: settings.enabled ?? true, autoRun: settings.autoRun ?? false }),
		ai_prompt_context: encodePromptContext(settings.promptContext ?? '')
	};
	const localData: Record<string, unknown> = {
		...(settings.credentials ? { ai_credentials: settings.credentials } : {}),
		...(settings.status ? { ai_connection_status: settings.status } : {})
	};
	const sync = createMemoryArea('sync', syncData, onChanged);
	const local = createMemoryArea('local', localData, onChanged);
	const session = createMemoryArea('session', settings.session ?? {}, onChanged);
	const store = createAiSettingsStore({
		sync,
		local,
		onChanged,
		nativeMessaging: settings.nativeMessaging ?? 'port',
		bootstrap: Boolean(settings.bootstrapper),
		...(settings.bootstrapper ? { bootstrapper: settings.bootstrapper, build: '9.9.9' } : {})
	});
	const status = createConnectionStatusStore(local);
	const clearConnectionStatus = (connectionId: string) => status.update(connectionId, () => undefined);
	return { store, sync, local, session, onChanged, clearConnectionStatus };
}

let settingsHtml: string | undefined;

/** Loads the real settings.html body into the jsdom document, as `interpreter-settings.test.ts` parses it. */
export function loadSettingsDocument(): Document {
	settingsHtml ??= readFileSync(resolve(process.cwd(), 'src/settings.html'), 'utf8');
	const parsed = new DOMParser().parseFromString(settingsHtml, 'text/html');
	document.body.replaceChildren(...Array.from(parsed.body.childNodes).map(node => document.importNode(node, true)));
	return document;
}

export function installGuideEnvironment(overrides: Partial<NativeCliInstallEnvironment> = {}): NativeCliInstallEnvironment {
	return {
		extensionId: 'abcdefghijklmnopabcdefghijklmnop',
		platform: 'mac',
		isChrome: true,
		workspaceRoot: '/Users/example/obsidian-clipper',
		copyText: async () => undefined,
		...overrides
	};
}

/** Lets queued mutations, store writes, and `observe` reloads settle. */
export async function settle(rounds = 8): Promise<void> {
	for (let index = 0; index < rounds; index++) await new Promise(resolve => setTimeout(resolve, 0));
}

export const API_CONNECTION: Connection = {
	id: 'openai',
	kind: 'openai-compatible',
	label: 'OpenAI',
	presetId: 'openai',
	baseUrl: 'https://api.openai.com/v1/chat/completions',
	apiKeyRequired: true
};

export const LOCAL_CONNECTION: Connection = {
	id: 'ollama',
	kind: 'ollama',
	label: 'Ollama',
	presetId: 'ollama',
	baseUrl: 'http://127.0.0.1:11434/api/chat',
	apiKeyRequired: false
};

export const CODEX_CONNECTION: Connection = { id: 'codex', kind: 'cli-codex', label: '' };

export const GPT_PROFILE: ModelProfile = { id: 'gpt', connectionId: 'openai', model: 'gpt-5.6', label: 'GPT', enabled: true };
export const MINI_PROFILE: ModelProfile = { id: 'mini', connectionId: 'openai', model: 'gpt-5.6-mini', label: '', enabled: true };
export const LLAMA_PROFILE: ModelProfile = { id: 'llama', connectionId: 'ollama', model: 'llama4', label: 'Llama', enabled: true };
export const CODEX_PROFILE: ModelProfile = {
	id: 'codex-high',
	connectionId: 'codex',
	model: 'gpt-5.6-sol',
	label: 'Codex high',
	options: { reasoningEffort: 'high' },
	enabled: true
};
