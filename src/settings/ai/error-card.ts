import { describeAiError, type AiErrorAction } from '../../ai/error-messages';
import { clearAiErrorCard, renderAiErrorCard } from '../../ai/ui/error-card';
import type { AiError } from '../../ai/errors';
import { isAiSettingsStorageError, type AiSettingsStorageError } from '../../ai/settings';
import { getMessage } from '../../utils/i18n';
import { AiSettingsBootstrapFailedError, AiSettingsItemMissingError, AiSettingsNotWritableError } from './controller';
import { createIcon, finishRender } from './dom';

// The AI section's error card (decision 11): `describeAiError` for model and connection errors,
// a quota message for refused storage writes, and a collapsed technical detail. The markup is the
// shared card of `src/ai/ui/error-card.ts`, with Settings' handlers and Lucide icons.

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

/** The section name of a v2 sync item, for the bootstrap message; other keys are shown as is. */
function itemName(key: string | undefined): string {
	switch (key) {
		case 'ai_connections': return getMessage('aiConnections');
		case 'ai_profiles': return getMessage('aiProfiles');
		case 'ai_routing': return getMessage('aiRouting');
		case 'ai_prompt_context': return getMessage('defaultInterpreterContext');
		case 'ai_interpreter': return getMessage('aiSettings');
		default: return key ?? getMessage('aiSettings');
	}
}

/**
 * A failed bootstrap leaves the section read-only, so the body says how to get out: a full sync
 * storage needs space freed and a reload, not another try from this page. An item too large to
 * migrate cannot be shortened here, so the body names it and asks for a report instead.
 */
function bootstrapStorageBody(error: AiSettingsStorageError): string {
	if (error.reason === 'total-quota') return getMessage('aiSettingsBootstrapQuotaTotal');
	if (error.reason === 'item-too-large') return getMessage('aiSettingsBootstrapItemTooLarge', itemName(error.key));
	return storageBody(error);
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

export interface RenderErrorCardOptions {
	handlers?: ErrorCardHandlers;
	/** Shows a dismiss button that calls this. */
	onDismiss?: () => void;
}

/** Renders `error` into `container`, or empties and hides it when `error` is undefined. */
export function renderErrorCard(container: HTMLElement, error: unknown, options: RenderErrorCardOptions = {}): void {
	if (error === undefined) {
		clearAiErrorCard(container);
		return;
	}
	const doc = container.ownerDocument;
	const { retry, copyInstallCommand, switchProfile } = options.handlers ?? {};
	renderAiErrorCard(container, describeSettingsError(error), {
		doc,
		handlers: {
			...(retry ? { retry } : {}),
			...(copyInstallCommand ? { copyInstallCommand } : {}),
			...(switchProfile ? { switchProfile } : {})
		},
		...(options.onDismiss ? { onDismiss: options.onDismiss } : {}),
		icon: name => createIcon(doc, name === 'alert' ? 'alert-triangle' : 'x')
	});
	finishRender(container);
}
