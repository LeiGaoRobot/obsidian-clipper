// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AiError } from '../ai/errors';
import { deriveAiSettings } from '../ai/settings-view';
import type { AiSettingsView } from '../ai/types';
import type { Settings, Template } from '../types/types';

const mocks = vi.hoisted(() => ({
	runAiTask: vi.fn(),
	loadAiSettings: vi.fn(),
	saveRouting: vi.fn()
}));

vi.mock('./ai-settings', () => ({
	loadAiSettings: mocks.loadAiSettings,
	aiSettingsStore: { load: mocks.loadAiSettings, saveRouting: mocks.saveRouting }
}));
vi.mock('./template-compiler', () => ({ compileTemplate: async (_tabId: number, text: string) => text }));
vi.mock('../ai/client', () => ({ runAiTask: mocks.runAiTask }));
vi.mock('./i18n', () => ({ getMessage: (key: string) => key }));
vi.mock('./debug', () => ({ debugLog: vi.fn() }));

import {
	handleInterpreterUI,
	initializeInterpreter,
	populatePopupModelSelect,
	popupInterpretProfileId,
	saveInterpretProfile
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

// A stored (v2) view: per-task routing, labelled connections, and a CLI listed even where the
// browser has no Native Messaging (the resolver explains that when it runs).
function storedView(routing: Partial<AiSettingsView['routing']> = {}): AiSettingsView {
	return {
		enabled: true,
		connections: [
			{ id: 'openai', kind: 'openai-compatible', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1/chat/completions', apiKeyRequired: true },
			{ id: 'codex', kind: 'cli-codex', label: '' }
		],
		profiles: [
			{ id: 'gpt', connectionId: 'openai', model: 'gpt-5', label: 'GPT-5', enabled: true },
			{ id: 'gpt-off', connectionId: 'openai', model: 'gpt-4', label: 'Old', enabled: false },
			{ id: 'mini', connectionId: 'openai', model: 'gpt-5-mini', label: '', enabled: true },
			{ id: 'codex-default', connectionId: 'codex', label: '', enabled: true }
		],
		routing: { defaultProfileId: 'gpt', taskProfiles: {}, ...routing },
		interpreter: { autoRun: false, defaultPromptContext: '' },
		credentials: { openai: 'sk' },
		nativeMessaging: 'none'
	};
}

function selectGroups(select: HTMLSelectElement): Array<[string, Array<[string, string | null]>]> {
	return Array.from(select.querySelectorAll('optgroup'), group => [
		group.label,
		Array.from(group.querySelectorAll('option'), option => [option.value, option.textContent] as [string, string | null])
	]);
}

function modelSelect(): HTMLSelectElement {
	return document.getElementById('model-select') as HTMLSelectElement;
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
			<select id="model-select" style="display: none;"></select>
		`;
		mocks.saveRouting.mockReset().mockResolvedValue(false);
		mocks.loadAiSettings.mockReset().mockResolvedValue(v1View());
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

	test('passes the chosen profile id to the gateway', async () => {
		await handleInterpreterUI(template, {}, 1, 'https://example.com', 'legacy-cli-codex-default');

		expect(mocks.runAiTask).toHaveBeenCalledWith('interpret', expect.anything(), { profileId: 'legacy-cli-codex-default' });
	});

	test('lists every enabled profile in one group per connection, CLI profiles included', () => {
		populatePopupModelSelect(modelSelect(), storedView());

		expect(selectGroups(modelSelect())).toEqual([
			['OpenAI', [['gpt', 'GPT-5'], ['mini', 'gpt-5-mini']]],
			['interpreterExecutionModeCodex', [['codex-default', 'interpreterExecutionModeCodex']]]
		]);
		expect(modelSelect().style.display).toBe('inline-block');
		expect(modelSelect().value).toBe('gpt');
	});

	test('lists the derived v1 models and both CLIs before v2 exists, starting on the v1 model', () => {
		populatePopupModelSelect(modelSelect(), v1View({ interpreterExecutionMode: 'codex' }));

		expect(selectGroups(modelSelect())).toEqual([
			['OpenAI', [['model-b', 'B']]],
			['interpreterExecutionModeCodex', [['legacy-cli-codex-default', 'interpreterExecutionModeCodex']]],
			['interpreterExecutionModeGrok', [['legacy-cli-grok-default', 'interpreterExecutionModeGrok']]]
		]);
		// The select is shown in a CLI mode too, on the CLI profile that serves interpret.
		expect(modelSelect().style.display).toBe('inline-block');
		expect(modelSelect().value).toBe('legacy-cli-codex-default');
		expect(popupInterpretProfileId(v1View())).toBe('model-b');
	});

	test('starts on the interpret routing entry, and on no choice when it names a disabled profile', () => {
		populatePopupModelSelect(modelSelect(), storedView({ taskProfiles: { interpret: 'codex-default', translate: 'mini' } }));
		expect(modelSelect().value).toBe('codex-default');

		// No self-heal: the resolver reports not-configured when the run is routed.
		populatePopupModelSelect(modelSelect(), storedView({ taskProfiles: { interpret: 'gpt-off' } }));
		expect(modelSelect().value).toBe('');
	});

	test('hides the select when no profile is enabled', () => {
		const view = storedView();
		populatePopupModelSelect(modelSelect(), { ...view, profiles: view.profiles.map(profile => ({ ...profile, enabled: false })) });

		expect(modelSelect().options.length).toBe(0);
		expect(modelSelect().style.display).toBe('none');
	});

	test('a choice writes routing.taskProfiles.interpret when v2 is stored', async () => {
		mocks.loadAiSettings.mockResolvedValue(storedView({ taskProfiles: { translate: 'mini' } }));
		mocks.saveRouting.mockResolvedValue(true);

		const next = await saveInterpretProfile('codex-default');

		expect(mocks.saveRouting).toHaveBeenCalledWith({
			defaultProfileId: 'gpt',
			taskProfiles: { translate: 'mini', interpret: 'codex-default' }
		});
		expect(popupInterpretProfileId(next)).toBe('codex-default');
	});

	test('a choice equal to the default clears the interpret entry', async () => {
		mocks.loadAiSettings.mockResolvedValue(storedView({ taskProfiles: { interpret: 'mini' } }));
		mocks.saveRouting.mockResolvedValue(true);

		await saveInterpretProfile('gpt');

		expect(mocks.saveRouting).toHaveBeenCalledWith({ defaultProfileId: 'gpt', taskProfiles: {} });
	});

	test('before v2 exists a choice is not stored, is logged, and is kept in memory for this popup', async () => {
		mocks.saveRouting.mockResolvedValue(false);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const next = await saveInterpretProfile('model-b');

		expect(mocks.saveRouting).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('not saved'));
		expect(popupInterpretProfileId(next)).toBe('model-b');
		warn.mockRestore();
	});

	test('the popup select saves a change, reports the new view, and runs with the chosen profile', async () => {
		const view = storedView();
		mocks.loadAiSettings.mockResolvedValue(view);
		mocks.saveRouting.mockResolvedValue(true);
		const onViewChange = vi.fn();

		await initializeInterpreter(template, {}, 1, 'https://example.com', view, onViewChange);
		expect(modelSelect().value).toBe('gpt');

		modelSelect().value = 'codex-default';
		modelSelect().dispatchEvent(new Event('change'));
		await vi.waitFor(() => expect(onViewChange).toHaveBeenCalledOnce());
		expect(mocks.saveRouting).toHaveBeenCalledWith({ defaultProfileId: 'gpt', taskProfiles: { interpret: 'codex-default' } });
		expect(popupInterpretProfileId(onViewChange.mock.calls[0][0])).toBe('codex-default');

		// A rebuild from the reported view shows the new choice.
		modelSelect().textContent = '';
		populatePopupModelSelect(modelSelect(), onViewChange.mock.calls[0][0]);
		expect(modelSelect().value).toBe('codex-default');

		(document.getElementById('interpret-btn') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(mocks.runAiTask).toHaveBeenCalledOnce());
		expect(mocks.runAiTask).toHaveBeenCalledWith('interpret', expect.anything(), { profileId: 'codex-default' });
	});

	test('the interpret button lets routing decide when the select has no choice', async () => {
		const view = storedView({ taskProfiles: { interpret: 'gpt-off' } });

		await initializeInterpreter(template, {}, 1, 'https://example.com', view);
		(document.getElementById('interpret-btn') as HTMLButtonElement).click();

		await vi.waitFor(() => expect(mocks.runAiTask).toHaveBeenCalledOnce());
		expect(mocks.runAiTask).toHaveBeenCalledWith('interpret', expect.anything(), {});
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
