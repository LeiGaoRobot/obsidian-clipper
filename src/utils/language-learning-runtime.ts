import browser from './browser-polyfill';
import {
	LanguageLearningResponse,
	LearningSelection,
	TranscriptReadingCheckpointStore,
	TranscriptReadingProgressHandler,
	TranscriptReadingSegments,
	TranscriptTranslationProgressHandler,
	createLanguageLearningAssistant,
	isCompleteTranscriptReadings
} from './language-learning';
import { getMessage } from './i18n';
import { raceWithRequestCancellation, throwIfRequestAborted } from './request-cancellation';
import { loadSettings } from './storage-utils';

let languageLearningRequestSequence = 0;
const GROK_JAPANESE_READING_PROMPT_CHAR_LIMIT = 1600;
const CODEX_JAPANESE_READING_PROMPT_CHAR_LIMIT = 2500;
const MIN_CLI_JAPANESE_READING_PROMPT_CHAR_LIMIT = 600;
const MAX_READING_SESSION_ENTRIES = 20;
const japaneseReadingCheckpoints = new Map<string, TranscriptReadingSegments>();
const japaneseReadingPromptLimits = new Map<string, number>();

function getJapaneseReadingSessionKey(scope: string, segments: string[]): string {
	return JSON.stringify([scope, segments]);
}

function cloneTranscriptReadings(readings: TranscriptReadingSegments): TranscriptReadingSegments {
	return readings.map(tokens => tokens.map(token => ({ ...token })));
}

function createJapaneseReadingCheckpointStore(scope: string): TranscriptReadingCheckpointStore {
	return {
		load(segments) {
			const checkpoint = japaneseReadingCheckpoints.get(getJapaneseReadingSessionKey(scope, segments));
			return checkpoint ? cloneTranscriptReadings(checkpoint) : undefined;
		},
		save(segments, readings) {
			const key = getJapaneseReadingSessionKey(scope, segments);
			if (japaneseReadingCheckpoints.has(key)) japaneseReadingCheckpoints.delete(key);
			japaneseReadingCheckpoints.set(key, cloneTranscriptReadings(readings));
			while (japaneseReadingCheckpoints.size > MAX_READING_SESSION_ENTRIES) {
				const oldestKey = japaneseReadingCheckpoints.keys().next().value;
				if (oldestKey === undefined) break;
				japaneseReadingCheckpoints.delete(oldestKey);
			}
		},
		clear(segments) {
			japaneseReadingCheckpoints.delete(getJapaneseReadingSessionKey(scope, segments));
		}
	};
}

function reduceJapaneseReadingPromptLimit(key: string, currentLimit: number): void {
	const nextLimit = Math.max(
		MIN_CLI_JAPANESE_READING_PROMPT_CHAR_LIMIT,
		Math.floor(currentLimit / 2)
	);
	if (japaneseReadingPromptLimits.has(key)) japaneseReadingPromptLimits.delete(key);
	japaneseReadingPromptLimits.set(key, nextLimit);
	while (japaneseReadingPromptLimits.size > MAX_READING_SESSION_ENTRIES) {
		const oldestKey = japaneseReadingPromptLimits.keys().next().value;
		if (oldestKey === undefined) break;
		japaneseReadingPromptLimits.delete(oldestKey);
	}
}

function isCliTimeoutError(error: unknown): error is Error {
	return error instanceof Error && /\bCLI timed out\b/i.test(error.message);
}

function createLanguageLearningRequestId(): string {
	languageLearningRequestSequence += 1;
	return `language-learning-${Date.now()}-${languageLearningRequestSequence}`;
}

async function loadConfiguredAssistant(japaneseReadingSegments?: string[]) {
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
	const japaneseReadingSessionKey = executionMode === 'api' || !japaneseReadingSegments
		? undefined
		: getJapaneseReadingSessionKey(readingCheckpointScope, japaneseReadingSegments);
	const initialJapaneseReadingPromptCharLimit = executionMode === 'grok'
		? GROK_JAPANESE_READING_PROMPT_CHAR_LIMIT
		: CODEX_JAPANESE_READING_PROMPT_CHAR_LIMIT;
	const japaneseReadingPromptCharLimit = executionMode === 'api'
		? undefined
		: japaneseReadingSessionKey
			? japaneseReadingPromptLimits.get(japaneseReadingSessionKey)
				?? initialJapaneseReadingPromptCharLimit
			: initialJapaneseReadingPromptCharLimit;
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
		japaneseReadingPromptCharLimit,
		japaneseReadingCheckpoints: createJapaneseReadingCheckpointStore(readingCheckpointScope)
	});

	return {
		assistant,
		responseLanguage,
		japaneseReadingSessionKey,
		japaneseReadingPromptCharLimit
	};
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
		const {
			assistant,
			japaneseReadingSessionKey,
			japaneseReadingPromptCharLimit
		} = await loadConfiguredAssistant(segments);
		try {
			const readings = await assistant.annotateJapaneseTranscript(segments, onProgress, signal);
			if (japaneseReadingSessionKey && isCompleteTranscriptReadings(readings, segments)) {
				japaneseReadingPromptLimits.delete(japaneseReadingSessionKey);
			}
			return readings;
		} catch (error) {
			if (
				japaneseReadingSessionKey
				&& japaneseReadingPromptCharLimit
				&& isCliTimeoutError(error)
			) {
				reduceJapaneseReadingPromptLimit(
					japaneseReadingSessionKey,
					japaneseReadingPromptCharLimit
				);
				throw new Error(`${error.message} ${getMessage('readerJapaneseReadingsTimeoutRetry')}`);
			}
			throw error;
		}
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
