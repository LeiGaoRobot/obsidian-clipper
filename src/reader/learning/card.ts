import browser from '../../utils/browser-polyfill';
import { getMessage } from '../../utils/i18n';
import type { LearningSelection } from '../../utils/language-learning';
import { renderLanguageLearningCenter } from '../../utils/language-learning-center';
import { trapFocus } from '../../utils/focus-trap';
import { AiError } from '../../ai/errors';
import { describeAiError, type AiErrorDescription } from '../../ai/error-messages';
import { renderAiErrorCard, type AiErrorCardHandler } from '../../ai/ui/error-card';
import type { ReaderAiTask, TranscriptLanguageLearning, TranscriptProfileOption } from './types';

// The Reader's learning card: a modal dialog in the host page's document (inert background, focus
// trap, Escape, return focus) that shows an explanation with its actions, the Learning Center, or
// a failed request through the shared AI error card. The page can script this document, so every
// card control that can start model work or change settings ignores untrusted clicks.

/** What the card currently shows; null while it is closed. */
export type LearningCardOwner = 'explain' | 'transcript' | 'center';

export interface LearningCardErrorOptions {
	/** The flow's own task, for an error that names none. */
	task: ReaderAiTask;
	/** The profile to preselect when the error names none. */
	profileId?: string;
	/** The failed run's last progress, which relabels Retry as Continue remaining. */
	progress?: { completed: number; total: number };
	/** Runs the failed request again; called only after a trusted click. */
	retry: () => void;
	/** Called once Switch and retry has routed the task to `option`, before the retry. */
	onProfileSwitched?: (option: TranscriptProfileOption) => void;
}

/** A profile as the error card's switch lists it: its own name, under its connection's name. */
function toSelectProfile(option: TranscriptProfileOption): { id: string; label: string; group?: string } {
	return {
		id: option.id,
		label: option.name ?? option.label,
		...(option.group !== undefined ? { group: option.group } : {})
	};
}

export interface LearningCard {
	element: HTMLElement;
	readonly owner: LearningCardOwner | null;
	/** Where focus returns when the card closes; kept only while the card is closed. */
	rememberReturnFocus(preferred?: HTMLElement | null): void;
	/**
	 * Shows `body` as plain text under `title`; `cancellable` adds a Cancel button, which closes the
	 * card as the close button does.
	 */
	showMessage(owner: LearningCardOwner, title: string, body: string, options?: { cancellable?: boolean }): void;
	/** Fills the explanation card and its actions; does nothing once another view took the card. */
	showExplanation(selection: LearningSelection, explanation: string): Promise<void>;
	showError(owner: LearningCardOwner, title: string, error: AiError, options: LearningCardErrorOptions): void;
	showCenter(): Promise<void>;
	hide(): void;
}

export interface LearningCardOptions {
	doc: Document;
	tools: TranscriptLanguageLearning;
	/** Aborted when the Reader rewires or navigates; restores the background and drops late work. */
	signal: AbortSignal;
	/**
	 * Called after the user closed the card (close button, Escape, or Cancel) with what it showed.
	 * The modal card makes the page's task bar unreachable, so closing is how its request is stopped.
	 */
	onClose?: (owner: LearningCardOwner) => void;
}

const READER_TASKS: readonly ReaderAiTask[] = ['translate', 'reading', 'explain'];
const readerMessages = new WeakMap<AiError, string>();

function isReaderAiTask(value: unknown): value is ReaderAiTask {
	return READER_TASKS.includes(value as ReaderAiTask);
}

/**
 * The Reader's own alignment check failed: the model left segments out. The card shows the
 * Reader's localized message as the body instead of the generic incomplete copy.
 */
export function readerIncompleteError(messageKey: string, task: ReaderAiTask): AiError {
	const message = getMessage(messageKey);
	const error = new AiError('incomplete', { detail: message, task });
	readerMessages.set(error, message);
	return error;
}

function describeReaderError(error: AiError): AiErrorDescription {
	const description = describeAiError(error);
	const message = readerMessages.get(error);
	if (!message) return description;
	return { title: description.title, body: message, action: description.action };
}

/** Wraps a card handler so that a click synthesized by the host page does nothing. */
function trusted(handler: AiErrorCardHandler): AiErrorCardHandler {
	return (event, profileId) => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		return handler(event, profileId);
	};
}

function actionButton(doc: Document, className: string, label: string): HTMLButtonElement {
	const button = doc.createElement('button');
	button.type = 'button';
	button.className = `language-learning-card-action ${className}`;
	button.textContent = label;
	button.hidden = true;
	return button;
}

export function createLearningCard({ doc, tools, signal, onClose }: LearningCardOptions): LearningCard {
	const card = doc.createElement('aside');
	card.className = 'language-learning-card';
	card.setAttribute('role', 'dialog');
	card.setAttribute('aria-modal', 'true');
	card.setAttribute('tabindex', '-1');
	card.style.display = 'none';

	const header = doc.createElement('div');
	header.className = 'language-learning-card-header';
	const title = doc.createElement('strong');
	title.id = `language-learning-card-title-${Math.random().toString(36).slice(2)}`;
	card.setAttribute('aria-labelledby', title.id);
	const closeButton = doc.createElement('button');
	closeButton.type = 'button';
	closeButton.className = 'language-learning-card-close';
	closeButton.textContent = '×';
	closeButton.setAttribute('aria-label', getMessage('close'));
	header.append(title, closeButton);

	const body = doc.createElement('div');
	body.className = 'language-learning-card-body';
	// Messages and explanations are announced as they change; an error card announces itself.
	const announceBody = (announce: boolean) => {
		if (announce) body.setAttribute('aria-live', 'polite');
		else body.removeAttribute('aria-live');
	};
	announceBody(true);
	const actions = doc.createElement('div');
	actions.className = 'language-learning-card-actions';
	const feedback = doc.createElement('span');
	feedback.className = 'language-learning-card-feedback';
	feedback.setAttribute('role', 'status');
	feedback.setAttribute('aria-live', 'polite');
	const favoriteButton = actionButton(doc, 'language-learning-card-favorite', getMessage('readerFavorite'));
	const copyButton = actionButton(doc, 'language-learning-card-copy', getMessage('copyToClipboard'));
	const saveButton = actionButton(doc, 'language-learning-card-save', getMessage('addToObsidian'));
	const cancelButton = actionButton(doc, 'language-learning-card-cancel', getMessage('cancel'));
	actions.append(feedback, favoriteButton, copyButton, saveButton, cancelButton);
	card.append(header, body, actions);
	doc.body.appendChild(card);

	let owner: LearningCardOwner | null = null;
	let returnFocus: HTMLElement | null = null;
	let currentExplanation: { selection: LearningSelection; explanation: string } | null = null;
	// Bumped by every view change, so a profile listing for an error no longer shown is dropped.
	let view = 0;

	const inertBackground = new Map<HTMLElement, boolean>();
	const setBackgroundInert = (inert: boolean) => {
		const HTMLElementConstructor = doc.defaultView?.HTMLElement;
		if (!HTMLElementConstructor) return;
		if (inert) {
			Array.from(doc.body.children).forEach(child => {
				if (!(child instanceof HTMLElementConstructor) || child === card) return;
				if (!inertBackground.has(child)) inertBackground.set(child, child.hasAttribute('inert'));
				child.setAttribute('inert', '');
			});
			return;
		}
		inertBackground.forEach((wasInert, element) => {
			if (!element.isConnected) return;
			if (wasInert) element.setAttribute('inert', '');
			else element.removeAttribute('inert');
		});
		inertBackground.clear();
	};
	signal.addEventListener('abort', () => setBackgroundInert(false), { once: true });

	const isOpen = () => card.style.display !== 'none';
	const open = () => {
		card.style.display = 'block';
		setBackgroundInert(true);
		closeButton.focus();
	};
	const hideExplanationActions = () => {
		currentExplanation = null;
		favoriteButton.hidden = true;
		copyButton.hidden = true;
		saveButton.hidden = true;
	};
	const rememberReturnFocus = (preferred?: HTMLElement | null) => {
		if (isOpen()) return;
		if (preferred?.isConnected) {
			returnFocus = preferred;
			return;
		}
		const activeElement = doc.activeElement;
		const HTMLElementConstructor = doc.defaultView?.HTMLElement;
		returnFocus = HTMLElementConstructor && activeElement instanceof HTMLElementConstructor && activeElement !== doc.body
			? activeElement
			: null;
	};
	const beginView = (nextOwner: LearningCardOwner, heading: string) => {
		view++;
		owner = nextOwner;
		title.textContent = heading;
		card.classList.remove('is-error');
		announceBody(true);
		hideExplanationActions();
		cancelButton.hidden = true;
	};
	const hide = () => {
		const focusTarget = returnFocus;
		view++;
		owner = null;
		card.style.display = 'none';
		setBackgroundInert(false);
		card.classList.remove('is-error');
		hideExplanationActions();
		cancelButton.hidden = true;
		feedback.textContent = '';
		returnFocus = null;
		if (focusTarget?.isConnected) focusTarget.focus();
	};
	/** The user closed the card; its owner then stops what the card was waiting for. */
	const close = () => {
		const closed = owner;
		hide();
		if (closed) onClose?.(closed);
	};

	const openSettings = trusted(() => {
		void browser.runtime.sendMessage({ action: 'openOptionsPage', section: 'ai' }).catch(() => {});
	});

	const showError = (nextOwner: LearningCardOwner, heading: string, error: AiError, options: LearningCardErrorOptions) => {
		rememberReturnFocus();
		beginView(nextOwner, heading);
		// The error card is `role="alert"`; a live body would announce it a second time.
		announceBody(false);
		const shown = view;
		const description = describeReaderError(error);
		// The runtime names the task that failed (a readings run can fail in its translate step).
		const task = isReaderAiTask(error.task) ? error.task : options.task;
		const selectedProfileId = error.profileId ?? options.profileId;
		const retry = trusted(() => options.retry());
		const render = (profiles?: TranscriptProfileOption[]) => {
			const switchProfile = profiles && trusted(async (_event, profileId) => {
				const option = profiles.find(item => item.id === profileId);
				if (!option || !tools.setTaskProfile) return;
				const controls = Array.from(body.querySelectorAll<HTMLButtonElement>('.ai-error-card-action'));
				controls.forEach(control => { control.disabled = true; });
				try {
					await tools.setTaskProfile(task, option.id);
				} catch {
					feedback.textContent = getMessage('error');
					return;
				} finally {
					controls.forEach(control => { control.disabled = false; });
				}
				if (shown !== view || signal.aborted) return;
				options.onProfileSwitched?.(option);
				hide();
				options.retry();
			});
			renderAiErrorCard(body, description, {
				doc,
				handlers: { retry, openSettings, ...(switchProfile ? { switchProfile } : {}) },
				// Grouped by connection and named by profile, as Settings' routing lists them.
				...(profiles ? { profiles: profiles.map(toSelectProfile), selectedProfileId } : {}),
				...(options.progress ? { progress: options.progress } : {})
			});
		};
		render();
		card.classList.add('is-error');
		open();
		if (!tools.setTaskProfile || !tools.listProfiles) return;
		void tools.listProfiles().then(profiles => profiles, () => []).then(profiles => {
			if (shown !== view || signal.aborted || profiles.length === 0) return;
			render(profiles);
		});
	};

	favoriteButton.addEventListener('click', async event => {
		if (!event.isTrusted || !currentExplanation || !tools.toggleVocabularyFavorite) return;
		const favorite = await tools.toggleVocabularyFavorite(currentExplanation.selection, currentExplanation.explanation);
		favoriteButton.textContent = getMessage(favorite ? 'readerUnfavorite' : 'readerFavorite');
		feedback.textContent = getMessage(favorite ? 'readerFavoriteSaved' : 'readerFavoriteRemoved');
	});
	copyButton.addEventListener('click', async event => {
		if (!event.isTrusted || !currentExplanation || !tools.copyLearningText) return;
		const copied = await tools.copyLearningText([
			currentExplanation.selection.text,
			currentExplanation.explanation
		].join('\n\n'));
		feedback.textContent = getMessage(copied ? 'copied' : 'error');
	});
	saveButton.addEventListener('click', async event => {
		if (!event.isTrusted || !currentExplanation || !tools.saveVocabularyToObsidian) return;
		await tools.saveVocabularyToObsidian(currentExplanation.selection, currentExplanation.explanation);
		feedback.textContent = getMessage('readerSavedToObsidian');
	});
	closeButton.addEventListener('click', close);
	cancelButton.addEventListener('click', close);
	doc.addEventListener('keydown', event => {
		if (!isOpen()) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
			return;
		}
		trapFocus(event, card);
	}, { signal });

	return {
		element: card,
		get owner() {
			return owner;
		},
		rememberReturnFocus,
		showMessage(nextOwner, heading, message, options = {}) {
			beginView(nextOwner, heading);
			body.textContent = message;
			cancelButton.hidden = !options.cancellable;
			feedback.textContent = '';
			open();
		},
		async showExplanation(selection, explanation) {
			if (owner !== 'explain') return;
			body.textContent = explanation;
			cancelButton.hidden = true;
			currentExplanation = { selection, explanation };
			copyButton.hidden = !tools.copyLearningText;
			saveButton.hidden = !tools.saveVocabularyToObsidian;
			favoriteButton.hidden = !tools.toggleVocabularyFavorite;
			if (tools.isVocabularyFavorite && tools.toggleVocabularyFavorite) {
				const favorite = await tools.isVocabularyFavorite(selection);
				if (currentExplanation?.selection !== selection) return;
				favoriteButton.textContent = getMessage(favorite ? 'readerUnfavorite' : 'readerFavorite');
			}
		},
		showError,
		async showCenter() {
			rememberReturnFocus();
			beginView('center', getMessage('readerLearningCenter'));
			body.replaceChildren();
			const center = renderLanguageLearningCenter({
				doc,
				container: body,
				tools,
				onFeedback: message => { feedback.textContent = message; }
			});
			await center.ready;
			if (signal.aborted || !card.isConnected) return;
			open();
		},
		hide
	};
}
