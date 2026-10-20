import { resolveProfile } from '../../ai/resolve';
import {
	AI_CONNECTIONS_KEY,
	AI_CONNECTION_STATUS_KEY,
	AI_CREDENTIALS_KEY,
	AI_PROFILES_KEY,
	AI_ROUTING_KEY,
	type AiStorageKey
} from '../../ai/settings';
import { AI_TASKS, type AiTask } from '../../ai/types';
import { getMessage } from '../../utils/i18n';
import { connectionBadge, connectionDisplayName, createBadgeElement, type ConnectionBadge } from './connections';
import type { AiSettingsController, AiSettingsState } from './controller';
import { createElement, createSettingItem } from './dom';
import type { AiSettingsPanel } from './panel';
import { profileDisplayName } from './profiles';

// Tasks group (decision 8): the Default model row on top (the response language row follows it,
// see language.ts), then the per-task rows inside a collapsed "Customize per task" disclosure. A
// row shows a badge only when its route has a problem; the badge follows the profile the resolver
// would pick, which is what the old readiness assistant answered.

export type RoutingRowKey = 'default' | AiTask;

export const ROUTING_ROWS: readonly RoutingRowKey[] = ['default', ...AI_TASKS];

export function routingSelectId(row: RoutingRowKey): string {
	return `ai-routing-${row}`;
}

export function routingRowLabel(row: RoutingRowKey): string {
	switch (row) {
		case 'default': return getMessage('aiRoutingDefault');
		case 'interpret': return getMessage('aiTaskInterpret');
		case 'edit': return getMessage('aiTaskEdit');
		case 'translate': return getMessage('aiTaskTranslate');
		case 'reading': return getMessage('aiTaskReading');
		case 'explain': return getMessage('aiTaskExplain');
	}
}

function rowDescription(row: RoutingRowKey): string {
	switch (row) {
		case 'default': return getMessage('aiRoutingDefaultDescription');
		case 'interpret': return getMessage('aiTaskInterpretDescription');
		case 'edit': return getMessage('aiTaskEditDescription');
		case 'translate': return getMessage('aiTaskTranslateDescription');
		case 'reading': return getMessage('aiTaskReadingDescription');
		case 'explain': return getMessage('aiTaskExplainDescription');
	}
}

/** The badge for a row: the resolved profile's connection status, or why nothing resolves. */
export function routingBadge(state: AiSettingsState, row: RoutingRowKey): ConnectionBadge {
	const { routing } = state.view;
	const profileId = row === 'default' ? routing.defaultProfileId : routing.taskProfiles[row] ?? routing.defaultProfileId;
	if (!profileId) return { state: 'unset', label: getMessage('aiRoutingNotSet') };
	// The master switch is the Interpreter panel's concern; the badge describes the route itself.
	const resolved = resolveProfile({ ...state.view, enabled: true }, row === 'default' ? 'interpret' : row, { profileId });
	if (resolved.ok) return connectionBadge(resolved.connection, state);
	const connection = state.view.connections.find(item => item.id === resolved.error.connectionId);
	if (connection && (resolved.error.code === 'credential-missing' || resolved.error.code === 'host-unsupported')) {
		return connectionBadge(connection, state);
	}
	return { state: 'unavailable', label: getMessage('aiRoutingUnavailable') };
}

/** Badge states that mean the route cannot run as configured. Untested and OK show nothing. */
const PROBLEM_STATES: ReadonlySet<ConnectionBadge['state']> = new Set(['failing', 'key-missing', 'unsupported', 'unavailable']);

/**
 * The badge a row shows, if any: only a problem. A task row that follows the default shows the
 * default's problem only once, on the Default row, unless the task resolves differently.
 */
export function routingProblem(state: AiSettingsState, row: RoutingRowKey): ConnectionBadge | undefined {
	const badge = routingBadge(state, row);
	if (!PROBLEM_STATES.has(badge.state)) return undefined;
	if (row === 'default' || state.view.routing.taskProfiles[row]) return badge;
	const fallback = routingBadge(state, 'default');
	return fallback.state === badge.state && fallback.label === badge.label ? undefined : badge;
}

/** Tasks whose stored route differs from Use default. */
export function customizedTaskCount(state: AiSettingsState): number {
	const { routing } = state.view;
	return AI_TASKS.filter(task => {
		const profileId = routing.taskProfiles[task];
		return profileId !== undefined && profileId !== routing.defaultProfileId;
	}).length;
}

interface RoutingOption {
	value: string;
	label: string;
}

interface RoutingOptionGroup {
	label: string;
	options: RoutingOption[];
}

function optionGroups(state: AiSettingsState): RoutingOptionGroup[] {
	return state.view.connections
		.map(connection => ({
			label: connectionDisplayName(connection),
			options: state.view.profiles
				.filter(profile => profile.connectionId === connection.id && profile.enabled)
				.map(profile => ({ value: profile.id, label: profileDisplayName(profile, connection) }))
		}))
		.filter(group => group.options.length > 0);
}

function selectedValue(state: AiSettingsState, row: RoutingRowKey): string {
	const { routing } = state.view;
	return (row === 'default' ? routing.defaultProfileId : routing.taskProfiles[row]) ?? '';
}

/** A stored choice that is no longer offered (disabled or deleted profile) stays visible. */
function unavailableOption(state: AiSettingsState, value: string, groups: RoutingOptionGroup[]): RoutingOption | undefined {
	if (!value || groups.some(group => group.options.some(option => option.value === value))) return undefined;
	const profile = state.view.profiles.find(item => item.id === value);
	const connection = profile && state.view.connections.find(item => item.id === profile.connectionId);
	return {
		value,
		label: profile
			? getMessage('aiRoutingDisabledProfile', profileDisplayName(profile, connection))
			: getMessage('aiRoutingMissingProfile')
	};
}

export function routingPanelState(state: AiSettingsState): unknown {
	const groups = optionGroups(state);
	return {
		groups,
		customized: customizedTaskCount(state),
		rows: ROUTING_ROWS.map(row => {
			const value = selectedValue(state, row);
			return { row, value, unavailable: unavailableOption(state, value, groups) ?? null, badge: routingProblem(state, row) ?? null };
		})
	};
}

export interface RoutingPanelOptions {
	doc: Document;
	controller: AiSettingsController;
	/** `#ai-routing`: the Default model row. */
	container: HTMLElement;
	/** `#ai-routing-tasks`, inside the "Customize per task" disclosure (kept open across renders). */
	tasksContainer: HTMLElement;
	/** `#ai-routing-customize-count`, in the disclosure's summary. */
	summaryCount: HTMLElement;
}

export interface RoutingPanel extends AiSettingsPanel {
	/** Moves focus to the routing table (the error card's "Choose another model"). */
	focus(): void;
}

export function createRoutingPanel(options: RoutingPanelOptions): RoutingPanel {
	const { doc, controller, container, tasksContainer, summaryCount } = options;

	function createSelect(row: RoutingRowKey, state: AiSettingsState, groups: RoutingOptionGroup[]): HTMLSelectElement {
		const select = createElement(doc, 'select', 'ai-routing-select');
		select.id = routingSelectId(row);
		const empty = createElement(doc, 'option', undefined, row === 'default' ? getMessage('aiRoutingNone') : getMessage('aiRoutingUseDefault'));
		empty.value = '';
		select.appendChild(empty);
		for (const group of groups) {
			const optgroup = createElement(doc, 'optgroup');
			optgroup.label = group.label;
			for (const item of group.options) {
				const option = createElement(doc, 'option', undefined, item.label);
				option.value = item.value;
				optgroup.appendChild(option);
			}
			select.appendChild(optgroup);
		}
		const value = selectedValue(state, row);
		const unavailable = unavailableOption(state, value, groups);
		if (unavailable) {
			const option = createElement(doc, 'option', undefined, unavailable.label);
			option.value = unavailable.value;
			option.disabled = true;
			select.appendChild(option);
		}
		select.value = value;
		select.addEventListener('change', () => {
			const next = select.value || undefined;
			const saving = row === 'default'
				? controller.setDefaultProfile(next)
				: controller.setTaskProfile(row, next);
			void saving.then(saved => {
				if (!saved) render(controller.state);
			});
		});
		return select;
	}

	function createRow(row: RoutingRowKey, state: AiSettingsState, groups: RoutingOptionGroup[]): HTMLElement {
		const { item, control } = createSettingItem(doc, {
			label: routingRowLabel(row),
			description: rowDescription(row),
			forId: routingSelectId(row)
		});
		item.classList.add('ai-routing-row');
		item.dataset.row = row;
		if (row === 'default') item.classList.add('mod-default');
		const problem = routingProblem(state, row);
		if (problem) control.appendChild(createBadgeElement(doc, problem));
		control.appendChild(createSelect(row, state, groups));
		return item;
	}

	function render(state: AiSettingsState): void {
		const groups = optionGroups(state);
		container.replaceChildren(createRow('default', state, groups));
		tasksContainer.replaceChildren(...AI_TASKS.map(task => createRow(task, state, groups)));
		const customized = customizedTaskCount(state);
		summaryCount.textContent = customized > 0 ? getMessage('aiRoutingCustomizeChanged', String(customized)) : '';
		const problems = AI_TASKS.filter(task => routingProblem(state, task)).length;
		summaryCount.nextElementSibling?.remove();
		if (problems > 0) {
			summaryCount.after(createBadgeElement(doc, { state: 'failing', label: getMessage('aiRoutingNeedsAttention', String(problems)) }));
		}
	}

	return {
		keys: [AI_CONNECTIONS_KEY, AI_PROFILES_KEY, AI_ROUTING_KEY, AI_CREDENTIALS_KEY, AI_CONNECTION_STATUS_KEY] as readonly AiStorageKey[],
		stateOf: routingPanelState,
		render,
		focus() {
			const select = doc.getElementById(routingSelectId('default')) as HTMLSelectElement | null;
			select?.scrollIntoView?.({ block: 'center' });
			select?.focus();
		}
	};
}
