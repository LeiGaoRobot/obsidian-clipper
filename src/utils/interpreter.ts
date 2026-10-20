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
import { refreshPromptChips, type PromptChipState } from './prompt-chips';
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

/** The idle line of the AI bar: how many prompts the template has. */
export function interpreterPromptCountText(count: number): string {
	return count === 1
		? getMessage('interpreterPromptCount', [String(count)])
		: getMessage('interpreterPromptCountPlural', [String(count)]);
}

/**
 * Puts the AI bar's line in its idle state for a template with `count` prompts. The popup calls it
 * when it builds the fields, before the Interpreter starts. While a run is showing its state
 * (running, done, partial, or an error), only the count is kept, for a later return to idle.
 */
export function showInterpreterIdle(count: number, doc: Document = document): void {
	const container = doc.getElementById('interpreter');
	const summary = doc.getElementById('interpreter-summary');
	const button = doc.getElementById('interpret-btn');
	if (container) container.dataset.promptCount = String(count);
	const showingRun = ['processing', 'done', 'partial', 'error'].some(state => button?.classList.contains(state));
	if (summary && !showingRun) summary.textContent = interpreterPromptCountText(count);
}

// Bumped when the bar is reset, so a run's late settlement leaves the reset bar alone.
let barGeneration = 0;

/**
 * Returns the AI bar to idle for fields that were just rebuilt or recompiled with their prompts. A
 * shown outcome (done, partial, error, or cancelled) no longer describes those fields, so a Clip
 * runs the Interpreter again instead of saving the placeholders. A running request is kept unless
 * `cancelRunning` (a template switch): a highlight refresh of the same template still wants it.
 */
export function resetInterpreterBar(options: { cancelRunning: boolean }, doc: Document = document): void {
	const button = doc.getElementById('interpret-btn') as HTMLButtonElement | null;
	if (!button) return;
	const running = button.classList.contains('processing');
	if (running && !options.cancelRunning) return;
	if (!running && !['done', 'partial', 'error', 'cancelled'].some(state => button.classList.contains(state))) return;

	barGeneration++;
	if (running) interpreterAction?.cancel();
	retryFailedRun = undefined;
	const container = doc.getElementById('interpreter');
	container?.classList.remove('running', 'done', 'partial', 'error', 'cancelled');
	button.classList.remove('processing', 'done', 'partial', 'error', 'cancelled');
	button.textContent = getMessage('interpreterRun');
	button.disabled = false;
	const cancelBtn = doc.getElementById('interpreter-cancel-btn') as HTMLButtonElement | null;
	if (cancelBtn) cancelBtn.hidden = true;
	const modelSelect = doc.getElementById('model-select') as HTMLSelectElement | null;
	if (modelSelect) modelSelect.disabled = false;
	const timer = doc.getElementById('interpreter-timer');
	if (timer) timer.style.display = 'none';
	const message = doc.getElementById('interpreter-error');
	if (message) clearInterpreterMessage(message);
	for (const id of ['clip-btn', 'more-btn']) {
		const control = doc.getElementById(id) as HTMLButtonElement | null;
		if (control) control.disabled = false;
	}
	const count = Number(container?.dataset.promptCount);
	const summary = doc.getElementById('interpreter-summary');
	if (summary && count > 0) summary.textContent = interpreterPromptCountText(count);
}

function syncPromptChips(state: PromptChipState): void {
	refreshPromptChips(document, { getMessage, state });
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
		return;
	}

	if (interpreterContainer) interpreterContainer.style.display = 'flex';
	showInterpreterIdle(promptVariables.length);
	if (modelSelect) modelSelect.setAttribute('aria-label', getMessage('interpreterModelLabel'));
	
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
	summary: HTMLElement | null;
	modelSelect: HTMLSelectElement | null;
	clipButton: HTMLButtonElement;
	moreButton: HTMLButtonElement;
}

function setSummary(ui: InterpreterElements, text: string): void {
	if (ui.summary) ui.summary.textContent = text;
}

/** The idle line for the bar's template, as `showInterpreterIdle` last set it. */
function idleSummary(ui: InterpreterElements, promptCount: number): string {
	const stored = Number(ui.container?.dataset.promptCount);
	return interpreterPromptCountText(Number.isFinite(stored) && stored > 0 ? stored : promptCount);
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
	const modelSelect = document.getElementById('model-select') as HTMLSelectElement | null;
	const ui: InterpreterElements = {
		container: document.getElementById('interpreter'),
		interpretBtn: document.getElementById('interpret-btn') as HTMLButtonElement,
		cancelBtn: document.getElementById('interpreter-cancel-btn') as HTMLButtonElement | null,
		message: document.getElementById('interpreter-error') as HTMLDivElement,
		timer: document.getElementById('interpreter-timer') as HTMLSpanElement,
		summary: document.getElementById('interpreter-summary'),
		modelSelect,
		clipButton: document.getElementById('clip-btn') as HTMLButtonElement,
		moreButton: document.getElementById('more-btn') as HTMLButtonElement
	};
	const promptContextTextarea = document.getElementById('prompt-context') as HTMLTextAreaElement;
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
	const generation = barGeneration;
	const { container, interpretBtn, cancelBtn, message, timer, modelSelect, clipButton, moreButton } = ui;

	// Everything up to the first await runs synchronously, so a Clip that clicks the button sees
	// `processing` at once. While running, the bar shows progress and Cancel in place of Run.
	clearInterpreterMessage(message);
	container?.classList.remove('done', 'partial', 'error', 'cancelled');
	container?.classList.add('running');
	interpretBtn.classList.remove('done', 'partial', 'error', 'cancelled');
	interpretBtn.textContent = getMessage('interpreterRun');
	interpretBtn.classList.add('processing');
	setSummary(ui, getMessage('interpreterRunningSummary'));
	if (modelSelect) modelSelect.disabled = true;
	syncPromptChips('running');
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
	// A newer run owns the controls now, or the bar was reset for rebuilt fields.
	if (state.status === 'running' || generation !== barGeneration) return state.status;

	if (cancelBtn) cancelBtn.hidden = true;
	interpretBtn.classList.remove('processing');
	container?.classList.remove('running');
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
	// Cancelled: the bar returns to Run, saying the request was cancelled, and can run again.
	interpretBtn.classList.add('cancelled');
	container?.classList.add('cancelled');
	if (modelSelect) modelSelect.disabled = false;
	setSummary(ui, getMessage('aiRequestCancelled'));
	syncPromptChips('idle');
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

	// Update the bar's state; a partial result is never marked done. The bar stays quiet: the
	// outcome, how long it took, and the model, with no further action.
	const state = missing.length > 0 ? 'partial' : 'done';
	ui.interpretBtn.classList.add(state);
	ui.interpretBtn.disabled = true;
	ui.container?.classList.add(state);
	setSummary(ui, state === 'done' ? getMessage('interpreterDoneSummary') : getMessage('interpreterPartialStatus'));
	if (state === 'partial') {
		const unanswered = promptVariables.filter(variable => missing.includes(variable.key));
		showInterpreterPartial(ui.message, unanswered, promptVariables.length);
	}

	// Update fields with responses; prompts left unanswered keep a chip that says so.
	replacePromptVariables(promptVariables, promptResponses);
	syncPromptChips(state === 'partial' ? 'failed' : 'idle');

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
	// The bar becomes the compact error card: its title names the error in place of the controls.
	ui.interpretBtn.classList.add('error');
	ui.interpretBtn.disabled = true;
	ui.container?.classList.add('error');
	if (ui.modelSelect) ui.modelSelect.disabled = false;
	ui.timer.style.display = 'none';
	syncPromptChips('failed');

	const retry = () => {
		ui.interpretBtn.disabled = false;
		return runInterpreter(ui, promptVariables, relaunch, relaunch);
	};
	retryFailedRun = retry;
	renderAiErrorCard(ui.message, describeAiError(error), {
		variant: 'compact',
		source: errorSource(ui.modelSelect, error),
		handlers: {
			// The same prompts again, with the context and model shown now.
			retry: () => { void retry(); },
			openSettings: () => {
				void browser.runtime.sendMessage({ action: 'openOptionsPage', section: 'ai' });
			}
		},
		// Dismiss returns the bar to idle, where another model can be chosen before running again.
		onDismiss: () => {
			retryFailedRun = undefined;
			clearInterpreterMessage(ui.message);
			ui.container?.classList.remove('error');
			ui.interpretBtn.classList.remove('error');
			ui.interpretBtn.disabled = false;
			setSummary(ui, idleSummary(ui, promptVariables.length));
			syncPromptChips('idle');
			ui.interpretBtn.focus();
		}
	});
	ui.message.style.display = 'block';
	// The footer stays in view; this keeps any scroller around the card showing it whole.
	ui.message.scrollIntoView?.({ block: 'nearest' });
}

/**
 * The compact card's line naming what failed: the connection and model of the failed profile as
 * the model select lists them, with the HTTP status when there is one.
 */
function errorSource(select: HTMLSelectElement | null, error: AiError): string | undefined {
	const profileId = error.profileId || select?.value;
	if (!select || !profileId) return undefined;
	const option = Array.from(select.options).find(candidate => candidate.value === profileId);
	const model = option?.textContent?.trim();
	if (!option || !model) return undefined;
	const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label.trim() : '';
	const source = group && group !== model ? getMessage('aiErrorSource', [group, model]) : model;
	return error.status ? getMessage('aiErrorSourceHttp', [source, String(error.status)]) : source;
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
