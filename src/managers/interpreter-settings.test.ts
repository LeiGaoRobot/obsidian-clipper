// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

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
	getLocalStorage: vi.fn(async () => undefined),
	setLocalStorage: vi.fn(async () => undefined)
}));

import { updateCodexModelVisibility } from './interpreter-settings';

describe('Interpreter Codex model setting', () => {
	test('shows the editable model input only in Codex mode', () => {
		const settingsDocument = new DOMParser().parseFromString(
			readFileSync(
				resolve(process.cwd(), 'src/settings.html'),
				'utf8'
			),
			'text/html'
		);
		const mode = settingsDocument.getElementById('interpreter-execution-mode') as HTMLSelectElement;
		const item = settingsDocument.getElementById('interpreter-codex-model-item') as HTMLElement;
		const input = settingsDocument.getElementById('interpreter-codex-model') as HTMLInputElement;

		mode.value = 'api';
		updateCodexModelVisibility(settingsDocument);
		expect(item.hidden).toBe(true);

		mode.value = 'codex';
		updateCodexModelVisibility(settingsDocument);
		expect(item.hidden).toBe(false);
		expect(input.maxLength).toBe(200);
		expect(input.getAttribute('list')).toBe('interpreter-codex-model-options');
		expect(Array.from(settingsDocument.querySelectorAll('#interpreter-codex-model-options option'))
			.map(option => option.getAttribute('value'))).toEqual([
				'gpt-5.6-sol',
				'gpt-5.6-terra',
				'gpt-5.6-luna'
			]);
	});
});
