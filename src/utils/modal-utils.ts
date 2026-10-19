import { getFocusableElements, trapFocus } from './focus-trap';

export interface ShowModalOptions {
	/**
	 * Runs once when the modal closes by any path: `hideModal`, Escape, or a click on the backdrop.
	 * Use it for cleanup that must happen on every close, such as clearing a secret field.
	 */
	onHide?: () => void;
	/**
	 * Treats the modal's `.modal` box as a modal dialog: focus moves into it on open, Tab and
	 * Shift+Tab stay inside it, and focus returns to the opener when it closes.
	 */
	trapFocus?: boolean;
	/**
	 * Where focus returns on close, for `trapFocus`. Defaults to the element focused when the
	 * modal opened; a function is resolved on close, for openers that may have been re-rendered.
	 */
	returnFocus?: HTMLElement | null | (() => HTMLElement | null | undefined);
}

interface ModalState {
	onKeydown: (event: KeyboardEvent) => void;
	onBackdropClick: () => void;
	backdrop: Element | null;
	options: ShowModalOptions;
	opener: HTMLElement | null;
}

const modalStates = new WeakMap<HTMLElement, ModalState>();

function detach(modal: HTMLElement, state: ModalState): void {
	modal.ownerDocument.removeEventListener('keydown', state.onKeydown);
	state.backdrop?.removeEventListener('click', state.onBackdropClick);
	modalStates.delete(modal);
}

function returnFocusTarget(state: ModalState): HTMLElement | null {
	const option = state.options.returnFocus;
	const target = typeof option === 'function' ? option() : option !== undefined ? option : state.opener;
	return target?.isConnected ? target : null;
}

export function showModal(modal: HTMLElement | null, options: ShowModalOptions = {}): void {
	if (!modal) return;
	const doc = modal.ownerDocument;
	const previous = modalStates.get(modal);
	// Showing an open modal again replaces its listeners; its opener is kept.
	if (previous) detach(modal, previous);
	const active = doc.activeElement as HTMLElement | null;
	const opener = previous?.opener ?? (active && !modal.contains(active) ? active : null);

	modal.style.display = 'flex';
	const dialog = (modal.querySelector('.modal') as HTMLElement | null) ?? modal;
	const state: ModalState = {
		onKeydown: event => {
			if (event.key === 'Escape') {
				hideModal(modal);
				return;
			}
			if (options.trapFocus) trapFocus(event, dialog);
		},
		onBackdropClick: () => hideModal(modal),
		backdrop: modal.querySelector('.modal-bg'),
		options,
		opener
	};
	modalStates.set(modal, state);
	state.backdrop?.addEventListener('click', state.onBackdropClick);
	doc.addEventListener('keydown', state.onKeydown);

	if (options.trapFocus && !dialog.contains(doc.activeElement)) {
		(getFocusableElements(dialog)[0] ?? dialog).focus();
	}
}

export function hideModal(modal: HTMLElement | null): void {
	if (!modal) return;
	modal.style.display = 'none';

	const state = modalStates.get(modal);
	if (state) {
		detach(modal, state);
		state.options.onHide?.();
		if (state.options.trapFocus) {
			const doc = modal.ownerDocument;
			const target = returnFocusTarget(state);
			if (target && (!doc.activeElement || doc.activeElement === doc.body || modal.contains(doc.activeElement))) {
				target.focus();
			}
		}
	}

	// Clear the textarea content
	const textarea = modal.querySelector('#import-json-textarea') as HTMLTextAreaElement;
	if (textarea) {
		textarea.value = '';
	}
}
