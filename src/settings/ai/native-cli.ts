import { AI_CONNECTIONS_KEY, type AiStorageKey } from '../../ai/settings';
import type { CliConnectionKind } from '../../ai/types';
import { getMessage } from '../../utils/i18n';
import { wireNativeCliInstallGuide } from '../../utils/native-cli-install';
import type { AiSettingsController, AiSettingsState } from './controller';
import { createElement, createIcon, createSettingItem, createTextButton, finishRender } from './dom';
import type { AiSettingsPanel } from './panel';

// "Add local CLI" (decision 8): one connection per CLI kind, plus the Native Messaging Host
// install guide with its element ids unchanged. Hidden where the browser has no Native Messaging.

export const CLI_KINDS: readonly CliConnectionKind[] = ['cli-codex', 'cli-grok'];

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

function cliName(kind: CliConnectionKind): string {
	return kind === 'cli-codex' ? getMessage('aiCliCodex') : getMessage('aiCliGrok');
}

export function nativeCliPanelState(state: AiSettingsState): unknown {
	return {
		supported: state.view.nativeMessaging !== 'none',
		added: CLI_KINDS.filter(kind => state.view.connections.some(connection => connection.kind === kind))
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
	for (const kind of CLI_KINDS) {
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
	const guide = createElement(doc, 'div', 'native-cli-install-guide');
	const description = createElement(doc, 'div', 'setting-item-description');
	description.id = 'native-cli-install-description';
	const command = createElement(doc, 'code', 'native-cli-install-command');
	command.id = 'native-cli-install-command';
	const copyButton = createTextButton(doc, getMessage('nativeCliInstallCopy'), 'native-cli-install-copy');
	copyButton.id = 'native-cli-install-copy';
	const status = createElement(doc, 'div', 'setting-item-description native-cli-install-status');
	status.id = 'native-cli-install-status';
	status.setAttribute('role', 'status');
	status.setAttribute('aria-live', 'polite');
	guide.append(description, command, copyButton, status);

	container.replaceChildren(item, guide);
	finishRender(container);

	const scoped = {
		getElementById: (id: string) => container.querySelector<HTMLElement>(`[id="${id}"]`)
	};
	const installGuide = options.installGuide
		? wireNativeCliInstallGuide({ doc: scoped, ...options.installGuide })
		: undefined;
	if (!options.installGuide) {
		description.textContent = getMessage('nativeCliInstallUnsupported');
		command.hidden = true;
		copyButton.hidden = true;
	}

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
		pendingCopy() {
			return installGuide?.pendingCopy() ?? Promise.resolve();
		}
	};
}
