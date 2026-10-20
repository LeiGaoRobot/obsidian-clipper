import { decodeDiagnostics } from '../../ai/diagnostics';
import { aiErrorMessageKeys } from '../../ai/error-messages';
import type { StorageAreaLike } from '../../ai/job-store';
import { AI_DIAGNOSTICS_KEY } from '../../ai/settings';
import type { AiDiagnosticEntry, AiSettingsView } from '../../ai/types';
import { getMessage } from '../../utils/i18n';
import { connectionDisplayName, structuredOutputLabel } from './connections';
import { createElement, createTextButton } from './dom';
import { routingRowLabel } from './routing';

// Diagnostics panel (decision 12): the redacted log the background keeps in `storage.session`,
// read directly (extension pages are trusted contexts), newest first, with Clear and Copy as JSON.
// It sits in a collapsed disclosure whose summary counts the runs and failures.

export interface DiagnosticsPanelOptions {
	doc: Document;
	/** `#ai-diagnostics`. */
	container: HTMLElement;
	/** `#ai-diagnostics-overview`, in the disclosure's summary. */
	overview?: HTMLElement;
	/** `storage.session`; absent on browsers without it, where the panel says so. */
	session?: StorageAreaLike;
	/** Connection names for the entries. */
	view: () => AiSettingsView;
	copyText?: (text: string) => Promise<void>;
}

export interface DiagnosticsPanel {
	/** Re-reads the log, for a `storage.onChanged` event of `ai_diagnostics`. */
	refresh(): Promise<void>;
	readonly entries: readonly AiDiagnosticEntry[];
}

function outcomeLabel(entry: AiDiagnosticEntry): string {
	switch (entry.outcome) {
		case 'ok': return getMessage('aiStatusOk');
		case 'cancelled': return getMessage('aiDiagnosticsCancelled');
		default: return entry.code ? getMessage(aiErrorMessageKeys(entry.code).title) : getMessage('error');
	}
}

/** The disclosure summary: how many runs are logged and how many failed. */
export function diagnosticsOverview(entries: readonly AiDiagnosticEntry[]): string {
	if (entries.length === 0) return getMessage('aiDiagnosticsEmpty');
	const failed = entries.filter(entry => entry.outcome === 'error').length;
	if (entries.length === 1) return failed ? getMessage('aiDiagnosticsOverviewOneFailed') : getMessage('aiDiagnosticsOverviewOne');
	return failed > 0
		? getMessage('aiDiagnosticsOverviewFailed', [String(entries.length), String(failed)])
		: getMessage('aiDiagnosticsOverview', String(entries.length));
}

function durationLabel(ms: number): string {
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function createDiagnosticsPanel(options: DiagnosticsPanelOptions): DiagnosticsPanel {
	const { doc, container, session } = options;
	const copyText = options.copyText ?? (async (text: string) => {
		if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable.');
		await navigator.clipboard.writeText(text);
	});
	let entries: AiDiagnosticEntry[] = [];

	if (!session) {
		if (options.overview) options.overview.textContent = '';
		container.replaceChildren(createElement(doc, 'div', 'setting-item-description ai-empty-state', getMessage('aiDiagnosticsUnavailable')));
		return { refresh: async () => undefined, get entries() { return entries; } };
	}

	const actions = createElement(doc, 'div', 'ai-diagnostics-actions');
	const copy = createTextButton(doc, getMessage('aiDiagnosticsCopy'), 'ai-diagnostics-copy');
	const clear = createTextButton(doc, getMessage('aiDiagnosticsClear'), 'ai-diagnostics-clear');
	const copied = createElement(doc, 'span', 'ai-diagnostics-copied');
	copied.setAttribute('role', 'status');
	actions.append(copy, clear, copied);
	const list = createElement(doc, 'div', 'ai-diagnostics-list');
	container.replaceChildren(actions, list);

	function connectionName(id: string): string {
		const connection = options.view().connections.find(item => item.id === id);
		return connection ? connectionDisplayName(connection) : id;
	}

	function createRow(entry: AiDiagnosticEntry): HTMLElement {
		const row = createElement(doc, 'div', `ai-diagnostics-entry is-${entry.outcome}`);
		const time = createElement(doc, 'time', 'ai-diagnostics-time', new Date(entry.at).toLocaleTimeString());
		time.dateTime = new Date(entry.at).toISOString();
		const task = entry.task === 'test' ? getMessage('aiConnectionTest') : routingRowLabel(entry.task);
		const summary = createElement(doc, 'span', 'ai-diagnostics-summary', `${task} · ${connectionName(entry.connectionId)}`);
		const outcome = createElement(doc, 'span', 'ai-diagnostics-outcome', outcomeLabel(entry));
		const details = [
			entry.status ? `HTTP ${entry.status}` : '',
			durationLabel(entry.durationMs),
			entry.structuredMode ? structuredOutputLabel(entry.structuredMode) : '',
			entry.fallback ? getMessage('aiDiagnosticsFallback') : '',
			entry.groups !== undefined ? getMessage('aiDiagnosticsGroups', [String(entry.groups), String(entry.retries ?? 0)]) : ''
		].filter(Boolean).join(' · ');
		row.append(time, summary, outcome, createElement(doc, 'span', 'ai-diagnostics-details', details));
		return row;
	}

	function render(): void {
		if (options.overview) options.overview.textContent = diagnosticsOverview(entries);
		list.replaceChildren();
		copy.disabled = entries.length === 0;
		clear.disabled = entries.length === 0;
		if (entries.length === 0) {
			list.appendChild(createElement(doc, 'div', 'setting-item-description ai-empty-state', getMessage('aiDiagnosticsEmpty')));
			return;
		}
		for (const entry of [...entries].reverse()) list.appendChild(createRow(entry));
	}

	async function refresh(): Promise<void> {
		try {
			entries = decodeDiagnostics((await session!.get(AI_DIAGNOSTICS_KEY))[AI_DIAGNOSTICS_KEY]);
		} catch {
			entries = [];
		}
		render();
	}

	copy.addEventListener('click', () => {
		copyText(JSON.stringify(entries, null, 2)).then(
			() => { copied.textContent = getMessage('copied'); },
			() => { copied.textContent = getMessage('error'); }
		);
	});
	clear.addEventListener('click', () => {
		copied.textContent = '';
		void session.remove(AI_DIAGNOSTICS_KEY).catch(() => undefined).then(() => {
			entries = [];
			render();
		});
	});

	render();
	void refresh();
	return {
		refresh,
		get entries() {
			return entries;
		}
	};
}
