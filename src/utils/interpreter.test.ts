// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AiError } from '../ai/errors';
import { deriveAiSettings } from '../ai/settings-view';
import type { AiSettingsView } from '../ai/types';
import type { Settings, Template } from '../types/types';

const mocks = vi.hoisted(() => ({
	runAiTask: vi.fn(),
	generalSettings: {} as Record<string, unknown>
}));

vi.mock('./storage-utils', () => ({
	generalSettings: mocks.generalSettings,
	saveSettings: vi.fn()
}));
vi.mock('../ai/client', () => ({ runAiTask: mocks.runAiTask }));
vi.mock('./i18n', () => ({ getMessage: (key: string) => key }));
vi.mock('./debug', () => ({ debugLog: vi.fn() }));

import {
	findPopupModelProfile,
	handleInterpreterUI,
	listPopupModelProfiles,
	usesPopupModelSelect
} from './interpreter';

const template: Template = {
	id: 'template-1',
	name: 'Template',
	behavior: 'create',
	noteNameFormat: '',
	path: '',
	noteContentFormat: '{{"Summarize"}}',
	properties: []
};

// Views are built from v1 settings exactly as the loader derives them until v2 is stored.
function v1View(overrides: Partial<Settings> = {}): AiSettingsView {
	return deriveAiSettings({
		interpreterEnabled: true,
		interpreterAutoRun: false,
		interpreterExecutionMode: 'api',
		interpreterModel: 'model-b',
		defaultPromptContext: '',
		providers: [{ id: 'provider-1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1/chat/completions', apiKey: 'sk', apiKeyRequired: true }],
		models: [
			{ id: 'model-a', providerId: 'provider-1', providerModelId: 'gpt-a', name: 'A', enabled: false },
			{ id: 'model-b', providerId: 'provider-1', providerModelId: 'gpt-b', name: 'B', enabled: true }
		],
		readerSettings: {},
		...overrides
	} as Settings, { nativeMessaging: 'port' });
}

describe('Interpreter', () => {
	beforeEach(() => {
		document.body.innerHTML = `
			<div id="interpreter"></div>
			<button id="interpret-btn"></button>
			<div id="interpreter-error"></div>
			<span id="interpreter-timer"></span>
			<button id="clip-btn"></button>
			<button id="more-btn"></button>
			<textarea id="prompt-context">Page context</textarea>
		`;
		mocks.runAiTask.mockReset().mockResolvedValue({
			output: { responses: { prompt_1: 'Done' }, missing: [] },
			connectionKind: 'cli-codex'
		});
	});

	test('runs CLI modes through the gateway without an explicit profile', async () => {
		await handleInterpreterUI(template, {}, 1, 'https://example.com');

		expect(mocks.runAiTask).toHaveBeenCalledWith(
			'interpret',
			{ context: 'Page context', prompts: [{ key: 'prompt_1', prompt: 'Summarize', filters: '' }] },
			{}
		);
		expect(document.getElementById('interpreter')?.classList.contains('done')).toBe(true);
	});

	test('fills answered prompts and marks a partial result without calling it done', async () => {
		const twoPrompts = { ...template, noteContentFormat: '{{"Summarize"}} {{"Tags"|lower}}' };
		document.body.insertAdjacentHTML('beforeend',
			'<textarea id="note-content-field">{{"Summarize"}} / {{"Tags"|lower}}</textarea>');
		mocks.runAiTask.mockResolvedValue({
			output: { responses: { prompt_1: 'Done' }, missing: ['prompt_2'] },
			connectionKind: 'cli-codex'
		});

		await handleInterpreterUI(twoPrompts, {}, 1, 'https://example.com');

		expect((document.getElementById('note-content-field') as HTMLTextAreaElement).value)
			.toBe('Done / {{"Tags"|lower}}');
		const container = document.getElementById('interpreter')!;
		const button = document.getElementById('interpret-btn') as HTMLButtonElement;
		expect(container.classList.contains('partial')).toBe(true);
		expect(container.classList.contains('done')).toBe(false);
		expect(button.classList.contains('partial')).toBe(true);
		expect(button.classList.contains('done')).toBe(false);
		expect(button.textContent).toBe('interpreterpartialstatus');
		const warning = document.getElementById('interpreter-error') as HTMLDivElement;
		expect(warning.style.display).toBe('block');
		expect(warning.classList.contains('warning')).toBe(true);
		expect(warning.querySelector('strong')?.textContent).toBe('interpreterPartialTitle');
		expect(Array.from(warning.querySelectorAll('li'), item => item.textContent)).toEqual(['Tags']);
		expect((document.getElementById('clip-btn') as HTMLButtonElement).disabled).toBe(false);
	});

	test('clears a previous partial warning when a later run completes', async () => {
		mocks.runAiTask.mockResolvedValueOnce({
			output: { responses: {}, missing: ['prompt_1'] },
			connectionKind: 'cli-codex'
		});
		await handleInterpreterUI(template, {}, 1, 'https://example.com');
		await handleInterpreterUI(template, {}, 1, 'https://example.com');

		const warning = document.getElementById('interpreter-error') as HTMLDivElement;
		expect(warning.style.display).toBe('none');
		expect(warning.classList.contains('warning')).toBe(false);
		expect(document.getElementById('interpreter')?.classList.contains('partial')).toBe(false);
		expect(document.getElementById('interpreter')?.classList.contains('done')).toBe(true);
		expect(document.getElementById('interpret-btn')?.classList.contains('partial')).toBe(false);
	});

	test('passes the selected model as the profile in API mode', async () => {
		const profile = findPopupModelProfile(v1View(), 'model-b');
		await handleInterpreterUI(template, {}, 1, 'https://example.com', profile);

		expect(mocks.runAiTask).toHaveBeenCalledWith('interpret', expect.anything(), { profileId: 'model-b' });
	});

	test('lists the enabled v1 models for the model select, only in API mode', () => {
		const view = v1View();
		expect(listPopupModelProfiles(view).map(profile => [profile.id, profile.label])).toEqual([['model-b', 'B']]);
		expect(findPopupModelProfile(view, 'model-a')?.enabled).toBe(false);
		expect(findPopupModelProfile(view, 'legacy-cli-codex-default')).toBeUndefined();
		expect(usesPopupModelSelect(view)).toBe(true);
		expect(usesPopupModelSelect(v1View({ interpreterExecutionMode: 'codex' }))).toBe(false);
		expect(usesPopupModelSelect(v1View({ interpreterExecutionMode: 'grok' }))).toBe(false);
	});

	test('shows a localized AI error with its technical detail', async () => {
		mocks.runAiTask.mockRejectedValue(new AiError('auth', { status: 401, detail: 'invalid x-api-key' }));

		await expect(handleInterpreterUI(template, {}, 1, 'https://example.com')).rejects.toThrow('aiErrorAuthBody');

		const error = document.getElementById('interpreter-error') as HTMLDivElement;
		expect(error.style.display).toBe('block');
		expect(error.querySelector('strong')?.textContent).toBe('aiErrorAuthTitle');
		expect(error.textContent).toContain('aiErrorAuthBody');
		expect(error.querySelector('details')?.textContent).toContain('invalid x-api-key');
		expect(document.getElementById('interpreter')?.classList.contains('error')).toBe(true);
	});
});
