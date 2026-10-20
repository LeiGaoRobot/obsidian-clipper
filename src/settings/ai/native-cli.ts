import { AI_CONNECTIONS_KEY, type AiStorageKey } from '../../ai/settings';
import { CLI_CONNECTION_KINDS, type CliConnectionKind } from '../../ai/types';
import { getMessage } from '../../utils/i18n';
import { wireNativeCliInstallGuide } from '../../utils/native-cli-install';
import type { AiSettingsController, AiSettingsState } from './controller';
import { createElement, createIcon, createSettingItem, createTextButton, finishRender } from './dom';
import type { AiSettingsPanel } from './panel';

// "Add local CLI" (decision 8): one connection per CLI kind, plus the Native Messaging Host
// install guide (element ids unchanged) behind a disclosure. Hidden where the browser has no
// Native Messaging.

/** What the install guide needs from the browser; resolved once by the section. */
export interface NativeCliInstallEnvironment {
	extensionId: string;
	platform: string;
	isChrome: boolean;
	workspaceRoot?: string;
	copyText: (text: string) => Promise<void>;
}

export interface NativeCliPanelOptions {
	doc: Document;
	controller: AiSettingsController;
	/** `#ai-add-local-cli`. */
	container: HTMLElement;
	installGuide?: NativeCliInstallEnvironment;
}

export interface NativeCliPanel extends AiSettingsPanel {
	/** Clicks the install guide's copy button, when it is offered. */
	copyInstallCommand(): void;
	/** Whether the copy button is offered on this platform. */
	canCopyInstallCommand(): boolean;
	pendingCopy(): Promise<void>;
}

export interface InstallGuide {
	element: HTMLElement;
	copyButton: HTMLButtonElement;
	pendingCopy(): Promise<void>;
}

/**
 * The Host install guide: description, command, Copy, and its status. `ids` puts the element ids
 * on it, which only the "Add local CLI" copy has; a CLI card's copy has none.
 */
export function createInstallGuide(doc: Document, environment: NativeCliInstallEnvironment | undefined, ids: boolean, className = ''): InstallGuide {
	const element = createElement(doc, 'div', `native-cli-install-guide ${className}`);
	const parts: Record<string, HTMLElement> = {
		'native-cli-install-description': createElement(doc, 'div', 'setting-item-description'),
		'native-cli-install-command': createElement(doc, 'code', 'native-cli-install-command'),
		'native-cli-install-copy': createTextButton(doc, getMessage('nativeCliInstallCopy'), 'native-cli-install-copy'),
		'native-cli-install-status': createElement(doc, 'div', 'setting-item-description native-cli-install-status')
	};
	for (const [id, part] of Object.entries(parts)) {
		if (ids) part.id = id;
		element.appendChild(part);
	}
	const status = parts['native-cli-install-status'];
	status.setAttribute('role', 'status');
	status.setAttribute('aria-live', 'polite');
	const copyButton = parts['native-cli-install-copy'] as HTMLButtonElement;
	const wired = environment
		? wireNativeCliInstallGuide({ doc: { getElementById: id => parts[id] ?? null }, ...environment })
		: undefined;
	if (!environment) {
		parts['native-cli-install-description'].textContent = getMessage('nativeCliInstallUnsupported');
		parts['native-cli-install-command'].hidden = true;
		copyButton.hidden = true;
	}
	return { element, copyButton, pendingCopy: () => wired?.pendingCopy() ?? Promise.resolve() };
}

function cliName(kind: CliConnectionKind): string {
	return kind === 'cli-codex' ? getMessage('aiCliCodex') : getMessage('aiCliGrok');
}

export function nativeCliPanelState(state: AiSettingsState): unknown {
	return {
		supported: state.view.nativeMessaging !== 'none',
		added: CLI_CONNECTION_KINDS.filter(kind => state.view.connections.some(connection => connection.kind === kind))
	};
}

export function createNativeCliPanel(options: NativeCliPanelOptions): NativeCliPanel {
	const { doc, controller, container } = options;
	const { item, control } = createSettingItem(doc, {
		label: getMessage('aiAddLocalCli'),
		description: getMessage('aiAddLocalCliDescription')
	});
	item.classList.add('ai-native-cli-item');
	control.classList.add('ai-native-cli-actions');
	const buttons = new Map<CliConnectionKind, HTMLButtonElement>();
	for (const kind of CLI_CONNECTION_KINDS) {
		const button = createTextButton(doc, '', 'ai-add-cli-button');
		button.dataset.kind = kind;
		button.append(createIcon(doc, 'terminal'), createElement(doc, 'span', undefined, getMessage('aiAddCli', cliName(kind))));
		button.addEventListener('click', () => {
			button.disabled = true;
			void controller.addCliConnection(kind).finally(() => render(controller.state));
		});
		buttons.set(kind, button);
		control.appendChild(button);
	}

	// The guide markup lives here (not in settings.html), so it exists only where the control does.
	// The command is needed once per computer, so it stays behind a disclosure here; a CLI card
	// whose Host check failed shows it directly.
	const guide = createInstallGuide(doc, options.installGuide, true);
	const { copyButton } = guide;
	const setup = createElement(doc, 'details', 'ai-native-cli-setup');
	setup.id = 'ai-native-cli-setup';
	setup.append(createElement(doc, 'summary', undefined, getMessage('aiNativeHostSetup')), guide.element);

	container.replaceChildren(item, setup);
	finishRender(container);

	function render(state: AiSettingsState): void {
		container.hidden = state.view.nativeMessaging === 'none';
		for (const [kind, button] of buttons) {
			const added = state.view.connections.some(connection => connection.kind === kind);
			button.disabled = added;
			button.title = added ? getMessage('aiCliAlreadyAdded', cliName(kind)) : '';
		}
	}

	return {
		keys: [AI_CONNECTIONS_KEY] as readonly AiStorageKey[],
		stateOf: nativeCliPanelState,
		render,
		copyInstallCommand() {
			if (!copyButton.hidden) copyButton.click();
		},
		canCopyInstallCommand() {
			return !container.hidden && !copyButton.hidden;
		},
		pendingCopy: guide.pendingCopy
	};
}
