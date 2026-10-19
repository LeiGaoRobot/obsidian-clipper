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
