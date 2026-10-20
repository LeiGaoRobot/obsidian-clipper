// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../utils/browser-polyfill', () => ({
	default: { runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) } }
}));

vi.mock('../../utils/i18n', () => ({
	getMessage: (key: string, substitutions?: string | string[]) => substitutions
		? `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
		: key
}));

import browser from '../../utils/browser-polyfill';
import { AiError } from '../../ai/errors';
import { createLearningCard, readerIncompleteError } from './card';
import { captureTrustedClicks, flushPromises } from './test-support';
import type { TranscriptLanguageLearning } from './types';

const RETRY_BUTTON = '.ai-error-card-action[data-action="retry"]';

function tools(overrides: Partial<TranscriptLanguageLearning> = {}): TranscriptLanguageLearning {
	return {
		translateTranscript: vi.fn(),
		annotateJapaneseTranscript: vi.fn(),
		explainSelection: vi.fn(),
		...overrides
	};
}

describe('Reader learning card', () => {
	let clicks: ReturnType<typeof captureTrustedClicks>;
	let wiring: AbortController;

	beforeEach(() => {
		document.body.innerHTML = '<main><button id="trigger">Trigger</button></main>';
		vi.mocked(browser.runtime.sendMessage).mockClear();
		clicks = captureTrustedClicks();
		wiring = new AbortController();
	});

	afterEach(() => {
		wiring.abort();
		clicks.restore();
	});

	test('Retry ignores a synthetic click and runs the retry after a trusted one', async () => {
		const card = createLearningCard({ doc: document, tools: tools(), signal: wiring.signal });
		const retry = vi.fn();

		card.showError('transcript', 'readerBilingualSubtitles', new AiError('network', { task: 'translate' }), {
			task: 'translate',
			retry
		});
		const button = document.querySelector(RETRY_BUTTON) as HTMLButtonElement;
		button.click();
		expect(retry).not.toHaveBeenCalled();

		await clicks.click(button);
		expect(retry).toHaveBeenCalledOnce();
	});

	test('labels Retry as Continue remaining when the failed run completed some work', () => {
		const card = createLearningCard({ doc: document, tools: tools(), signal: wiring.signal });

		card.showError('transcript', 'readerBilingualSubtitles', new AiError('timeout', { task: 'translate' }), {
			task: 'translate',
			progress: { completed: 3, total: 5 },
			retry: vi.fn()
		});

		expect(document.querySelector(RETRY_BUTTON)?.textContent).toBe('readerContinueRemaining:3,5');
		expect(document.querySelector('.language-learning-card')?.classList.contains('is-error')).toBe(true);
	});

	test('Open AI settings sends the runtime message only for a trusted click', async () => {
		const card = createLearningCard({ doc: document, tools: tools(), signal: wiring.signal });

		card.showError('explain', 'Hello', new AiError('credential-missing', { task: 'explain' }), {
			task: 'explain',
			retry: vi.fn()
		});
		const button = document.querySelector('.ai-error-card-action[data-action="openSettings"]') as HTMLButtonElement;
		expect(button.textContent).toBe('aiErrorActionOpenSettings');
		button.click();
		expect(browser.runtime.sendMessage).not.toHaveBeenCalled();

		await clicks.click(button);
		expect(browser.runtime.sendMessage).toHaveBeenCalledWith({ action: 'openOptionsPage', section: 'ai' });
	});

	test('a missing CLI host leads to Settings, where the install guide lives', () => {
		const card = createLearningCard({ doc: document, tools: tools(), signal: wiring.signal });

		card.showError('transcript', 'readerBilingualSubtitles', new AiError('host-missing', { task: 'translate' }), {
			task: 'translate',
			retry: vi.fn()
		});

		const actions = Array.from(document.querySelectorAll<HTMLElement>('.ai-error-card-action'), button => button.dataset.action);
		expect(actions).toEqual(['openSettings', 'retry']);
	});

	test('shows the Reader message for its own incomplete-result check', () => {
		const card = createLearningCard({ doc: document, tools: tools(), signal: wiring.signal });

		card.showError('transcript', 'readerBilingualSubtitles', readerIncompleteError('readerTranslationIncomplete', 'translate'), {
			task: 'translate',
			retry: vi.fn()
		});

		expect(document.querySelector('.ai-error-card-title')?.textContent).toBe('aiErrorIncompleteTitle');
		expect(document.querySelector('.ai-error-card-body')?.textContent).toBe('readerTranslationIncomplete');
		expect(document.querySelector('.ai-error-card-detail')).toBeNull();
	});

	test('the profile switch lists profile names under their connection, as Settings routing does', async () => {
		const card = createLearningCard({
			doc: document,
			tools: tools({
				listProfiles: vi.fn().mockResolvedValue([
					{ id: 'fast', label: 'Mock OpenAI-compatible · Mock fast', name: 'Mock fast', group: 'Mock OpenAI-compatible', kind: 'openai-compatible' },
					{ id: 'large', label: 'Mock OpenAI-compatible · Mock large', name: 'Mock large', group: 'Mock OpenAI-compatible', kind: 'openai-compatible' },
					{ id: 'codex', label: 'Codex CLI', name: 'Codex CLI', group: 'Codex CLI', kind: 'cli-codex' }
				]),
				setTaskProfile: vi.fn()
			}),
			signal: wiring.signal
		});

		card.showError('transcript', 'readerBilingualSubtitles', new AiError('quota', { task: 'translate', profileId: 'large' }), {
			task: 'translate',
			retry: vi.fn()
		});
		await flushPromises();

		const select = document.querySelector('.ai-error-card-profile-select') as HTMLSelectElement;
		expect(Array.from(select.querySelectorAll('optgroup'), group => [
			group.label,
			Array.from(group.querySelectorAll('option'), option => option.textContent)
		])).toEqual([
			['Mock OpenAI-compatible', ['Mock fast', 'Mock large']],
			['Codex CLI', ['Codex CLI']]
		]);
		expect(select.value).toBe('large');
	});

	test('a failed profile switch reports the failure and does not retry', async () => {
		const setTaskProfile = vi.fn().mockRejectedValue(new Error('not set up'));
		const card = createLearningCard({
			doc: document,
			tools: tools({
				listProfiles: vi.fn().mockResolvedValue([{ id: 'model-b', label: 'OpenAI · B', kind: 'openai-compatible' }]),
				setTaskProfile
			}),
			signal: wiring.signal
		});
		const retry = vi.fn();

		card.showError('transcript', 'readerJapaneseReadings', new AiError('quota', { task: 'reading' }), {
			task: 'reading',
			retry
		});
		await flushPromises();
		await clicks.click(document.querySelector('.ai-error-card-action[data-action="switchProfile"]'));

		expect(setTaskProfile).toHaveBeenCalledWith('reading', 'model-b');
		expect(retry).not.toHaveBeenCalled();
		expect(document.querySelector('.language-learning-card-feedback')?.textContent).toBe('error');
	});

	test('Escape closes the card, restores the background, and returns focus', () => {
		const trigger = document.getElementById('trigger') as HTMLButtonElement;
		trigger.focus();
		const card = createLearningCard({ doc: document, tools: tools(), signal: wiring.signal });

		card.rememberReturnFocus();
		card.showMessage('explain', 'Hello', 'thinking');
		expect(card.owner).toBe('explain');
		expect(document.querySelector('main')?.hasAttribute('inert')).toBe(true);
		expect(document.activeElement?.classList.contains('language-learning-card-close')).toBe(true);

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		expect(card.element.style.display).toBe('none');
		expect(card.owner).toBeNull();
		expect(document.querySelector('main')?.hasAttribute('inert')).toBe(false);
		expect(document.activeElement).toBe(trigger);
	});

	test('an error is announced once, by the error card, and a later message by the live body', () => {
		const card = createLearningCard({ doc: document, tools: tools(), signal: wiring.signal });
		const body = document.querySelector('.language-learning-card-body') as HTMLElement;
		expect(body.getAttribute('aria-live')).toBe('polite');

		card.showError('explain', 'Hello', new AiError('network', { task: 'explain' }), { task: 'explain', retry: vi.fn() });
		expect(body.querySelector('.ai-error-card')?.getAttribute('role')).toBe('alert');
		expect(body.hasAttribute('aria-live')).toBe(false);

		card.showMessage('explain', 'Hello', 'thinking');
		expect(body.getAttribute('aria-live')).toBe('polite');
	});

	test('the user closing the card reports what it showed; a programmatic hide does not', () => {
		const onClose = vi.fn();
		const card = createLearningCard({ doc: document, tools: tools(), signal: wiring.signal, onClose });

		card.showMessage('explain', 'Hello', 'thinking');
		card.hide();
		expect(onClose).not.toHaveBeenCalled();

		card.showMessage('explain', 'Hello', 'thinking');
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(onClose).toHaveBeenLastCalledWith('explain');

		card.showMessage('transcript', 'readerBilingualSubtitles', 'thinking');
		(document.querySelector('.language-learning-card-close') as HTMLButtonElement).click();
		expect(onClose).toHaveBeenLastCalledWith('transcript');
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	test('a cancellable message offers Cancel, which closes the card', () => {
		const onClose = vi.fn();
		const card = createLearningCard({ doc: document, tools: tools(), signal: wiring.signal, onClose });
		const cancel = document.querySelector('.language-learning-card-cancel') as HTMLButtonElement;

		card.showMessage('explain', 'Hello', 'thinking');
		expect(cancel.hidden).toBe(true);

		card.showMessage('explain', 'Hello', 'thinking', { cancellable: true });
		expect(cancel.hidden).toBe(false);
		expect(cancel.textContent).toBe('cancel');
		cancel.click();

		expect(card.element.style.display).toBe('none');
		expect(cancel.hidden).toBe(true);
		expect(onClose).toHaveBeenCalledWith('explain');
	});

	test('an explanation that arrives after the card changed view is not shown', async () => {
		const card = createLearningCard({ doc: document, tools: tools(), signal: wiring.signal });
		const selection = { kind: 'word' as const, text: 'Hello', context: 'Hello world.' };

		card.showMessage('explain', 'Hello', 'thinking');
		card.hide();
		await card.showExplanation(selection, 'a greeting');

		expect(document.querySelector('.language-learning-card-body')?.textContent).toBe('thinking');
		expect((document.querySelector('.language-learning-card-copy') as HTMLElement).hidden).toBe(true);
	});
});
