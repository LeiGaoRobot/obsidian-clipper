// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { initializeAiSettings } from './index';
import { PROMPT_CONTEXT_DEBOUNCE_MS } from './interpreter';
import { createFakeStore, installGuideEnvironment, loadSettingsDocument, settle, type FakeSettings } from './test-support';

async function section(settings: FakeSettings, promptContextDebounceMs?: number) {
	const fake = createFakeStore(settings);
	const handle = await initializeAiSettings({
		store: fake.store,
		installGuide: installGuideEnvironment(),
		...(promptContextDebounceMs !== undefined ? { promptContextDebounceMs } : {})
	});
	return { ...fake, handle };
}

function checkbox(id: string): HTMLInputElement {
	return document.getElementById(id) as HTMLInputElement;
}

function textarea(): HTMLTextAreaElement {
	return document.getElementById('ai-prompt-context') as HTMLTextAreaElement;
}

function toggle(id: string, checked: boolean): void {
	checkbox(id).checked = checked;
	checkbox(id).dispatchEvent(new Event('change'));
}

beforeEach(() => {
	loadSettingsDocument();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('Interpreter panel', () => {
	test('shows the stored switches and prompt context', async () => {
		await section({ enabled: true, autoRun: true, promptContext: '{{content}}' });
		expect(checkbox('ai-interpreter-enabled').checked).toBe(true);
		expect(checkbox('ai-interpreter-enabled').closest('.checkbox-container')?.classList.contains('is-enabled')).toBe(true);
		expect(checkbox('ai-interpreter-auto-run').checked).toBe(true);
		expect(textarea().value).toBe('{{content}}');
		expect(textarea().placeholder).toBe('{{fullHtml}}');
	});

	test('the master switch is at the top of the AI section, above Connections', async () => {
		await section({ enabled: false });
		const switchInput = checkbox('ai-interpreter-enabled');
		expect(switchInput.closest('#ai-enabled')).not.toBeNull();
		expect(document.getElementById('ai-interpreter')?.contains(switchInput)).toBe(false);
		const connections = document.getElementById('ai-connections-group')!;
		expect(switchInput.compareDocumentPosition(connections) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		const aiSection = document.getElementById('ai-section')!;
		expect(aiSection.querySelector('.setting-group')?.id).toBe('ai-enabled-group');
	});

	test('adding the first model while AI is off shows a hint next to the switch until it is on', async () => {
		const connection = { id: 'openai', kind: 'openai-compatible' as const, label: 'OpenAI', baseUrl: 'https://api.openai.com/v1/chat/completions', apiKeyRequired: true };
		const { handle } = await section({ enabled: false, connections: [connection] });
		const hint = () => document.querySelector<HTMLElement>('#ai-enabled .ai-enabled-hint')!;
		expect(hint().hidden).toBe(true);

		await handle.controller.addProfile({ connectionId: 'openai', label: '', model: 'gpt-5' });
		await settle();
		expect(hint().hidden).toBe(false);
		expect(hint().textContent).toBe("AI features are off, so the models you add aren't used yet. Turn this on to use them.");
		expect(hint().getAttribute('role')).toBe('status');
		expect(checkbox('ai-interpreter-enabled').checked).toBe(false);

		toggle('ai-interpreter-enabled', true);
		expect(hint().hidden).toBe(true);
		await settle();
		expect(hint().hidden).toBe(true);
	});

	test('no hint for models already stored, or when AI is on', async () => {
		const connection = { id: 'openai', kind: 'openai-compatible' as const, label: 'OpenAI', baseUrl: 'https://api.openai.com/v1/chat/completions', apiKeyRequired: true };
		const profile = { id: 'gpt', connectionId: 'openai', model: 'gpt-5', label: '', enabled: true };
		await section({ enabled: false, connections: [connection], profiles: [profile] });
		expect(document.querySelector<HTMLElement>('#ai-enabled .ai-enabled-hint')?.hidden).toBe(true);

		loadSettingsDocument();
		const { handle } = await section({ enabled: true, connections: [connection] });
		await handle.controller.addProfile({ connectionId: 'openai', label: '', model: 'gpt-5' });
		await settle();
		expect(document.querySelector<HTMLElement>('#ai-enabled .ai-enabled-hint')?.hidden).toBe(true);
	});

	test('enable and auto-run write ai_interpreter through the controller', async () => {
		const { sync, handle } = await section({ enabled: false, autoRun: false });
		const setEnabled = vi.spyOn(handle.controller, 'setInterpreterEnabled');
		const setAutoRun = vi.spyOn(handle.controller, 'setAutoRun');

		toggle('ai-interpreter-enabled', true);
		await settle();
		toggle('ai-interpreter-auto-run', true);
		await settle();

		expect(setEnabled).toHaveBeenCalledWith(true);
		expect(setAutoRun).toHaveBeenCalledWith(true);
		expect(sync.data.ai_interpreter).toEqual({ v: 1, enabled: true, autoRun: true });
	});

	test('the template editor prompt context follows the master switch', async () => {
		await section({ enabled: false });
		const container = document.getElementById('prompt-context-container')!;
		expect(container.style.display).toBe('none');
		toggle('ai-interpreter-enabled', true);
		expect(container.style.display).toBe('block');
	});

	test('a refused write puts the toggle back', async () => {
		const { sync } = await section({ enabled: false });
		sync.failNextSet = new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded');
		toggle('ai-interpreter-enabled', true);
		await settle();
		expect(checkbox('ai-interpreter-enabled').checked).toBe(false);
		expect(document.getElementById('ai-settings-error')?.hidden).toBe(false);
	});

	test('the prompt context is saved 500 ms after the last keystroke', async () => {
		const { sync, handle } = await section({ promptContext: '' });
		const setPromptContext = vi.spyOn(handle.controller, 'setPromptContext');
		expect(PROMPT_CONTEXT_DEBOUNCE_MS).toBe(500);
		vi.useFakeTimers();

		for (const text of ['{{', '{{con', '{{content}}']) {
			textarea().value = text;
			textarea().dispatchEvent(new Event('input'));
			await vi.advanceTimersByTimeAsync(200);
		}
		expect(setPromptContext).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(300);
		expect(setPromptContext).toHaveBeenCalledTimes(1);
		expect(setPromptContext).toHaveBeenCalledWith('{{content}}');
		vi.useRealTimers();
		await settle();
		expect(sync.data.ai_prompt_context).toEqual({ v: 1, text: '{{content}}' });
	});

	test('leaving the field saves a pending edit at once', async () => {
		const { sync } = await section({ promptContext: '' });
		textarea().value = 'Summarize {{content}}';
		textarea().dispatchEvent(new Event('input'));
		textarea().dispatchEvent(new Event('change'));
		await settle();
		expect(sync.data.ai_prompt_context).toEqual({ v: 1, text: 'Summarize {{content}}' });
	});

	test('when the page goes away a pending edit is written before dispose returns', async () => {
		const { sync, handle } = await section({ promptContext: '' }, 10_000);
		textarea().value = 'Last words';
		textarea().dispatchEvent(new Event('input'));

		handle.dispose();
		// Synchronously, before any awaited promise resolves.
		expect(sync.sets).toEqual([{ ai_prompt_context: { v: 1, text: 'Last words' } }]);
		await settle();
		expect(sync.sets).toHaveLength(1);
	});

	test('a debounced save that is still queued is written at once when the page is hidden', async () => {
		const { sync, handle } = await section({ promptContext: '' }, 0);
		textarea().value = 'Queued';
		textarea().dispatchEvent(new Event('input'));
		textarea().dispatchEvent(new Event('change'));
		// The queued save is waiting for its pre-read; hiding the page writes now.
		handle.flush();
		expect(sync.sets).toEqual([{ ai_prompt_context: { v: 1, text: 'Queued' } }]);
		await settle();
		expect(sync.sets).toHaveLength(1);
		expect(sync.data.ai_prompt_context).toEqual({ v: 1, text: 'Queued' });
	});

	test('nothing is written on hide when there is no unsaved edit', async () => {
		const { sync, handle } = await section({ promptContext: 'kept' });
		handle.flush();
		handle.dispose();
		await settle();
		expect(sync.sets).toEqual([]);
	});

	test('a change from another context does not overwrite what is being typed', async () => {
		const { sync } = await section({ promptContext: 'old' }, 10_000);
		textarea().focus();
		textarea().value = 'typing';
		textarea().dispatchEvent(new Event('input'));

		await sync.set({ ai_prompt_context: { v: 1, text: 'other tab' } });
		await settle();
		expect(textarea().value).toBe('typing');

		textarea().blur();
		await sync.set({ ai_prompt_context: { v: 1, text: 'other tab again' } });
		await settle();
		// The edit is still waiting to be saved, so it is kept.
		expect(textarea().value).toBe('typing');
	});
});
