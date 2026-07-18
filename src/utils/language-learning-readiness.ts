import type { Settings } from '../types/types';
import { getMessage } from './i18n';

export type ReadinessState = 'ready' | 'pending' | 'error';

export interface LanguageLearningReadinessStep {
	id: 'enabled' | 'engine' | 'language';
	state: ReadinessState;
	label: string;
}

export interface LanguageLearningReadiness {
	ready: boolean;
	mode: 'api' | 'grok' | 'codex';
	steps: LanguageLearningReadinessStep[];
}

export function assessLanguageLearningReadiness(
	settings: Settings,
	cliState: ReadinessState = 'pending'
): LanguageLearningReadiness {
	const mode = settings.interpreterExecutionMode ?? 'api';
	const enabledModels = settings.models.filter(model => model.enabled);
	const selectedModel = enabledModels.find(model => model.id === settings.interpreterModel) || enabledModels[0];
	const selectedProvider = selectedModel
		? settings.providers.find(provider => provider.id === selectedModel.providerId)
		: undefined;
	const apiReady = Boolean(
		selectedModel
		&& selectedProvider?.baseUrl.trim()
		&& (!selectedProvider.apiKeyRequired || selectedProvider.apiKey.trim())
	);
	const enabledState: ReadinessState = settings.interpreterEnabled ? 'ready' : 'error';
	const engineState: ReadinessState = mode === 'api'
		? apiReady ? 'ready' : 'error'
		: cliState;
	const language = settings.readerSettings.learningResponseLanguage.trim();
	const steps: LanguageLearningReadinessStep[] = [
		{
			id: 'enabled',
			state: enabledState,
			label: getMessage(settings.interpreterEnabled
				? 'languageLearningReadinessEnabled'
				: 'languageLearningReadinessEnable')
		},
		{
			id: 'engine',
			state: engineState,
			label: getMessage(mode === 'api'
				? apiReady
					? 'languageLearningReadinessApiReady'
					: selectedModel
						? 'languageLearningReadinessApiConfigMissing'
						: 'languageLearningReadinessApiMissing'
				: cliState === 'ready'
					? 'languageLearningReadinessCliReady'
					: cliState === 'error'
						? 'languageLearningReadinessCliFailed'
						: 'languageLearningReadinessCliUnchecked')
		},
		{
			id: 'language',
			state: 'ready',
			label: language
				? getMessage('languageLearningReadinessLanguage', language)
				: getMessage('languageLearningReadinessBrowserLanguage')
		}
	];
	return {
		ready: enabledState === 'ready' && engineState === 'ready',
		mode,
		steps
	};
}

interface ReadinessUiOptions {
	doc: Document;
	getSettings: () => Settings;
	checkCli: (mode: 'grok' | 'codex') => Promise<void>;
}

export interface LanguageLearningReadinessController {
	refresh: () => void;
	pendingCheck: () => Promise<void>;
}

export function wireLanguageLearningReadiness({
	doc,
	getSettings,
	checkCli
}: ReadinessUiOptions): LanguageLearningReadinessController {
	const root = doc.getElementById('language-learning-readiness') as HTMLDetailsElement | null;
	const summary = root?.querySelector('summary');
	const stepsElement = doc.getElementById('language-learning-readiness-steps');
	const checkButton = doc.getElementById('language-learning-readiness-check') as HTMLButtonElement | null;
	const status = doc.getElementById('language-learning-readiness-status');
	let cliState: ReadinessState = 'pending';
	let checkedMode: 'grok' | 'codex' | null = null;
	let checkPromise = Promise.resolve();

	const refresh = () => {
		if (!root || !summary || !stepsElement || !checkButton || !status) return;
		const settings = getSettings();
		const mode = settings.interpreterExecutionMode ?? 'api';
		if (mode !== checkedMode && mode !== 'api') cliState = 'pending';
		const readiness = assessLanguageLearningReadiness(settings, cliState);
		summary.textContent = readiness.ready
			? getMessage('languageLearningReadinessReady')
			: getMessage('languageLearningReadinessTitle');
		stepsElement.replaceChildren();
		for (const step of readiness.steps) {
			const item = doc.createElement('li');
			item.dataset.readinessStep = step.id;
			item.className = `language-learning-readiness-step is-${step.state}`;
			item.textContent = step.label;
			stepsElement.appendChild(item);
		}
		checkButton.textContent = mode === 'api'
			? getMessage('languageLearningReadinessReview')
			: getMessage('nativeCliHealthCheck');
		checkButton.disabled = false;
		status.textContent = readiness.ready
			? getMessage('languageLearningReadinessReadyDescription')
			: getMessage('languageLearningReadinessIncomplete');
		status.classList.toggle('is-success', readiness.ready);
		status.classList.toggle('is-error', !readiness.ready && cliState === 'error');
		root.open = !readiness.ready;
	};

	checkButton?.addEventListener('click', () => {
		checkPromise = (async () => {
			const mode = getSettings().interpreterExecutionMode ?? 'api';
			if (mode === 'api') {
				refresh();
				return;
			}
			checkButton.disabled = true;
			status!.textContent = getMessage('nativeCliHealthChecking');
			try {
				await checkCli(mode);
				checkedMode = mode;
				cliState = 'ready';
			} catch {
				checkedMode = mode;
				cliState = 'error';
			}
			refresh();
		})();
	});

	refresh();
	return {
		refresh,
		pendingCheck: () => checkPromise
	};
}
