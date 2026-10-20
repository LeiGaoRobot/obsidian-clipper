// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest';
import { describeAiError } from '../ai/error-messages';
import { AiError } from '../ai/errors';
import { resolveProfile } from '../ai/resolve';
import { deriveAiSettings } from '../ai/settings-view';
import type { NativeMessagingSupport } from '../ai/types';
import type { V1AiSettings, V1ModelConfig, V1Provider } from '../ai/migrate';
import {
	initializeLanguageLearningPopup,
	isLanguageLearningPopupAvailable
} from './language-learning-popup';

const apiProvider: V1Provider = {
	id: 'provider-1',
	name: 'OpenAI',
	baseUrl: 'https://api.openai.com/v1/chat/completions',
	apiKey: 'sk-test',
	apiKeyRequired: true
};
const apiModel: V1ModelConfig = { id: 'model-1', providerId: 'provider-1', providerModelId: 'gpt', name: 'GPT', enabled: true };

// Views are built from v1 settings exactly as the loader derives them until v2 is stored.
function v1View(overrides: Partial<V1AiSettings> = {}, nativeMessaging: NativeMessagingSupport = 'port') {
	return deriveAiSettings({
		interpreterEnabled: true,
		interpreterAutoRun: false,
		interpreterExecutionMode: 'api',
		interpreterModel: 'model-1',
		defaultPromptContext: '',
		providers: [apiProvider],
		models: [apiModel],
		readerSettings: {},
		...overrides
	} as V1AiSettings, { nativeMessaging });
}

function createPopupFixture() {
	document.body.innerHTML = `
		<section id="language-learning-tools" style="display:none">
			<select id="ai-edit-preset"><option value="bilingual" selected>Bilingual</option></select>
			<textarea id="ai-edit-instruction"></textarea>
			<button id="ai-edit-preview-btn">Preview</button>
			<button id="ai-edit-undo-btn" disabled>Undo</button>
			<div id="ai-edit-preview" style="display:none">
				<pre id="ai-edit-preview-content"></pre>
				<button id="ai-edit-apply-btn">Apply</button>
				<button id="ai-edit-cancel-btn">Cancel</button>
			</div>
			<button id="ai-edit-cancel-request-btn" hidden>Cancel request</button>
			<div id="ai-edit-status"></div>
			<div id="ai-edit-error" hidden></div>
		</section>
		<textarea id="note-content-field">Before difficult after.</textarea>
	`;
	return {
		content: document.getElementById('note-content-field') as HTMLTextAreaElement,
		previewButton: document.getElementById('ai-edit-preview-btn') as HTMLButtonElement,
		applyButton: document.getElementById('ai-edit-apply-btn') as HTMLButtonElement,
			cancelButton: document.getElementById('ai-edit-cancel-btn') as HTMLButtonElement,
			cancelRequestButton: document.getElementById('ai-edit-cancel-request-btn') as HTMLButtonElement,
		undoButton: document.getElementById('ai-edit-undo-btn') as HTMLButtonElement,
			preview: document.getElementById('ai-edit-preview') as HTMLElement,
			previewContent: document.getElementById('ai-edit-preview-content') as HTMLElement,
			instruction: document.getElementById('ai-edit-instruction') as HTMLTextAreaElement,
			status: document.getElementById('ai-edit-status') as HTMLElement,
			errorCard: document.getElementById('ai-edit-error') as HTMLElement
	};
}

describe('Language learning popup', () => {
	test('is available in CLI modes without an enabled API model', () => {
		for (const mode of ['grok', 'codex'] as const) {
			expect(isLanguageLearningPopupAvailable(v1View({ models: [], interpreterExecutionMode: mode }))).toBe(true);
		}
		expect(isLanguageLearningPopupAvailable(v1View({ models: [], interpreterExecutionMode: 'api' }))).toBe(false);
		expect(isLanguageLearningPopupAvailable(v1View({
			models: [],
			interpreterEnabled: false,
			interpreterExecutionMode: 'grok'
		}))).toBe(false);
	});

	test('is available when the edit task resolves to a profile', () => {
		expect(isLanguageLearningPopupAvailable(v1View())).toBe(true);
	});

	test('is unavailable when AI is disabled', () => {
		expect(isLanguageLearningPopupAvailable(v1View({ interpreterEnabled: false }))).toBe(false);
	});

	test('is unavailable without a profile for the edit task', () => {
		const view = v1View({ models: [{ ...apiModel, enabled: false }] });
		expect(view.routing.defaultProfileId).toBeUndefined();
		expect(isLanguageLearningPopupAvailable(view)).toBe(false);
	});

	test('stays available when the key is missing on this device', () => {
		const view = v1View({ providers: [{ ...apiProvider, apiKey: '' }] });
		expect(resolveProfile(view, 'edit')).toMatchObject({ ok: false, error: { code: 'credential-missing' } });
		expect(isLanguageLearningPopupAvailable(view)).toBe(true);
	});

	test('stays available when the browser cannot reach the CLI host', () => {
		const view = v1View({ interpreterExecutionMode: 'codex' }, 'none');
		expect(resolveProfile(view, 'edit')).toMatchObject({ ok: false, error: { code: 'host-unsupported' } });
		expect(isLanguageLearningPopupAvailable(view)).toBe(true);
	});

	test('follows the edit route over the default profile', () => {
		const view = v1View();
		view.routing.taskProfiles.edit = 'missing-profile';
		expect(isLanguageLearningPopupAvailable(view)).toBe(false);
	});

	test('previews, applies, undoes, and cancels a selected-text AI edit', async () => {
		const fixture = createPopupFixture();
		const transformContent = vi.fn().mockResolvedValue('simple');
		initializeLanguageLearningPopup({
			enabled: true,
			transformContent,
			getMessage: key => `message:${key}`
		});
		fixture.content.setSelectionRange(7, 16);

		expect(fixture.instruction.value).toBe('message:aiEditInstructionBilingual');
		fixture.previewButton.click();
		await vi.waitFor(() => expect(transformContent).toHaveBeenCalledOnce());
			expect(transformContent).toHaveBeenCalledWith(
				'difficult',
				'message:aiEditInstructionBilingual',
				expect.any(AbortSignal)
			);
		await vi.waitFor(() => expect(fixture.previewContent.textContent).toBe('simple'));
		expect(fixture.preview.style.display).toBe('block');

		fixture.applyButton.click();
		expect(fixture.content.value).toBe('Before simple after.');
		expect(fixture.undoButton.disabled).toBe(false);

		fixture.undoButton.click();
		expect(fixture.content.value).toBe('Before difficult after.');
		expect(fixture.undoButton.disabled).toBe(true);

		fixture.previewButton.click();
		await vi.waitFor(() => expect(transformContent).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(fixture.preview.style.display).toBe('block'));
		fixture.cancelButton.click();
		expect(fixture.preview.style.display).toBe('none');
		expect(fixture.content.value).toBe('Before difficult after.');
		});

	test('cancels an in-flight AI edit request', async () => {
		const fixture = createPopupFixture();
		const transformContent = vi.fn((_content: string, _instruction: string, signal?: AbortSignal) => new Promise<string>((_, reject) => {
			signal?.addEventListener('abort', () => reject(new AiError('cancelled')), { once: true });
		}));
		initializeLanguageLearningPopup({
			enabled: true,
			transformContent,
			getMessage: key => key
		});

		fixture.previewButton.click();
		expect(fixture.cancelRequestButton.hidden).toBe(false);
		fixture.cancelRequestButton.click();
		await vi.waitFor(() => expect(fixture.status.textContent).toBe('aiRequestCancelled'));
		expect(fixture.cancelRequestButton.hidden).toBe(true);
	});

	test('shows a model error in the error card, and a cancelled code as cancelled without a card', async () => {
		const fixture = createPopupFixture();
		const auth = new AiError('auth', { status: 401, detail: 'invalid key', task: 'edit' });
		const transformContent = vi.fn()
			.mockRejectedValueOnce(auth)
			.mockRejectedValueOnce(new AiError('cancelled', { task: 'edit' }));
		const openSettings = vi.fn();
		initializeLanguageLearningPopup({
			enabled: true,
			transformContent,
			getMessage: key => key,
			openSettings
		});

		fixture.previewButton.click();
		await vi.waitFor(() => expect(fixture.errorCard.hidden).toBe(false));
		const description = describeAiError(auth);
		expect(fixture.errorCard.querySelector('.ai-error-card-title')?.textContent).toBe(description.title);
		expect(fixture.errorCard.querySelector('.ai-error-card-body')?.textContent).toBe(description.body);
		expect(fixture.errorCard.querySelector('.ai-error-card-detail')?.textContent).toContain('invalid key');
		expect(cardActions(fixture.errorCard)).toEqual(['openSettings', 'retry']);
		expect(fixture.status.textContent).toBe('');
		cardAction(fixture.errorCard, 'openSettings').click();
		expect(openSettings).toHaveBeenCalledOnce();

		fixture.previewButton.click();
		expect(fixture.errorCard.hidden).toBe(true);
		await vi.waitFor(() => expect(fixture.status.textContent).toBe('aiRequestCancelled'));
		expect(fixture.status.classList.contains('is-error')).toBe(false);
		expect(fixture.errorCard.hidden).toBe(true);
		expect(fixture.errorCard.childElementCount).toBe(0);
	});

	test('Retry sends the same content and instruction again and previews against the same source', async () => {
		const fixture = createPopupFixture();
		const transformContent = vi.fn()
			.mockRejectedValueOnce(new AiError('network', { task: 'edit' }))
			.mockResolvedValueOnce('simple');
		initializeLanguageLearningPopup({ enabled: true, transformContent, getMessage: key => key });
		fixture.content.setSelectionRange(7, 16);

		fixture.previewButton.click();
		await vi.waitFor(() => expect(fixture.errorCard.hidden).toBe(false));
		// The selection may move before Retry; the request and its target stay as they were.
		fixture.content.setSelectionRange(0, 0);
		cardAction(fixture.errorCard, 'retry').click();
		expect(fixture.errorCard.hidden).toBe(true);
		await vi.waitFor(() => expect(fixture.preview.style.display).toBe('block'));

		expect(transformContent).toHaveBeenCalledTimes(2);
		expect(transformContent.mock.calls[1].slice(0, 2)).toEqual(['difficult', 'aiEditInstructionBilingual']);
		expect(transformContent.mock.calls[1][2]).not.toBe(transformContent.mock.calls[0][2]);
		fixture.applyButton.click();
		expect(fixture.content.value).toBe('Before simple after.');
	});

	test('Retry after the note changed sends nothing and says the content changed', async () => {
		const fixture = createPopupFixture();
		const transformContent = vi.fn().mockRejectedValueOnce(new AiError('network', { task: 'edit' }));
		initializeLanguageLearningPopup({ enabled: true, transformContent, getMessage: key => key });

		fixture.previewButton.click();
		await vi.waitFor(() => expect(fixture.errorCard.hidden).toBe(false));
		fixture.content.value = 'Edited by hand.';
		cardAction(fixture.errorCard, 'retry').click();

		expect(transformContent).toHaveBeenCalledOnce();
		expect(fixture.status.textContent).toBe('aiEditContentChanged');
		expect(fixture.status.classList.contains('is-error')).toBe(true);
		expect(fixture.errorCard.hidden).toBe(true);
		expect(fixture.preview.style.display).toBe('none');
		expect(fixture.previewButton.disabled).toBe(false);
	});

	test('shows an empty response as an error card', async () => {
		const fixture = createPopupFixture();
		initializeLanguageLearningPopup({ enabled: true, transformContent: vi.fn().mockResolvedValue('  '), getMessage: key => key });

		fixture.previewButton.click();

		await vi.waitFor(() => expect(fixture.errorCard.hidden).toBe(false));
		expect(fixture.errorCard.querySelector('.ai-error-card-detail')?.textContent).toContain('emptyResponse');
		expect(fixture.preview.style.display).toBe('none');
	});

	test('ignores a stale result that settles after a newer preview started', async () => {
		const fixture = createPopupFixture();
		let resolveFirst!: (value: string) => void;
		let resolveSecond!: (value: string) => void;
		const transformContent = vi.fn()
			.mockImplementationOnce(() => new Promise<string>(resolve => { resolveFirst = resolve; }))
			.mockImplementationOnce(() => new Promise<string>(resolve => { resolveSecond = resolve; }));
		initializeLanguageLearningPopup({ enabled: true, transformContent, getMessage: key => key });

		fixture.previewButton.click();
		fixture.cancelRequestButton.click();
		await vi.waitFor(() => expect(fixture.status.textContent).toBe('aiRequestCancelled'));
		fixture.previewButton.click();
		expect(transformContent).toHaveBeenCalledTimes(2);

		resolveFirst('stale');
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fixture.preview.style.display).toBe('none');
		expect(fixture.status.textContent).toBe('thinking');

		resolveSecond('fresh');
		await vi.waitFor(() => expect(fixture.previewContent.textContent).toBe('fresh'));
		expect(fixture.previewButton.disabled).toBe(false);
	});
});

function cardActions(card: HTMLElement): string[] {
	return Array.from(card.querySelectorAll<HTMLElement>('.ai-error-card-action'), button => button.dataset.action ?? '');
}

function cardAction(card: HTMLElement, action: string): HTMLButtonElement {
	return card.querySelector(`.ai-error-card-action[data-action="${action}"]`) as HTMLButtonElement;
}
