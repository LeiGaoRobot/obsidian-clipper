// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest';
import { initializeLanguageLearningPopup } from './language-learning-popup';

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
			status: document.getElementById('ai-edit-status') as HTMLElement
	};
}

describe('Language learning popup', () => {
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
		expect(fixture.previewContent.textContent).toBe('simple');
		expect(fixture.preview.style.display).toBe('block');

		fixture.applyButton.click();
		expect(fixture.content.value).toBe('Before simple after.');
		expect(fixture.undoButton.disabled).toBe(false);

		fixture.undoButton.click();
		expect(fixture.content.value).toBe('Before difficult after.');
		expect(fixture.undoButton.disabled).toBe(true);

		fixture.previewButton.click();
		await vi.waitFor(() => expect(transformContent).toHaveBeenCalledTimes(2));
		fixture.cancelButton.click();
		expect(fixture.preview.style.display).toBe('none');
		expect(fixture.content.value).toBe('Before difficult after.');
		});

	test('cancels an in-flight AI edit request', async () => {
		const fixture = createPopupFixture();
		const transformContent = vi.fn((_content: string, _instruction: string, signal?: AbortSignal) => new Promise<string>((_, reject) => {
			signal?.addEventListener('abort', () => reject(new Error('The request was cancelled.')), { once: true });
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
});
