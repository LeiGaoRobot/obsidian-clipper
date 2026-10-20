import { describeAiError } from '../ai/error-messages';
import { AiError } from '../ai/errors';
import { resolveProfile } from '../ai/resolve';
import type { AiSettingsView } from '../ai/types';
import { createAiAction } from '../ai/ui/action';
import { clearAiErrorCard, renderAiErrorCard } from '../ai/ui/error-card';
import { replaceTextSelection } from './language-learning';

interface LanguageLearningPopupOptions {
	doc?: Document;
	enabled: boolean;
	transformContent: (content: string, instruction: string, signal?: AbortSignal) => Promise<string>;
	getMessage: (key: string) => string;
	/** The error card's Open AI settings. Without it the card offers Retry only. */
	openSettings?: () => void;
}

const AI_EDIT_PRESET_MESSAGE_KEYS: Record<string, string> = {
	bilingual: 'aiEditInstructionBilingual',
	simplify: 'aiEditInstructionSimplify',
	polish: 'aiEditInstructionPolish',
	'study-notes': 'aiEditInstructionStudyNotes'
};

/**
 * Whether the popup shows the AI edit tools: AI is on and `edit` resolves to a profile, or fails
 * only for a reason the tools' error card explains (a key missing on this device, or a CLI this
 * browser cannot reach).
 */
export function isLanguageLearningPopupAvailable(view: AiSettingsView): boolean {
	if (!view.enabled) return false;
	const resolved = resolveProfile(view, 'edit');
	return resolved.ok
		|| resolved.error.code === 'credential-missing'
		|| resolved.error.code === 'host-unsupported';
}

export function initializeLanguageLearningPopup({
	doc = document,
	enabled,
	transformContent,
	getMessage,
	openSettings
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
	const errorCard = doc.getElementById('ai-edit-error') as HTMLElement;
	if (!container || !noteContentField || !presetSelect || !instructionField || !previewButton
		|| !undoButton || !preview || !previewContent || !applyButton || !cancelButton || !cancelRequestButton || !status
		|| !errorCard) return;

	container.style.display = enabled ? 'block' : 'none';
	if (!enabled) return;

	interface EditSource {
		sourceValue: string;
		selectionStart: number;
		selectionEnd: number;
	}
	interface PendingEdit extends EditSource {
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
	// One request at a time; a settlement after a cancel or a newer request changes nothing.
	const action = createAiAction<string>();

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

	/** Shows one request's progress and outcome; `launch` starts it on the controller. */
	const runPreview = async (source: EditSource, launch: () => Promise<string | undefined>) => {
		clearAiErrorCard(errorCard);
		previewButton.disabled = true;
		previewButton.setAttribute('aria-busy', 'true');
		cancelRequestButton.hidden = false;
		showStatus(getMessage('thinking'));
		const output = await launch();
		// A newer request owns the controls now.
		if (action.state.status === 'running') return;
		previewButton.disabled = false;
		previewButton.removeAttribute('aria-busy');
		cancelRequestButton.hidden = true;

		const { state } = action;
		if (state.status === 'done' && output !== undefined) {
			pendingEdit = { ...source, output };
			previewContent.textContent = output;
			preview.style.display = 'block';
			showStatus('');
		} else if (state.status === 'error' && state.error) {
			showStatus('');
			renderAiErrorCard(errorCard, describeAiError(state.error), {
				handlers: {
					// The same content and instruction again, previewed against the same source. Once the
					// note has changed, that preview could never be applied, so nothing is sent.
					retry: () => {
						if (noteContentField.value !== source.sourceValue) {
							clearAiErrorCard(errorCard);
							showStatus(getMessage('aiEditContentChanged'), true);
							return;
						}
						void runPreview(source, () => action.retry());
					},
					...(openSettings ? { openSettings } : {})
				}
			});
		} else {
			showStatus(getMessage('aiRequestCancelled'));
		}
	};

	previewButton.addEventListener('click', () => {
		hidePreview();
		clearAiErrorCard(errorCard);
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

		void runPreview({ sourceValue, selectionStart, selectionEnd }, () => action.start(async signal => {
			const output = await transformContent(content, instruction, signal);
			if (!output.trim()) throw new AiError('bad-response', { task: 'edit', detail: getMessage('emptyResponse') });
			return output;
		}));
	});

	cancelRequestButton.addEventListener('click', () => {
		action.cancel();
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
