import { describe, expect, test } from 'vitest';
import {
	createAiSettingsBootstrapper,
	importCredentials,
	migrateV1,
	readMigrationRecord,
	type AiMigrationRecord,
	type AiSettingsWrites
} from './migrate';
import {
	LEGACY_CODEX_CONNECTION_ID,
	LEGACY_CODEX_PROFILE_ID,
	LEGACY_GROK_CONNECTION_ID,
	LEGACY_GROK_PROFILE_ID
} from './settings-view';

function last<T>(items: T[]): T {
	return items[items.length - 1];
}

const SYNC_KEYS = ['ai_connections', 'ai_profiles', 'ai_routing', 'ai_interpreter', 'ai_prompt_context'];

function v1Interpreter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		interpreterModel: 'model-b',
		interpreterEnabled: true,
		interpreterAutoRun: true,
		interpreterExecutionMode: 'api',
		defaultPromptContext: 'Context',
		providers: [
			{
				id: 'provider-openai',
				name: 'OpenAI',
				baseUrl: 'https://api.openai.com/v1/chat/completions',
				apiKey: 'sk-openai',
				apiKeyRequired: true
			},
			{
				id: 'provider-local',
				name: 'Local',
				baseUrl: 'http://127.0.0.1:1234/v1/chat/completions',
				apiKey: '',
				apiKeyRequired: false
			}
		],
		models: [
			{ id: 'model-a', providerId: 'provider-openai', providerModelId: 'gpt-a', name: 'A', enabled: true },
			{ id: 'model-b', providerId: 'provider-local', providerModelId: 'local-b', name: 'B', enabled: true },
			{ id: 'model-c', providerId: 'provider-openai', providerModelId: 'gpt-c', name: 'C', enabled: false }
		],
		...overrides
	};
}

function v1Sync(
	interpreter: Record<string, unknown> = v1Interpreter(),
	reader: Record<string, unknown> | null = { learningResponseLanguage: ' Japanese ', fontSize: 16 }
): Record<string, unknown> {
	return {
		interpreter_settings: interpreter,
		...(reader ? { reader_settings: reader } : {}),
		vaults: ['Vault']
	};
}

/** A device's storage. Writes are JSON-cloned like the browser's structured storage. */
interface Device {
	sync: Record<string, unknown>;
	local: Record<string, unknown>;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function apply(device: Device, writes: AiSettingsWrites | undefined): void {
	if (writes?.sync) Object.assign(device.sync, clone(writes.sync));
	if (writes?.local) Object.assign(device.local, clone(writes.local));
}

function bootstrapper(now = 1000) {
	return createAiSettingsBootstrapper({ now: () => now });
}

/** Plans on a device and applies the result, as the store's `load()` does. */
function load(device: Device, build = '2.0.0', now = 1000): AiSettingsWrites | undefined {
	const writes = bootstrapper(now).plan(clone(device.sync), clone(device.local), build);
	apply(device, writes);
	return writes;
}

describe('migrateV1', () => {
	test('maps an API-mode configuration to the v2 bundle', () => {
		const result = migrateV1(v1Sync());

		expect(result.sync).toEqual({
			ai_connections: {
				v: 1,
				items: [
					{
						id: 'provider-openai',
						kind: 'openai-compatible',
						label: 'OpenAI',
						presetId: 'openai',
						baseUrl: 'https://api.openai.com/v1/chat/completions',
						apiKeyRequired: true
					},
					{
						id: 'provider-local',
						kind: 'openai-compatible',
						label: 'Local',
						baseUrl: 'http://127.0.0.1:1234/v1/chat/completions',
						apiKeyRequired: false
					}
				]
			},
			ai_profiles: {
				v: 1,
				items: [
					{ id: 'model-a', connectionId: 'provider-openai', model: 'gpt-a', label: 'A', enabled: true },
					{ id: 'model-b', connectionId: 'provider-local', model: 'local-b', label: 'B', enabled: true },
					{ id: 'model-c', connectionId: 'provider-openai', model: 'gpt-c', label: 'C', enabled: false }
				]
			},
			ai_routing: { v: 1, defaultProfileId: 'model-b', taskProfiles: {}, responseLanguage: 'Japanese' },
			ai_interpreter: { v: 1, enabled: true, autoRun: true },
			ai_prompt_context: { v: 1, text: 'Context' }
		});
		expect(result.credentials).toEqual({ 'provider-openai': 'sk-openai' });
	});

	test('never places API keys in the sync bundle', () => {
		const result = migrateV1(v1Sync());
		const serialized = JSON.stringify(result.sync);
		expect(serialized).not.toContain('sk-openai');
		expect(serialized).not.toContain('apiKey"');
	});

	test('maps empty and missing v1 items to the defaults', () => {
		const expected = {
			ai_connections: { v: 1, items: [] },
			ai_profiles: { v: 1, items: [] },
			ai_routing: { v: 1, taskProfiles: {} },
			ai_interpreter: { v: 1, enabled: false, autoRun: false },
			ai_prompt_context: { v: 1, text: '' }
		};
		expect(migrateV1({})).toEqual({ sync: expected, credentials: {} });
		expect(migrateV1({ interpreter_settings: {}, reader_settings: {} })).toEqual({ sync: expected, credentials: {} });
		expect(migrateV1({ interpreter_settings: 'corrupt', reader_settings: [] })).toEqual({ sync: expected, credentials: {} });
	});

	test('treats a provider without apiKeyRequired as not requiring a key, like v1', () => {
		const result = migrateV1(v1Sync(v1Interpreter({
			providers: [{ id: 'p', name: 'Custom', baseUrl: 'https://x.example/v1/chat/completions', apiKey: 'k' }],
			models: []
		})));
		expect(result.sync.ai_connections.items[0].apiKeyRequired).toBe(false);
		expect(result.credentials).toEqual({ p: 'k' });
	});

	test('drops models whose provider is missing, and never defaults to one', () => {
		const result = migrateV1(v1Sync(v1Interpreter({
			interpreterModel: 'orphan',
			models: [
				{ id: 'orphan', providerId: 'deleted-provider', providerModelId: 'x', name: 'X', enabled: true },
				{ id: 'model-a', providerId: 'provider-openai', providerModelId: 'gpt-a', name: 'A', enabled: true }
			]
		})));
		expect(result.sync.ai_profiles.items.map(profile => profile.id)).toEqual(['model-a']);
		expect(result.sync.ai_routing.defaultProfileId).toBe('model-a');
	});

	test('falls back to the first enabled model when interpreterModel is stale', () => {
		const stale = migrateV1(v1Sync(v1Interpreter({ interpreterModel: 'model-c' })));
		expect(stale.sync.ai_routing.defaultProfileId).toBe('model-a');
		const missing = migrateV1(v1Sync(v1Interpreter({ interpreterModel: 'gone' })));
		expect(missing.sync.ai_routing.defaultProfileId).toBe('model-a');
	});

	test('leaves the default unset without an enabled model', () => {
		const result = migrateV1(v1Sync(v1Interpreter({
			models: [{ id: 'm', providerId: 'provider-openai', providerModelId: 'x', name: 'M', enabled: false }]
		})));
		expect(result.sync.ai_routing).toEqual({ v: 1, taskProfiles: {}, responseLanguage: 'Japanese' });
	});

	test('carries only the Grok CLI in Grok mode and makes it the default', () => {
		const result = migrateV1(v1Sync(v1Interpreter({ interpreterExecutionMode: 'grok' })));
		expect(result.sync.ai_connections.items.map(connection => connection.id))
			.toEqual(['provider-openai', 'provider-local', LEGACY_GROK_CONNECTION_ID]);
		expect(result.sync.ai_connections.items[2]).toEqual({ id: LEGACY_GROK_CONNECTION_ID, kind: 'cli-grok', label: '' });
		expect(last(result.sync.ai_profiles.items)).toEqual({
			id: LEGACY_GROK_PROFILE_ID,
			connectionId: LEGACY_GROK_CONNECTION_ID,
			label: '',
			enabled: true
		});
		expect(result.sync.ai_routing.defaultProfileId).toBe(LEGACY_GROK_PROFILE_ID);
		expect(JSON.stringify(result.sync)).not.toContain(LEGACY_CODEX_CONNECTION_ID);
	});

	test('carries the Codex model and effort onto the Codex profile in Codex mode', () => {
		const result = migrateV1(v1Sync(v1Interpreter({
			interpreterExecutionMode: 'codex',
			interpreterCodexModel: '  gpt-5-codex  ',
			interpreterCodexReasoningEffort: 'high'
		})));
		expect(last(result.sync.ai_connections.items)).toEqual({ id: LEGACY_CODEX_CONNECTION_ID, kind: 'cli-codex', label: '' });
		expect(last(result.sync.ai_profiles.items)).toEqual({
			id: LEGACY_CODEX_PROFILE_ID,
			connectionId: LEGACY_CODEX_CONNECTION_ID,
			model: 'gpt-5-codex',
			label: '',
			options: { reasoningEffort: 'high' },
			enabled: true
		});
		expect(result.sync.ai_routing.defaultProfileId).toBe(LEGACY_CODEX_PROFILE_ID);
		expect(JSON.stringify(result.sync)).not.toContain(LEGACY_GROK_CONNECTION_ID);
	});

	test('omits the Codex model and effort when absent or invalid', () => {
		for (const overrides of [
			{},
			{ interpreterCodexModel: '   ', interpreterCodexReasoningEffort: 'extreme' },
			{ interpreterCodexModel: 'x'.repeat(201), interpreterCodexReasoningEffort: 3 }
		]) {
			const result = migrateV1(v1Sync(v1Interpreter({ interpreterExecutionMode: 'codex', ...overrides })));
			expect(last(result.sync.ai_profiles.items)).toEqual({
				id: LEGACY_CODEX_PROFILE_ID,
				connectionId: LEGACY_CODEX_CONNECTION_ID,
				label: '',
				enabled: true
			});
		}
	});

	test('carries no CLI in API mode and coerces an unknown mode to API', () => {
		for (const interpreterExecutionMode of ['api', undefined, 'cloud']) {
			const result = migrateV1(v1Sync(v1Interpreter({ interpreterExecutionMode })));
			expect(result.sync.ai_connections.items.every(connection => !connection.kind.startsWith('cli-'))).toBe(true);
			expect(result.sync.ai_profiles.items.map(profile => profile.id)).toEqual(['model-a', 'model-b', 'model-c']);
		}
	});

	test('copies a trimmed response language and omits a blank or missing one', () => {
		expect(migrateV1(v1Sync()).sync.ai_routing.responseLanguage).toBe('Japanese');
		expect(migrateV1(v1Sync(v1Interpreter(), { learningResponseLanguage: '  ' })).sync.ai_routing)
			.not.toHaveProperty('responseLanguage');
		expect(migrateV1(v1Sync(v1Interpreter(), null)).sync.ai_routing)
			.not.toHaveProperty('responseLanguage');
	});

	test('sets presetId from a matching catalog base URL and infers the kind from it', () => {
		const result = migrateV1(v1Sync(v1Interpreter({
			providers: [
				{ id: 'a', name: 'Claude', baseUrl: 'https://api.anthropic.com/v1/messages', apiKey: 'x', apiKeyRequired: true },
				{ id: 'o', name: 'My models', baseUrl: 'http://127.0.0.1:11434/api/chat', apiKey: '' },
				// The preset table wins over the legacy name rule.
				{ id: 'd', name: 'Anthropic mirror', baseUrl: 'https://api.deepseek.com/v1/chat/completions', apiKey: '' },
				{ id: 'k', name: 'Kept', baseUrl: 'https://proxy.example/v1/chat/completions', apiKey: '', presetId: 'openrouter' },
				{ id: 'u', name: 'Unknown preset', baseUrl: 'https://api.perplexity.ai/chat/completions', apiKey: '', presetId: 'gone' },
				{ id: 'c', name: 'Anthropic proxy', baseUrl: 'https://gateway.example/v1/messages', apiKey: '' }
			],
			models: []
		})));
		expect(result.sync.ai_connections.items.map(({ id, kind, presetId }) => ({ id, kind, presetId }))).toEqual([
			{ id: 'a', kind: 'anthropic', presetId: 'anthropic' },
			{ id: 'o', kind: 'ollama', presetId: 'ollama' },
			{ id: 'd', kind: 'openai-compatible', presetId: 'deepseek' },
			{ id: 'k', kind: 'openai-compatible', presetId: 'openrouter' },
			{ id: 'u', kind: 'perplexity', presetId: 'perplexity' },
			{ id: 'c', kind: 'anthropic', presetId: undefined }
		]);
		expect(result.sync.ai_connections.items[5]).not.toHaveProperty('presetId');
	});

	test('sanitizes malformed v1 items the way loadSettings does', () => {
		const result = migrateV1(v1Sync({
			interpreterModel: 42,
			interpreterEnabled: 'yes',
			interpreterAutoRun: 1,
			defaultPromptContext: null,
			providers: [
				null,
				'provider',
				{ name: 'No id' },
				{ id: 7, name: 'Numeric id' },
				{ id: 'p', name: 3, baseUrl: { url: 'x' }, apiKey: 5, apiKeyRequired: 'true' },
				{ id: 'p', name: 'Duplicate', baseUrl: 'https://dup.example', apiKey: 'sk-dup' }
			],
			models: [
				{ id: 'm', providerId: 'p', providerModelId: 9, name: null, enabled: 1 },
				{ id: 'm', providerId: 'p', providerModelId: 'dup', name: 'Duplicate', enabled: true },
				{ providerId: 'p' },
				[]
			]
		}));
		expect(result.sync.ai_connections.items).toEqual([
			{ id: 'p', kind: 'openai-compatible', label: '', baseUrl: '', apiKeyRequired: false }
		]);
		expect(result.sync.ai_profiles.items).toEqual([
			{ id: 'm', connectionId: 'p', label: '', enabled: true }
		]);
		expect(result.sync.ai_routing.defaultProfileId).toBe('m');
		expect(result.sync.ai_interpreter).toEqual({ v: 1, enabled: false, autoRun: false });
		expect(result.sync.ai_prompt_context).toEqual({ v: 1, text: '' });
		expect(result.credentials).toEqual({});
	});

	test('produces a byte-identical bundle across runs and does not mutate the input', () => {
		const raw = v1Sync(v1Interpreter({
			interpreterExecutionMode: 'codex',
			interpreterCodexModel: 'm',
			interpreterCodexReasoningEffort: 'low'
		}));
		const snapshot = clone(raw);
		const first = JSON.stringify(migrateV1(raw).sync);
		const second = JSON.stringify(migrateV1(clone(raw)).sync);
		expect(second).toBe(first);
		expect(raw).toEqual(snapshot);
	});
});

describe('importCredentials', () => {
	test('imports only keys for v2 connections without a local or past import', () => {
		expect(importCredentials({
			connectionIds: ['new', 'local', 'deleted', 'empty', 'no-v1'],
			v1Credentials: { new: 'k1', local: 'k2', deleted: 'k3', empty: '', orphan: 'k5' },
			localCredentials: { local: 'already' },
			importedIds: ['deleted']
		})).toEqual({ new: 'k1' });
	});
});

describe('readMigrationRecord', () => {
	test('accepts a well-formed record and rejects others', () => {
		const record: AiMigrationRecord = {
			v: 1,
			status: 'reused',
			at: 5,
			build: '2.0.0',
			source: { providers: 1, models: 2, mode: 'api' },
			credentials: ['a', 'a', 'b']
		};
		expect(readMigrationRecord(record)).toEqual({ ...record, credentials: ['a', 'b'] });
		expect(readMigrationRecord({ ...record, v: 2 })).toBeUndefined();
		expect(readMigrationRecord({ ...record, status: 'done' })).toBeUndefined();
		expect(readMigrationRecord({ ...record, source: { providers: 1, models: 2, mode: 'cloud' } })).toBeUndefined();
		expect(readMigrationRecord(undefined)).toBeUndefined();
	});
});

describe('aiSettingsBootstrapper', () => {
	test('writes nothing without v1 or v2 data', () => {
		expect(bootstrapper().plan({}, {}, '2.0.0')).toBeUndefined();
		// reader_settings alone is not AI configuration.
		expect(bootstrapper().plan({ reader_settings: { learningResponseLanguage: 'French' } }, {}, '2.0.0'))
			.toBeUndefined();
	});

	test('bootstraps the five sync keys and the two local keys from v1', () => {
		const sync = v1Sync();
		const writes = bootstrapper(1234).plan(sync, {}, '2.0.0');

		expect(Object.keys(writes?.sync ?? {}).sort()).toEqual([...SYNC_KEYS].sort());
		expect(writes?.sync).toEqual(migrateV1(sync).sync);
		expect(Object.keys(writes?.local ?? {}).sort()).toEqual(['ai_credentials', 'ai_migration']);
		expect(writes?.local?.ai_credentials).toEqual({ 'provider-openai': 'sk-openai' });
		expect(writes?.local?.ai_migration).toEqual({
			v: 1,
			status: 'bootstrapped',
			at: 1234,
			build: '2.0.0',
			source: { providers: 2, models: 3, mode: 'api' },
			credentials: ['provider-openai']
		});
		expect(JSON.stringify(writes?.sync)).not.toContain('sk-openai');
	});

	test('never writes v1 keys', () => {
		const writes = bootstrapper().plan(v1Sync(), {}, '2.0.0');
		expect(writes?.sync).not.toHaveProperty('interpreter_settings');
		expect(writes?.sync).not.toHaveProperty('reader_settings');
	});

	test('records the source mode and a bootstrap without keys', () => {
		const writes = bootstrapper().plan(v1Sync(v1Interpreter({
			interpreterExecutionMode: 'codex',
			providers: [],
			models: []
		})), {}, '2.0.0');
		expect(writes?.local).toEqual({
			ai_migration: {
				v: 1,
				status: 'bootstrapped',
				at: 1000,
				build: '2.0.0',
				source: { providers: 0, models: 0, mode: 'codex' },
				credentials: []
			}
		});
	});

	test('reuses present v2 items without writing sync, and imports this device\'s key', () => {
		const deviceA: Device = { sync: v1Sync(), local: {} };
		load(deviceA);
		const deviceB: Device = { sync: clone(deviceA.sync), local: {} };

		const writes = load(deviceB, '2.0.1', 2000);
		expect(writes?.sync).toBeUndefined();
		expect(deviceB.local).toEqual({
			ai_credentials: { 'provider-openai': 'sk-openai' },
			ai_migration: {
				v: 1,
				status: 'reused',
				at: 2000,
				build: '2.0.1',
				source: { providers: 2, models: 3, mode: 'api' },
				credentials: ['provider-openai']
			}
		});
	});

	test('reuses v2 edited on another device instead of re-deriving from v1', () => {
		const device: Device = { sync: v1Sync(), local: {} };
		load(device);
		const edited = clone(device.sync.ai_profiles) as { v: 1; items: { id: string }[] };
		edited.items = edited.items.slice(0, 1);
		device.sync.ai_profiles = edited;
		device.local = {};

		expect(load(device)?.sync).toBeUndefined();
		expect(device.sync.ai_profiles).toEqual(edited);
	});

	test('is idempotent once applied', () => {
		const device: Device = { sync: v1Sync(), local: {} };
		load(device);
		const snapshot = clone(device);
		expect(load(device)).toBeUndefined();
		expect(device).toEqual(snapshot);
	});

	test('leaves a present local credential untouched', () => {
		const device: Device = { sync: v1Sync(), local: {} };
		load(device);
		device.local.ai_credentials = { 'provider-openai': 'sk-new-on-this-device', other: 'x' };
		device.local.ai_migration = { ...(device.local.ai_migration as AiMigrationRecord), credentials: [] };

		expect(load(device)).toBeUndefined();
		expect(device.local.ai_credentials).toEqual({ 'provider-openai': 'sk-new-on-this-device', other: 'x' });
	});

	test('does not re-import a credential the user deleted', () => {
		const device: Device = { sync: v1Sync(), local: {} };
		load(device);
		device.local.ai_credentials = {};

		expect(load(device)).toBeUndefined();
		expect(device.local.ai_credentials).toEqual({});
	});

	test('a malformed record still blocks re-importing the ids it lists', () => {
		const device: Device = {
			sync: v1Sync(),
			local: { ai_migration: { v: 1, status: 'unknown', credentials: ['provider-openai'] } }
		};
		const writes = load(device);
		expect(writes?.local).not.toHaveProperty('ai_credentials');
		expect((device.local.ai_migration as AiMigrationRecord).credentials).toEqual(['provider-openai']);
		expect(readMigrationRecord(device.local.ai_migration)?.status).toBe('bootstrapped');
	});

	test('keeps unrelated local credentials when importing', () => {
		const device: Device = { sync: v1Sync(), local: { ai_credentials: { manual: 'sk-manual', junk: 5 } } };
		load(device);
		expect(device.local.ai_credentials).toEqual({ manual: 'sk-manual', 'provider-openai': 'sk-openai' });
	});

	test('ignores an old build rewriting v1 after migration, except for allowed key imports', () => {
		const device: Device = { sync: v1Sync(), local: {} };
		load(device);
		const v2Before = Object.fromEntries(SYNC_KEYS.map(key => [key, clone(device.sync[key])]));
		const recordBefore = clone(device.local.ai_migration) as AiMigrationRecord;

		// The old build edits v1: renames a model, adds a provider with a key, changes the
		// imported key, and adds a key to the local provider.
		const interpreter = v1Interpreter();
		const providers = clone(interpreter.providers) as Record<string, unknown>[];
		providers[0].apiKey = 'sk-rotated';
		providers[1].apiKey = 'sk-local-added';
		providers.push({ id: 'provider-new', name: 'New', baseUrl: 'https://new.example', apiKey: 'sk-new' });
		const models = clone(interpreter.models) as Record<string, unknown>[];
		models[0].name = 'Renamed on old build';
		device.sync.interpreter_settings = { ...interpreter, providers, models, interpreterModel: 'model-a' };

		const writes = load(device, '2.0.0', 9000);
		expect(writes?.sync).toBeUndefined();
		for (const key of SYNC_KEYS) expect(device.sync[key]).toEqual(v2Before[key]);
		// Only the v2 connection with no local key and no past import receives the new v1 key.
		expect(device.local.ai_credentials).toEqual({
			'provider-openai': 'sk-openai',
			'provider-local': 'sk-local-added'
		});
		expect(device.local.ai_migration).toEqual({
			...recordBefore,
			credentials: ['provider-openai', 'provider-local']
		});
	});

	test('two devices: A bootstraps, B reuses and imports, then B deletes its key', () => {
		const deviceA: Device = { sync: v1Sync(), local: {} };
		expect(load(deviceA, '2.0.0', 1)?.sync).toBeDefined();
		const deviceB: Device = { sync: clone(deviceA.sync), local: {} };
		expect(load(deviceB, '2.0.0', 2)?.sync).toBeUndefined();
		expect(deviceB.local.ai_credentials).toEqual({ 'provider-openai': 'sk-openai' });

		deviceB.local.ai_credentials = {};
		expect(load(deviceB)).toBeUndefined();
		expect(deviceB.local.ai_credentials).toEqual({});
		// A is unaffected: its key stays.
		expect(load(deviceA)).toBeUndefined();
		expect(deviceA.local.ai_credentials).toEqual({ 'provider-openai': 'sk-openai' });
	});

	test('two devices bootstrapping concurrently write byte-identical sync items', () => {
		const v1 = v1Sync(v1Interpreter({
			interpreterExecutionMode: 'codex',
			interpreterCodexModel: 'gpt-5-codex',
			interpreterCodexReasoningEffort: 'medium'
		}));
		const writesA = createAiSettingsBootstrapper({ now: () => 111 }).plan(clone(v1), {}, '2.0.0');
		const writesB = createAiSettingsBootstrapper({ now: () => 999 }).plan(clone(v1), {}, '2.0.1');
		expect(JSON.stringify(writesB?.sync)).toBe(JSON.stringify(writesA?.sync));

		// Whichever write lands last, both devices converge on the same v2 items.
		const deviceA: Device = { sync: clone(v1), local: {} };
		const deviceB: Device = { sync: clone(v1), local: {} };
		apply(deviceA, writesA);
		apply(deviceB, writesB);
		Object.assign(deviceA.sync, clone(writesB?.sync));
		expect(deviceA.sync).toEqual(deviceB.sync);
		expect(load(deviceA)).toBeUndefined();
		expect(load(deviceB)).toBeUndefined();
	});

	test('writes a reused record once when v2 exists without v1', () => {
		const device: Device = { sync: clone(migrateV1(v1Sync()).sync) as unknown as Record<string, unknown>, local: {} };
		const writes = load(device);
		expect(writes).toEqual({
			local: {
				ai_migration: {
					v: 1,
					status: 'reused',
					at: 1000,
					build: '2.0.0',
					source: { providers: 0, models: 0, mode: 'api' },
					credentials: []
				}
			}
		});
		expect(load(device)).toBeUndefined();
	});

	test('re-bootstraps when the v2 items are gone, keeping the import history', () => {
		const device: Device = { sync: v1Sync(), local: {} };
		load(device);
		for (const key of SYNC_KEYS) delete device.sync[key];
		device.local.ai_credentials = {};

		const writes = load(device, '2.1.0', 5000);
		expect(Object.keys(writes?.sync ?? {}).sort()).toEqual([...SYNC_KEYS].sort());
		expect(writes?.local).not.toHaveProperty('ai_credentials');
		expect(device.local.ai_migration).toMatchObject({
			status: 'bootstrapped',
			at: 5000,
			build: '2.1.0',
			credentials: ['provider-openai']
		});
	});

	test('treats a corrupt ai_connections item as present and never overwrites it', () => {
		const device: Device = { sync: { ...v1Sync(), ai_connections: 'corrupt' }, local: {} };
		const writes = load(device);
		expect(writes?.sync).toBeUndefined();
		expect(device.sync.ai_connections).toBe('corrupt');
		expect(device.local).not.toHaveProperty('ai_credentials');
		expect(readMigrationRecord(device.local.ai_migration)?.status).toBe('reused');
	});

	test('only imports keys for connections present in v2', () => {
		const device: Device = { sync: v1Sync(), local: {} };
		load(device);
		const connections = clone(device.sync.ai_connections) as { v: 1; items: { id: string }[] };
		connections.items = connections.items.filter(item => item.id !== 'provider-openai');
		const deviceB: Device = { sync: { ...clone(device.sync), ai_connections: connections }, local: {} };

		load(deviceB);
		expect(deviceB.local).not.toHaveProperty('ai_credentials');
		expect((deviceB.local.ai_migration as AiMigrationRecord).credentials).toEqual([]);
	});
});
