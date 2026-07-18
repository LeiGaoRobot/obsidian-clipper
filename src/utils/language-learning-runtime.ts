import browser from './browser-polyfill';
import {
	LanguageLearningResponse,
	LearningSelection,
	TranscriptReadingCheckpointStore,
	TranscriptReadingProgressHandler,
	TranscriptReadingSegments,
	TranscriptTranslationProgressHandler,
	createLanguageLearningAssistant
} from './language-learning';
import { getMessage } from './i18n';
import { raceWithRequestCancellation, throwIfRequestAborted } from './request-cancellation';
import { loadSettings } from './storage-utils';

let languageLearningRequestSequence = 0;
const CLI_JAPANESE_READING_PROMPT_CHAR_LIMIT = 2500;
const MAX_READING_CHECKPOINTS = 20;
const japaneseReadingCheckpoints = new Map<string, TranscriptReadingSegments>();

function cloneTranscriptReadings(readings: TranscriptReadingSegments): TranscriptReadingSegments {
	return readings.map(tokens => tokens.map(token => ({ ...token })));
}

function createJapaneseReadingCheckpointStore(scope: string): TranscriptReadingCheckpointStore {
	const getKey = (segments: string[]) => JSON.stringify([scope, segments]);
	return {
		load(segments) {
			const checkpoint = japaneseReadingCheckpoints.get(getKey(segments));
			return checkpoint ? cloneTranscriptReadings(checkpoint) : undefined;
		},
		save(segments, readings) {
			const key = getKey(segments);
			if (japaneseReadingCheckpoints.has(key)) japaneseReadingCheckpoints.delete(key);
			japaneseReadingCheckpoints.set(key, cloneTranscriptReadings(readings));
			while (japaneseReadingCheckpoints.size > MAX_READING_CHECKPOINTS) {
				const oldestKey = japaneseReadingCheckpoints.keys().next().value;
				if (oldestKey === undefined) break;
				japaneseReadingCheckpoints.delete(oldestKey);
			}
		},
		clear(segments) {
			japaneseReadingCheckpoints.delete(getKey(segments));
		}
	};
}

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
	let readingCheckpointScope: string = executionMode;
	if (executionMode === 'api') {
		const enabledModels = settings.models.filter(model => model.enabled);
		const model = enabledModels.find(item => item.id === settings.interpreterModel) || enabledModels[0];
		if (!model) {
			throw new Error(getMessage('aiLanguageToolsRequireModel'));
		}
		readingCheckpointScope = `${executionMode}:${model.id}`;
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
	}, {
		japaneseReadingPromptCharLimit: executionMode === 'api'
			? undefined
			: CLI_JAPANESE_READING_PROMPT_CHAR_LIMIT,
		japaneseReadingCheckpoints: createJapaneseReadingCheckpointStore(readingCheckpointScope)
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
