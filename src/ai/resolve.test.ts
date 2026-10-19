import { describe, expect, test } from 'vitest';
import type { Settings } from '../types/types';
import { deriveAiSettings, LEGACY_CODEX_PROFILE_ID } from './settings-view';
import { effectiveStructuredOutput, resolveProfile, resolveResponseLanguage } from './resolve';
import type { AiSettingsView } from './types';

function view(overrides: Partial<AiSettingsView> = {}): AiSettingsView {
	return {
		enabled: true,
		connections: [
			{ id: 'anthropic', kind: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1/messages', apiKeyRequired: true },
			{ id: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/api/chat', apiKeyRequired: false },
			{ id: 'codex', kind: 'cli-codex', label: 'Codex CLI' }
		],
		profiles: [
			{ id: 'claude', connectionId: 'anthropic', model: 'claude', label: 'Claude', enabled: true },
			{ id: 'llama', connectionId: 'ollama', model: 'llama', label: 'Llama', enabled: true },
			{ id: 'codex-high', connectionId: 'codex', label: 'Codex', options: { reasoningEffort: 'high' }, enabled: true },
			{ id: 'off', connectionId: 'anthropic', model: 'x', label: 'Off', enabled: false },
			{ id: 'orphan', connectionId: 'deleted', model: 'x', label: 'Orphan', enabled: true }
		],
		routing: { defaultProfileId: 'claude', taskProfiles: {} },
		interpreter: { autoRun: false, defaultPromptContext: '' },
		credentials: { anthropic: 'sk-ant' },
		nativeMessaging: 'port',
		...overrides
	};
}

function routed(defaultProfileId: string | undefined, taskProfiles: AiSettingsView['routing']['taskProfiles'] = {}) {
	return { routing: { defaultProfileId, taskProfiles } };
}

describe('resolveProfile', () => {
	test('resolves the default profile with its connection and credential', () => {
		const result = resolveProfile(view(), 'translate');
		expect(result).toMatchObject({
			ok: true,
			profile: { id: 'claude' },
			connection: { id: 'anthropic' },
			credential: 'sk-ant'
		});
	});

	test('lets a task override beat the default', () => {
		const result = resolveProfile(view(routed('claude', { reading: 'codex-high' })), 'reading');
		expect(result).toMatchObject({ ok: true, profile: { id: 'codex-high' } });
		expect(resolveProfile(view(routed('claude', { reading: 'codex-high' })), 'explain'))
			.toMatchObject({ ok: true, profile: { id: 'claude' } });
	});

	test('lets an explicit profile beat routing', () => {
		const result = resolveProfile(view(routed('claude', { interpret: 'codex-high' })), 'interpret', { profileId: 'llama' });
		expect(result).toMatchObject({ ok: true, profile: { id: 'llama' } });
		expect(resolveProfile(view(), 'interpret', { profileId: 'off' }))
			.toMatchObject({ ok: false, error: { code: 'not-configured', reason: 'profile-unavailable' } });
	});

	test('does not require a credential for a keyless connection', () => {
		const result = resolveProfile(view(routed('llama')), 'edit');
		expect(result.ok).toBe(true);
		expect(result.ok && result.credential).toBeUndefined();
	});

	test.each([
		['disabled AI', { enabled: false }, 'not-configured', 'disabled'],
		['no profile', routed(undefined), 'not-configured', 'no-profile'],
		['a disabled profile', routed('off'), 'not-configured', 'profile-unavailable'],
		['an unknown profile', routed('missing'), 'not-configured', 'profile-unavailable'],
		['a missing connection', routed('orphan'), 'not-configured', 'connection-missing'],
		['no Native Messaging', { ...routed('codex-high'), nativeMessaging: 'none' as const }, 'host-unsupported', undefined],
		['a missing key', { credentials: { anthropic: '  ' } }, 'credential-missing', undefined]
	])('rejects %s', (_label, overrides, code, reason) => {
		const result = resolveProfile(view(overrides as Partial<AiSettingsView>), 'interpret');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe(code);
			expect(result.error.reason).toBe(reason);
		}
	});

	test('rejects a connection without a base URL', () => {
		const base = view();
		base.connections[0] = { ...base.connections[0], baseUrl: ' ' };
		const result = resolveProfile(base, 'interpret');
		expect(result.ok || result.error).toMatchObject({ code: 'not-configured', reason: 'base-url-missing', connectionId: 'anthropic' });
	});
});

describe('resolveResponseLanguage', () => {
	test('prefers the configured language, then the browser language', () => {
		expect(resolveResponseLanguage(view({ routing: { taskProfiles: {}, responseLanguage: 'Japanese' } }), 'en')).toBe('Japanese');
		expect(resolveResponseLanguage(view(), 'en')).toBe('en');
		expect(resolveResponseLanguage(view(), '')).toBe('English');
	});
});

describe('v1 parity', () => {
	function v1(overrides: Partial<Settings>): Settings {
		return {
			interpreterEnabled: true,
			interpreterAutoRun: false,
			defaultPromptContext: '',
			interpreterExecutionMode: 'api',
			providers: [
				{ id: 'p-key', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1/chat/completions', apiKey: 'sk', apiKeyRequired: true },
				{ id: 'p-nokey', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1/chat/completions', apiKey: '', apiKeyRequired: true },
				{ id: 'p-local', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/api/chat', apiKey: '' },
				{ id: 'p-nourl', name: 'Custom', baseUrl: '  ', apiKey: 'k' }
			],
			models: [],
			readerSettings: { learningResponseLanguage: '' },
			...overrides
		} as unknown as Settings;
	}

	test('resolves the Grok profile in Grok mode on Safari-style Native Messaging', () => {
		const settings = v1({ interpreterExecutionMode: 'grok' });
		const resolved = resolveProfile(deriveAiSettings(settings, { nativeMessaging: 'message' }), 'translate');
		expect(resolved).toMatchObject({ ok: true, connection: { kind: 'cli-grok' } });
	});

	test('resolves the Codex profile in Codex mode', () => {
		const settings = v1({ interpreterExecutionMode: 'codex', interpreterCodexModel: 'gpt-codex' });
		const resolved = resolveProfile(deriveAiSettings(settings, { nativeMessaging: 'port' }), 'interpret');
		expect(resolved).toMatchObject({
			ok: true,
			profile: { id: LEGACY_CODEX_PROFILE_ID, model: 'gpt-codex' },
			connection: { kind: 'cli-codex' }
		});
	});
});

describe('effectiveStructuredOutput', () => {
	const compatible = { kind: 'openai-compatible' as const, baseUrl: 'https://api.deepseek.com/v1/chat/completions' };

	test('uses the device override, then the connection, then the kind default', () => {
		expect(effectiveStructuredOutput(compatible)).toBe('json_object');
		expect(effectiveStructuredOutput({ ...compatible, structuredOutput: 'unknown' })).toBe('json_object');
		expect(effectiveStructuredOutput({ ...compatible, structuredOutput: 'json_schema' })).toBe('json_schema');
		expect(effectiveStructuredOutput({ ...compatible, structuredOutput: 'json_schema' }, { structuredOutput: 'none' })).toBe('none');
		expect(effectiveStructuredOutput(compatible, {})).toBe('json_object');
		expect(effectiveStructuredOutput({ kind: 'anthropic' })).toBe('json_schema');
	});
});
