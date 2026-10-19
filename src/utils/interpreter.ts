import { generalSettings, saveSettings } from './storage-utils';
import { PromptVariable, Template } from '../types/types';
import { compileTemplate } from './template-compiler';
import { applyFilters } from './filters';
import { formatDuration } from './string-utils';
import { adjustNoteNameHeight } from './ui-utils';
import { debugLog } from './debug';
import { getMessage } from './i18n';
import { updateTokenCount } from './token-counter';
import { runAiTask } from '../ai/client';
import { describeAiError } from '../ai/error-messages';
import { isAiError } from '../ai/errors';
import type { AiSettingsView } from '../ai/types';
import {
	isCliProfile,
	listEnabledProfileGroups,
	profileDisplayName,
	routedProfileId,
	saveTaskProfile
} from './ai-profiles';


// Store event listeners for cleanup
const eventListeners = new WeakMap<HTMLElement, { [key: string]: EventListener }>();

export function collectPromptVariables(template: Template | null): PromptVariable[] {
	const promptMap = new Map<string, PromptVariable>();
	const promptRegex = /{{(?:prompt:)?"([\s\S]*?)"(\|.*?)?}}/g;
	let match;

	function addPrompt(prompt: string, filters: string) {
		if (!promptMap.has(prompt)) {
			const key = `prompt_${promptMap.size + 1}`;
			promptMap.set(prompt, { key, prompt, filters });
		}
	}

	if (template?.noteContentFormat) {
		while ((match = promptRegex.exec(template.noteContentFormat)) !== null) {
			addPrompt(match[1], match[2] || '');
		}
	}

	if (template?.properties) {
		for (const property of template.properties) {
			let propertyValue = property.value;
			while ((match = promptRegex.exec(propertyValue)) !== null) {
				addPrompt(match[1], match[2] || '');
			}
		}
	}

	const allInputs = document.querySelectorAll('input, textarea');
	allInputs.forEach((input) => {
		if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
			let inputValue = input.value;
			while ((match = promptRegex.exec(inputValue)) !== null) {
				addPrompt(match[1], match[2] || '');
			}
		}
	});

	return Array.from(promptMap.values());
}

/**
 * The profile the popup model select starts on: the one routing names for `interpret` (its task
 * entry, else the default). Availability is not checked here; when the profile is disabled or
 * missing the select shows no choice and the gateway's resolver reports `not-configured`.
 */
export function popupInterpretProfileId(view: AiSettingsView): string | undefined {
	return routedProfileId(view, 'interpret');
}

/**
 * Fills the popup model select with every enabled profile, one `<optgroup>` per connection, CLI
 * profiles included so the select is shown whenever any profile is enabled.
 */
export function populatePopupModelSelect(select: HTMLSelectElement, view: AiSettingsView): void {
	const groups = listEnabledProfileGroups(view);
	select.textContent = '';
	for (const group of groups) {
		const optgroup = document.createElement('optgroup');
		optgroup.label = group.label;
		for (const profile of group.profiles) {
			const option = document.createElement('option');
			option.value = profile.id;
			option.textContent = profileDisplayName(profile, group.connection);
			optgroup.appendChild(option);
		}
		select.appendChild(optgroup);
	}
	select.value = popupInterpretProfileId(view) ?? '';
	select.style.display = groups.length > 0 ? 'inline-block' : 'none';
}

/**
 * Persists the popup's model choice as `routing.taskProfiles.interpret` (cleared when it equals the
 * default) and returns the view with that routing, for the popup to keep in memory.
 */
export async function saveInterpretProfile(profileId: string): Promise<AiSettingsView> {
	const { written, view } = await saveTaskProfile('interpret', profileId);
	if (!written) {
		// DERIVED-MODE FALLBACK — delete in Phase 5 Task 9 (the AI_V2_BOOTSTRAP switch), with the
		// `generalSettings` / `saveSettings` imports if nothing else uses them. Until v2 is stored the
		// store write is a no-op, so the choice keeps its v1 effect: an API profile is the v1
		// `interpreterModel` (its id is the v1 model id). A CLI profile has no v1 per-popup
		// equivalent (the mode is global), so it is kept only in the returned in-memory view and
		// passed explicitly with each run.
		if (!isCliProfile(view, profileId)) {
			generalSettings.interpreterModel = profileId;
			await saveSettings();
		}
	}
	return view;
}

export async function initializeInterpreter(
	template: Template,
	variables: { [key: string]: string },
	tabId: number,
	currentUrl: string,
	view: AiSettingsView,
	onViewChange?: (view: AiSettingsView) => void
) {
	const interpreterContainer = document.getElementById('interpreter');
	const interpretBtn = document.getElementById('interpret-btn');
	const promptContextTextarea = document.getElementById('prompt-context') as HTMLTextAreaElement;
	const modelSelect = document.getElementById('model-select') as HTMLSelectElement;

	function removeOldListeners(element: HTMLElement, eventType: string) {
		const listeners = eventListeners.get(element);
		if (listeners && listeners[eventType]) {
			element.removeEventListener(eventType, listeners[eventType]);
		}
	}

	function storeListener(element: HTMLElement, eventType: string, listener: EventListener) {
		let listeners = eventListeners.get(element);
		if (!listeners) {
			listeners = {};
			eventListeners.set(element, listeners);
		}
		removeOldListeners(element, eventType);
		listeners[eventType] = listener;
		element.addEventListener(eventType, listener);
	}

	const promptVariables = collectPromptVariables(template);

	// Hide interpreter if it's disabled or there are no prompt variables
	if (!view.enabled || promptVariables.length === 0) {
		if (interpreterContainer) interpreterContainer.style.display = 'none';
		if (interpretBtn) interpretBtn.style.display = 'none';
		return;
	}

	if (interpreterContainer) interpreterContainer.style.display = 'flex';
	if (interpretBtn) interpretBtn.style.display = 'inline-block';
	
	if (promptContextTextarea) {
		const tokenCounter = document.getElementById('token-counter');
		
		const inputListener = () => {
			template.context = promptContextTextarea.value;
			if (tokenCounter) {
				updateTokenCount(promptContextTextarea.value, tokenCounter);
			}
		};
		
		storeListener(promptContextTextarea, 'input', inputListener);

		let promptToDisplay =
			template.context
			|| view.interpreter.defaultPromptContext
			|| '{{fullHtml|remove_html:("#navbar,.footer,#footer,header,footer,style,script")|strip_tags:("script,h1,h2,h3,h4,h5,h6,meta,a,ol,ul,li,p,em,strong,i,b,s,strike,u,sup,sub,img,video,audio,math,table,cite,td,th,tr,caption")|strip_attr:("alt,src,href,id,content,property,name,datetime,title")}}';
		promptToDisplay = await compileTemplate(tabId, promptToDisplay, variables, currentUrl);
		promptContextTextarea.value = promptToDisplay;
		
		// Initial token count
		if (tokenCounter) {
			updateTokenCount(promptContextTextarea.value, tokenCounter);
		}
	}

	if (template) {
		// Only add click listener if auto-run is disabled
		if (interpretBtn && !view.interpreter.autoRun) {
			const clickListener = async () => {
				// No choice (no enabled profile, or the routed one is unavailable): routing decides.
				await handleInterpreterUI(template, variables, tabId, currentUrl, modelSelect?.value || undefined);
			};
			storeListener(interpretBtn, 'click', clickListener);
		}

		if (modelSelect) {
			const changeListener = async () => {
				const profileId = modelSelect.value;
				if (!profileId) return;
				try {
					onViewChange?.(await saveInterpretProfile(profileId));
				} catch (error) {
					console.error('Error saving the interpret model choice:', error);
				}
			};
			storeListener(modelSelect, 'change', changeListener);

			// Only repopulate if the skeleton hasn't already done it
			if (modelSelect.options.length === 0) {
				populatePopupModelSelect(modelSelect, view);
			}
		}
	}
}

export async function handleInterpreterUI(
	template: Template,
	variables: { [key: string]: string },
	tabId: number,
	currentUrl: string,
	profileId?: string
): Promise<void> {
	const interpreterContainer = document.getElementById('interpreter');
	const interpretBtn = document.getElementById('interpret-btn') as HTMLButtonElement;
	const interpreterErrorMessage = document.getElementById('interpreter-error') as HTMLDivElement;
	const responseTimer = document.getElementById('interpreter-timer') as HTMLSpanElement;
	const clipButton = document.getElementById('clip-btn') as HTMLButtonElement;
	const moreButton = document.getElementById('more-btn') as HTMLButtonElement;
	const promptContextTextarea = document.getElementById('prompt-context') as HTMLTextAreaElement;

	try {
		// Hide any previous error message
		interpreterErrorMessage.style.display = 'none';
		interpreterErrorMessage.textContent = '';
		interpreterErrorMessage.classList.remove('warning');

		// Remove any previous done, partial, or error classes
		interpreterContainer?.classList.remove('done', 'partial', 'error');
		interpretBtn.classList.remove('done', 'partial', 'error');

		const promptVariables = collectPromptVariables(template);

		if (promptVariables.length === 0) {
			throw new Error('No prompt variables found. Please add at least one prompt variable to your template.');
		}

		const contextToUse = promptContextTextarea.value;
		const contentToProcess = variables.content || '';

		// Start the timer
		const startTime = performance.now();
		let timerInterval: number;

		// Change button text and add class
		interpretBtn.textContent = getMessage('thinking');
		interpretBtn.classList.add('processing');

		// Disable the clip button
		clipButton.disabled = true;
		moreButton.disabled = true;

		// Show and update the timer
		responseTimer.style.display = 'inline';
		responseTimer.textContent = '0ms';

		// Update the timer text with elapsed time
		timerInterval = window.setInterval(() => {
			const elapsedTime = performance.now() - startTime;
			responseTimer.textContent = formatDuration(elapsedTime);
		}, 10);

		// The model select's profile is an explicit choice for this run; without one, routing picks.
		const { output: { responses, missing } } = await runAiTask('interpret', {
			context: contextToUse,
			prompts: promptVariables
		}, profileId ? { profileId } : {});
		// Unanswered prompts get no response, so their placeholders stay in the fields.
		const promptResponses = promptVariables
			.filter(variable => Object.prototype.hasOwnProperty.call(responses, variable.key))
			.map(variable => ({
				key: variable.key,
				prompt: variable.prompt,
				user_response: responses[variable.key]
			}));
		debugLog('Interpreter', 'LLM response:', { promptResponses, missing });

		// Stop the timer and update UI
		clearInterval(timerInterval);
		const endTime = performance.now();
		const totalTime = endTime - startTime;
		responseTimer.textContent = formatDuration(totalTime);

		// Update button state; a partial result is never marked done
		const state = missing.length > 0 ? 'partial' : 'done';
		interpretBtn.textContent = getMessage(state === 'done' ? 'done' : 'interpreterPartialStatus').toLowerCase();
		interpretBtn.classList.remove('processing');
		interpretBtn.classList.add(state);
		interpretBtn.disabled = true;
		interpreterContainer?.classList.add(state);
		if (state === 'partial') {
			const unanswered = promptVariables.filter(variable => missing.includes(variable.key));
			showInterpreterPartial(interpreterErrorMessage, unanswered, promptVariables.length);
		}

		// Update fields with responses
		replacePromptVariables(promptVariables, promptResponses);

		// Re-enable clip button
		clipButton.disabled = false;
		moreButton.disabled = false;

		// Adjust height for noteNameField after content is replaced
		const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement | null;
		if (noteNameField instanceof HTMLTextAreaElement) {
			adjustNoteNameHeight(noteNameField);
		}

	} catch (error) {
		console.error('Error processing LLM:', error);
		
		// Revert button text and remove class in case of error
		interpretBtn.textContent = getMessage('error');
		interpretBtn.classList.remove('processing');
		interpretBtn.classList.add('error');
		interpretBtn.disabled = true;

		// Add error class to interpreter container
		interpreterContainer?.classList.add('error');

		// Hide the timer
		responseTimer.style.display = 'none';

		// Display the error message
		showInterpreterError(interpreterErrorMessage, error);

		// Re-enable the clip button
		clipButton.disabled = false;
		moreButton.disabled = false;

		if (isAiError(error)) {
			throw new Error(describeAiError(error).body);
		} else if (error instanceof Error) {
			throw new Error(`${error.message}`);
		} else {
			throw new Error('An unknown error occurred while processing the interpreter request.');
		}
	}
}

function showInterpreterError(container: HTMLElement, error: unknown): void {
	container.replaceChildren();
	if (isAiError(error)) {
		const description = describeAiError(error);
		const title = document.createElement('strong');
		title.textContent = description.title;
		container.append(title, ` ${description.body}`);
		if (description.detail) {
			const details = document.createElement('details');
			const summary = document.createElement('summary');
			summary.textContent = getMessage('readerTechnicalDetails');
			const detail = document.createElement('div');
			detail.textContent = description.detail;
			details.append(summary, detail);
			container.append(details);
		}
	} else {
		container.textContent = error instanceof Error
			? error.message
			: 'An unknown error occurred while processing the interpreter request.';
	}
	container.style.display = 'block';
}

function showInterpreterPartial(container: HTMLElement, unanswered: PromptVariable[], total: number): void {
	container.replaceChildren();
	container.classList.add('warning');
	const title = document.createElement('strong');
	title.textContent = getMessage('interpreterPartialTitle');
	const body = getMessage('interpreterPartialBody', [String(total - unanswered.length), String(total)]);
	const list = document.createElement('ul');
	for (const variable of unanswered) {
		const item = document.createElement('li');
		item.textContent = variable.prompt;
		list.append(item);
	}
	container.append(title, ` ${body}`, list);
	container.style.display = 'block';
}

// Similar to replaceVariables, but happens after the LLM response is received
export function replacePromptVariables(promptVariables: PromptVariable[], promptResponses: any[]) {
	const allInputs = document.querySelectorAll('input, textarea');
	allInputs.forEach((input) => {
		if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
			input.value = input.value.replace(/{{(?:prompt:)?"([\s\S]*?)"(\|[\s\S]*?)?}}/g, (match, promptText, filters) => {
				const variable = promptVariables.find(v => v.prompt === promptText);
				if (!variable) return match;

				const response = promptResponses.find(r => r.key === variable.key);
				if (response && response.user_response !== undefined) {
					let value = response.user_response;
					
					// Handle array or object responses
					if (typeof value === 'object') {
						try {
							value = JSON.stringify(value, null, 2);
						} catch (error) {
							console.error('Error stringifying object:', error);
							value = String(value);
						}
					}

					if (filters) {
						value = applyFilters(value, filters.slice(1));
					}
					
					return value;
				}
				return match; // Return original if no match found
			});

			// Adjust height for noteNameField after updating its value
			if (input.id === 'note-name-field' && input instanceof HTMLTextAreaElement) {
				adjustNoteNameHeight(input);
			}
		}
	});
}
