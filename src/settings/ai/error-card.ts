import { describeAiError, type AiErrorAction } from '../../ai/error-messages';
import type { AiError } from '../../ai/errors';
import { isAiSettingsStorageError, type AiSettingsStorageError } from '../../ai/settings';
import { getMessage } from '../../utils/i18n';
import { AiSettingsBootstrapFailedError, AiSettingsItemMissingError, AiSettingsNotWritableError } from './controller';
import { createElement, createIcon, createIconButton, createTextButton, finishRender } from './dom';

// The AI section's error card (decision 11): `describeAiError` for model and connection errors,
// a quota message for refused storage writes, and a collapsed technical detail.

export interface SettingsErrorDescription {
	title: string;
	body: string;
	action: AiErrorAction;
	detail?: string;
}

/**
 * Settings controls the card's action button can drive, called with the click event. A missing
 * handler hides the button.
 */
export interface ErrorCardHandlers {
	/** Runs the Test again; it checks that the click is trusted, since a Test may be billed. */
	retry?: (event: Event) => void;
	/** The install guide's copy button. */
	copyInstallCommand?: (event: Event) => void;
	/** Focuses the routing table. */
	switchProfile?: (event: Event) => void;
}

function isAiError(error: unknown): error is AiError {
	return error instanceof Error && error.name === 'AiError' && typeof (error as AiError).code === 'string';
}

function storageBody(error: AiSettingsStorageError): string {
	switch (error.reason) {
		case 'item-too-large':
			return getMessage('aiSettingsQuotaItemTooLarge');
		case 'write-rate':
			return getMessage('aiSettingsQuotaWriteRate');
		default:
			return getMessage('aiSettingsQuotaTotal');
	}
}

/**
 * A failed bootstrap leaves the section read-only, so the body says how to get out: a full sync
 * storage needs space freed and a reload, not another try from this page.
 */
function bootstrapStorageBody(error: AiSettingsStorageError): string {
	return error.reason === 'total-quota' ? getMessage('aiSettingsBootstrapQuotaTotal') : storageBody(error);
}

function storageDetail(error: AiSettingsStorageError): string | undefined {
	if (!error.key) return undefined;
	return error.bytes !== undefined ? `${error.key}: ${error.bytes} B` : error.key;
}

function messageOf(error: unknown): string | undefined {
	if (error instanceof Error && error.message) return error.message;
	return typeof error === 'string' && error ? error : undefined;
}

export function describeSettingsError(error: unknown): SettingsErrorDescription {
	if (error instanceof AiSettingsBootstrapFailedError) {
		const cause = error.cause;
		const storage = isAiSettingsStorageError(cause);
		const detail = storage ? storageDetail(cause) : messageOf(cause);
		return {
			title: getMessage('aiSettingsBootstrapFailedTitle'),
			body: storage ? bootstrapStorageBody(cause) : getMessage('aiSettingsBootstrapFailedBody'),
			action: 'none',
			...(detail ? { detail } : {})
		};
	}
	if (isAiSettingsStorageError(error)) {
		const detail = storageDetail(error);
		return {
			title: getMessage('aiSettingsSaveFailedTitle'),
			body: storageBody(error),
			action: 'none',
			...(detail ? { detail } : {})
		};
	}
	if (error instanceof AiSettingsItemMissingError) {
		return {
			title: error.item === 'profile'
				? getMessage('aiSettingsProfileMissingTitle')
				: getMessage('aiSettingsConnectionMissingTitle'),
			body: getMessage('aiSettingsItemMissingBody'),
			action: 'none'
		};
	}
	if (error instanceof AiSettingsNotWritableError) {
		return { title: getMessage('aiSettingsNotWritableTitle'), body: getMessage('aiSettingsNotWritableBody'), action: 'none' };
	}
	if (isAiError(error)) {
		const description = describeAiError(error);
		// Settings is where `openSettings` leads, so it has no control here.
		return { ...description, action: description.action === 'openSettings' ? 'none' : description.action };
	}
	const detail = messageOf(error);
	return {
		title: getMessage('aiSettingsSaveFailedTitle'),
		body: getMessage('aiSettingsUnexpectedBody'),
		action: 'none',
		...(detail ? { detail } : {})
	};
}

function actionButton(doc: Document, action: AiErrorAction, handlers: ErrorCardHandlers): HTMLButtonElement | undefined {
	const handler = action === 'retry'
		? handlers.retry
		: action === 'copyInstallCommand'
			? handlers.copyInstallCommand
			: action === 'switchProfile'
				? handlers.switchProfile
				: undefined;
	if (!handler) return undefined;
	const label = action === 'retry'
		? getMessage('aiErrorActionRetry')
		: action === 'copyInstallCommand'
			? getMessage('nativeCliInstallCopy')
			: getMessage('aiErrorActionSwitchProfile');
	const button = createTextButton(doc, label, 'ai-error-card-action');
	button.addEventListener('click', handler);
	return button;
}

export interface RenderErrorCardOptions {
	handlers?: ErrorCardHandlers;
	/** Shows a dismiss button that calls this. */
	onDismiss?: () => void;
}

/** Renders `error` into `container`, or empties and hides it when `error` is undefined. */
export function renderErrorCard(container: HTMLElement, error: unknown, options: RenderErrorCardOptions = {}): void {
	const doc = container.ownerDocument;
	container.replaceChildren();
	container.hidden = error === undefined;
	if (error === undefined) return;

	const description = describeSettingsError(error);
	const card = createElement(doc, 'div', 'ai-error-card');
	card.setAttribute('role', 'alert');
	const iconContainer = createElement(doc, 'div', 'ai-error-card-icon');
	iconContainer.appendChild(createIcon(doc, 'alert-triangle'));
	const content = createElement(doc, 'div', 'ai-error-card-content');
	content.append(
		createElement(doc, 'div', 'ai-error-card-title', description.title),
		createElement(doc, 'div', 'ai-error-card-body', description.body)
	);
	if (description.detail) {
		const details = createElement(doc, 'details', 'ai-error-card-detail');
		details.append(
			createElement(doc, 'summary', undefined, getMessage('aiErrorTechnicalDetails')),
			createElement(doc, 'code', undefined, description.detail)
		);
		content.appendChild(details);
	}
	const button = actionButton(doc, description.action, options.handlers ?? {});
	if (button) {
		const actions = createElement(doc, 'div', 'ai-error-card-actions');
		actions.appendChild(button);
		content.appendChild(actions);
	}
	card.append(iconContainer, content);
	if (options.onDismiss) {
		const dismiss = createIconButton(doc, 'x', getMessage('close'), 'ai-error-card-dismiss');
		dismiss.addEventListener('click', options.onDismiss);
		card.appendChild(dismiss);
	}
	container.appendChild(card);
	finishRender(container);
}
