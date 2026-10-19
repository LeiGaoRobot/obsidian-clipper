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

// Task routing (decision 8): Default on top, then one row per task. Each row's badge follows the
// profile the resolver would pick, which is what the old readiness assistant answered.

export type RoutingRowKey = 'default' | AiTask;

export const ROUTING_ROWS: readonly RoutingRowKey[] = ['default', ...AI_TASKS];

export function routingSelectId(row: RoutingRowKey): string {
	return `ai-routing-${row}`;
}

function rowLabel(row: RoutingRowKey): string {
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
		rows: ROUTING_ROWS.map(row => {
			const value = selectedValue(state, row);
			return { row, value, unavailable: unavailableOption(state, value, groups) ?? null, badge: routingBadge(state, row) };
		})
	};
}

export interface RoutingPanelOptions {
	doc: Document;
	controller: AiSettingsController;
	/** `#ai-routing`. */
	container: HTMLElement;
}

export interface RoutingPanel extends AiSettingsPanel {
	/** Moves focus to the routing table (the error card's "Choose another model"). */
	focus(): void;
}

export function createRoutingPanel(options: RoutingPanelOptions): RoutingPanel {
	const { doc, controller, container } = options;

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

	function render(state: AiSettingsState): void {
		const groups = optionGroups(state);
		const items = createElement(doc, 'div', 'setting-items ai-routing-table');
		for (const row of ROUTING_ROWS) {
			const { item, control } = createSettingItem(doc, {
				label: rowLabel(row),
				description: rowDescription(row),
				forId: routingSelectId(row)
			});
			item.classList.add('ai-routing-row');
			item.dataset.row = row;
			if (row === 'default') item.classList.add('mod-default');
			control.append(createBadgeElement(doc, routingBadge(state, row)), createSelect(row, state, groups));
			items.appendChild(item);
		}
		container.replaceChildren(items);
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
