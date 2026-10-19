import { aiSettingsBootstrapper } from '../../ai/migrate';
import type { AiSettingsStore, AiStorageKey } from '../../ai/settings';
import { createBrowserAiSettingsStore } from '../../utils/ai-settings';
import browser from '../../utils/browser-polyfill';
import { createAiSettingsController, type AiSettingsController, type AiSettingsControllerOptions } from './controller';
import { createConnectionsPanel } from './connections';
import { renderErrorCard } from './error-card';
import { createInterpreterPanel } from './interpreter';
import { createLanguagePanel } from './language';
import { createNativeCliPanel, type NativeCliInstallEnvironment } from './native-cli';
import type { AiSettingsPanel } from './panel';
import { createProfilesPanel } from './profiles';
import { createRoutingPanel } from './routing';

// Entry of the AI settings section (lazy `settings-ai` chunk once Task 9 wires it). Loads the view,
// builds the panels into their static containers, and re-renders a panel when the controller or
// `storage.onChanged` reports one of its keys and what it shows actually changed.

export interface InitializeAiSettingsOptions {
	doc?: Document;
	/** Defaults to a browser store that runs the v1 → v2 bootstrap. */
	store?: AiSettingsStore;
	createId?: AiSettingsControllerOptions['createId'];
	/** Defaults to the runtime's platform and the unpacked build's `native-host-install.json`. */
	installGuide?: NativeCliInstallEnvironment | (() => Promise<NativeCliInstallEnvironment | undefined>);
	confirm?: (message: string) => boolean;
	promptContextDebounceMs?: number;
}

export interface AiSettingsSection {
	controller: AiSettingsController;
	/** Saves pending edits and stops listening to storage. */
	dispose(): void;
}

/** What the unpacked-extension install guide needs; packaged builds have no workspace root. */
export async function resolveNativeCliInstallEnvironment(doc: Document): Promise<NativeCliInstallEnvironment> {
	let platform = '';
	let workspaceRoot: string | undefined;
	try {
		platform = (await browser.runtime.getPlatformInfo()).os;
	} catch {
		// The manual setup stays unavailable when the platform cannot be verified.
	}
	try {
		const response = await fetch(browser.runtime.getURL('native-host-install.json'));
		if (response.ok) {
			const metadata = await response.json() as { workspaceRoot?: unknown };
			if (typeof metadata.workspaceRoot === 'string' && metadata.workspaceRoot.startsWith('/')) {
				workspaceRoot = metadata.workspaceRoot;
			}
		}
	} catch {
		// Packaged builds intentionally exclude the local source path.
	}
	return {
		extensionId: browser.runtime.id,
		platform,
		isChrome: doc.documentElement.classList.contains('is-chrome'),
		...(workspaceRoot ? { workspaceRoot } : {}),
		copyText: async text => {
			if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable.');
			await navigator.clipboard.writeText(text);
		}
	};
}

function requireContainer(doc: Document, id: string): HTMLElement {
	const element = doc.getElementById(id);
	if (!element) throw new Error(`AI settings container #${id} is missing.`);
	return element;
}

export async function initializeAiSettings(options: InitializeAiSettingsOptions = {}): Promise<AiSettingsSection> {
	const doc = options.doc ?? document;
	const store = options.store ?? createBrowserAiSettingsStore(aiSettingsBootstrapper);
	const errorContainer = requireContainer(doc, 'ai-settings-error');

	let showError: (error: unknown) => void = () => {};
	const controller = createAiSettingsController({
		store,
		...(options.createId ? { createId: options.createId } : {}),
		onError: error => showError(error)
	});

	const installGuide = typeof options.installGuide === 'function'
		? options.installGuide()
		: options.installGuide
			? Promise.resolve(options.installGuide)
			: resolveNativeCliInstallEnvironment(doc);
	const [loaded, environment] = await Promise.all([
		controller.load().then(() => true, error => {
			renderErrorCard(errorContainer, error);
			return false;
		}),
		installGuide.catch(() => undefined)
	]);

	const confirm = options.confirm;
	const connections = createConnectionsPanel({ doc, controller, container: requireContainer(doc, 'ai-connections'), ...(confirm ? { confirm } : {}) });
	const nativeCli = createNativeCliPanel({
		doc,
		controller,
		container: requireContainer(doc, 'ai-add-local-cli'),
		...(environment ? { installGuide: environment } : {})
	});
	const profiles = createProfilesPanel({ doc, controller, container: requireContainer(doc, 'ai-profiles'), ...(confirm ? { confirm } : {}) });
	const routing = createRoutingPanel({ doc, controller, container: requireContainer(doc, 'ai-routing') });
	const language = createLanguagePanel({ doc, controller, container: requireContainer(doc, 'ai-language') });
	const interpreter = createInterpreterPanel({
		doc,
		controller,
		container: requireContainer(doc, 'ai-interpreter'),
		...(options.promptContextDebounceMs !== undefined ? { debounceMs: options.promptContextDebounceMs } : {})
	});
	const panels: AiSettingsPanel[] = [connections, nativeCli, profiles, routing, language, interpreter];

	showError = error => renderErrorCard(errorContainer, error, {
		handlers: {
			switchProfile: () => routing.focus(),
			...(nativeCli.canCopyInstallCommand() ? { copyInstallCommand: () => nativeCli.copyInstallCommand() } : {})
		},
		onDismiss: () => controller.clearError()
	});
	if (loaded) showError(controller.error);

	const rendered = new Map<AiSettingsPanel, string>();
	function renderPanel(panel: AiSettingsPanel, force = false): void {
		const serialized = JSON.stringify(panel.stateOf(controller.state));
		if (!force && rendered.get(panel) === serialized) return;
		rendered.set(panel, serialized);
		panel.render(controller.state);
	}
	for (const panel of panels) renderPanel(panel, true);

	const stopController = controller.subscribe((keys: readonly AiStorageKey[]) => {
		for (const panel of panels) {
			if (panel.keys.some(key => keys.includes(key))) renderPanel(panel);
		}
	});
	const stopObserving = store.observe(change => {
		if (change.area === 'session') return;
		void controller.reload(change.keys);
	});

	return {
		controller,
		dispose() {
			stopObserving();
			stopController();
			for (const panel of panels) panel.dispose?.();
		}
	};
}
