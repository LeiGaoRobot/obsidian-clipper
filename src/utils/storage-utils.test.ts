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

import { generalSettings, loadSettings, saveSettings } from './storage-utils';

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

	test('loads a trimmed Codex model and a supported reasoning effort from v1', async () => {
		mocks.state.interpreter_settings = {
			interpreterExecutionMode: 'codex',
			interpreterCodexModel: '  gpt-5.6-terra  ',
			interpreterCodexReasoningEffort: 'max'
		};

		const settings = await loadSettings();
		expect(settings.interpreterCodexModel).toBe('gpt-5.6-terra');
		expect(settings.interpreterCodexReasoningEffort).toBe('max');
	});

	test('normalizes an unknown Codex reasoning effort to an omitted value on load', async () => {
		mocks.state.interpreter_settings = {
			interpreterExecutionMode: 'codex',
			interpreterCodexReasoningEffort: 'extreme'
		};

		const settings = await loadSettings();
		expect(settings.interpreterCodexReasoningEffort).toBeUndefined();
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
		await saveSettings({ ...settings, interpreterEnabled: false, interpreterModel: 'other' });

		for (const [values] of mocks.set.mock.calls) {
			expect(values).not.toHaveProperty('interpreter_settings');
		}
		expect(mocks.state.interpreter_settings).toEqual(v1);
	});

	test('saving no longer runs the Codex normalizers', async () => {
		await loadSettings();
		await saveSettings({ interpreterCodexModel: '  padded  ', interpreterCodexReasoningEffort: 'extreme' as never });

		expect(generalSettings.interpreterCodexModel).toBe('  padded  ');
		expect(generalSettings.interpreterCodexReasoningEffort).toBe('extreme');
		expect(mocks.set.mock.calls[mocks.set.mock.calls.length - 1]?.[0]).not.toHaveProperty('interpreter_settings');
	});
});
