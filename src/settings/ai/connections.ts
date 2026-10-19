import { CATALOG, findCatalogEntryByBaseUrl, getCatalogEntry, type CatalogEntry } from '../../ai/catalog';
import { testConnection, type TestConnectionOptions } from '../../ai/client';
import { isCliKind } from '../../ai/connection-kind';
import { aiErrorMessageKeys } from '../../ai/error-messages';
import { isAiError } from '../../ai/errors';
import { deserializeAiError } from '../../ai/protocol';
import { connectionTestPlan, type ConnectionTestPlan } from '../../ai/test-connection';
import {
	AI_CONNECTIONS_KEY,
	AI_CONNECTION_STATUS_KEY,
	AI_CREDENTIALS_KEY,
	AI_PROFILES_KEY,
	type AiStorageKey
} from '../../ai/settings';
import type { AiTestResult, AiTestStep, Connection, StructuredOutputSupport } from '../../ai/types';
import { getMessage } from '../../utils/i18n';
import { hideModal, showModal } from '../../utils/modal-utils';
import type { AiSettingsController, AiSettingsState, ConnectionDraft } from './controller';
import {
	createAddLink,
	createElement,
	createIcon,
	createIconButton,
	createTextButton,
	finishRender,
	syncToggle
} from './dom';
import { renderErrorCard, type ErrorCardHandlers } from './error-card';
import type { AiSettingsPanel } from './panel';

// Connections panel (decision 8): one card per connection with its status badge, the catalog
// picker, and the connection dialog. The API key is written to device-local storage only.

/** Upper bound of the Advanced "Max concurrent requests" field. */
export const MAX_CONNECTION_CONCURRENCY = 32;

export type ConnectionBadgeState =
	| 'untested'
	| 'ok'
	| 'failing'
	| 'key-missing'
	| 'unsupported'
	// Routing rows only: nothing routed, or the routed profile cannot run.
	| 'unset'
	| 'unavailable';

export interface ConnectionBadge {
	state: ConnectionBadgeState;
	label: string;
	/** Longer text for the tooltip, such as the provider's error detail. */
	title?: string;
}

export function catalogEntryFor(connection: Pick<Connection, 'presetId' | 'baseUrl'>): CatalogEntry | undefined {
	return (connection.presetId ? getCatalogEntry(connection.presetId) : undefined)
		?? findCatalogEntryByBaseUrl(connection.baseUrl);
}

export function connectionDisplayName(connection: Connection): string {
	const label = connection.label.trim();
	if (label) return label;
	if (connection.kind === 'cli-codex') return getMessage('aiCliCodex');
	if (connection.kind === 'cli-grok') return getMessage('aiCliGrok');
	return catalogEntryFor(connection)?.name ?? (connectionHost(connection) || getMessage('aiConnectionUnnamed'));
}

/** The host shown under the name; template URLs that do not parse are shown as typed. */
export function connectionHost(connection: Connection): string {
	if (isCliKind(connection.kind)) return getMessage('aiCliConnectionHost');
	const baseUrl = connection.baseUrl?.trim() ?? '';
	try {
		return new URL(baseUrl).host || baseUrl;
	} catch {
		return baseUrl;
	}
}

export function connectionBadge(connection: Connection, state: AiSettingsState): ConnectionBadge {
	const { view } = state;
	if (isCliKind(connection.kind)) {
		if (view.nativeMessaging === 'none') return { state: 'unsupported', label: getMessage('aiStatusUnsupported') };
	} else if (connection.apiKeyRequired && !view.credentials[connection.id]?.trim()) {
		return { state: 'key-missing', label: getMessage('aiStatusKeyMissing') };
	}
	const status = state.connectionStatus[connection.id];
	if (status?.state === 'ok') return { state: 'ok', label: getMessage('aiStatusOk') };
	if (status?.state === 'failing') {
		const reason = status.code ? getMessage(aiErrorMessageKeys(status.code).title) : '';
		const label = reason ? getMessage('aiStatusFailingReason', reason) : getMessage('aiStatusFailing');
		const detail = [status.status ? `HTTP ${status.status}` : '', status.detail ?? ''].filter(Boolean).join(' · ');
		return { state: 'failing', label, ...(detail ? { title: `${label} (${detail})` } : {}) };
	}
	return { state: 'untested', label: getMessage('aiStatusUntested') };
}

export function createBadgeElement(doc: Document, badge: ConnectionBadge): HTMLElement {
	const element = createElement(doc, 'span', `ai-status-badge is-${badge.state}`, badge.label);
	element.title = badge.title ?? badge.label;
	return element;
}

/** The kind icon: the provider's mark for catalog presets, a terminal for CLIs. */
export function createKindIcon(doc: Document, connection: Pick<Connection, 'kind' | 'label' | 'presetId' | 'baseUrl'>): HTMLElement {
	const container = createElement(doc, 'div', 'ai-kind-icon-container');
	if (isCliKind(connection.kind)) {
		container.appendChild(createIcon(doc, 'terminal'));
		return container;
	}
	const slug = catalogEntryFor(connection)?.id ?? connection.label.toLowerCase().trim().replace(/\s+/g, '-');
	container.appendChild(createElement(doc, 'span', `ai-kind-icon icon-${slug}`));
	return container;
}

function parseConcurrency(value: string): number | undefined | false {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const number = Number(trimmed);
	return Number.isInteger(number) && number >= 1 && number <= MAX_CONNECTION_CONCURRENCY ? number : false;
}

/** An http(s) URL with every catalog `{placeholder}` replaced (braces are valid in URLs). */
function isHttpUrl(value: string): boolean {
	if (/[{}]/.test(value)) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:';
	} catch {
		return false;
	}
}

/** The Test plan for a connection with its enabled profiles. */
export function testPlanFor(connection: Connection, state: AiSettingsState): ConnectionTestPlan {
	return connectionTestPlan(
		connection,
		state.view.profiles.filter(profile => profile.connectionId === connection.id && profile.enabled)
	);
}

export function structuredOutputLabel(mode: Exclude<StructuredOutputSupport, 'unknown'>): string {
	switch (mode) {
		case 'json_schema': return getMessage('aiStructuredOutputJsonSchema');
		case 'json_object': return getMessage('aiStructuredOutputJsonObject');
		default: return getMessage('aiStructuredOutputNone');
	}
}

export type RunConnectionTest = (connectionId: string, options: TestConnectionOptions) => Promise<AiTestResult>;

/** A Test in this page: running with its current step, or its last outcome. */
interface TestState {
	running?: { step?: AiTestStep; profileId?: string; controller: AbortController };
	result?: AiTestResult;
	/** A Test that ended without a result (not a cancel). */
	error?: unknown;
}

interface ConnectionDialogTarget {
	connection?: Connection;
	preset?: CatalogEntry;
}

export interface ConnectionsPanelOptions {
	doc: Document;
	controller: AiSettingsController;
	/** `#ai-connections`. */
	container: HTMLElement;
	confirm?: (message: string) => boolean;
	/** Runs a Test through the gateway. Injected by tests. */
	runTest?: RunConnectionTest;
	/**
	 * Whether a click may start a Test, which can send a billable request: only a real user click.
	 * Injected by DOM tests, whose synthetic clicks are never trusted.
	 */
	isTrusted?: (event: Event) => boolean;
	/** The section's install-guide and routing actions for a failing Test's error card. */
	errorHandlers?: () => ErrorCardHandlers;
}

export interface ConnectionsPanel extends AiSettingsPanel {
	openCatalogPicker(): void;
	openConnectionDialog(target: ConnectionDialogTarget): void;
}

export function connectionsPanelState(state: AiSettingsState): unknown {
	return state.view.connections.map(connection => ({
		connection,
		name: connectionDisplayName(connection),
		badge: connectionBadge(connection, state),
		billable: testPlanFor(connection, state).billable,
		profiles: state.view.profiles
			.filter(profile => profile.connectionId === connection.id)
			.map(profile => [profile.id, profile.label, profile.model, profile.enabled])
	}));
}

export function createConnectionsPanel(options: ConnectionsPanelOptions): ConnectionsPanel {
	const { doc, controller, container } = options;
	const confirmAction = options.confirm ?? ((message: string) => doc.defaultView?.confirm(message) ?? false);
	const runTest: RunConnectionTest = options.runTest ?? testConnection;
	const isTrusted = options.isTrusted ?? ((event: Event) => event.isTrusted);
	const tests = new Map<string, TestState>();
	const list = createElement(doc, 'div', 'ai-connection-list');
	list.id = 'ai-connection-list';
	const { container: addContainer, link: addLink } = createAddLink(doc, getMessage('aiAddApiProvider'), 'ai-add-api-provider');
	container.replaceChildren(list, addContainer);

	const catalogModal = doc.getElementById('ai-catalog-modal');
	const catalogList = doc.getElementById('ai-catalog-list');
	const modal = doc.getElementById('ai-connection-modal');
	const form = doc.getElementById('ai-connection-form') as HTMLFormElement | null;
	const title = modal?.querySelector('.modal-title') as HTMLElement | null;
	const labelInput = doc.getElementById('ai-connection-label') as HTMLInputElement | null;
	const baseUrlInput = doc.getElementById('ai-connection-base-url') as HTMLInputElement | null;
	const apiKeyInput = doc.getElementById('ai-connection-api-key') as HTMLInputElement | null;
	const apiKeyToggle = doc.getElementById('ai-connection-api-key-toggle') as HTMLButtonElement | null;
	const apiKeyDescription = doc.getElementById('ai-connection-api-key-description');
	const apiKeyRequiredInput = doc.getElementById('ai-connection-api-key-required') as HTMLInputElement | null;
	const concurrencyInput = doc.getElementById('ai-connection-max-concurrency') as HTMLInputElement | null;
	const advanced = doc.getElementById('ai-connection-advanced') as HTMLDetailsElement | null;
	const errorContainer = doc.getElementById('ai-connection-error');
	const confirmButton = modal?.querySelector('.ai-connection-confirm-btn') as HTMLButtonElement | null;
	const cancelButton = modal?.querySelector('.ai-connection-cancel-btn') as HTMLButtonElement | null;
	let target: ConnectionDialogTarget = {};
	let saving = false;

	function setApiKeyVisible(visible: boolean): void {
		if (!apiKeyInput || !apiKeyToggle) return;
		apiKeyInput.type = visible ? 'text' : 'password';
		apiKeyToggle.textContent = visible ? getMessage('aiConnectionHideKey') : getMessage('aiConnectionShowKey');
		apiKeyToggle.setAttribute('aria-pressed', String(visible));
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

	function setApiKeyDescription(entry: CatalogEntry | undefined, name: string): void {
		if (!apiKeyDescription) return;
		apiKeyDescription.textContent = `${getMessage('aiConnectionApiKeyDescription')} `;
		if (entry?.apiKeyUrl) {
			const link = createElement(doc, 'a', undefined, getMessage('getApiKeyHere', name));
			link.href = entry.apiKeyUrl;
			link.target = '_blank';
			link.rel = 'noopener noreferrer';
			apiKeyDescription.appendChild(link);
		}
	}

	function openConnectionDialog(next: ConnectionDialogTarget): void {
		if (!modal || !labelInput || !baseUrlInput || !apiKeyInput || !apiKeyRequiredInput || !concurrencyInput) return;
		target = next;
		const { connection, preset } = next;
		const entry = connection ? catalogEntryFor(connection) : preset;
		if (title) title.textContent = connection ? getMessage('aiConnectionEditTitle') : getMessage('aiConnectionAddTitle');
		labelInput.value = connection ? connectionDisplayName(connection) : preset?.name ?? '';
		baseUrlInput.value = connection?.baseUrl ?? preset?.baseUrl ?? '';
		apiKeyInput.value = connection ? controller.state.view.credentials[connection.id] ?? '' : '';
		apiKeyRequiredInput.checked = connection ? connection.apiKeyRequired === true : preset?.apiKeyRequired ?? true;
		syncToggle(apiKeyRequiredInput);
		concurrencyInput.value = connection?.maxConcurrency !== undefined ? String(connection.maxConcurrency) : '';
		if (advanced) advanced.open = connection?.maxConcurrency !== undefined;
		setApiKeyDescription(entry, labelInput.value || entry?.name || '');
		setApiKeyVisible(false);
		showDialogError(undefined);
		showModal(modal);
		(connection || !preset ? labelInput : apiKeyInput).focus();
	}

	function readDraft(): ConnectionDraft | undefined {
		if (!labelInput || !baseUrlInput || !apiKeyInput || !apiKeyRequiredInput || !concurrencyInput) return undefined;
		const label = labelInput.value.trim();
		const baseUrl = baseUrlInput.value.trim();
		if (!label) {
			showDialogError(getMessage('aiConnectionLabelRequired'));
			labelInput.focus();
			return undefined;
		}
		if (!isHttpUrl(baseUrl)) {
			showDialogError(getMessage('aiConnectionBaseUrlInvalid'));
			baseUrlInput.focus();
			return undefined;
		}
		const maxConcurrency = parseConcurrency(concurrencyInput.value);
		if (maxConcurrency === false) {
			showDialogError(getMessage('aiConnectionMaxConcurrencyInvalid', String(MAX_CONNECTION_CONCURRENCY)));
			if (advanced) advanced.open = true;
			concurrencyInput.focus();
			return undefined;
		}
		const presetId = target.connection?.presetId ?? target.preset?.id;
		return {
			...(presetId ? { presetId } : {}),
			label,
			baseUrl,
			apiKey: apiKeyInput.value,
			apiKeyRequired: apiKeyRequiredInput.checked,
			...(maxConcurrency !== undefined ? { maxConcurrency } : {})
		};
	}

	async function save(): Promise<void> {
		if (saving) return;
		const draft = readDraft();
		if (!draft) return;
		saving = true;
		if (confirmButton) confirmButton.disabled = true;
		try {
			const saved = target.connection
				? await controller.updateConnection(target.connection.id, draft)
				: Boolean(await controller.addApiConnection(draft));
			if (saved) {
				hideModal(modal);
				target = {};
			} else {
				showDialogError(undefined, controller.error);
			}
		} finally {
			saving = false;
			if (confirmButton) confirmButton.disabled = false;
		}
	}

	function openCatalogPicker(): void {
		if (!catalogModal || !catalogList) {
			openConnectionDialog({});
			return;
		}
		catalogList.replaceChildren();
		const choose = (preset?: CatalogEntry) => {
			hideModal(catalogModal);
			openConnectionDialog(preset ? { preset } : {});
		};
		for (const entry of CATALOG) {
			const option = createElement(doc, 'button', 'ai-catalog-option');
			option.type = 'button';
			option.dataset.presetId = entry.id;
			const text = createElement(doc, 'span', 'ai-catalog-option-text');
			text.append(
				createElement(doc, 'span', 'ai-catalog-option-name', entry.name),
				createElement(doc, 'span', 'ai-catalog-option-host', connectionHost({ id: '', kind: entry.kind, label: '', baseUrl: entry.baseUrl }))
			);
			option.append(createKindIcon(doc, { kind: entry.kind, label: entry.name, presetId: entry.id }), text);
			option.addEventListener('click', () => choose(entry));
			catalogList.appendChild(option);
		}
		const custom = createElement(doc, 'button', 'ai-catalog-option mod-custom');
		custom.type = 'button';
		custom.dataset.presetId = '';
		const customText = createElement(doc, 'span', 'ai-catalog-option-text');
		customText.append(
			createElement(doc, 'span', 'ai-catalog-option-name', getMessage('custom')),
			createElement(doc, 'span', 'ai-catalog-option-host', getMessage('aiCatalogCustomDescription'))
		);
		custom.append(createKindIcon(doc, { kind: 'openai-compatible', label: '' }), customText);
		custom.addEventListener('click', () => choose());
		catalogList.appendChild(custom);
		finishRender(catalogList);
		showModal(catalogModal);
		(catalogList.firstElementChild as HTMLElement | null)?.focus();
	}

	addLink.addEventListener('click', event => {
		event.preventDefault();
		openCatalogPicker();
	});
	catalogModal?.querySelector('.ai-catalog-cancel-btn')?.addEventListener('click', () => hideModal(catalogModal));
	apiKeyToggle?.addEventListener('click', () => setApiKeyVisible(apiKeyInput?.type === 'password'));
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
		target = {};
	});
	if (form) finishRender(form);

	function deleteConnection(connection: Connection): void {
		const profiles = controller.state.view.profiles.filter(profile => profile.connectionId === connection.id).length;
		const message = getMessage('aiConnectionDeleteConfirm', [connectionDisplayName(connection), String(profiles)]);
		if (!confirmAction(message)) return;
		void controller.deleteConnection(connection.id);
	}

	function profileName(connectionId: string, profileId: string | undefined): string {
		const profile = controller.state.view.profiles.find(item => item.id === profileId && item.connectionId === connectionId);
		return profile ? (profile.label.trim() || profile.model || getMessage('aiProfileCliDefault')) : '';
	}

	function stepText(connectionId: string, step: AiTestStep | undefined, profileId: string | undefined): string {
		switch (step) {
			case 'listing': return getMessage('aiTestStepListing');
			case 'structured': return getMessage('aiTestStepStructured');
			case 'probe': return getMessage('aiTestStepProbe');
			case 'exec': {
				const name = profileName(connectionId, profileId);
				return name ? getMessage('aiTestStepExecProfile', name) : getMessage('aiTestStepExec');
			}
			default: return getMessage('aiTestStepHealth');
		}
	}

	function rerender(): void {
		render(controller.state);
	}

	/** Starts a Test, which may send a billable request; only after a trusted click. */
	async function startTest(connectionId: string): Promise<void> {
		if (tests.get(connectionId)?.running || controller.saving) return;
		const abort = new AbortController();
		tests.set(connectionId, { running: { controller: abort } });
		rerender();
		try {
			const result = await runTest(connectionId, {
				signal: abort.signal,
				onStep: (step, profileId) => {
					if (tests.get(connectionId)?.running?.controller !== abort) return;
					tests.set(connectionId, { running: { step, ...(profileId ? { profileId } : {}), controller: abort } });
					rerender();
				}
			});
			tests.set(connectionId, { result });
			await controller.applyTestResult(result);
		} catch (error) {
			const cancelled = isAiError(error) && error.code === 'cancelled';
			if (cancelled) tests.delete(connectionId);
			else tests.set(connectionId, { error });
		}
		rerender();
	}

	function onTrustedClick(handler: () => void): (event: Event) => void {
		return event => {
			if (!isTrusted(event)) return;
			handler();
		};
	}

	function errorCardHandlers(connectionId: string): ErrorCardHandlers {
		return {
			...(options.errorHandlers?.() ?? {}),
			retry: onTrustedClick(() => void startTest(connectionId))
		};
	}

	function renderResult(connection: Connection, result: AiTestResult): HTMLElement {
		const element = createElement(doc, 'div', `ai-connection-test-result is-${result.state}`);
		if (result.state === 'failing') {
			renderErrorCard(element, deserializeAiError(result.error), { handlers: errorCardHandlers(connection.id) });
			element.hidden = false;
		} else {
			element.appendChild(createElement(doc, 'div', 'ai-connection-test-result-title', getMessage('aiTestResultOk')));
			const lines: string[] = [];
			const models = result.models ?? [];
			if (models.length > 0) {
				lines.push(getMessage('aiTestResultModels', [String(models.filter(model => model.listed).length), String(models.length)]));
				const missing = models.filter(model => !model.listed).map(model => model.model);
				if (missing.length > 0) lines.push(getMessage('aiTestResultNotListed', missing.join(', ')));
			}
			if (result.structuredOutput) lines.push(getMessage('aiTestResultStructured', structuredOutputLabel(result.structuredOutput)));
			for (const line of lines) element.appendChild(createElement(doc, 'div', 'ai-connection-test-result-line', line));
		}
		if (result.billable) element.appendChild(createElement(doc, 'div', 'ai-connection-test-result-note', getMessage('aiTestResultBillable')));
		if (result.transport === 'message') {
			element.appendChild(createElement(doc, 'div', 'ai-connection-test-result-note', getMessage('aiTestResultOneShot')));
		}
		return element;
	}

	function createTestPanel(connection: Connection, state: AiSettingsState): HTMLElement {
		const panel = createElement(doc, 'div', 'ai-connection-test-panel');
		const test = tests.get(connection.id);
		// The cost note sits above Test whenever the plan has a billable step.
		const plan = testPlanFor(connection, state);
		if (plan.billable) {
			panel.appendChild(createElement(
				doc,
				'div',
				'ai-connection-cost-note',
				isCliKind(connection.kind) ? getMessage('aiConnectionTestCostNoteCli') : getMessage('aiConnectionTestCostNote')
			));
		}
		const bar = createElement(doc, 'div', 'ai-connection-test-bar');
		const button = createTextButton(doc, getMessage('aiConnectionTest'), 'ai-connection-test');
		button.disabled = Boolean(test?.running) || controller.saving;
		button.addEventListener('click', onTrustedClick(() => void startTest(connection.id)));
		bar.appendChild(button);
		if (test?.running) {
			const cancel = createTextButton(doc, getMessage('cancel'), 'ai-connection-test-cancel');
			const running = test.running;
			cancel.addEventListener('click', () => running.controller.abort());
			const progress = createElement(doc, 'span', 'ai-connection-test-progress', stepText(connection.id, running.step, running.profileId));
			progress.setAttribute('role', 'status');
			bar.append(cancel, progress);
		}
		panel.appendChild(bar);
		if (test?.result) panel.appendChild(renderResult(connection, test.result));
		else if (test?.error !== undefined) {
			const element = createElement(doc, 'div', 'ai-connection-test-result is-failing');
			renderErrorCard(element, test.error, { handlers: errorCardHandlers(connection.id) });
			element.hidden = false;
			panel.appendChild(element);
		}
		return panel;
	}

	function createCard(connection: Connection, state: AiSettingsState): HTMLElement {
		const item = createElement(doc, 'div', 'ai-connection-item');
		item.dataset.connectionId = connection.id;
		const card = createElement(doc, 'div', 'ai-connection-card');
		const info = createElement(doc, 'div', 'ai-connection-info');
		info.append(
			createElement(doc, 'div', 'ai-connection-name', connectionDisplayName(connection)),
			createElement(doc, 'div', 'ai-connection-host', connectionHost(connection))
		);
		const actions = createElement(doc, 'div', 'ai-connection-actions');
		if (!isCliKind(connection.kind)) {
			const edit = createIconButton(doc, 'pen-line', getMessage('edit'), 'ai-connection-edit');
			edit.addEventListener('click', () => openConnectionDialog({ connection }));
			actions.appendChild(edit);
		}
		const remove = createIconButton(doc, 'trash-2', getMessage('delete'), 'ai-connection-delete');
		remove.addEventListener('click', () => deleteConnection(connection));
		actions.appendChild(remove);
		card.append(createKindIcon(doc, connection), info, createBadgeElement(doc, connectionBadge(connection, state)), actions);
		item.append(card, createTestPanel(connection, state));
		return item;
	}

	function render(state: AiSettingsState): void {
		list.replaceChildren();
		const ids = new Set(state.view.connections.map(connection => connection.id));
		for (const [id, test] of tests) {
			if (ids.has(id)) continue;
			test.running?.controller.abort();
			tests.delete(id);
		}
		if (state.view.connections.length === 0) {
			list.appendChild(createElement(doc, 'div', 'setting-item-description ai-empty-state', getMessage('aiConnectionsEmpty')));
			return;
		}
		for (const connection of state.view.connections) list.appendChild(createCard(connection, state));
		finishRender(list);
	}

	// Test waits for pending saves, so it never runs against settings that are still being written.
	const stopSaving = controller.onSavingChange(saving => {
		list.querySelectorAll<HTMLButtonElement>('.ai-connection-test').forEach(button => {
			const id = button.closest<HTMLElement>('.ai-connection-item')?.dataset.connectionId ?? '';
			button.disabled = saving || Boolean(tests.get(id)?.running);
		});
	});

	return {
		// Profiles change the Test plan (models to check, cost note) and the exec step labels.
		keys: [AI_CONNECTIONS_KEY, AI_PROFILES_KEY, AI_CREDENTIALS_KEY, AI_CONNECTION_STATUS_KEY] as readonly AiStorageKey[],
		stateOf(state) {
			return {
				cards: connectionsPanelState(state),
				tests: Array.from(tests.entries()).map(([id, test]) => [id, test.running ? [test.running.step, test.running.profileId] : null, test.result ?? null, test.error !== undefined])
			};
		},
		render,
		dispose() {
			stopSaving();
			for (const test of tests.values()) test.running?.controller.abort();
			tests.clear();
		},
		openCatalogPicker,
		openConnectionDialog
	};
}
