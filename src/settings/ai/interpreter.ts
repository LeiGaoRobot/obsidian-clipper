import { AI_INTERPRETER_KEY, AI_PROMPT_CONTEXT_KEY, type AiStorageKey } from '../../ai/settings';
import { getMessage } from '../../utils/i18n';
import type { AiSettingsController, AiSettingsState } from './controller';
import { createElement, createSettingItem, createToggle, debounce, finishRender, hasFocus, syncToggle } from './dom';
import type { AiSettingsPanel } from './panel';

// Interpreter panel: the AI master switch, auto-run, and the default prompt context. The prompt
// context is saved 500 ms after the last keystroke, which also keeps typing far below the sync
// write-rate limit. When the page is hidden or goes away, an unsaved edit is written at once.

export const PROMPT_CONTEXT_DEBOUNCE_MS = 500;

/** The template editor's prompt-context controls follow the master switch, as before. */
export function updateTemplatePromptContextVisibility(doc: Document, enabled: boolean): void {
	for (const id of ['prompt-context-container', 'template-advanced-section']) {
		const element = doc.getElementById(id);
		if (element) element.style.display = enabled ? 'block' : 'none';
	}
}

export interface InterpreterPanelOptions {
	doc: Document;
	controller: AiSettingsController;
	/** `#ai-interpreter`. */
	container: HTMLElement;
	debounceMs?: number;
}

export interface InterpreterPanel extends AiSettingsPanel {
	/** Dispatches the storage write of an unsaved prompt-context edit before returning. */
	flush(): void;
}

export function interpreterPanelState(state: AiSettingsState): unknown {
	return {
		enabled: state.view.enabled,
		autoRun: state.view.interpreter.autoRun,
		promptContext: state.view.interpreter.defaultPromptContext
	};
}

export function createInterpreterPanel(options: InterpreterPanelOptions): InterpreterPanel {
	const { doc, controller, container } = options;

	const enabledItem = createSettingItem(doc, {
		label: getMessage('aiEnabled'),
		description: getMessage('aiEnabledDescription'),
		forId: 'ai-interpreter-enabled',
		toggle: true
	});
	const enabled = createToggle(doc, 'ai-interpreter-enabled', false);
	enabledItem.control.appendChild(enabled.container);

	const autoRunItem = createSettingItem(doc, {
		label: getMessage('autoRunInterpreter'),
		description: getMessage('autoRunInterpreterDescription'),
		forId: 'ai-interpreter-auto-run',
		toggle: true
	});
	const autoRun = createToggle(doc, 'ai-interpreter-auto-run', false);
	autoRunItem.control.appendChild(autoRun.container);

	const contextItem = createElement(doc, 'div', 'setting-item ai-prompt-context-item');
	const contextLabel = createElement(doc, 'label', undefined, getMessage('defaultInterpreterContext'));
	contextLabel.htmlFor = 'ai-prompt-context';
	const contextDescription = createElement(doc, 'div', 'setting-item-description', getMessage('defaultInterpreterContextDescription'));
	const textarea = createElement(doc, 'textarea');
	textarea.id = 'ai-prompt-context';
	textarea.rows = 4;
	textarea.placeholder = '{{fullHtml}}';
	textarea.spellcheck = false;
	contextItem.append(contextLabel, contextDescription, textarea);

	const items = createElement(doc, 'div', 'setting-items');
	items.append(enabledItem.item, autoRunItem.item, contextItem);
	container.replaceChildren(items);
	finishRender(container);

	function render(state: AiSettingsState): void {
		enabled.input.checked = state.view.enabled;
		syncToggle(enabled.input);
		autoRun.input.checked = state.view.interpreter.autoRun;
		syncToggle(autoRun.input);
		// Never overwrite what the user is typing; the debounced save catches up.
		if (!hasFocus(textarea) && !savePromptContext.pending()) {
			textarea.value = state.view.interpreter.defaultPromptContext;
		}
		updateTemplatePromptContextVisibility(doc, state.view.enabled);
	}

	// The text typed here that is not known to be stored yet.
	let unsaved: string | undefined;
	const savePromptContext = debounce((text: string) => {
		void controller.setPromptContext(text).then(saved => {
			if (saved && unsaved === text) unsaved = undefined;
		});
	}, options.debounceMs ?? PROMPT_CONTEXT_DEBOUNCE_MS);

	/**
	 * For a page that is going away: a queued save needs a storage round trip a closing page never
	 * finishes, so the write is dispatched now. It also covers a debounced save already queued.
	 */
	function flushNow(): void {
		savePromptContext.cancel();
		if (unsaved === undefined) return;
		const text = unsaved;
		unsaved = undefined;
		if (!controller.flushPromptContext(text)) void controller.setPromptContext(text);
	}

	enabled.input.addEventListener('change', () => {
		const checked = enabled.input.checked;
		updateTemplatePromptContextVisibility(doc, checked);
		void controller.setInterpreterEnabled(checked).then(saved => {
			if (!saved) render(controller.state);
		});
	});
	autoRun.input.addEventListener('change', () => {
		void controller.setAutoRun(autoRun.input.checked).then(saved => {
			if (!saved) render(controller.state);
		});
	});
	textarea.addEventListener('input', () => {
		unsaved = textarea.value;
		savePromptContext(textarea.value);
	});
	textarea.addEventListener('change', () => savePromptContext.flush());

	return {
		keys: [AI_INTERPRETER_KEY, AI_PROMPT_CONTEXT_KEY] as readonly AiStorageKey[],
		stateOf: interpreterPanelState,
		render,
		flush: flushNow,
		dispose: flushNow
	};
}
