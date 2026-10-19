import { beforeEach, describe, expect, test, vi } from 'vitest';
import { deriveAiSettings } from '../ai/settings-view';
import { sanitizeV1AiSettings } from '../ai/settings';
import type { Settings } from '../types/types';

const mocks = vi.hoisted(() => ({
	sync: {} as Record<string, unknown>,
	local: {} as Record<string, unknown>,
	syncSet: vi.fn(),
	localSet: vi.fn(),
	runtime: {} as Record<string, unknown>
}));

function area(values: Record<string, unknown>, set: (items: Record<string, unknown>) => unknown) {
	return {
		get: vi.fn(async (keys?: string | string[] | null) => {
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
			get local() { return area(mocks.local, mocks.localSet); },
			onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
		}
	}
}));

import { detectNativeMessaging } from './native-messaging-support';
import { loadAiSettings, loadAiSettingsSnapshot } from './ai-settings';

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
		mocks.runtime = { connectNative: () => undefined, sendNativeMessage: () => undefined };
	});

	test('derives the view from the stored v1 items and writes nothing', async () => {
		mocks.sync.interpreter_settings = interpreterSettings;
		mocks.sync.reader_settings = { learningResponseLanguage: 'Japanese' };

		const snapshot = await loadAiSettingsSnapshot();

		expect(snapshot.mode).toBe('derived');
		expect(snapshot.view).toEqual(deriveAiSettings(
			sanitizeV1AiSettings(interpreterSettings, mocks.sync.reader_settings) as Settings,
			{ nativeMessaging: 'port' }
		));
		expect(snapshot.view.credentials).toEqual({ 'provider-1': 'sk-1' });
		expect(snapshot.view.routing.responseLanguage).toBe('Japanese');
		expect(mocks.syncSet).not.toHaveBeenCalled();
		expect(mocks.localSet).not.toHaveBeenCalled();
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
