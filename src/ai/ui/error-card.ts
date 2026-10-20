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
	/**
	 * The profiles for `switchProfile`'s select; without them the action is a plain button. Profiles
	 * with a `group` (their connection's name) are listed under it, as Settings' routing does.
	 */
	profiles?: { id: string; label: string; group?: string }[];
	selectedProfileId?: string;
	/** Completed work, which relabels `retry` as Continue remaining (n of m). */
	progress?: { completed: number; total: number };
	onDismiss?: () => void;
	/** An element for the icon slots, e.g. Settings' Lucide placeholders; the Reader passes none. */
	icon?: (name: AiErrorCardIcon) => HTMLElement;
	/**
	 * `compact` fits a short bar, e.g. the popup's AI bar: Retry leads, and the explanation and any
	 * raw detail move behind a Details toggle. Without it the card renders as the Reader and
	 * Settings show it.
	 */
	variant?: 'default' | 'compact';
	/**
	 * Compact only: one line naming what failed, e.g. the connection and model, shown in place of
	 * the body, which then moves behind Details.
	 */
	source?: string;
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
		let optgroup: HTMLOptGroupElement | undefined;
		for (const profile of profiles) {
			const option = element(doc, 'option', undefined, profile.label);
			option.value = profile.id;
			if (profile.group === undefined) {
				optgroup = undefined;
				select.appendChild(option);
				continue;
			}
			if (optgroup?.label !== profile.group) {
				optgroup = element(doc, 'optgroup');
				optgroup.label = profile.group;
				select.appendChild(optgroup);
			}
			optgroup.appendChild(option);
		}
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

let compactDetailIds = 0;

/**
 * The compact card's content: title, one line (the source, else the body), then a row with Retry
 * first, the other actions, and a Details toggle for what did not fit: the body when the source
 * replaced it, and the raw detail.
 */
function compactContent(
	doc: Document,
	content: HTMLElement,
	description: AiErrorDescription,
	options: AiErrorCardOptions
): void {
	const source = options.source?.trim();
	const line = element(doc, 'div', 'ai-error-card-body', source || description.body);
	line.title = line.textContent ?? '';
	content.append(element(doc, 'div', 'ai-error-card-title', description.title), line);

	const controls = actionControls(doc, description, options);
	// Retry leads: the bar sits where the run was started, so running it again comes first.
	controls.sort((a, b) => Number(b.dataset.action === 'retry') - Number(a.dataset.action === 'retry'));
	const actions = element(doc, 'div', 'ai-error-card-actions');
	actions.append(...controls);

	const hiddenBody = source ? description.body : '';
	if (hiddenBody || description.detail) {
		const panel = element(doc, 'div', 'ai-error-card-detail');
		panel.id = `ai-error-card-detail-${++compactDetailIds}`;
		panel.hidden = true;
		if (hiddenBody) panel.appendChild(element(doc, 'p', 'ai-error-card-explanation', hiddenBody));
		if (description.detail) panel.appendChild(element(doc, 'code', undefined, description.detail));
		const toggle = element(doc, 'button', 'ai-error-card-details-toggle', getMessage('aiErrorDetails'));
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', 'false');
		toggle.setAttribute('aria-controls', panel.id);
		toggle.addEventListener('click', () => {
			panel.hidden = !panel.hidden;
			toggle.setAttribute('aria-expanded', String(!panel.hidden));
		});
		actions.appendChild(toggle);
		content.append(actions, panel);
	} else if (actions.childElementCount > 0) {
		content.appendChild(actions);
	}
}

/** Renders `description` into `container`, replacing what it held, and shows it. Returns the card. */
export function renderAiErrorCard(
	container: HTMLElement,
	description: AiErrorDescription,
	options: AiErrorCardOptions = {}
): HTMLElement {
	const doc = options.doc ?? container.ownerDocument;
	const compact = options.variant === 'compact';
	const card = element(doc, 'div', compact ? 'ai-error-card is-compact' : 'ai-error-card');
	card.setAttribute('role', 'alert');
	if (options.icon) {
		const iconSlot = element(doc, 'div', 'ai-error-card-icon');
		iconSlot.appendChild(options.icon('alert'));
		card.appendChild(iconSlot);
	}
	const content = element(doc, 'div', 'ai-error-card-content');
	if (compact) {
		compactContent(doc, content, description, options);
	} else {
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
