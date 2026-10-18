// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const storageMocks = vi.hoisted(() => ({
	getLocalStorage: vi.fn(),
	setLocalStorage: vi.fn(async () => undefined)
}));

vi.mock('../utils/browser-polyfill', () => ({
	default: {
		i18n: { getMessage: vi.fn(() => '') },
		runtime: {
			id: 'test-extension',
			getPlatformInfo: vi.fn(async () => ({ os: 'mac' })),
			getURL: vi.fn((path: string) => path)
		},
		storage: {
			local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
			sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) }
		}
	}
}));

vi.mock('../utils/storage-utils', () => ({
	generalSettings: { models: [], providers: [] },
	loadSettings: vi.fn(async () => undefined),
	saveSettings: vi.fn(async () => undefined),
	getLocalStorage: storageMocks.getLocalStorage,
	setLocalStorage: storageMocks.setLocalStorage
}));

const legacyDeepSeek = {
	id: 'deepseek',
	name: 'DeepSeek',
	baseUrl: 'https://api.deepseek.com/v1/chat/completions',
	apiKeyRequired: true,
	popularModels: [
		{ id: 'deepseek-chat', name: 'DeepSeek Chat' },
		{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }
	]
};

function catalogResponse(version: string): Response {
	return new Response(JSON.stringify({ version, deepseek: legacyDeepSeek }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

describe('Interpreter provider preset loading', () => {
	beforeEach(() => {
		vi.resetModules();
		storageMocks.getLocalStorage.mockReset();
		storageMocks.setLocalStorage.mockClear();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('normalizes a freshly fetched DeepSeek preset', async () => {
		storageMocks.getLocalStorage.mockResolvedValue(undefined);
		vi.stubGlobal('fetch', vi.fn(async () => catalogResponse('remote-v4')));
		const { getPresetProviders } = await import('./interpreter-settings');

		const providers = await getPresetProviders();

		expect(providers.deepseek.popularModels).toEqual([
			{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', recommended: true },
			{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }
		]);
		expect(storageMocks.setLocalStorage).toHaveBeenCalled();
	});

	test('normalizes the matching cached DeepSeek preset', async () => {
		storageMocks.getLocalStorage.mockResolvedValue({
			version: 'cached-v4',
			deepseek: legacyDeepSeek
		});
		vi.stubGlobal('fetch', vi.fn(async () => catalogResponse('cached-v4')));
		const { getPresetProviders } = await import('./interpreter-settings');

		const providers = await getPresetProviders();

		expect(providers.deepseek.popularModels?.map(model => model.id)).toEqual([
			'deepseek-v4-flash',
			'deepseek-v4-pro'
		]);
		expect(storageMocks.setLocalStorage).not.toHaveBeenCalled();
	});
});
