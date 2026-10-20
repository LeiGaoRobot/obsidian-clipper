import {
	AI_CONNECTIONS_KEY,
	AI_CONNECTION_STATUS_KEY,
	AI_CREDENTIALS_KEY,
	AI_INTERPRETER_KEY,
	AI_PROFILES_KEY,
	AI_ROUTING_KEY,
	type AiStorageKey
} from '../../ai/settings';
import { getMessage } from '../../utils/i18n';
import { connectionBadge } from './connections';
import type { AiSettingsController, AiSettingsState } from './controller';
import { createElement, createIcon, finishRender, syncToggle } from './dom';
import { updateTemplatePromptContextVisibility } from './interpreter';
import type { AiSettingsPanel } from './panel';
import { profileDisplayName } from './profiles';

// Status card at the top of the AI section: the master switch, with a hint when a first model is
// added while AI is off, and a short checklist derived from the settings and the last Tests on
// this device. Nothing here starts a request.

export type StatusCheckState = 'done' | 'todo' | 'warn';

export interface StatusCheck {
	id: 'provider' | 'model' | 'test';
	state: StatusCheckState;
	label: string;
}

/**
 * "2 minutes ago", in the page's language (`lang` may be an extension code such as `zh_CN`),
 * else the browser's.
 */
export function formatRelativeTime(at: number, now: number, locale = ''): string {
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	let format: Intl.RelativeTimeFormat;
	try {
		format = new Intl.RelativeTimeFormat(locale.replace('_', '-') || undefined, { numeric: 'auto' });
	} catch {
		format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	}
	if (minutes < 1) return format.format(0, 'second');
	if (minutes < 60) return format.format(-minutes, 'minute');
	return minutes < 1440 ? format.format(-Math.floor(minutes / 60), 'hour') : format.format(-Math.floor(minutes / 1440), 'day');
}

function providerCheck(state: AiSettingsState): StatusCheck {
	const { connections } = state.view;
	if (connections.length === 0) return { id: 'provider', state: 'todo', label: getMessage('aiStatusCheckNoProvider') };
	const badges = connections.map(connection => connectionBadge(connection, state).state);
	const ok = badges.filter(badge => badge === 'ok').length;
	if (ok > 1) return { id: 'provider', state: 'done', label: getMessage('aiStatusCheckProvidersConnected', String(ok)) };
	if (ok === 1) return { id: 'provider', state: 'done', label: getMessage('aiStatusCheckProviderConnected') };
	if (badges.includes('key-missing')) return { id: 'provider', state: 'warn', label: getMessage('aiStatusKeyMissing') };
	return { id: 'provider', state: 'todo', label: getMessage('aiStatusCheckProviderAdded') };
}

function modelCheck(state: AiSettingsState): StatusCheck {
	const { profiles, connections, routing } = state.view;
	const id = routing.defaultProfileId;
	if (id) {
		const profile = profiles.find(item => item.id === id);
		const connection = profile && connections.find(item => item.id === profile.connectionId);
		if (profile?.enabled && connection) {
			return { id: 'model', state: 'done', label: getMessage('aiStatusCheckDefaultModel', profileDisplayName(profile, connection)) };
		}
		return { id: 'model', state: 'warn', label: getMessage('aiStatusCheckDefaultModelUnavailable') };
	}
	if (profiles.length === 0) return { id: 'model', state: 'todo', label: getMessage('aiStatusCheckNoModel') };
	return { id: 'model', state: 'todo', label: getMessage('aiStatusCheckDefaultModelNotSet') };
}

function testCheck(state: AiSettingsState, now: number, locale?: string): StatusCheck | undefined {
	const ids = new Set(state.view.connections.map(connection => connection.id));
	if (ids.size === 0) return undefined;
	let latest: { state?: 'ok' | 'failing'; testedAt: number } | undefined;
	for (const [id, status] of Object.entries(state.connectionStatus)) {
		if (!ids.has(id) || !status.state || status.testedAt === undefined) continue;
		if (!latest || status.testedAt > latest.testedAt) latest = { state: status.state, testedAt: status.testedAt };
	}
	if (!latest) return { id: 'test', state: 'todo', label: getMessage('aiStatusCheckNotTested') };
	const when = formatRelativeTime(latest.testedAt, now, locale);
	return latest.state === 'ok'
		? { id: 'test', state: 'done', label: getMessage('aiStatusCheckTested', when) }
		: { id: 'test', state: 'warn', label: getMessage('aiStatusCheckTestFailed', when) };
}

/** The checklist under the switch: what is set up, and what is missing, without a "Not set" wall. */
export function statusChecks(state: AiSettingsState, now = Date.now(), locale?: string): StatusCheck[] {
	const test = testCheck(state, now, locale);
	return [providerCheck(state), modelCheck(state), ...(test ? [test] : [])];
}

export interface StatusPanelOptions {
	doc: Document;
	controller: AiSettingsController;
	/** `#ai-status`, at the top of the section; its switch, texts, and list are in settings.html. */
	container: HTMLElement;
}

export function statusPanelState(state: AiSettingsState): unknown {
	return {
		enabled: state.view.enabled,
		profileCount: state.view.profiles.length,
		// With no clock, the Test time reads the same until a Test changes `testedAt`.
		checks: statusChecks(state, 0),
		tested: Object.values(state.connectionStatus).map(status => status.testedAt)
	};
}

export function createStatusPanel(options: StatusPanelOptions): AiSettingsPanel {
	const { doc, controller, container } = options;

	const find = <T extends HTMLElement>(selector: string) => container.querySelector(selector) as T;
	const title = find('.ai-status-title');
	// Adding a model does not turn AI on; the hint says so next to the switch instead.
	const enableHint = find('.ai-enabled-hint');
	const input = find<HTMLInputElement>('input');
	// The title says the state; the switch is named for what it does.
	input.setAttribute('aria-label', getMessage('aiEnabled'));
	const checklist = find('.ai-status-checklist');
	finishRender(container);

	// The profile count of the last render; unknown before the first, so stored models show no hint.
	let knownProfileCount: number | undefined;
	let showEnableHint = false;

	function renderTitle(on: boolean): void {
		title.textContent = on ? getMessage('aiStatusOn') : getMessage('aiStatusOff');
		container.classList.toggle('is-on', on);
	}

	function render(state: AiSettingsState): void {
		input.checked = state.view.enabled;
		syncToggle(input);
		renderTitle(state.view.enabled);
		const profileCount = state.view.profiles.length;
		if (state.view.enabled) showEnableHint = false;
		else if (knownProfileCount === 0 && profileCount > 0) showEnableHint = true;
		knownProfileCount = profileCount;
		enableHint.hidden = !showEnableHint;
		updateTemplatePromptContextVisibility(doc, state.view.enabled);

		checklist.replaceChildren();
		for (const check of statusChecks(state, Date.now(), doc.documentElement.lang)) {
			const item = createElement(doc, 'li', `ai-status-check is-${check.state}`);
			item.dataset.check = check.id;
			item.append(
				check.state === 'todo'
					? createElement(doc, 'span', 'ai-status-check-marker')
					: createIcon(doc, check.state === 'done' ? 'check' : 'alert-triangle'),
				createElement(doc, 'span', 'ai-status-check-label', check.label)
			);
			checklist.appendChild(item);
		}
		finishRender(checklist);
	}

	input.addEventListener('change', () => {
		const checked = input.checked;
		if (checked) {
			showEnableHint = false;
			enableHint.hidden = true;
		}
		renderTitle(checked);
		updateTemplatePromptContextVisibility(doc, checked);
		void controller.setInterpreterEnabled(checked).then(saved => {
			if (!saved) render(controller.state);
		});
	});

	return {
		keys: [
			AI_INTERPRETER_KEY,
			AI_CONNECTIONS_KEY,
			AI_PROFILES_KEY,
			AI_ROUTING_KEY,
			AI_CREDENTIALS_KEY,
			AI_CONNECTION_STATUS_KEY
		] as readonly AiStorageKey[],
		stateOf: statusPanelState,
		render
	};
}
