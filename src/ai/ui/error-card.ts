import { getMessage } from '../../utils/i18n';
import type { AiErrorAction, AiErrorDescription } from '../error-messages';

// The one AI error card (Phase 6, Decision 2): a description in, DOM out. The Reader appends it to
// the host page's document, so it builds plain elements through `doc.createElement` only: no icon
// module, no Settings helpers, no sanitizer. Its styles live in `styles/_ai-error-card.scss`, which
// both `style.scss` and `reader.scss` import.
//
// Handlers never check whether a click is trusted: a caller whose page can be scripted (the
// Reader) wraps each handler in its trusted-click check.

export type AiErrorCardAction = Exclude<AiErrorAction, 'none'>;

/** A control's click handler; `switchProfile` with `profiles` also gets the selected profile id. */
export type AiErrorCardHandler = (event: Event, profileId?: string) => void;

export type AiErrorCardIcon = 'alert' | 'dismiss';

export interface AiErrorCardOptions {
	doc?: Document;
	handlers?: Partial<Record<AiErrorCardAction, AiErrorCardHandler>>;
	/** The profiles for `switchProfile`'s select; without them the action is a plain button. */
	profiles?: { id: string; label: string }[];
	selectedProfileId?: string;
	/** Completed work, which relabels `retry` as Continue remaining (n of m). */
	progress?: { completed: number; total: number };
	onDismiss?: () => void;
	/** An element for the icon slots, e.g. Settings' Lucide placeholders; the Reader passes none. */
	icon?: (name: AiErrorCardIcon) => HTMLElement;
}

function element<K extends keyof HTMLElementTagNameMap>(
	doc: Document,
	tag: K,
	className?: string,
	text?: string
): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(doc: Document, action: AiErrorCardAction, label: string, onClick: (event: Event) => void): HTMLButtonElement {
	const control = element(doc, 'button', 'ai-error-card-action', label);
	control.type = 'button';
	control.dataset.action = action;
	control.addEventListener('click', onClick);
	return control;
}

/**
 * The action a card leads with. The install guide lives in Settings, so where no copy handler is
 * given (popup, Reader) `copyInstallCommand` leads to Settings instead.
 */
function primaryAction(action: AiErrorAction, handlers: AiErrorCardOptions['handlers'] = {}): AiErrorAction {
	if (action === 'copyInstallCommand' && !handlers.copyInstallCommand) return 'openSettings';
	return action;
}

function retryLabel(progress: AiErrorCardOptions['progress']): string {
	return progress && progress.completed > 0
		? getMessage('readerContinueRemaining', [String(progress.completed), String(progress.total)])
		: getMessage('aiErrorActionRetry');
}

/**
 * The card's controls, primary first: the description's action when a handler for it exists, then
 * Retry (always offered when a retry handler is given, since the cause may have been fixed
 * elsewhere), then the profile switch when profiles are given.
 */
function actionControls(doc: Document, description: AiErrorDescription, options: AiErrorCardOptions): HTMLElement[] {
	const handlers = options.handlers ?? {};
	const action = primaryAction(description.action, handlers);
	const retryHandler = handlers.retry;
	const profiles = options.profiles ?? [];
	const controls: HTMLElement[] = [];
	const retry = (handler: AiErrorCardHandler) => button(doc, 'retry', retryLabel(options.progress), event => handler(event));

	switch (action) {
		case 'retry':
			if (retryHandler) controls.push(retry(retryHandler));
			break;
		case 'continueRemaining': {
			const handler = handlers.continueRemaining ?? retryHandler;
			if (handler) controls.push(retry(handler));
			break;
		}
		case 'openSettings':
			if (handlers.openSettings) {
				controls.push(button(doc, 'openSettings', getMessage('aiErrorActionOpenSettings'), handlers.openSettings));
			}
			break;
		case 'copyInstallCommand':
			if (handlers.copyInstallCommand) {
				controls.push(button(doc, 'copyInstallCommand', getMessage('nativeCliInstallCopy'), handlers.copyInstallCommand));
			}
			break;
		case 'switchProfile':
			// With profiles the select below is the control; without them, a plain button.
			if (handlers.switchProfile && profiles.length === 0) {
				controls.push(button(doc, 'switchProfile', getMessage('aiErrorActionSwitchProfile'), handlers.switchProfile));
			}
			break;
	}

	const hasRetry = controls.some(control => control.dataset.action === 'retry');
	if (retryHandler && !hasRetry) controls.push(retry(retryHandler));

	const switchHandler = handlers.switchProfile;
	if (switchHandler && profiles.length > 0) {
		const group = element(doc, 'div', 'ai-error-card-switch');
		const select = element(doc, 'select', 'ai-error-card-profile-select');
		select.setAttribute('aria-label', getMessage('aiErrorSwitchProfileSelect'));
		select.append(...profiles.map(profile => {
			const option = element(doc, 'option', undefined, profile.label);
			option.value = profile.id;
			return option;
		}));
		select.value = profiles.some(profile => profile.id === options.selectedProfileId)
			? options.selectedProfileId as string
			: profiles[0].id;
		group.append(
			select,
			button(doc, 'switchProfile', getMessage('readerSwitchAndRetry'), event => switchHandler(event, select.value))
		);
		if (action === 'switchProfile') controls.unshift(group);
		else controls.push(group);
	}
	return controls;
}

/** Renders `description` into `container`, replacing what it held, and shows it. Returns the card. */
export function renderAiErrorCard(
	container: HTMLElement,
	description: AiErrorDescription,
	options: AiErrorCardOptions = {}
): HTMLElement {
	const doc = options.doc ?? container.ownerDocument;
	const card = element(doc, 'div', 'ai-error-card');
	card.setAttribute('role', 'alert');
	if (options.icon) {
		const iconSlot = element(doc, 'div', 'ai-error-card-icon');
		iconSlot.appendChild(options.icon('alert'));
		card.appendChild(iconSlot);
	}
	const content = element(doc, 'div', 'ai-error-card-content');
	content.append(
		element(doc, 'div', 'ai-error-card-title', description.title),
		element(doc, 'div', 'ai-error-card-body', description.body)
	);
	if (description.detail) {
		const details = element(doc, 'details', 'ai-error-card-detail');
		details.append(
			element(doc, 'summary', undefined, getMessage('aiErrorTechnicalDetails')),
			element(doc, 'code', undefined, description.detail)
		);
		content.appendChild(details);
	}
	const controls = actionControls(doc, description, options);
	if (controls.length > 0) {
		const actions = element(doc, 'div', 'ai-error-card-actions');
		actions.append(...controls);
		content.appendChild(actions);
	}
	card.appendChild(content);
	if (options.onDismiss) {
		const label = getMessage('close');
		const dismiss = element(doc, 'button', 'clickable-icon ai-error-card-dismiss');
		dismiss.type = 'button';
		dismiss.setAttribute('aria-label', label);
		dismiss.title = label;
		if (options.icon) dismiss.appendChild(options.icon('dismiss'));
		else dismiss.textContent = '×';
		dismiss.addEventListener('click', options.onDismiss);
		card.appendChild(dismiss);
	}
	container.replaceChildren(card);
	container.hidden = false;
	return card;
}

/** Empties and hides a card container. */
export function clearAiErrorCard(container: HTMLElement): void {
	container.replaceChildren();
	container.hidden = true;
}
