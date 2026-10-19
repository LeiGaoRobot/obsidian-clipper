import { describe, expect, test } from 'vitest';
import type { Settings } from '../types/types';
import { deriveAiSettings, LEGACY_CODEX_CONNECTION_ID, LEGACY_GROK_CONNECTION_ID } from './settings-view';

function v1Settings(overrides: Partial<Settings> = {}): Settings {
	return {
		interpreterEnabled: true,
		interpreterAutoRun: false,
		interpreterExecutionMode: 'api',
		interpreterModel: 'model-b',
		defaultPromptContext: 'Context',
		providers: [
			{
				id: 'provider-anthropic',
				name: 'Anthropic',
				baseUrl: 'https://api.anthropic.com/v1/messages',
				apiKey: 'sk-ant',
				apiKeyRequired: true
			},
			{
				id: 'provider-ollama',
				name: 'Ollama',
				baseUrl: 'http://127.0.0.1:11434/api/chat',
				apiKey: '',
				apiKeyRequired: false
			}
		],
		models: [
			{ id: 'model-a', providerId: 'provider-anthropic', providerModelId: 'claude-a', name: 'A', enabled: true },
			{ id: 'model-b', providerId: 'provider-ollama', providerModelId: 'llama', name: 'B', enabled: true },
			{ id: 'model-c', providerId: 'provider-anthropic', providerModelId: 'claude-c', name: 'C', enabled: false }
		],
		readerSettings: { learningResponseLanguage: ' Japanese ' },
		...overrides
	} as Settings;
}

describe('deriveAiSettings', () => {
	test('maps providers and models to connections and profiles', () => {
		const view = deriveAiSettings(v1Settings(), { nativeMessaging: 'none' });

		expect(view.enabled).toBe(true);
		expect(view.connections.slice(0, 2)).toEqual([
			{
				id: 'provider-anthropic',
				kind: 'anthropic',
				label: 'Anthropic',
				baseUrl: 'https://api.anthropic.com/v1/messages',
				apiKeyRequired: true
			},
			{
				id: 'provider-ollama',
				kind: 'ollama',
				label: 'Ollama',
				baseUrl: 'http://127.0.0.1:11434/api/chat',
				apiKeyRequired: false
			}
		]);
		expect(view.profiles.slice(0, 3).map(profile => [profile.id, profile.connectionId, profile.model, profile.enabled]))
			.toEqual([
				['model-a', 'provider-anthropic', 'claude-a', true],
				['model-b', 'provider-ollama', 'llama', true],
				['model-c', 'provider-anthropic', 'claude-c', false]
			]);
		expect(view.routing).toEqual({
			defaultProfileId: 'model-b',
			taskProfiles: {},
			responseLanguage: 'Japanese'
		});
		expect(view.interpreter).toEqual({ autoRun: false, defaultPromptContext: 'Context' });
		expect(view.nativeMessaging).toBe('none');
	});

	test('treats a missing key requirement as not required, like v1', () => {
		const settings = v1Settings();
		settings.providers = [{ id: 'p', name: 'Custom', baseUrl: 'https://x.example/v1', apiKey: '  ' }];
		const view = deriveAiSettings(settings, { nativeMessaging: 'none' });
		expect(view.connections[0].apiKeyRequired).toBe(false);
		expect(view.credentials).toEqual({});
	});

	test('tolerates malformed stored providers', () => {
		const settings = v1Settings();
		settings.providers = [{ id: 'broken' } as Settings['providers'][number], ...settings.providers];
		const view = deriveAiSettings(settings, { nativeMessaging: 'none' });
		expect(view.connections[0]).toEqual({
			id: 'broken',
			kind: 'openai-compatible',
			label: '',
			baseUrl: '',
			apiKeyRequired: false
		});
	});

	test('keeps API keys out of connections', () => {
		const view = deriveAiSettings(v1Settings(), { nativeMessaging: 'none' });

		expect(view.credentials).toEqual({ 'provider-anthropic': 'sk-ant' });
		expect(JSON.stringify(view.connections)).not.toContain('sk-ant');
	});

	test('falls back to the first enabled model when the selected model is stale', () => {
		const view = deriveAiSettings(
			v1Settings({ interpreterModel: 'model-c' }),
			{ nativeMessaging: 'none' }
		);
		expect(view.routing.defaultProfileId).toBe('model-a');
	});

	test('leaves the default unset without an enabled model', () => {
		const settings = v1Settings();
		settings.models = settings.models.map(model => ({ ...model, enabled: false }));
		expect(deriveAiSettings(settings, { nativeMessaging: 'none' }).routing.defaultProfileId)
			.toBeUndefined();
	});

	test('synthesizes CLI connections carrying the Codex options', () => {
		const view = deriveAiSettings(
			v1Settings({
				interpreterExecutionMode: 'codex',
				interpreterCodexModel: 'gpt-codex',
				interpreterCodexReasoningEffort: 'high'
			}),
			{ nativeMessaging: 'port' }
		);

		expect(view.connections.slice(-2).map(connection => [connection.id, connection.kind])).toEqual([
			[LEGACY_CODEX_CONNECTION_ID, 'cli-codex'],
			[LEGACY_GROK_CONNECTION_ID, 'cli-grok']
		]);
		const codex = view.profiles.find(profile => profile.id === view.routing.defaultProfileId);
		expect(codex).toMatchObject({
			connectionId: LEGACY_CODEX_CONNECTION_ID,
			model: 'gpt-codex',
			options: { reasoningEffort: 'high' },
			enabled: true
		});
		const grok = view.profiles.find(profile => profile.connectionId === LEGACY_GROK_CONNECTION_ID);
		expect(grok).toMatchObject({ enabled: true });
		expect(grok?.model).toBeUndefined();
		expect(grok?.options).toBeUndefined();
	});

	test('selects the Grok profile in Grok mode', () => {
		const view = deriveAiSettings(
			v1Settings({ interpreterExecutionMode: 'grok' }),
			{ nativeMessaging: 'message' }
		);
		const selected = view.profiles.find(profile => profile.id === view.routing.defaultProfileId);
		expect(selected?.connectionId).toBe(LEGACY_GROK_CONNECTION_ID);
	});

	test('keeps CLI connections even where Native Messaging is unsupported', () => {
		const view = deriveAiSettings(
			v1Settings({ interpreterExecutionMode: 'codex' }),
			{ nativeMessaging: 'none' }
		);
		const selected = view.profiles.find(profile => profile.id === view.routing.defaultProfileId);
		expect(selected?.connectionId).toBe(LEGACY_CODEX_CONNECTION_ID);
		expect(view.nativeMessaging).toBe('none');
	});

	test('omits a blank response language and treats a missing mode as API', () => {
		const settings = v1Settings({
			interpreterExecutionMode: undefined,
			readerSettings: { learningResponseLanguage: '  ' } as Settings['readerSettings']
		});
		const view = deriveAiSettings(settings, { nativeMessaging: 'port' });
		expect(view.routing.responseLanguage).toBeUndefined();
		expect(view.routing.defaultProfileId).toBe('model-b');
	});

	test('does not mutate the v1 settings', () => {
		const settings = v1Settings({ interpreterExecutionMode: 'codex', interpreterCodexModel: 'm' });
		const snapshot = JSON.parse(JSON.stringify(settings));
		const view = deriveAiSettings(settings, { nativeMessaging: 'port' });
		view.connections[0].label = 'changed';
		view.profiles[0].enabled = false;
		expect(settings).toEqual(snapshot);
	});
});
