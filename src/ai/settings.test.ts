import { describe, expect, test, vi } from 'vitest';
import type { Settings } from '../types/types';
import type { StorageAreaLike } from './job-store';
import {
	AI_CONNECTION_STATUS_KEY,
	AI_CONNECTIONS_KEY,
	AI_CREDENTIALS_KEY,
	AI_INTERPRETER_KEY,
	AI_MIGRATION_KEY,
	AI_PROFILES_KEY,
	AI_PROMPT_CONTEXT_KEY,
	AI_ROUTING_KEY,
	AI_SETTINGS_DEFAULTS,
	AI_V2_BOOTSTRAP,
	AiSettingsStorageError,
	assertSyncItemSize,
	createAiSettingsStore,
	decodeAiSettings,
	decodeConnectionStatus,
	encodeAiSettingsSync,
	isAiSettingsStorageError,
	syncItemBytes,
	toAiSettingsStorageError,
	type AiSettingsBootstrapper,
	type AiSettingsChange,
	type StorageChangedListener
} from './settings';
import { deriveAiSettings } from './settings-view';

// --- Fakes ---------------------------------------------------------------------------------------

function clone<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

interface FakeArea extends StorageAreaLike {
	data: Record<string, unknown>;
	gets: (string | string[] | null | undefined)[];
	sets: Record<string, unknown>[];
	failNextSet?: unknown;
}

function fakeOnChanged() {
	const listeners = new Set<StorageChangedListener>();
	return {
		addListener: (listener: StorageChangedListener) => { listeners.add(listener); },
		removeListener: (listener: StorageChangedListener) => { listeners.delete(listener); },
		emit: (changes: Record<string, unknown>, areaName: string) => {
			for (const listener of listeners) listener(changes as Parameters<StorageChangedListener>[0], areaName);
		},
		size: () => listeners.size
	};
}

function fakeArea(initial: Record<string, unknown> = {}): FakeArea {
	const area: FakeArea = {
		data: clone(initial),
		gets: [],
		sets: [],
		async get(keys) {
			area.gets.push(keys);
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
			Object.assign(area.data, clone(values));
		},
		async remove(keys) {
			for (const key of Array.isArray(keys) ? keys : [keys]) delete area.data[key];
		}
	};
	return area;
}

// --- Fixtures ------------------------------------------------------------------------------------

const connections = [
	{ id: 'conn-openai', kind: 'openai-compatible', label: 'OpenAI', presetId: 'openai', baseUrl: 'https://api.openai.com/v1/chat/completions', apiKeyRequired: true, structuredOutput: 'json_schema', maxConcurrency: 4 },
	{ id: 'conn-codex', kind: 'cli-codex', label: '' }
];
const profiles = [
	{ id: 'p-gpt', connectionId: 'conn-openai', model: 'gpt-x', label: 'GPT', enabled: true, options: { temperature: 0.2, maxOutputTokens: 512 } },
	{ id: 'p-codex', connectionId: 'conn-codex', model: '  gpt-codex  ', label: '', enabled: true, options: { reasoningEffort: 'high' } }
];

function storedSync(): Record<string, unknown> {
	return {
		[AI_CONNECTIONS_KEY]: { v: 1, items: connections },
		[AI_PROFILES_KEY]: { v: 1, items: profiles },
		[AI_ROUTING_KEY]: { v: 1, defaultProfileId: 'p-gpt', taskProfiles: { translate: 'p-codex' }, responseLanguage: ' Japanese ' },
		[AI_INTERPRETER_KEY]: { v: 1, enabled: true, autoRun: true },
		[AI_PROMPT_CONTEXT_KEY]: { v: 1, text: 'Be brief.' }
	};
}

function storedLocal(): Record<string, unknown> {
	return { [AI_CREDENTIALS_KEY]: { 'conn-openai': 'sk-test', blank: '  ' } };
}

// The settings-view.test.ts v1 fixtures, as raw sync items.
function v1Interpreter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		interpreterEnabled: true,
		interpreterAutoRun: false,
		interpreterExecutionMode: 'api',
		interpreterModel: 'model-b',
		defaultPromptContext: 'Context',
		providers: [
			{ id: 'provider-anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1/messages', apiKey: 'sk-ant', apiKeyRequired: true },
			{ id: 'provider-ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/api/chat', apiKey: '', apiKeyRequired: false }
		],
		models: [
			{ id: 'model-a', providerId: 'provider-anthropic', providerModelId: 'claude-a', name: 'A', enabled: true },
			{ id: 'model-b', providerId: 'provider-ollama', providerModelId: 'llama', name: 'B', enabled: true },
			{ id: 'model-c', providerId: 'provider-anthropic', providerModelId: 'claude-c', name: 'C', enabled: false }
		],
		...overrides
	};
}

function v1Settings(interpreter: Record<string, unknown>, reader: Record<string, unknown> | undefined): Settings {
	return {
		...interpreter,
		interpreterExecutionMode: interpreter.interpreterExecutionMode ?? 'api',
		readerSettings: { learningResponseLanguage: reader?.learningResponseLanguage ?? '' }
	} as unknown as Settings;
}

function derivedStore(sync: Record<string, unknown>, local: Record<string, unknown> = {}) {
	const areas = { sync: fakeArea(sync), local: fakeArea(local) };
	const store = createAiSettingsStore({ ...areas, nativeMessaging: 'port', bootstrap: false });
	return { ...areas, store };
}

function stubBootstrapper(writes: ReturnType<AiSettingsBootstrapper['plan']>) {
	return { plan: vi.fn<AiSettingsBootstrapper['plan']>(() => clone(writes)) };
}

// --- Codec ---------------------------------------------------------------------------------------

describe('decodeAiSettings', () => {
	test('uses the defaults for every absent key', () => {
		expect(decodeAiSettings({}, {}, 'none')).toEqual({
			enabled: AI_SETTINGS_DEFAULTS.enabled,
			connections: [],
			profiles: [],
			routing: { taskProfiles: {} },
			interpreter: { autoRun: false, defaultPromptContext: '' },
			credentials: {},
			nativeMessaging: 'none'
		});
	});

	test('decodes every key', () => {
		const view = decodeAiSettings(storedSync(), storedLocal(), 'port');
		expect(view.enabled).toBe(true);
		expect(view.connections).toEqual(connections);
		expect(view.profiles[0]).toEqual(profiles[0]);
		expect(view.routing).toEqual({ defaultProfileId: 'p-gpt', taskProfiles: { translate: 'p-codex' }, responseLanguage: 'Japanese' });
		expect(view.interpreter).toEqual({ autoRun: true, defaultPromptContext: 'Be brief.' });
		expect(view.credentials).toEqual({ 'conn-openai': 'sk-test' });
		expect(view.nativeMessaging).toBe('port');
	});

	test('a corrupt item falls back to its default without touching the others', () => {
		const sync = storedSync();
		sync[AI_PROFILES_KEY] = 'garbage';
		sync[AI_ROUTING_KEY] = { v: 2, defaultProfileId: 'p-gpt', taskProfiles: {} };
		sync[AI_INTERPRETER_KEY] = { v: 1, enabled: 'yes', autoRun: 1 };
		const view = decodeAiSettings(sync, { [AI_CREDENTIALS_KEY]: ['not', 'a', 'map'] }, 'port');
		expect(view.profiles).toEqual([]);
		expect(view.routing).toEqual({ taskProfiles: {} });
		expect(view.enabled).toBe(false);
		expect(view.interpreter.autoRun).toBe(false);
		expect(view.credentials).toEqual({});
		expect(view.connections).toEqual(connections);
		expect(view.interpreter.defaultPromptContext).toBe('Be brief.');
	});

	test('drops connections with an unknown kind or without a string id, and strips unknown fields', () => {
		const sync = storedSync();
		sync[AI_CONNECTIONS_KEY] = {
			v: 1,
			items: [
				{ id: 'ok', kind: 'anthropic', label: 'A', apiKey: 'sk-leak', extra: 1 },
				{ id: 'bad-kind', kind: 'openai', label: 'B' },
				{ id: 7, kind: 'anthropic' },
				{ kind: 'ollama' },
				null,
				'string'
			]
		};
		const view = decodeAiSettings(sync, {}, 'port');
		expect(view.connections).toEqual([{ id: 'ok', kind: 'anthropic', label: 'A' }]);
	});

	test('keeps the first of duplicate ids', () => {
		const sync = storedSync();
		sync[AI_CONNECTIONS_KEY] = { v: 1, items: [connections[0], { ...connections[0], label: 'Second' }] };
		sync[AI_PROFILES_KEY] = { v: 1, items: [profiles[0], { ...profiles[0], label: 'Second' }] };
		const view = decodeAiSettings(sync, {}, 'port');
		expect(view.connections.map(item => item.label)).toEqual(['OpenAI']);
		expect(view.profiles.map(item => item.label)).toEqual(['GPT']);
	});

	test('normalizes Codex model and effort, and coerces field types', () => {
		const sync = storedSync();
		sync[AI_PROFILES_KEY] = {
			v: 1,
			items: [
				profiles[1],
				{ id: 'p-codex-long', connectionId: 'conn-codex', model: 'x'.repeat(201), label: 7, enabled: 'no', options: { reasoningEffort: 'extreme', temperature: 'hot' } },
				{ id: 'p-api', connectionId: 'conn-openai', model: '  spaced  ', label: 'L', enabled: false, options: { reasoningEffort: 'low' } },
				{ id: 'no-connection', label: 'X' }
			]
		};
		const view = decodeAiSettings(sync, {}, 'port');
		expect(view.profiles).toEqual([
			{ id: 'p-codex', connectionId: 'conn-codex', model: 'gpt-codex', label: '', options: { reasoningEffort: 'high' }, enabled: true },
			{ id: 'p-codex-long', connectionId: 'conn-codex', label: '', enabled: true },
			{ id: 'p-api', connectionId: 'conn-openai', model: '  spaced  ', label: 'L', options: { reasoningEffort: 'low' }, enabled: false }
		]);
	});

	test('keeps only known tasks in routing and omits a blank response language', () => {
		const sync = storedSync();
		sync[AI_ROUTING_KEY] = { v: 1, defaultProfileId: '', taskProfiles: { edit: 'p-gpt', bogus: 'p-gpt', explain: 3 }, responseLanguage: '   ' };
		expect(decodeAiSettings(sync, {}, 'port').routing).toEqual({ taskProfiles: { edit: 'p-gpt' } });
	});

	test('returns fresh objects, not the frozen defaults', () => {
		const view = decodeAiSettings({}, {}, 'none');
		view.connections.push({ id: 'x', kind: 'anthropic', label: '' });
		view.routing.taskProfiles.edit = 'x';
		expect(AI_SETTINGS_DEFAULTS.connections).toEqual([]);
		expect(AI_SETTINGS_DEFAULTS.taskProfiles).toEqual({});
	});
});

describe('decodeConnectionStatus', () => {
	test('keeps tested entries and structured-output-only entries', () => {
		expect(decodeConnectionStatus({
			a: { state: 'ok', testedAt: 5, models: [{ profileId: 'p', model: 'm', listed: false }, { bad: true }], structuredOutput: 'json_schema' },
			b: { state: 'failing', testedAt: 6, code: 'auth', status: 401, detail: 'Unauthorized' },
			c: { structuredOutput: 'none' },
			d: { state: 'ok' },
			e: { state: 'failing', testedAt: 1, code: 'made-up' },
			f: 'x'
		})).toEqual({
			a: { state: 'ok', testedAt: 5, models: [{ profileId: 'p', model: 'm', listed: false }], structuredOutput: 'json_schema' },
			b: { state: 'failing', testedAt: 6, code: 'auth', status: 401, detail: 'Unauthorized' },
			c: { structuredOutput: 'none' },
			e: { state: 'failing', testedAt: 1 }
		});
	});
});

describe('encodeAiSettingsSync', () => {
	test('round-trips through decodeAiSettings', () => {
		const view = decodeAiSettings(storedSync(), storedLocal(), 'port');
		const encoded = encodeAiSettingsSync(view);
		expect(Object.keys(encoded)).toEqual([AI_CONNECTIONS_KEY, AI_PROFILES_KEY, AI_ROUTING_KEY, AI_INTERPRETER_KEY, AI_PROMPT_CONTEXT_KEY]);
		for (const item of Object.values(encoded)) expect(item.v).toBe(1);
		expect(decodeAiSettings(clone(encoded) as unknown as Record<string, unknown>, storedLocal(), 'port')).toEqual(view);
	});

	test('never writes credentials or unknown connection fields', () => {
		const view = decodeAiSettings(storedSync(), storedLocal(), 'port');
		(view.connections[0] as unknown as Record<string, unknown>).apiKey = 'sk-test';
		expect(JSON.stringify(encodeAiSettingsSync(view))).not.toContain('sk-test');
	});
});

// --- Quota ---------------------------------------------------------------------------------------

describe('assertSyncItemSize', () => {
	// key "k" (1 byte) + JSON string quotes (2 bytes) + content.
	test('passes at 8,192 bytes and throws at 8,193', () => {
		expect(syncItemBytes('k', 'x'.repeat(8189))).toBe(8192);
		expect(() => assertSyncItemSize('k', 'x'.repeat(8189))).not.toThrow();
		let thrown: unknown;
		try {
			assertSyncItemSize('k', 'x'.repeat(8190));
		} catch (error) {
			thrown = error;
		}
		expect(isAiSettingsStorageError(thrown)).toBe(true);
		expect(thrown).toMatchObject({ reason: 'item-too-large', key: 'k', bytes: 8193 });
	});

	test('counts UTF-8 bytes and the escapes Chromium adds', () => {
		expect(syncItemBytes('键', '你')).toBe(3 + 3 + 2);
		expect(syncItemBytes('k', '😀')).toBe(1 + 4 + 2);
		expect(syncItemBytes('k', '<')).toBe(1 + 6 + 2);
		expect(syncItemBytes('k', ' ')).toBe(1 + 6 + 2);
		expect(syncItemBytes('k', 'a"b')).toBe(1 + 4 + 2);
		expect(syncItemBytes('ai_routing', { v: 1, taskProfiles: {} })).toBe('ai_routing'.length + '{"v":1,"taskProfiles":{}}'.length);
	});
});

describe('toAiSettingsStorageError', () => {
	test.each([
		['QUOTA_BYTES_PER_ITEM quota exceeded', 'item-too-large'],
		['QUOTA_BYTES quota exceeded', 'total-quota'],
		['MAX_ITEMS quota exceeded', 'total-quota'],
		['MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded', 'write-rate'],
		['MAX_WRITE_OPERATIONS_PER_HOUR quota exceeded', 'write-rate'],
		['QuotaExceededError: storage.sync API call exceeded its quota limitations.', 'total-quota']
	])('maps "%s" to %s', (message, reason) => {
		const cause = new Error(message);
		const mapped = toAiSettingsStorageError(cause, 'ai_profiles');
		expect(mapped).toBeInstanceOf(AiSettingsStorageError);
		expect(mapped).toMatchObject({ reason, key: 'ai_profiles', cause });
	});

	test('passes other errors through unchanged', () => {
		const error = new Error('Extension context invalidated.');
		expect(toAiSettingsStorageError(error)).toBe(error);
	});
});

// --- Store: derived mode -------------------------------------------------------------------------

describe('createAiSettingsStore in derived mode', () => {
	test('AI_V2_BOOTSTRAP is off in 5a', () => {
		expect(AI_V2_BOOTSTRAP).toBe(false);
	});

	test.each([
		['api', v1Interpreter(), { learningResponseLanguage: ' Japanese ' }],
		['stale model', v1Interpreter({ interpreterModel: 'model-c' }), { learningResponseLanguage: '' }],
		['no enabled model', v1Interpreter({ models: [{ id: 'm', providerId: 'p', providerModelId: 'x', name: 'M', enabled: false }] }), {}],
		['missing key requirement', v1Interpreter({ providers: [{ id: 'p', name: 'Custom', baseUrl: 'https://x.example/v1', apiKey: '  ' }] }), {}],
		['malformed provider', v1Interpreter({ providers: [{ id: 'broken' }, ...(v1Interpreter().providers as unknown[])] }), {}],
		['codex', v1Interpreter({ interpreterExecutionMode: 'codex', interpreterCodexModel: 'gpt-codex', interpreterCodexReasoningEffort: 'high' }), {}],
		['grok', v1Interpreter({ interpreterExecutionMode: 'grok' }), {}],
		['missing mode, blank language', v1Interpreter({ interpreterExecutionMode: undefined }), { learningResponseLanguage: '  ' }],
		['missing reader settings', v1Interpreter(), undefined]
	])('load() equals deriveAiSettings(v1) for the %s fixture and writes nothing', async (_name, interpreter, reader) => {
		const sync: Record<string, unknown> = { interpreter_settings: interpreter, ...(reader ? { reader_settings: reader } : {}) };
		const { store, sync: syncArea, local } = derivedStore(sync, storedLocal());

		const snapshot = await store.loadSnapshot();

		expect(snapshot.mode).toBe('derived');
		expect(snapshot.view).toEqual(deriveAiSettings(v1Settings(interpreter, reader), { nativeMessaging: 'port' }));
		expect(syncArea.sets).toEqual([]);
		expect(local.sets).toEqual([]);
		expect(syncArea.gets).toHaveLength(1);
		expect(local.gets).toHaveLength(1);
	});

	test('sanitizes raw v1 the way loadSettings does', async () => {
		const interpreter = v1Interpreter({
			interpreterExecutionMode: 'turbo',
			interpreterCodexModel: 'x'.repeat(201),
			interpreterCodexReasoningEffort: 'extreme',
			providers: [{ id: 3, name: 'Numeric' }, null, ...(v1Interpreter().providers as unknown[])],
			models: 'not-an-array'
		});
		const { store } = derivedStore({ interpreter_settings: interpreter });
		const view = await store.load();
		expect(view.connections.map(item => item.id)).toEqual(['provider-anthropic', 'provider-ollama', 'legacy-cli-codex', 'legacy-cli-grok']);
		expect(view.profiles.map(item => item.id)).toEqual(['legacy-cli-codex-default', 'legacy-cli-grok-default']);
		expect(view.profiles[0].model).toBeUndefined();
		expect(view.profiles[0].options).toBeUndefined();
		expect(view.routing.defaultProfileId).toBeUndefined();
	});

	test('loads defaults with no v1 item at all', async () => {
		const { store } = derivedStore({});
		const view = await store.load();
		expect(view.enabled).toBe(false);
		expect(view.routing.defaultProfileId).toBeUndefined();
	});

	test('writes are no-ops until v2 exists', async () => {
		const { store, sync, local } = derivedStore({ interpreter_settings: v1Interpreter() });
		await expect(store.saveRouting({ taskProfiles: { interpret: 'model-a' } })).resolves.toBe(false);
		await expect(store.saveConnections([])).resolves.toBe(false);
		await expect(store.setCredential('provider-anthropic', 'sk-new')).resolves.toBe(false);
		await expect(store.deleteConnectionStatus('provider-anthropic')).resolves.toBe(false);
		expect(sync.sets).toEqual([]);
		expect(local.sets).toEqual([]);
	});

	test('reads stored v2 when it exists, without bootstrapping', async () => {
		const { store, sync } = derivedStore(
			{ ...storedSync(), interpreter_settings: v1Interpreter() },
			{ ...storedLocal(), [AI_CONNECTION_STATUS_KEY]: { 'conn-openai': { state: 'ok', testedAt: 1 } } }
		);
		const snapshot = await store.loadSnapshot();
		expect(snapshot.mode).toBe('stored');
		expect(snapshot.view).toEqual(decodeAiSettings(storedSync(), storedLocal(), 'port'));
		expect(snapshot.connectionStatus).toEqual({ 'conn-openai': { state: 'ok', testedAt: 1 } });
		expect(sync.sets).toEqual([]);
	});

	test('resolves nativeMessaging lazily when given a function', async () => {
		const detect = vi.fn(() => 'message' as const);
		const store = createAiSettingsStore({ sync: fakeArea(storedSync()), local: fakeArea(), nativeMessaging: detect, bootstrap: false });
		expect(detect).not.toHaveBeenCalled();
		expect((await store.load()).nativeMessaging).toBe('message');
	});
});

// --- Store: bootstrap ----------------------------------------------------------------------------

describe('createAiSettingsStore bootstrap', () => {
	const bundle = storedSync();
	const localWrites = { [AI_CREDENTIALS_KEY]: { 'conn-openai': 'sk-test' }, [AI_MIGRATION_KEY]: { v: 1, status: 'bootstrapped' } };

	function bootstrapStore(sync: Record<string, unknown>, local: Record<string, unknown>, bootstrapper: AiSettingsBootstrapper) {
		const areas = { sync: fakeArea(sync), local: fakeArea(local) };
		const store = createAiSettingsStore({ ...areas, nativeMessaging: 'port', bootstrap: true, bootstrapper, build: '1.2.3' });
		return { ...areas, store };
	}

	test('applies the planned sync writes in one set and the local writes in one set, then decodes the merged state', async () => {
		const bootstrapper = stubBootstrapper({ sync: bundle, local: localWrites });
		const { store, sync, local } = bootstrapStore({ interpreter_settings: v1Interpreter() }, {}, bootstrapper);

		const snapshot = await store.loadSnapshot();

		expect(bootstrapper.plan).toHaveBeenCalledTimes(1);
		expect(bootstrapper.plan).toHaveBeenCalledWith({ interpreter_settings: v1Interpreter() }, {}, '1.2.3');
		expect(sync.sets).toEqual([bundle]);
		expect(local.sets).toEqual([localWrites]);
		expect(snapshot.mode).toBe('stored');
		expect(snapshot.view).toEqual(decodeAiSettings(bundle, localWrites, 'port'));
		expect(sync.data.interpreter_settings).toEqual(v1Interpreter());
	});

	test('writes nothing when the plan is empty', async () => {
		const { store, sync, local } = bootstrapStore(storedSync(), storedLocal(), stubBootstrapper(undefined));
		expect((await store.loadSnapshot()).mode).toBe('stored');
		const empty = bootstrapStore(storedSync(), storedLocal(), stubBootstrapper({ sync: {}, local: {} }));
		await empty.store.load();
		expect([...sync.sets, ...local.sets, ...empty.sync.sets, ...empty.local.sets]).toEqual([]);
	});

	test('applies local-only writes when v2 already exists', async () => {
		const writes = { [AI_CREDENTIALS_KEY]: { 'conn-openai': 'sk-imported' } };
		const { store, sync, local } = bootstrapStore(storedSync(), {}, stubBootstrapper({ local: writes }));
		const view = await store.load();
		expect(sync.sets).toEqual([]);
		expect(local.sets).toEqual([writes]);
		expect(view.credentials).toEqual({ 'conn-openai': 'sk-imported' });
	});

	test('does not call the bootstrapper when bootstrap is false', async () => {
		const bootstrapper = stubBootstrapper({ sync: bundle });
		const store = createAiSettingsStore({ sync: fakeArea({}), local: fakeArea(), nativeMessaging: 'port', bootstrap: false, bootstrapper });
		expect((await store.loadSnapshot()).mode).toBe('derived');
		expect(bootstrapper.plan).not.toHaveBeenCalled();
	});

	test('a failed sync write skips the local write and keeps the derived view', async () => {
		const bootstrapper = stubBootstrapper({ sync: bundle, local: localWrites });
		const { store, sync, local } = bootstrapStore({ interpreter_settings: v1Interpreter() }, {}, bootstrapper);
		sync.failNextSet = new Error('QUOTA_BYTES quota exceeded');

		const snapshot = await store.loadSnapshot();

		expect(snapshot.mode).toBe('derived');
		expect(snapshot.bootstrapError).toMatchObject({ reason: 'total-quota' });
		expect(snapshot.view).toEqual(deriveAiSettings(v1Settings(v1Interpreter(), undefined), { nativeMessaging: 'port' }));
		expect(local.sets).toEqual([]);
	});

	test('an oversized planned item is refused before anything is written', async () => {
		const big = { ...bundle, [AI_PROMPT_CONTEXT_KEY]: { v: 1, text: 'x'.repeat(9000) } };
		const { store, sync, local } = bootstrapStore({}, {}, stubBootstrapper({ sync: big, local: localWrites }));
		const snapshot = await store.loadSnapshot();
		expect(snapshot.bootstrapError).toMatchObject({ reason: 'item-too-large', key: AI_PROMPT_CONTEXT_KEY });
		expect(sync.sets).toEqual([]);
		expect(local.sets).toEqual([]);
	});

	test('a throwing bootstrapper is reported and the load still resolves', async () => {
		const failure = new Error('bug');
		const { store } = bootstrapStore({}, {}, { plan: () => { throw failure; } });
		const snapshot = await store.loadSnapshot();
		expect(snapshot.bootstrapError).toBe(failure);
		expect(snapshot.mode).toBe('derived');
	});

	test('a write before the first load runs the bootstrap first', async () => {
		const bootstrapper = stubBootstrapper({ sync: bundle, local: localWrites });
		const { store, sync } = bootstrapStore({ interpreter_settings: v1Interpreter() }, {}, bootstrapper);

		await expect(store.saveRouting({ defaultProfileId: 'p-codex', taskProfiles: {} })).resolves.toBe(true);

		expect(bootstrapper.plan).toHaveBeenCalledTimes(1);
		expect(sync.sets).toEqual([bundle, { [AI_ROUTING_KEY]: { v: 1, defaultProfileId: 'p-codex', taskProfiles: {} } }]);
	});

	test('a write rejects with the bootstrap error when v2 still does not exist', async () => {
		const { store, sync } = bootstrapStore({}, {}, stubBootstrapper({ sync: bundle }));
		sync.failNextSet = new Error('QUOTA_BYTES quota exceeded');
		await expect(store.saveRouting({ taskProfiles: {} })).rejects.toMatchObject({ reason: 'total-quota' });
		expect(sync.sets).toEqual([]);
	});

	test('concurrent loads run one at a time', async () => {
		let calls = 0;
		const bootstrapper: AiSettingsBootstrapper = {
			plan: rawSync => {
				calls++;
				return rawSync[AI_CONNECTIONS_KEY] === undefined ? { sync: clone(bundle) } : undefined;
			}
		};
		const { store, sync } = bootstrapStore({}, {}, bootstrapper);
		await Promise.all([store.load(), store.load()]);
		expect(calls).toBe(2);
		expect(sync.sets).toEqual([bundle]);
	});
});

// --- Store: writes -------------------------------------------------------------------------------

describe('createAiSettingsStore writes', () => {
	function v2Store(local: Record<string, unknown> = storedLocal()) {
		return derivedStore(storedSync(), local);
	}

	test('each save writes exactly one sync key', async () => {
		const { store, sync } = v2Store();
		const view = await store.load();
		await store.saveConnections(view.connections);
		await store.saveProfiles(view.profiles);
		await store.saveRouting(view.routing);
		await store.saveInterpreter({ enabled: false, autoRun: true });
		await store.savePromptContext('New context');
		expect(sync.sets.map(items => Object.keys(items))).toEqual([
			[AI_CONNECTIONS_KEY], [AI_PROFILES_KEY], [AI_ROUTING_KEY], [AI_INTERPRETER_KEY], [AI_PROMPT_CONTEXT_KEY]
		]);
		expect(sync.data[AI_INTERPRETER_KEY]).toEqual({ v: 1, enabled: false, autoRun: true });
		expect(sync.data[AI_PROMPT_CONTEXT_KEY]).toEqual({ v: 1, text: 'New context' });
		const reloaded = await store.load();
		expect(reloaded.connections).toEqual(view.connections);
		expect(reloaded.profiles).toEqual(view.profiles);
		expect(reloaded.routing).toEqual(view.routing);
	});

	test('saveProfiles normalizes Codex models using the stored connections', async () => {
		const { store, sync } = v2Store();
		await store.saveProfiles([{ id: 'p', connectionId: 'conn-codex', model: '  m  ', label: '', enabled: true }]);
		expect(sync.data[AI_PROFILES_KEY]).toEqual({ v: 1, items: [{ id: 'p', connectionId: 'conn-codex', model: 'm', label: '', enabled: true }] });
	});

	test('an oversized item is refused before it is sent', async () => {
		const { store, sync } = v2Store();
		await expect(store.savePromptContext('x'.repeat(9000))).rejects.toMatchObject({ name: 'AiSettingsStorageError', reason: 'item-too-large', key: AI_PROMPT_CONTEXT_KEY });
		expect(sync.sets).toEqual([]);
	});

	test.each([
		['MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded', 'write-rate'],
		['QUOTA_BYTES quota exceeded', 'total-quota'],
		['QUOTA_BYTES_PER_ITEM quota exceeded', 'item-too-large']
	])('a thrown "%s" rejects with AiSettingsStorageError(%s)', async (message, reason) => {
		const { store, sync } = v2Store();
		sync.failNextSet = new Error(message);
		await expect(store.saveRouting({ taskProfiles: {} })).rejects.toMatchObject({ reason, key: AI_ROUTING_KEY });
	});

	test('setCredential and deleteCredential update local ai_credentials only', async () => {
		const { store, sync, local } = v2Store({});
		await expect(store.setCredential('conn-openai', '  sk-new \n')).resolves.toBe(true);
		await expect(store.setCredential('conn-openai', 'sk-new')).resolves.toBe(false);
		await store.setCredential('conn-other', 'sk-other');
		expect(local.data[AI_CREDENTIALS_KEY]).toEqual({ 'conn-openai': 'sk-new', 'conn-other': 'sk-other' });
		await expect(store.deleteCredential('conn-openai')).resolves.toBe(true);
		await expect(store.deleteCredential('conn-openai')).resolves.toBe(false);
		await store.setCredential('conn-other', '   ');
		expect(local.data[AI_CREDENTIALS_KEY]).toEqual({});
		expect(sync.sets).toEqual([]);
		expect(local.sets.every(items => Object.keys(items).join() === AI_CREDENTIALS_KEY)).toBe(true);
	});

	test('concurrent credential writes do not lose updates', async () => {
		const { store, local } = v2Store({});
		await Promise.all([store.setCredential('a', 'ka'), store.setCredential('b', 'kb'), store.setCredential('c', 'kc')]);
		expect(local.data[AI_CREDENTIALS_KEY]).toEqual({ a: 'ka', b: 'kb', c: 'kc' });
	});

	test('deleteConnectionStatus removes the named entries', async () => {
		const { store, local } = v2Store({
			[AI_CONNECTION_STATUS_KEY]: { a: { state: 'ok', testedAt: 1 }, b: { state: 'failing', testedAt: 2 }, c: { structuredOutput: 'none' } }
		});
		await expect(store.deleteConnectionStatus(['a', 'c'])).resolves.toBe(true);
		await expect(store.deleteConnectionStatus('missing')).resolves.toBe(false);
		expect(local.data[AI_CONNECTION_STATUS_KEY]).toEqual({ b: { state: 'failing', testedAt: 2 } });
	});

	test('rejects a missing connection id', async () => {
		const { store } = v2Store();
		await expect(store.setCredential('', 'k')).rejects.toBeInstanceOf(TypeError);
	});
});

// --- Store: observe ------------------------------------------------------------------------------

describe('createAiSettingsStore observe', () => {
	test('fires only for AI keys and names them per area', () => {
		const onChanged = fakeOnChanged();
		const store = createAiSettingsStore({ sync: fakeArea(), local: fakeArea(), onChanged, nativeMessaging: 'port', bootstrap: false });
		const changes: AiSettingsChange[] = [];
		const stop = store.observe(change => changes.push(change));

		onChanged.emit({ interpreter_settings: {}, reader_settings: {}, templates: {} }, 'sync');
		onChanged.emit({ [AI_ROUTING_KEY]: {}, vaults: {}, [AI_CONNECTIONS_KEY]: {} }, 'sync');
		onChanged.emit({ [AI_CREDENTIALS_KEY]: {}, history: {} }, 'local');
		onChanged.emit({ ai_diagnostics: {}, 'aiJob:1': {} }, 'session');
		onChanged.emit({ [AI_ROUTING_KEY]: {} }, 'managed');
		onChanged.emit({ [AI_CREDENTIALS_KEY]: {} }, 'sync');

		expect(changes).toEqual([
			{ area: 'sync', keys: [AI_CONNECTIONS_KEY, AI_ROUTING_KEY] },
			{ area: 'local', keys: [AI_CREDENTIALS_KEY] },
			{ area: 'session', keys: ['ai_diagnostics'] }
		]);

		stop();
		expect(onChanged.size()).toBe(0);
		onChanged.emit({ [AI_ROUTING_KEY]: {} }, 'sync');
		expect(changes).toHaveLength(3);
	});

	test('is a no-op without onChanged', () => {
		const store = createAiSettingsStore({ sync: fakeArea(), local: fakeArea(), nativeMessaging: 'port', bootstrap: false });
		expect(() => store.observe(() => {})()).not.toThrow();
	});
});

