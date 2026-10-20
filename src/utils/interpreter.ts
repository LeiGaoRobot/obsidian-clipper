import { PromptVariable, Template } from '../types/types';
import { compileTemplate } from './template-compiler';
import { applyFilters } from './filters';
import { createPromptVariableRegex, stringifyValue } from './prompt-variables';
import { formatDuration } from './string-utils';
import { adjustNoteNameHeight } from './ui-utils';
import { debugLog } from './debug';
import { getMessage } from './i18n';
import { updateTokenCount } from './token-counter';
import browser from './browser-polyfill';
import { runAiTask, type AiTaskResult } from '../ai/client';
import { describeAiError } from '../ai/error-messages';
import { toAiError, type AiError } from '../ai/errors';
import type { AiSettingsView } from '../ai/types';
import { createAiAction, type AiAction, type AiActionStatus } from '../ai/ui/action';
import { renderAiErrorCard } from '../ai/ui/error-card';
import {
	listEnabledProfileGroups,
	profileDisplayName,
	routedProfileId,
	saveTaskProfile
} from './ai-profiles';


// Store event listeners for cleanup
const eventListeners = new WeakMap<HTMLElement, { [key: string]: EventListener }>();

export function collectPromptVariables(template: Template | null): PromptVariable[] {
	const promptMap = new Map<string, PromptVariable>();
	const promptRegex = createPromptVariableRegex();
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
 * default) and returns the view with that routing, for the popup to keep in memory. The popup's
 * store never creates v2: before the background has bootstrapped this device (a startup race),
 * the choice is not stored, which is logged, and applies only to runs from this popup, since the
 * select's value is passed with each run.
 */
export async function saveInterpretProfile(profileId: string): Promise<AiSettingsView> {
	const { written, view } = await saveTaskProfile('interpret', profileId);
	if (!written) {
		console.warn('The interpret model choice was not saved: AI settings are not set up on this device yet.');
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
		promptToDisplay = await compileTemplate(tabId, promptToDisplay, variables, currentUrl, { keepPromptVariables: view.enabled });
		promptContextTextarea.value = promptToDisplay;
		
		// Initial token count
		if (tokenCounter) {
			updateTokenCount(promptContextTextarea.value, tokenCounter);
		}
	}

	if (template) {
		// Auto-run starts the first run itself; the button runs it again after a cancel.
		if (interpretBtn) {
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

type InterpretResult = AiTaskResult<'interpret'>;

// One controller per popup document: a newer run aborts the previous one, and a settlement that
// arrives after it (or after a cancel) changes nothing.
let interpreterAction: AiAction<InterpretResult> | undefined;

function getInterpreterAction(): AiAction<InterpretResult> {
	interpreterAction ??= createAiAction<InterpretResult>();
	return interpreterAction;
}

interface InterpreterElements {
	container: HTMLElement | null;
	interpretBtn: HTMLButtonElement;
	cancelBtn: HTMLButtonElement | null;
	message: HTMLDivElement;
	timer: HTMLSpanElement;
	clipButton: HTMLButtonElement;
	moreButton: HTMLButtonElement;
}

/**
 * Runs the template's prompt variables through the `interpret` task and fills the fields with the
 * responses. Resolves with how the run ended: errors are shown in `#interpreter-error`, not thrown.
 * Cancel aborts the request; the error card's Retry sends it again with the context and model the
 * popup shows by then, so a fix made after the error is used.
 */
export async function handleInterpreterUI(
	template: Template,
	variables: { [key: string]: string },
	tabId: number,
	currentUrl: string,
	profileId?: string
): Promise<AiActionStatus> {
	const ui: InterpreterElements = {
		container: document.getElementById('interpreter'),
		interpretBtn: document.getElementById('interpret-btn') as HTMLButtonElement,
		cancelBtn: document.getElementById('interpreter-cancel-btn') as HTMLButtonElement | null,
		message: document.getElementById('interpreter-error') as HTMLDivElement,
		timer: document.getElementById('interpreter-timer') as HTMLSpanElement,
		clipButton: document.getElementById('clip-btn') as HTMLButtonElement,
		moreButton: document.getElementById('more-btn') as HTMLButtonElement
	};
	const promptContextTextarea = document.getElementById('prompt-context') as HTMLTextAreaElement;
	const modelSelect = document.getElementById('model-select') as HTMLSelectElement | null;
	const action = getInterpreterAction();
	if (ui.cancelBtn) ui.cancelBtn.onclick = () => action.cancel();

	// The prompts stay those of this template; the context is read when each run starts.
	const promptVariables = collectPromptVariables(template);
	const launch = (runProfileId: string | undefined) => () => action.start(async signal => {
		if (promptVariables.length === 0) {
			throw new Error('No prompt variables found. Please add at least one prompt variable to your template.');
		}
		const input = { context: promptContextTextarea.value, prompts: promptVariables };
		// The model select's profile is an explicit choice for this run; without one, routing picks.
		return runAiTask('interpret', input, runProfileId ? { profileId: runProfileId, signal } : { signal });
	});
	// A retry takes the select's current choice, as the Interpret button does; without a select
	// offering choices it keeps this run's profile.
	const relaunch = () => launch(modelSelect && modelSelect.options.length > 0 ? modelSelect.value || undefined : profileId)();
	return runInterpreter(ui, promptVariables, launch(profileId), relaunch);
}

/** Drives the Interpreter's controls through one run, which `launch` starts on the controller. */
async function runInterpreter(
	ui: InterpreterElements,
	promptVariables: PromptVariable[],
	launch: () => Promise<InterpretResult | undefined>,
	relaunch: () => Promise<InterpretResult | undefined>
): Promise<AiActionStatus> {
	const action = getInterpreterAction();
	retryFailedRun = undefined;
	const { container, interpretBtn, cancelBtn, message, timer, clipButton, moreButton } = ui;

	// Everything up to the first await runs synchronously, so a Clip that clicks the button sees
	// `processing` at once.
	clearInterpreterMessage(message);
	container?.classList.remove('done', 'partial', 'error');
	interpretBtn.classList.remove('done', 'partial', 'error', 'cancelled');
	interpretBtn.textContent = getMessage('thinking');
	interpretBtn.classList.add('processing');
	clipButton.disabled = true;
	moreButton.disabled = true;
	if (cancelBtn) cancelBtn.hidden = false;
	timer.style.display = 'inline';
	timer.textContent = '0ms';

	const pending = launch();
	const startedAt = action.state.startedAt ?? Date.now();
	const timerInterval = window.setInterval(() => {
		timer.textContent = formatDuration(Date.now() - startedAt);
	}, 10);
	let result: InterpretResult | undefined;
	try {
		result = await pending;
	} finally {
		window.clearInterval(timerInterval);
	}
	const { state } = action;
	// A newer run owns the controls now.
	if (state.status === 'running') return state.status;

	if (cancelBtn) cancelBtn.hidden = true;
	interpretBtn.classList.remove('processing');
	clipButton.disabled = false;
	moreButton.disabled = false;

	if (state.status === 'done' && result) {
		timer.textContent = formatDuration(Date.now() - startedAt);
		try {
			applyInterpretResult(ui, promptVariables, result);
			return 'done';
		} catch (error) {
			showInterpreterFailure(ui, promptVariables, toAiError(error), relaunch);
			return 'error';
		}
	}
	if (state.status === 'error' && state.error) {
		showInterpreterFailure(ui, promptVariables, state.error, relaunch);
		return 'error';
	}
	// Cancelled: the button returns to its idle label and can run again.
	interpretBtn.textContent = getMessage('interpret');
	interpretBtn.classList.add('cancelled');
	timer.style.display = 'none';
	return 'cancelled';
}

function applyInterpretResult(ui: InterpreterElements, promptVariables: PromptVariable[], result: InterpretResult): void {
	const { output: { responses, missing } } = result;
	// Unanswered prompts get no response, so their placeholders stay in the fields.
	const promptResponses = promptVariables
		.filter(variable => Object.prototype.hasOwnProperty.call(responses, variable.key))
		.map(variable => ({
			key: variable.key,
			prompt: variable.prompt,
			user_response: responses[variable.key]
		}));
	debugLog('Interpreter', 'LLM response:', { promptResponses, missing });

	// Update button state; a partial result is never marked done
	const state = missing.length > 0 ? 'partial' : 'done';
	ui.interpretBtn.textContent = getMessage(state === 'done' ? 'done' : 'interpreterPartialStatus').toLowerCase();
	ui.interpretBtn.classList.add(state);
	ui.interpretBtn.disabled = true;
	ui.container?.classList.add(state);
	if (state === 'partial') {
		const unanswered = promptVariables.filter(variable => missing.includes(variable.key));
		showInterpreterPartial(ui.message, unanswered, promptVariables.length);
	}

	// Update fields with responses
	replacePromptVariables(promptVariables, promptResponses);

	// Adjust height for noteNameField after content is replaced
	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement | null;
	if (noteNameField instanceof HTMLTextAreaElement) {
		adjustNoteNameHeight(noteNameField);
	}
}

// The failed run's Retry, for a Clip that needs the Interpreter again; cleared when a run starts.
let retryFailedRun: (() => Promise<AiActionStatus>) | undefined;

function showInterpreterFailure(
	ui: InterpreterElements,
	promptVariables: PromptVariable[],
	error: AiError,
	relaunch: () => Promise<InterpretResult | undefined>
): void {
	console.error('Error processing LLM:', error);
	ui.interpretBtn.textContent = getMessage('error');
	ui.interpretBtn.classList.add('error');
	ui.interpretBtn.disabled = true;
	ui.container?.classList.add('error');
	ui.timer.style.display = 'none';

	const retry = () => {
		ui.interpretBtn.disabled = false;
		return runInterpreter(ui, promptVariables, relaunch, relaunch);
	};
	retryFailedRun = retry;
	renderAiErrorCard(ui.message, describeAiError(error), {
		handlers: {
			// The same prompts again, with the context and model shown now.
			retry: () => { void retry(); },
			openSettings: () => {
				void browser.runtime.sendMessage({ action: 'openOptionsPage', section: 'ai' });
			}
		}
	});
	ui.message.style.display = 'block';
}

function clearInterpreterMessage(container: HTMLElement): void {
	container.replaceChildren();
	container.classList.remove('warning');
	container.style.display = 'none';
}

/** The interpreter left prompts unanswered; the clipper stays visible to show which. */
export class InterpreterPartialError extends Error {}

/** The interpreter run was cancelled; nothing is saved and the clipper stays as it is. */
export class InterpreterCancelledError extends Error {}

/** The interpreter run failed; its error card says why, nothing is saved, and the clipper stays. */
export class InterpreterFailedError extends Error {}

/**
 * What a Clip does before saving when the template has prompts: waits for a running Interpreter,
 * starts it when it has not run, and runs it again after an error, as the card's Retry does (the
 * button is disabled then, so clicking it would do nothing). A shown result, partial or not, is
 * saved as it is. Rejects as `waitForInterpreter` does.
 */
export async function prepareInterpreterForClip(interpretBtn: HTMLButtonElement): Promise<void> {
	const { classList } = interpretBtn;
	if (classList.contains('done') || classList.contains('partial')) return;
	if (!classList.contains('processing')) {
		if (classList.contains('error') && retryFailedRun) void retryFailedRun();
		else interpretBtn.click();
	}
	return waitForInterpreter(interpretBtn);
}

/**
 * Waits for the Interpreter run a Clip depends on by polling the button's state classes. Rejects
 * when the run left prompts unanswered, failed, or was cancelled.
 */
export async function waitForInterpreter(interpretBtn: HTMLButtonElement): Promise<void> {
	return new Promise((resolve, reject) => {
		const checkProcessing = () => {
			if (!interpretBtn.classList.contains('processing')) {
				if (interpretBtn.classList.contains('done')) {
					resolve();
				} else if (interpretBtn.classList.contains('partial')) {
					// Keep the popup open so the unanswered prompts are seen before saving.
					reject(new InterpreterPartialError(getMessage('interpreterPartialTitle')));
				} else if (interpretBtn.classList.contains('error')) {
					reject(new InterpreterFailedError(getMessage('failedToProcessInterpreter')));
				} else if (interpretBtn.classList.contains('cancelled')) {
					reject(new InterpreterCancelledError(getMessage('aiRequestCancelled')));
				} else {
					setTimeout(checkProcessing, 100);
				}
			} else {
				setTimeout(checkProcessing, 100);
			}
		};
		checkProcessing();
	});
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
			input.value = input.value.replace(createPromptVariableRegex(), (match, promptText, filters) => {
				const variable = promptVariables.find(v => v.prompt === promptText);
				if (!variable) return match;

				const response = promptResponses.find(r => r.key === variable.key);
				if (response && response.user_response !== undefined) {
					// Array or object responses as indented JSON
					let value = stringifyValue(response.user_response);

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
