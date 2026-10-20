import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	get: vi.fn(),
	set: vi.fn()
}));

vi.mock('./browser-polyfill', () => ({
	default: {
		storage: {
			sync: {
				get: mocks.get,
				set: mocks.set
			}
		}
	}
}));

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './storage-utils';

describe('Reader preference storage', () => {
	beforeEach(() => {
		mocks.state = {};
		mocks.get.mockReset();
		mocks.set.mockReset();
		mocks.get.mockImplementation(async () => ({ ...mocks.state }));
		mocks.set.mockImplementation(async (values: Record<string, unknown>) => {
			Object.assign(mocks.state, values);
		});
	});

	test('loads and saves transcript display preferences', async () => {
		mocks.state.reader_settings = {
			transcriptLayout: 'focus',
			compactPlayer: true,
			bilingualSubtitles: true,
			japaneseReadings: true
		};

		const settings = await loadSettings();
		expect(settings.readerSettings).toMatchObject({
			transcriptLayout: 'focus',
			compactPlayer: true,
			bilingualSubtitles: true,
			japaneseReadings: true
		});

		await saveSettings(settings);
		expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({
			reader_settings: expect.objectContaining({
				compactPlayer: true,
				bilingualSubtitles: true,
				japaneseReadings: true
			})
		}));
	});

	test('starts from DEFAULT_SETTINGS and loads them for empty storage, sharing no objects', async () => {
		vi.resetModules();
		const fresh = await import('./storage-utils');
		expect(fresh.generalSettings).toEqual(fresh.DEFAULT_SETTINGS);
		expect(fresh.generalSettings.stats).not.toBe(fresh.DEFAULT_SETTINGS.stats);

		const settings = await fresh.loadSettings();
		expect(settings).toEqual(fresh.DEFAULT_SETTINGS);
		expect(settings.alwaysShowHighlights).toBe(true);
		settings.stats.addToObsidian++;
		settings.readerSettings.fonts.push('Serif');
		expect(fresh.DEFAULT_SETTINGS.stats.addToObsidian).toBe(0);
		expect(fresh.DEFAULT_SETTINGS.readerSettings.fonts).toEqual([]);
	});

	test('does not read the v1 interpreter_settings item', async () => {
		mocks.state.interpreter_settings = {
			interpreterEnabled: true,
			interpreterExecutionMode: 'codex',
			interpreterCodexModel: 'gpt-5.6-terra',
			providers: [{ id: 'p', name: 'P', baseUrl: 'https://x.example/v1', apiKey: 'sk' }],
			models: [{ id: 'm', providerId: 'p', providerModelId: 'gpt', name: 'M', enabled: true }]
		};

		expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
	});

	test('saving never writes interpreter_settings and leaves the stored v1 item untouched', async () => {
		const v1 = {
			interpreterEnabled: true,
			interpreterExecutionMode: 'codex',
			interpreterCodexModel: 'gpt-5.6-terra',
			providers: [{ id: 'p', name: 'P', baseUrl: 'https://x.example/v1', apiKey: 'sk' }],
			models: []
		};
		mocks.state.interpreter_settings = structuredClone(v1);

		const settings = await loadSettings();
		await saveSettings({ ...settings, betaFeatures: true });

		for (const [values] of mocks.set.mock.calls) {
			expect(values).not.toHaveProperty('interpreter_settings');
		}
		expect(mocks.state.interpreter_settings).toEqual(v1);
	});

	test('round-trips the v1 reader_settings.learningResponseLanguage', async () => {
		mocks.state.reader_settings = { learningResponseLanguage: 'Japanese', fontSize: 18 };

		const settings = await loadSettings();
		expect(settings.readerSettings.learningResponseLanguage).toBe('Japanese');
		await saveSettings({ ...settings, readerSettings: { ...settings.readerSettings, fontSize: 20 } });

		expect(mocks.state.reader_settings).toMatchObject({ learningResponseLanguage: 'Japanese', fontSize: 20 });
	});
});
