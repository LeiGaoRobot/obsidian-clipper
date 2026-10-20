import type { Connection, ModelProfile } from '../../ai/types';
import type { CodexReasoningEffort } from '../../types/types';
import { MAX_CODEX_MODEL_CHARS } from '../../utils/codex-model';
import { CODEX_REASONING_EFFORTS, normalizeCodexReasoningEffort } from '../../utils/codex-reasoning-effort';
import { getMessage } from '../../utils/i18n';
import { hideModal, showModal } from '../../utils/modal-utils';
import { catalogEntryFor, connectionDisplayName, isModelNotListed } from './connections';
import { AiSettingsItemMissingError, type AiSettingsController, type AiSettingsState, type ProfileDraft } from './controller';
import { createAddLink, createElement, createIconButton, createToggle } from './dom';
import { renderErrorCard } from './error-card';

// Models (decision 8): the rows of a connection's models, in creation order, nested in its card
// in "Providers and models" (connections.ts), and the add/edit model dialog.

/** Model ids offered for Codex profiles; any other id the CLI accepts can be typed. */
export const CODEX_MODEL_SUGGESTIONS: readonly string[] = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

export function profileDisplayName(profile: ModelProfile, connection?: Connection): string {
	const label = profile.label.trim();
	if (label) return label;
	if (profile.model) return profile.model;
	return connection && connection.kind.startsWith('cli-')
		? getMessage('aiProfileCliDefault')
		: getMessage('aiProfileUnnamed');
}

/** The second line of a profile row: the model id when a label hides it, and the Codex effort. */
export function profileDetails(profile: ModelProfile, connection?: Connection): string {
	const parts: string[] = [];
	if (profile.label.trim()) {
		if (profile.model) parts.push(profile.model);
		else if (connection?.kind.startsWith('cli-')) parts.push(getMessage('aiProfileCliDefault'));
	}
	if (connection?.kind === 'cli-codex' && profile.options?.reasoningEffort) {
		parts.push(getMessage('aiProfileEffortValue', profile.options.reasoningEffort));
	}
	return parts.join(' · ');
}

/**
 * Datalist suggestions for a connection's model field: the ids the last Test in this page listed,
 * else the catalog's popular models.
 */
export function modelSuggestions(connection: Connection, listed?: readonly string[]): { id: string; name: string }[] {
	if (connection.kind === 'cli-codex') return CODEX_MODEL_SUGGESTIONS.map(id => ({ id, name: id }));
	if (connection.kind === 'cli-grok') return [];
	if (listed && listed.length > 0) return listed.map(id => ({ id, name: id }));
	return (catalogEntryFor(connection)?.popularModels ?? []).map(model => ({ id: model.id, name: model.name }));
}

export interface ProfilesOptions {
	doc: Document;
	controller: AiSettingsController;
	/** `#ai-connections`, where the connection cards and their model rows are. */
	root: HTMLElement;
	confirm?: (message: string) => boolean;
	/** Shows the stored state again after a refused write. */
	rerender: () => void;
}

export interface Profiles {
	openProfileDialog(connectionId: string, profile?: ModelProfile): void;
	/** A connection's model rows and its "+ Add model" link; orphans get rows only. */
	createModelList(connection: Connection | undefined, profiles: readonly ModelProfile[], state: AiSettingsState): HTMLElement;
}

export function createProfiles(options: ProfilesOptions): Profiles {
	const { doc, controller, root } = options;
	const confirmAction = options.confirm ?? ((message: string) => doc.defaultView?.confirm(message) ?? false);

	const modal = doc.getElementById('ai-profile-modal');
	const form = doc.getElementById('ai-profile-form') as HTMLFormElement | null;
	const title = modal?.querySelector('.modal-title') as HTMLElement | null;
	const connectionName = doc.getElementById('ai-profile-connection-name');
	const labelInput = doc.getElementById('ai-profile-label') as HTMLInputElement | null;
	const modelItem = doc.getElementById('ai-profile-model-item');
	const modelInput = doc.getElementById('ai-profile-model') as HTMLInputElement | null;
	const modelOptions = doc.getElementById('ai-profile-model-options');
	const modelDescription = doc.getElementById('ai-profile-model-description');
	const effortItem = doc.getElementById('ai-profile-effort-item');
	const effortSelect = doc.getElementById('ai-profile-effort') as HTMLSelectElement | null;
	const errorContainer = doc.getElementById('ai-profile-error');
	const confirmButton = modal?.querySelector('.ai-profile-confirm-btn') as HTMLButtonElement | null;
	const cancelButton = modal?.querySelector('.ai-profile-cancel-btn') as HTMLButtonElement | null;
	let target: { connectionId: string; profile?: ModelProfile } | undefined;
	let saving = false;
	// Bumped on every open and close, so a save that finishes later knows its dialog is gone.
	let dialogSession = 0;

	if (effortSelect) {
		effortSelect.replaceChildren(createElement(doc, 'option', undefined, getMessage('aiProfileEffortDefault')));
		(effortSelect.firstElementChild as HTMLOptionElement).value = '';
		for (const effort of CODEX_REASONING_EFFORTS) {
			const option = createElement(doc, 'option', undefined, effort);
			option.value = effort;
			effortSelect.appendChild(option);
		}
	}

	function showDialogError(message: string | undefined, error?: unknown): void {
		if (!errorContainer) return;
		if (error !== undefined) {
			renderErrorCard(errorContainer, error);
			return;
		}
		errorContainer.replaceChildren();
		errorContainer.hidden = !message;
		if (message) errorContainer.appendChild(createElement(doc, 'div', 'ai-form-error', message));
	}

	function setModelDescription(connection: Connection): void {
		if (!modelDescription) return;
		if (connection.kind === 'cli-codex') {
			modelDescription.textContent = getMessage('aiProfileCodexModelDescription');
			return;
		}
		modelDescription.textContent = `${getMessage('aiProfileModelDescription')} `;
		const entry = catalogEntryFor(connection);
		if (entry?.modelsList) {
			const link = createElement(doc, 'a', undefined, getMessage('modelsListFor', entry.name));
			link.href = entry.modelsList;
			link.target = '_blank';
			link.rel = 'noopener noreferrer';
			modelDescription.appendChild(link);
		}
	}

	function resetProfileDialog(): void {
		dialogSession++;
		target = undefined;
		form?.reset();
		showDialogError(undefined);
	}

	/** Where focus goes when the dialog closes: the row's Edit button, else the card's add link. */
	function dialogOpener(connectionId: string, profileId: string | undefined): () => HTMLElement | null {
		return () => {
			const row = profileId
				? Array.from(root.querySelectorAll<HTMLElement>('.ai-profile-row')).find(element => element.dataset.profileId === profileId)
				: undefined;
			const edit = row?.querySelector<HTMLElement>('.ai-profile-edit');
			if (edit) return edit;
			const group = Array.from(root.querySelectorAll<HTMLElement>('.ai-profile-group'))
				.find(element => element.dataset.connectionId === connectionId);
			return group?.querySelector<HTMLElement>('.ai-add-profile') ?? null;
		};
	}

	function openProfileDialog(connectionId: string, profile?: ModelProfile): void {
		const connection = controller.state.view.connections.find(item => item.id === connectionId);
		if (!modal || !connection || !labelInput || !modelInput || !effortSelect) return;
		dialogSession++;
		target = { connectionId, ...(profile ? { profile } : {}) };
		if (title) title.textContent = profile ? getMessage('aiProfileEditTitle') : getMessage('aiProfileAddTitle');
		if (connectionName) connectionName.textContent = connectionDisplayName(connection);
		labelInput.value = profile?.label ?? '';
		modelInput.value = profile?.model ?? '';
		modelInput.maxLength = connection.kind === 'cli-codex' ? MAX_CODEX_MODEL_CHARS : 500;
		modelInput.required = !connection.kind.startsWith('cli-');
		if (modelItem) modelItem.hidden = connection.kind === 'cli-grok';
		if (modelOptions) {
			modelOptions.replaceChildren(...modelSuggestions(connection, controller.listedModels(connection.id)).map(model => {
				const option = createElement(doc, 'option', undefined, model.name === model.id ? undefined : model.name);
				option.value = model.id;
				return option;
			}));
		}
		setModelDescription(connection);
		if (effortItem) effortItem.hidden = connection.kind !== 'cli-codex';
		effortSelect.value = profile?.options?.reasoningEffort ?? '';
		showDialogError(undefined);
		showModal(modal, { onHide: resetProfileDialog, trapFocus: true, returnFocus: dialogOpener(connectionId, profile?.id) });
		(connection.kind === 'cli-grok' ? labelInput : modelInput).focus();
	}

	function readDraft(): ProfileDraft | undefined {
		if (!target || !labelInput || !modelInput || !effortSelect) return undefined;
		const connection = controller.state.view.connections.find(item => item.id === target?.connectionId);
		// Deleted while the dialog was open: the save goes on, so the controller reports it.
		if (!connection) return { connectionId: target.connectionId, label: labelInput.value, model: modelInput.value.trim() };
		const model = connection.kind === 'cli-grok' ? '' : modelInput.value.trim();
		if (!model && !connection.kind.startsWith('cli-')) {
			showDialogError(getMessage('aiProfileModelRequired'));
			modelInput.focus();
			return undefined;
		}
		const effort: CodexReasoningEffort | undefined = connection.kind === 'cli-codex'
			? normalizeCodexReasoningEffort(effortSelect.value)
			: undefined;
		return {
			connectionId: connection.id,
			label: labelInput.value,
			model,
			...(effort ? { reasoningEffort: effort } : {})
		};
	}

	async function save(): Promise<void> {
		if (saving || !target) return;
		const draft = readDraft();
		if (!draft) return;
		saving = true;
		if (confirmButton) confirmButton.disabled = true;
		const session = dialogSession;
		try {
			const saved = target.profile
				? await controller.updateProfile(target.profile.id, draft)
				: Boolean(await controller.addProfile(draft));
			if (session !== dialogSession) return;
			if (saved || controller.error instanceof AiSettingsItemMissingError) {
				// A profile or connection deleted while the dialog was open: the section's error card says so.
				hideModal(modal);
			} else {
				showDialogError(undefined, controller.error);
			}
		} finally {
			saving = false;
			if (confirmButton) confirmButton.disabled = false;
		}
	}

	form?.addEventListener('submit', event => {
		event.preventDefault();
		void save();
	});
	confirmButton?.addEventListener('click', event => {
		event.preventDefault();
		void save();
	});
	cancelButton?.addEventListener('click', () => hideModal(modal));

	function createRow(profile: ModelProfile, connection: Connection | undefined, state: AiSettingsState): HTMLElement {
		const row = createElement(doc, 'div', 'ai-profile-row');
		row.dataset.profileId = profile.id;
		row.classList.toggle('is-disabled', !profile.enabled);
		const info = createElement(doc, 'div', 'ai-profile-info');
		const name = profileDisplayName(profile, connection);
		const nameLine = createElement(doc, 'div', 'ai-profile-name');
		nameLine.appendChild(createElement(doc, 'span', 'ai-profile-name-text', name));
		if (state.view.routing.defaultProfileId === profile.id) {
			nameLine.appendChild(createElement(doc, 'span', 'ai-profile-default-badge', getMessage('aiProfileDefaultBadge')));
		}
		info.appendChild(nameLine);
		const details = profileDetails(profile, connection);
		if (details) info.appendChild(createElement(doc, 'div', 'ai-profile-details', details));
		if (isModelNotListed(state, profile)) {
			// The key worked, so this does not fail the connection; the model id may be mistyped.
			const badge = createElement(doc, 'span', 'ai-status-badge is-key-missing ai-profile-model-not-listed', getMessage('aiProfileModelNotListed'));
			badge.title = getMessage('aiProfileModelNotListedTitle');
			row.append(info, badge);
		}

		const actions = createElement(doc, 'div', 'ai-profile-actions');
		if (connection) {
			const edit = createIconButton(doc, 'pen-line', getMessage('edit'), 'ai-profile-edit');
			edit.addEventListener('click', () => openProfileDialog(connection.id, profile));
			const duplicate = createIconButton(doc, 'copy-plus', getMessage('duplicate'), 'ai-profile-duplicate');
			duplicate.addEventListener('click', () => {
				void controller.duplicateProfile(profile.id, getMessage('aiProfileCopyLabel', name));
			});
			actions.append(edit, duplicate);
		}
		const remove = createIconButton(doc, 'trash-2', getMessage('delete'), 'ai-profile-delete');
		remove.addEventListener('click', () => {
			if (!confirmAction(getMessage('aiProfileDeleteConfirm', name))) return;
			void controller.deleteProfile(profile.id);
		});
		actions.appendChild(remove);
		if (connection) {
			const { container: toggle, input } = createToggle(doc, `ai-profile-enabled-${profile.id}`, profile.enabled, true);
			input.setAttribute('aria-label', getMessage('aiProfileEnabled', name));
			input.addEventListener('change', () => {
				void controller.setProfileEnabled(profile.id, input.checked).then(saved => {
					if (!saved) options.rerender();
				});
			});
			actions.appendChild(toggle);
		}
		if (!row.contains(info)) row.append(info);
		row.appendChild(actions);
		return row;
	}

	function createModelList(connection: Connection | undefined, profiles: readonly ModelProfile[], state: AiSettingsState): HTMLElement {
		const element = createElement(doc, 'div', 'ai-profile-group');
		element.dataset.connectionId = connection?.id ?? '';
		if (profiles.length > 0) {
			const list = createElement(doc, 'div', 'ai-profile-list');
			for (const profile of profiles) list.appendChild(createRow(profile, connection, state));
			element.appendChild(list);
		}
		if (connection) {
			const { container: add, link } = createAddLink(doc, getMessage('aiAddProfile'));
			link.classList.add('ai-add-profile');
			link.setAttribute('aria-label', getMessage('aiAddProfileTo', connectionDisplayName(connection)));
			link.addEventListener('click', event => {
				event.preventDefault();
				openProfileDialog(connection.id);
			});
			element.appendChild(add);
		}
		return element;
	}

	return {
		openProfileDialog,
		createModelList
	};
}
