import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getLocalStorage: vi.fn(),
	getMessage: vi.fn(),
	getUILanguage: vi.fn(),
	getURL: vi.fn()
}));

vi.mock('./storage-utils', () => ({
	getLocalStorage: mocks.getLocalStorage,
	setLocalStorage: vi.fn()
}));

vi.mock('./browser-polyfill', () => ({
	default: {
		i18n: {
			getMessage: mocks.getMessage,
			getUILanguage: mocks.getUILanguage
		},
		runtime: { getURL: mocks.getURL },
		extension: { getViews: vi.fn().mockResolvedValue([]) }
	}
}));

import { getMessage, initializeI18n } from './i18n';

describe('Runtime locale loading', () => {
	beforeEach(() => {
		mocks.getLocalStorage.mockReset().mockResolvedValue('zh_CN');
		mocks.getMessage.mockReset().mockReturnValue('');
		mocks.getUILanguage.mockReset().mockReturnValue('en-US');
		mocks.getURL.mockReset().mockImplementation(path => `chrome-extension://test/${path}`);
	});

	test('loads only the selected custom locale and falls back to English messages', async () => {
		const fetchLocale = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ customGreeting: { message: '你好，$1' } })
		});
		vi.stubGlobal('fetch', fetchLocale);

		await initializeI18n();

		expect(fetchLocale).toHaveBeenCalledOnce();
		expect(fetchLocale).toHaveBeenCalledWith(
			'chrome-extension://test/_locales/zh_CN/messages.json'
		);
		expect(getMessage('customGreeting', '朋友')).toBe('你好，朋友');
		expect(getMessage('add')).toBe('Add');
	});
});
