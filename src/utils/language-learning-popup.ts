import type { Settings } from '../types/types';
import { replaceTextSelection } from './language-learning';
import { isRequestCancelled } from './request-cancellation';

interface LanguageLearningPopupOptions {
	doc?: Document;
	enabled: boolean;
	transformContent: (content: string, instruction: string, signal?: AbortSignal) => Promise<string>;
	getMessage: (key: string) => string;
}

const AI_EDIT_PRESET_MESSAGE_KEYS: Record<string, string> = {
	bilingual: 'aiEditInstructionBilingual',
	simplify: 'aiEditInstructionSimplify',
	polish: 'aiEditInstructionPolish',
	'study-notes': 'aiEditInstructionStudyNotes'
};

export function isLanguageLearningPopupAvailable(
	settings: Pick<Settings, 'interpreterEnabled' | 'interpreterExecutionMode' | 'models'>
): boolean {
	if (!settings.interpreterEnabled) return false;
	return (settings.interpreterExecutionMode ?? 'api') !== 'api'
		|| settings.models.some(model => model.enabled);
}

export function initializeLanguageLearningPopup({
	doc = document,
	enabled,
	transformContent,
	getMessage
}: LanguageLearningPopupOptions): void {
	const container = doc.getElementById('language-learning-tools') as HTMLElement;
	const noteContentField = doc.getElementById('note-content-field') as HTMLTextAreaElement;
	const presetSelect = doc.getElementById('ai-edit-preset') as HTMLSelectElement;
	const instructionField = doc.getElementById('ai-edit-instruction') as HTMLTextAreaElement;
	const previewButton = doc.getElementById('ai-edit-preview-btn') as HTMLButtonElement;
	const undoButton = doc.getElementById('ai-edit-undo-btn') as HTMLButtonElement;
	const preview = doc.getElementById('ai-edit-preview') as HTMLElement;
	const previewContent = doc.getElementById('ai-edit-preview-content') as HTMLElement;
	const applyButton = doc.getElementById('ai-edit-apply-btn') as HTMLButtonElement;
	const cancelButton = doc.getElementById('ai-edit-cancel-btn') as HTMLButtonElement;
	const cancelRequestButton = doc.getElementById('ai-edit-cancel-request-btn') as HTMLButtonElement;
	const status = doc.getElementById('ai-edit-status') as HTMLElement;
	if (!container || !noteContentField || !presetSelect || !instructionField || !previewButton
		|| !undoButton || !preview || !previewContent || !applyButton || !cancelButton || !cancelRequestButton || !status) return;

	container.style.display = enabled ? 'block' : 'none';
	if (!enabled) return;

	interface PendingEdit {
		sourceValue: string;
		selectionStart: number;
		selectionEnd: number;
		output: string;
	}
	interface UndoEdit {
		beforeValue: string;
		afterValue: string;
		selectionStart: number;
		selectionEnd: number;
	}

	let pendingEdit: PendingEdit | null = null;
	let undoEdit: UndoEdit | null = null;
	let activeRequest: AbortController | null = null;

	const showStatus = (message: string, isError = false) => {
		status.textContent = message;
		status.classList.toggle('is-error', isError);
	};
	const hidePreview = () => {
		pendingEdit = null;
		preview.style.display = 'none';
		previewContent.textContent = '';
	};
	const updateInstruction = () => {
		const messageKey = AI_EDIT_PRESET_MESSAGE_KEYS[presetSelect.value];
		instructionField.value = messageKey ? getMessage(messageKey) : '';
	};

	presetSelect.addEventListener('change', () => {
		updateInstruction();
		instructionField.focus();
	});
	updateInstruction();

	previewButton.addEventListener('click', async () => {
		hidePreview();
		const sourceValue = noteContentField.value;
		const hasSelection = noteContentField.selectionEnd > noteContentField.selectionStart;
		const selectionStart = hasSelection ? noteContentField.selectionStart : 0;
		const selectionEnd = hasSelection ? noteContentField.selectionEnd : sourceValue.length;
		const content = sourceValue.slice(selectionStart, selectionEnd);
		const instruction = instructionField.value.trim();
		if (!content.trim() || !instruction) {
			showStatus(getMessage('aiEditMissingInput'), true);
			return;
		}

		previewButton.disabled = true;
		previewButton.setAttribute('aria-busy', 'true');
		cancelRequestButton.hidden = false;
		showStatus(getMessage('thinking'));
		const requestController = new AbortController();
		activeRequest = requestController;
		try {
			const output = await transformContent(content, instruction, requestController.signal);
			if (!output.trim()) throw new Error(getMessage('emptyResponse'));
			pendingEdit = { sourceValue, selectionStart, selectionEnd, output };
			previewContent.textContent = output;
			preview.style.display = 'block';
			showStatus('');
		} catch (error) {
			showStatus(
				isRequestCancelled(error) || requestController.signal.aborted
					? getMessage('aiRequestCancelled')
					: error instanceof Error ? error.message : getMessage('error'),
				!isRequestCancelled(error) && !requestController.signal.aborted
			);
		} finally {
			if (activeRequest === requestController) activeRequest = null;
			previewButton.disabled = false;
			previewButton.removeAttribute('aria-busy');
			cancelRequestButton.hidden = true;
		}
	});

	cancelRequestButton.addEventListener('click', () => {
		activeRequest?.abort();
	});

	applyButton.addEventListener('click', () => {
		if (!pendingEdit) return;
		if (noteContentField.value !== pendingEdit.sourceValue) {
			hidePreview();
			showStatus(getMessage('aiEditContentChanged'), true);
			return;
		}
		const result = replaceTextSelection(
			pendingEdit.sourceValue,
			pendingEdit.selectionStart,
			pendingEdit.selectionEnd,
			pendingEdit.output
		);
		undoEdit = {
			beforeValue: pendingEdit.sourceValue,
			afterValue: result.value,
			selectionStart: pendingEdit.selectionStart,
			selectionEnd: pendingEdit.selectionEnd
		};
		noteContentField.value = result.value;
		noteContentField.focus();
		noteContentField.setSelectionRange(result.selectionStart, result.selectionEnd);
		noteContentField.dispatchEvent(new Event('input', { bubbles: true }));
		undoButton.disabled = false;
		hidePreview();
		showStatus(getMessage('done'));
	});

	cancelButton.addEventListener('click', () => {
		hidePreview();
		showStatus('');
	});

	undoButton.addEventListener('click', () => {
		if (!undoEdit) return;
		if (noteContentField.value !== undoEdit.afterValue) {
			undoEdit = null;
			undoButton.disabled = true;
			showStatus(getMessage('aiEditContentChanged'), true);
			return;
		}
		noteContentField.value = undoEdit.beforeValue;
		noteContentField.focus();
		noteContentField.setSelectionRange(undoEdit.selectionStart, undoEdit.selectionEnd);
		noteContentField.dispatchEvent(new Event('input', { bubbles: true }));
		undoEdit = null;
		undoButton.disabled = true;
		showStatus('');
	});
}
