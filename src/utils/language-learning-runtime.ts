import browser from './browser-polyfill';
import {
	LanguageLearningResponse,
	LearningSelection,
	TranscriptReadingProgressHandler,
	TranscriptReadingSegments,
	TranscriptTranslationProgressHandler,
	createLanguageLearningAssistant
} from './language-learning';
import { getMessage } from './i18n';
import { raceWithRequestCancellation, throwIfRequestAborted } from './request-cancellation';
import { loadSettings } from './storage-utils';

let languageLearningRequestSequence = 0;

function createLanguageLearningRequestId(): string {
	languageLearningRequestSequence += 1;
	return `language-learning-${Date.now()}-${languageLearningRequestSequence}`;
}

async function loadConfiguredAssistant() {
	const settings = await loadSettings();
	if (!settings.interpreterEnabled) {
		throw new Error(getMessage('aiLanguageToolsRequireInterpreter'));
	}

	const executionMode = settings.interpreterExecutionMode ?? 'api';
	if (executionMode === 'api') {
		const enabledModels = settings.models.filter(model => model.enabled);
		const model = enabledModels.find(item => item.id === settings.interpreterModel) || enabledModels[0];
		if (!model) {
			throw new Error(getMessage('aiLanguageToolsRequireModel'));
		}
	}

	const responseLanguage = settings.readerSettings.learningResponseLanguage.trim()
		|| navigator.language
		|| 'English';
	const assistant = createLanguageLearningAssistant(async (request, signal) => {
		throwIfRequestAborted(signal);
		const requestId = createLanguageLearningRequestId();
		const cancelRequest = () => {
			void Promise.resolve(browser.runtime.sendMessage({
				action: 'languageLearningCancel',
				requestId
			})).catch(() => {});
		};
		signal?.addEventListener('abort', cancelRequest, { once: true });
		let response: {
			success: boolean;
			promptResponses?: LanguageLearningResponse[];
			error?: string;
		};
		try {
			response = await raceWithRequestCancellation(browser.runtime.sendMessage({
				action: 'languageLearningRequest',
				requestId,
				request
			}) as Promise<{
				success: boolean;
				promptResponses?: LanguageLearningResponse[];
				error?: string;
			}>, signal);
		} finally {
			signal?.removeEventListener('abort', cancelRequest);
		}
		if (!response?.success || !Array.isArray(response.promptResponses)) {
			throw new Error(response?.error || getMessage('error'));
		}
		return response.promptResponses;
	});

	return { assistant, responseLanguage };
}

export const configuredLanguageLearning = {
	async transformContent(content: string, instruction: string, signal?: AbortSignal): Promise<string> {
		const { assistant, responseLanguage } = await loadConfiguredAssistant();
		const resolvedInstruction = instruction.replace(/{{responseLanguage}}/g, responseLanguage);
		return assistant.transformContent(content, resolvedInstruction, signal);
	},

	async explainSelection(selection: LearningSelection, signal?: AbortSignal): Promise<string> {
		const { assistant, responseLanguage } = await loadConfiguredAssistant();
		return assistant.explainSelection(selection, responseLanguage, signal);
	},

	async annotateJapaneseTranscript(
		segments: string[],
		onProgress?: TranscriptReadingProgressHandler,
		signal?: AbortSignal
	): Promise<TranscriptReadingSegments> {
		const { assistant } = await loadConfiguredAssistant();
		return assistant.annotateJapaneseTranscript(segments, onProgress, signal);
	},

	async translateTranscript(
		segments: string[],
		onProgress?: TranscriptTranslationProgressHandler,
		signal?: AbortSignal
	): Promise<string[]> {
		const { assistant, responseLanguage } = await loadConfiguredAssistant();
		return assistant.translateTranscript(segments, responseLanguage, onProgress, signal);
	}
};
