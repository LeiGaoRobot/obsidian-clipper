import { beforeEach, describe, expect, test, vi } from 'vitest';
import { deriveAiSettings } from '../ai/settings-view';
import { sanitizeV1AiSettings } from '../ai/settings';

const mocks = vi.hoisted(() => ({
	sync: {} as Record<string, unknown>,
	local: {} as Record<string, unknown>,
	syncSet: vi.fn(),
	localSet: vi.fn(),
	localGets: [] as unknown[],
	runtime: {} as Record<string, unknown>
}));

function area(values: Record<string, unknown>, set: (items: Record<string, unknown>) => unknown, gets?: unknown[]) {
	return {
		get: vi.fn(async (keys?: string | string[] | null) => {
			gets?.push(keys);
			const wanted = keys === undefined || keys === null ? Object.keys(values) : (Array.isArray(keys) ? keys : [keys]);
			return Object.fromEntries(wanted.filter(key => key in values).map(key => [key, values[key]]));
		}),
		set: vi.fn(async (items: Record<string, unknown>) => { set(items); }),
		remove: vi.fn(async () => {})
	};
}

vi.mock('./browser-polyfill', () => ({
	default: {
		get runtime() { return mocks.runtime; },
		storage: {
			get sync() { return area(mocks.sync, mocks.syncSet); },
			get local() { return area(mocks.local, mocks.localSet, mocks.localGets); },
			onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
		}
	}
}));

import { detectNativeMessaging } from './native-messaging-support';
import { loadAiSettings, loadAiSettingsSnapshot, loadAiSettingsWithCredentialPresence } from './ai-settings';

const interpreterSettings = {
	interpreterEnabled: true,
	interpreterExecutionMode: 'api',
	interpreterModel: 'model-1',
	providers: [{ id: 'provider-1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1/chat/completions', apiKey: 'sk-1', apiKeyRequired: true }],
	models: [{ id: 'model-1', providerId: 'provider-1', providerModelId: 'gpt', name: 'GPT', enabled: true }]
};

describe('browser AI settings', () => {
	beforeEach(() => {
		for (const key of Object.keys(mocks.sync)) delete mocks.sync[key];
		for (const key of Object.keys(mocks.local)) delete mocks.local[key];
		mocks.syncSet.mockReset();
		mocks.localSet.mockReset();
		mocks.localGets.length = 0;
		mocks.runtime = { connectNative: () => undefined, sendNativeMessage: () => undefined };
	});

	test('derives the view from the stored v1 items and writes nothing', async () => {
		mocks.sync.interpreter_settings = interpreterSettings;
		mocks.sync.reader_settings = { learningResponseLanguage: 'Japanese' };

		const snapshot = await loadAiSettingsSnapshot();

		expect(snapshot.mode).toBe('derived');
		// The Popup and Reader store never carries keys, not even the v1 ones a derived view has.
		expect(snapshot.view).toEqual({
			...deriveAiSettings(
				sanitizeV1AiSettings(interpreterSettings, mocks.sync.reader_settings),
				{ nativeMessaging: 'port' }
			),
			credentials: {}
		});
		expect(snapshot.view.routing.responseLanguage).toBe('Japanese');
		expect(mocks.syncSet).not.toHaveBeenCalled();
		expect(mocks.localSet).not.toHaveBeenCalled();
	});

	test('the Reader store never reads ai_credentials; the Popup readiness view has only key presence', async () => {
		mocks.sync.ai_connections = { v: 1, items: [{ id: 'openai', kind: 'openai-compatible', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1/chat/completions', apiKeyRequired: true }] };
		mocks.local.ai_credentials = { openai: 'sk-local' };

		const view = await loadAiSettings();
		expect(view.credentials).toEqual({});
		expect(view).not.toHaveProperty('credentialIds');
		expect(mocks.localGets.flat()).not.toContain('ai_credentials');

		const readiness = await loadAiSettingsWithCredentialPresence();
		expect(readiness.credentials).toEqual({});
		expect(readiness.credentialIds).toEqual(['openai']);
		expect(JSON.stringify([view, readiness])).not.toContain('sk-local');
	});

	test('reports the Native Messaging support of the current context', async () => {
		expect(detectNativeMessaging()).toBe('port');
		mocks.runtime = { sendNativeMessage: () => undefined };
		expect(detectNativeMessaging()).toBe('message');
		expect((await loadAiSettings()).nativeMessaging).toBe('message');
		mocks.runtime = {};
		expect(detectNativeMessaging()).toBe('none');
	});
});
