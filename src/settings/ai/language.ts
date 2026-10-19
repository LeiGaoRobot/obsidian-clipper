import { AI_ROUTING_KEY, type AiStorageKey } from '../../ai/settings';
import { getMessage } from '../../utils/i18n';
import type { AiSettingsController, AiSettingsState } from './controller';
import { createElement, createSettingItem, hasFocus } from './dom';
import type { AiSettingsPanel } from './panel';

// Language panel: the response language for translations and explanations
// (`ai_routing.responseLanguage`). Blank uses the browser language.

/** The suggestions the Reader's response-language control offered. */
export const RESPONSE_LANGUAGE_SUGGESTIONS: readonly string[] = [
	'English',
	'Simplified Chinese',
	'Traditional Chinese',
	'Japanese',
	'Korean',
	'Spanish',
	'French',
	'German'
];

export interface LanguagePanelOptions {
	doc: Document;
	controller: AiSettingsController;
	/** `#ai-language`. */
	container: HTMLElement;
}

export function languagePanelState(state: AiSettingsState): unknown {
	return { responseLanguage: state.view.routing.responseLanguage ?? '' };
}

export function createLanguagePanel(options: LanguagePanelOptions): AiSettingsPanel {
	const { doc, controller, container } = options;
	const { item, info, control } = createSettingItem(doc, {
		label: getMessage('readerLearningResponseLanguage'),
		description: getMessage('readerLearningResponseLanguageDescription'),
		forId: 'ai-response-language'
	});
	const effective = createElement(doc, 'div', 'setting-item-description');
	effective.id = 'ai-response-language-effective';
	effective.setAttribute('aria-live', 'polite');
	info.appendChild(effective);

	const input = createElement(doc, 'input');
	input.type = 'text';
	input.id = 'ai-response-language';
	input.setAttribute('list', 'ai-response-language-options');
	input.setAttribute('aria-describedby', effective.id);
	input.placeholder = getMessage('readerLearningResponseLanguagePlaceholder');
	input.autocomplete = 'off';
	input.maxLength = 100;
	const datalist = createElement(doc, 'datalist');
	datalist.id = 'ai-response-language-options';
	for (const language of RESPONSE_LANGUAGE_SUGGESTIONS) {
		const option = createElement(doc, 'option');
		option.value = language;
		datalist.appendChild(option);
	}
	control.append(input, datalist);
	const items = createElement(doc, 'div', 'setting-items');
	items.appendChild(item);
	container.replaceChildren(items);

	function updateEffective(): void {
		const language = input.value.trim();
		effective.textContent = language
			? getMessage('readerLearningResponseLanguageEffective', language)
			: getMessage('readerLearningResponseLanguageBrowser');
	}

	function render(state: AiSettingsState): void {
		if (!hasFocus(input)) input.value = state.view.routing.responseLanguage ?? '';
		updateEffective();
	}

	input.addEventListener('input', updateEffective);
	input.addEventListener('change', () => {
		void controller.setResponseLanguage(input.value).then(saved => {
			// A refused write shows the stored value again.
			input.value = saved ? input.value.trim() : controller.state.view.routing.responseLanguage ?? '';
			updateEffective();
		});
	});

	return {
		keys: [AI_ROUTING_KEY] as readonly AiStorageKey[],
		stateOf: languagePanelState,
		render
	};
}
