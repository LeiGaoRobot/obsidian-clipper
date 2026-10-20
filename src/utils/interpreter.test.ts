// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AiError } from '../ai/errors';
import { deriveAiSettings } from '../ai/settings-view';
import type { AiSettingsView } from '../ai/types';
import type { V1AiSettings } from '../ai/v1-settings';
import type { Template } from '../types/types';

const mocks = vi.hoisted(() => ({
	runAiTask: vi.fn(),
	loadAiSettings: vi.fn(),
	saveRouting: vi.fn(),
	sendMessage: vi.fn(),
	compileTemplate: vi.fn()
}));

vi.mock('./browser-polyfill', () => ({ default: { runtime: { sendMessage: mocks.sendMessage } } }));

vi.mock('./ai-settings', () => ({
	loadAiSettings: mocks.loadAiSettings,
	aiSettingsStore: { load: mocks.loadAiSettings, saveRouting: mocks.saveRouting }
}));
vi.mock('./template-compiler', () => ({ compileTemplate: mocks.compileTemplate }));
vi.mock('../ai/client', () => ({ runAiTask: mocks.runAiTask }));
vi.mock('./i18n', () => ({ getMessage: (key: string) => key }));
vi.mock('./debug', () => ({ debugLog: vi.fn() }));

import {
	handleInterpreterUI,
	InterpreterCancelledError,
	InterpreterFailedError,
	initializeInterpreter,
	populatePopupModelSelect,
	popupInterpretProfileId,
	prepareInterpreterForClip,
	saveInterpretProfile,
	waitForInterpreter
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
function v1View(overrides: Partial<V1AiSettings> = {}): AiSettingsView {
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
	} as V1AiSettings, { nativeMessaging: 'port' });
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
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		document.body.innerHTML = `
			<div id="interpreter"></div>
			<button id="interpret-btn"></button>
			<div id="interpreter-error"></div>
			<span id="interpreter-timer"></span>
			<button id="interpreter-cancel-btn" hidden></button>
			<button id="clip-btn"></button>
			<button id="more-btn"></button>
			<textarea id="prompt-context">Page context</textarea>
			<select id="model-select" style="display: none;"></select>
		`;
		mocks.saveRouting.mockReset().mockResolvedValue(false);
		mocks.sendMessage.mockReset().mockResolvedValue(undefined);
		mocks.compileTemplate.mockReset().mockImplementation(async (_tabId: number, text: string) => text);
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
			{ signal: expect.any(AbortSignal) }
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

		expect(mocks.runAiTask).toHaveBeenCalledWith('interpret', expect.anything(), { profileId: 'legacy-cli-codex-default', signal: expect.any(AbortSignal) });
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
		expect(mocks.runAiTask).toHaveBeenCalledWith('interpret', expect.anything(), { profileId: 'codex-default', signal: expect.any(AbortSignal) });
	});

	test('compiles the prompt context keeping prompt variables while AI is on', async () => {
		const withContext = { ...template, context: 'Context {{"Summarize"}}' };
		await initializeInterpreter(withContext, {}, 1, 'https://example.com', storedView());

		expect(mocks.compileTemplate).toHaveBeenCalledWith(
			1, 'Context {{"Summarize"}}', {}, 'https://example.com', { keepPromptVariables: true }
		);
		expect((document.getElementById('prompt-context') as HTMLTextAreaElement).value).toBe('Context {{"Summarize"}}');
	});

	test('does not compile the prompt context while AI is off', async () => {
		const withContext = { ...template, context: 'Context {{"Summarize"}}' };
		await initializeInterpreter(withContext, {}, 1, 'https://example.com', { ...storedView(), enabled: false });

		expect(mocks.compileTemplate).not.toHaveBeenCalled();
		expect(document.getElementById('interpreter')?.style.display).toBe('none');
	});

	test('the interpret button lets routing decide when the select has no choice', async () => {
		const view = storedView({ taskProfiles: { interpret: 'gpt-off' } });

		await initializeInterpreter(template, {}, 1, 'https://example.com', view);
		(document.getElementById('interpret-btn') as HTMLButtonElement).click();

		await vi.waitFor(() => expect(mocks.runAiTask).toHaveBeenCalledOnce());
		expect(mocks.runAiTask).toHaveBeenCalledWith('interpret', expect.anything(), { signal: expect.any(AbortSignal) });
	});

	test('shows a localized AI error in the error card with Retry and Open AI settings', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		mocks.runAiTask.mockRejectedValue(new AiError('auth', { status: 401, detail: 'invalid x-api-key' }));

		await expect(handleInterpreterUI(template, {}, 1, 'https://example.com')).resolves.toBe('error');

		const container = document.getElementById('interpreter-error') as HTMLDivElement;
		expect(container.style.display).toBe('block');
		expect(container.querySelector('.ai-error-card-title')?.textContent).toBe('aiErrorAuthTitle');
		expect(container.querySelector('.ai-error-card-body')?.textContent).toBe('aiErrorAuthBody');
		expect(container.querySelector('.ai-error-card-detail')?.textContent).toContain('invalid x-api-key');
		expect(cardActions()).toEqual(['openSettings', 'retry']);
		expect(document.getElementById('interpreter')?.classList.contains('error')).toBe(true);
		expect(interpretButton().classList.contains('error')).toBe(true);
		expect(cancelButton().hidden).toBe(true);
		expect((document.getElementById('clip-btn') as HTMLButtonElement).disabled).toBe(false);

		cardAction('openSettings').click();
		expect(mocks.sendMessage).toHaveBeenCalledWith({ action: 'openOptionsPage', section: 'ai' });
		error.mockRestore();
	});

	test('the error card replaces the button label and is scrolled into view', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		mocks.runAiTask.mockRejectedValueOnce(new AiError('provider-error', { status: 500 }));

		await handleInterpreterUI(template, {}, 1, 'https://example.com');

		// The card's title names the error, so the button's "Error" label is not shown above it.
		expect(interpretButton().style.display).toBe('none');
		expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
		expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById('interpreter-error'));

		cardAction('retry').click();
		expect(interpretButton().style.display).toBe('inline-block');
		await vi.waitFor(() => expect(interpretButton().classList.contains('done')).toBe(true));
		expect(interpretButton().style.display).toBe('inline-block');
		delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
		error.mockRestore();
	});

	test('Retry sends the same request again and shows its result', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		mocks.runAiTask.mockRejectedValueOnce(new AiError('network'));
		await handleInterpreterUI(template, {}, 1, 'https://example.com', 'mini');

		cardAction('retry').click();
		expect(interpretButton().classList.contains('processing')).toBe(true);
		await vi.waitFor(() => expect(interpretButton().classList.contains('done')).toBe(true));

		expect(mocks.runAiTask).toHaveBeenCalledTimes(2);
		expect(mocks.runAiTask.mock.calls[1][0]).toBe('interpret');
		expect(mocks.runAiTask.mock.calls[1][1]).toEqual(mocks.runAiTask.mock.calls[0][1]);
		expect(mocks.runAiTask.mock.calls[1][2]).toMatchObject({ profileId: 'mini' });
		const container = document.getElementById('interpreter-error') as HTMLDivElement;
		expect(container.style.display).toBe('none');
		expect(container.childElementCount).toBe(0);
		expect(document.getElementById('interpreter')?.classList.contains('error')).toBe(false);
		error.mockRestore();
	});

	test('Retry sends the context and model the popup shows by then', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		mocks.runAiTask.mockRejectedValueOnce(new AiError('model-unavailable'));
		populatePopupModelSelect(modelSelect(), storedView());
		await handleInterpreterUI(template, {}, 1, 'https://example.com', modelSelect().value);
		expect(mocks.runAiTask.mock.calls[0][2]).toMatchObject({ profileId: 'gpt' });

		// The user shortens the context and picks another model before retrying.
		(document.getElementById('prompt-context') as HTMLTextAreaElement).value = 'Shorter context';
		modelSelect().value = 'mini';
		cardAction('retry').click();
		await vi.waitFor(() => expect(interpretButton().classList.contains('done')).toBe(true));

		expect(mocks.runAiTask).toHaveBeenCalledTimes(2);
		expect(mocks.runAiTask.mock.calls[1][1]).toEqual({
			context: 'Shorter context',
			prompts: [{ key: 'prompt_1', prompt: 'Summarize', filters: '' }]
		});
		expect(mocks.runAiTask.mock.calls[1][2]).toEqual({ profileId: 'mini', signal: expect.any(AbortSignal) });
		error.mockRestore();
	});

	test('a Clip after an error runs the Interpreter again, and a second failure keeps the card', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		mocks.runAiTask
			.mockRejectedValueOnce(new AiError('network'))
			.mockRejectedValueOnce(new AiError('auth', { status: 401 }));
		await handleInterpreterUI(template, {}, 1, 'https://example.com');
		expect(interpretButton().disabled).toBe(true);

		await expect(prepareInterpreterForClip(interpretButton())).rejects.toBeInstanceOf(InterpreterFailedError);

		expect(mocks.runAiTask).toHaveBeenCalledTimes(2);
		expect(interpretButton().classList.contains('error')).toBe(true);
		const container = document.getElementById('interpreter-error') as HTMLDivElement;
		expect(container.style.display).toBe('block');
		expect(container.querySelector('.ai-error-card-title')?.textContent).toBe('aiErrorAuthTitle');

		// A later Clip runs it once more and continues when it succeeds.
		await expect(prepareInterpreterForClip(interpretButton())).resolves.toBeUndefined();
		expect(mocks.runAiTask).toHaveBeenCalledTimes(3);
		expect(interpretButton().classList.contains('done')).toBe(true);
		error.mockRestore();
	});

	test('a Clip saves a shown result without running the Interpreter again', async () => {
		await handleInterpreterUI(template, {}, 1, 'https://example.com');

		await expect(prepareInterpreterForClip(interpretButton())).resolves.toBeUndefined();
		expect(mocks.runAiTask).toHaveBeenCalledOnce();
	});

	test('shows Cancel while running; cancelling aborts the request and returns the button to idle', async () => {
		let signal: AbortSignal | undefined;
		mocks.runAiTask.mockImplementation((_task: string, _input: unknown, options: { signal?: AbortSignal }) => {
			signal = options.signal;
			return new Promise(() => undefined);
		});

		const run = handleInterpreterUI(template, {}, 1, 'https://example.com');
		expect(cancelButton().hidden).toBe(false);
		expect(interpretButton().classList.contains('processing')).toBe(true);
		expect((document.getElementById('clip-btn') as HTMLButtonElement).disabled).toBe(true);

		cancelButton().click();
		await expect(run).resolves.toBe('cancelled');

		expect(signal?.aborted).toBe(true);
		expect(cancelButton().hidden).toBe(true);
		expect(interpretButton().classList.contains('processing')).toBe(false);
		expect(interpretButton().classList.contains('cancelled')).toBe(true);
		expect(interpretButton().textContent).toBe('interpret');
		expect(interpretButton().disabled).toBe(false);
		expect((document.getElementById('interpreter-timer') as HTMLSpanElement).style.display).toBe('none');
		expect((document.getElementById('interpreter-error') as HTMLDivElement).style.display).toBe('none');
		expect((document.getElementById('clip-btn') as HTMLButtonElement).disabled).toBe(false);
	});

	test('clears the timer interval after an error', async () => {
		vi.useFakeTimers();
		const clearInterval = vi.spyOn(window, 'clearInterval');
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		mocks.runAiTask.mockRejectedValue(new AiError('timeout'));

		await handleInterpreterUI(template, {}, 1, 'https://example.com');

		expect(clearInterval).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		error.mockRestore();
	});

	test('a synthetic click on the Interpret button still starts a run', async () => {
		await initializeInterpreter(template, {}, 1, 'https://example.com', storedView());

		interpretButton().dispatchEvent(new MouseEvent('click'));

		await vi.waitFor(() => expect(mocks.runAiTask).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(interpretButton().classList.contains('done')).toBe(true));
	});

	test('a Clip waiting on a run is released by cancel, and a later Clip click runs again', async () => {
		mocks.runAiTask.mockImplementationOnce(() => new Promise(() => undefined));
		await initializeInterpreter(template, {}, 1, 'https://example.com', storedView());

		// What handleClipObsidian does: click, then wait on the button's state.
		interpretButton().click();
		expect(interpretButton().classList.contains('processing')).toBe(true);
		const waiting = waitForInterpreter(interpretButton());
		cancelButton().click();
		await expect(waiting).rejects.toBeInstanceOf(InterpreterCancelledError);

		interpretButton().click();
		await expect(waitForInterpreter(interpretButton())).resolves.toBeUndefined();
		expect(mocks.runAiTask).toHaveBeenCalledTimes(2);
	});

	test('with auto-run the button runs again after a cancel', async () => {
		const view = storedView();
		view.interpreter.autoRun = true;
		await initializeInterpreter(template, {}, 1, 'https://example.com', view);

		interpretButton().click();

		await vi.waitFor(() => expect(mocks.runAiTask).toHaveBeenCalledOnce());
	});
});

function interpretButton(): HTMLButtonElement {
	return document.getElementById('interpret-btn') as HTMLButtonElement;
}

function cancelButton(): HTMLButtonElement {
	return document.getElementById('interpreter-cancel-btn') as HTMLButtonElement;
}

function cardActions(): string[] {
	return Array.from(document.querySelectorAll<HTMLElement>('#interpreter-error .ai-error-card-action'), button => button.dataset.action ?? '');
}

function cardAction(action: string): HTMLButtonElement {
	return document.querySelector(`#interpreter-error .ai-error-card-action[data-action="${action}"]`) as HTMLButtonElement;
}
