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

import { loadSettings, saveSettings } from './storage-utils';

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
});
