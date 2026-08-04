// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	saveSettings: vi.fn(async () => undefined)
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
	saveSettings: mocks.saveSettings,
	getLocalStorage: vi.fn(async () => undefined),
	setLocalStorage: vi.fn(async () => undefined)
}));

import { saveInterpreterSettingsFromForm, updateCodexSettingsVisibility } from './interpreter-settings';

describe('Interpreter Codex settings', () => {
	test('shows model and reasoning effort controls only in Codex mode', () => {
		const settingsDocument = new DOMParser().parseFromString(
			readFileSync(resolve(process.cwd(), 'src/settings.html'), 'utf8'),
			'text/html'
		);
		const mode = settingsDocument.getElementById('interpreter-execution-mode') as HTMLSelectElement;
		const modelItem = settingsDocument.getElementById('interpreter-codex-model-item') as HTMLElement;
		const effortItem = settingsDocument.getElementById('interpreter-codex-reasoning-effort-item') as HTMLElement;
		const effort = settingsDocument.getElementById('interpreter-codex-reasoning-effort') as HTMLSelectElement;
		const input = settingsDocument.getElementById('interpreter-codex-model') as HTMLInputElement;

		mode.value = 'grok';
		updateCodexSettingsVisibility(settingsDocument);
		expect(modelItem.hidden).toBe(true);
		expect(effortItem.hidden).toBe(true);

		mode.value = 'codex';
		updateCodexSettingsVisibility(settingsDocument);
		expect(modelItem.hidden).toBe(false);
		expect(effortItem.hidden).toBe(false);
		expect(Array.from(effort.options).map(option => option.value)).toEqual([
			'', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
		]);
		expect(input.maxLength).toBe(200);
		expect(input.getAttribute('list')).toBe('interpreter-codex-model-options');
		expect(Array.from(settingsDocument.querySelectorAll('#interpreter-codex-model-options option'))
			.map(option => option.getAttribute('value'))).toEqual([
				'gpt-5.6-sol',
				'gpt-5.6-terra',
				'gpt-5.6-luna'
			]);
	});

	test('saves the selected Codex reasoning effort and clears Default', () => {
		document.body.innerHTML = `
			<select id="interpreter-execution-mode"><option value="codex" selected>Codex</option></select>
			<select id="interpreter-codex-reasoning-effort">
				<option value=""></option>
				<option value="max" selected>max</option>
			</select>
		`;

		saveInterpreterSettingsFromForm();
		expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
			interpreterCodexReasoningEffort: 'max'
		}));

		(document.getElementById('interpreter-codex-reasoning-effort') as HTMLSelectElement).value = '';
		saveInterpreterSettingsFromForm();
		expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
			interpreterCodexReasoningEffort: undefined
		}));
	});
});
