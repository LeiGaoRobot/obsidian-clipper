import { AI_CONNECTIONS_KEY, AI_PROFILES_KEY, type AiStorageKey } from '../../ai/settings';
import type { Connection, ModelProfile } from '../../ai/types';
import type { CodexReasoningEffort } from '../../types/types';
import { MAX_CODEX_MODEL_CHARS } from '../../utils/codex-model';
import { CODEX_REASONING_EFFORTS, normalizeCodexReasoningEffort } from '../../utils/codex-reasoning-effort';
import { getMessage } from '../../utils/i18n';
import { hideModal, showModal } from '../../utils/modal-utils';
import { catalogEntryFor, connectionDisplayName, createKindIcon } from './connections';
import type { AiSettingsController, AiSettingsState, ProfileDraft } from './controller';
import { createAddLink, createElement, createIconButton, createToggle, finishRender } from './dom';
import { renderErrorCard } from './error-card';
import type { AiSettingsPanel } from './panel';

// Models panel (decision 8): profiles grouped under their connection, in creation order.

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

/** Datalist suggestions for a connection's model field. */
export function modelSuggestions(connection: Connection): { id: string; name: string }[] {
	if (connection.kind === 'cli-codex') return CODEX_MODEL_SUGGESTIONS.map(id => ({ id, name: id }));
	if (connection.kind === 'cli-grok') return [];
	return (catalogEntryFor(connection)?.popularModels ?? []).map(model => ({ id: model.id, name: model.name }));
}

interface ProfileGroup {
	connection?: Connection;
	connectionId: string;
	profiles: ModelProfile[];
}

function groupProfiles(state: AiSettingsState): ProfileGroup[] {
	const { connections, profiles } = state.view;
	const groups: ProfileGroup[] = connections.map(connection => ({
		connection,
		connectionId: connection.id,
		profiles: profiles.filter(profile => profile.connectionId === connection.id)
	}));
	const known = new Set(connections.map(connection => connection.id));
	const orphans = profiles.filter(profile => !known.has(profile.connectionId));
	if (orphans.length > 0) groups.push({ connectionId: '', profiles: orphans });
	return groups;
}

export function profilesPanelState(state: AiSettingsState): unknown {
	return groupProfiles(state).map(group => ({
		connection: group.connection ?? null,
		name: group.connection ? connectionDisplayName(group.connection) : '',
		profiles: group.profiles
	}));
}

export interface ProfilesPanelOptions {
	doc: Document;
	controller: AiSettingsController;
	/** `#ai-profiles`. */
	container: HTMLElement;
	confirm?: (message: string) => boolean;
}

export interface ProfilesPanel extends AiSettingsPanel {
	openProfileDialog(connectionId: string, profile?: ModelProfile): void;
}

export function createProfilesPanel(options: ProfilesPanelOptions): ProfilesPanel {
	const { doc, controller, container } = options;
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

	function openProfileDialog(connectionId: string, profile?: ModelProfile): void {
		const connection = controller.state.view.connections.find(item => item.id === connectionId);
		if (!modal || !connection || !labelInput || !modelInput || !effortSelect) return;
		target = { connectionId, ...(profile ? { profile } : {}) };
		if (title) title.textContent = profile ? getMessage('aiProfileEditTitle') : getMessage('aiProfileAddTitle');
		if (connectionName) connectionName.textContent = connectionDisplayName(connection);
		labelInput.value = profile?.label ?? '';
		modelInput.value = profile?.model ?? '';
		modelInput.maxLength = connection.kind === 'cli-codex' ? MAX_CODEX_MODEL_CHARS : 500;
		modelInput.required = !connection.kind.startsWith('cli-');
		if (modelItem) modelItem.hidden = connection.kind === 'cli-grok';
		if (modelOptions) {
			modelOptions.replaceChildren(...modelSuggestions(connection).map(model => {
				const option = createElement(doc, 'option', undefined, model.name === model.id ? undefined : model.name);
				option.value = model.id;
				return option;
			}));
		}
		setModelDescription(connection);
		if (effortItem) effortItem.hidden = connection.kind !== 'cli-codex';
		effortSelect.value = profile?.options?.reasoningEffort ?? '';
		showDialogError(undefined);
		showModal(modal);
		(connection.kind === 'cli-grok' ? labelInput : modelInput).focus();
	}

	function readDraft(): ProfileDraft | undefined {
		if (!target || !labelInput || !modelInput || !effortSelect) return undefined;
		const connection = controller.state.view.connections.find(item => item.id === target?.connectionId);
		if (!connection) return undefined;
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
		try {
			const saved = target.profile
				? await controller.updateProfile(target.profile.id, draft)
				: Boolean(await controller.addProfile(draft));
			if (saved) {
				hideModal(modal);
				target = undefined;
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
	cancelButton?.addEventListener('click', () => {
		hideModal(modal);
		target = undefined;
	});

	function createRow(profile: ModelProfile, connection: Connection | undefined): HTMLElement {
		const row = createElement(doc, 'div', 'ai-profile-row');
		row.dataset.profileId = profile.id;
		row.classList.toggle('is-disabled', !profile.enabled);
		const info = createElement(doc, 'div', 'ai-profile-info');
		const name = profileDisplayName(profile, connection);
		info.appendChild(createElement(doc, 'div', 'ai-profile-name', name));
		const details = profileDetails(profile, connection);
		if (details) info.appendChild(createElement(doc, 'div', 'ai-profile-details', details));

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
					if (!saved) render(controller.state);
				});
			});
			actions.appendChild(toggle);
		}
		row.append(info, actions);
		return row;
	}

	function createGroup(group: ProfileGroup): HTMLElement {
		const element = createElement(doc, 'div', 'ai-profile-group');
		element.dataset.connectionId = group.connectionId;
		const header = createElement(doc, 'div', 'ai-profile-group-header');
		if (group.connection) header.appendChild(createKindIcon(doc, group.connection));
		header.appendChild(createElement(
			doc,
			'div',
			'ai-profile-group-name',
			group.connection ? connectionDisplayName(group.connection) : getMessage('aiProfileOrphanGroup')
		));
		element.appendChild(header);
		const list = createElement(doc, 'div', 'ai-profile-list');
		for (const profile of group.profiles) list.appendChild(createRow(profile, group.connection));
		element.appendChild(list);
		if (group.connection) {
			const connection = group.connection;
			const { container: add, link } = createAddLink(doc, getMessage('aiAddProfile'));
			link.classList.add('ai-add-profile');
			link.addEventListener('click', event => {
				event.preventDefault();
				openProfileDialog(connection.id);
			});
			element.appendChild(add);
		}
		return element;
	}

	function render(state: AiSettingsState): void {
		container.replaceChildren();
		const groups = groupProfiles(state);
		if (groups.length === 0) {
			container.appendChild(createElement(doc, 'div', 'setting-item-description ai-empty-state', getMessage('aiProfilesEmpty')));
			return;
		}
		for (const group of groups) container.appendChild(createGroup(group));
		finishRender(container);
	}

	return {
		keys: [AI_CONNECTIONS_KEY, AI_PROFILES_KEY] as readonly AiStorageKey[],
		stateOf: profilesPanelState,
		render,
		openProfileDialog
	};
}
