import browser from './browser-polyfill';
import {
	LanguageLearningResponse,
	LearningSelection,
	TranscriptReadingCheckpointStore,
	TranscriptReadingProgressHandler,
	TranscriptReadingSegments,
	TranscriptTranslationCheckpointStore,
	TranscriptTranslationProgressHandler,
	createLanguageLearningAssistant,
	isCompleteTranscriptReadings
} from './language-learning';
import { getMessage } from './i18n';
import type { NativeCliErrorCode } from './native-cli-contract';
import { raceWithRequestCancellation, throwIfRequestAborted } from './request-cancellation';
import { loadSettings, saveSettings } from './storage-utils';
import { createSessionTranscriptCheckpointStore } from './transcript-checkpoint-storage';
import { configuredLanguageLearningVocabulary } from './language-learning-vocabulary';
import {
	applyJapaneseReadingDictionary,
	resolveJapaneseReadingsFromDictionary
} from './japanese-reading-dictionary';
import {
	configuredJapaneseReadingDictionary,
	listJapaneseReadingDictionary
} from './japanese-reading-dictionary-storage';

let languageLearningRequestSequence = 0;
const GROK_JAPANESE_READING_PROMPT_CHAR_LIMIT = 1600;
const CODEX_JAPANESE_READING_PROMPT_CHAR_LIMIT = 2500;
const MIN_CLI_JAPANESE_READING_PROMPT_CHAR_LIMIT = 600;
const MAX_READING_SESSION_ENTRIES = 20;
const japaneseReadingPromptLimits = new Map<string, number>();

export class LanguageLearningRequestError extends Error {
	code: NativeCliErrorCode | 'failed';
	details?: Record<string, unknown>;

	constructor(
		code: NativeCliErrorCode | 'failed',
		message: string,
		details?: Record<string, unknown>
	) {
		super(message);
		this.name = 'LanguageLearningRequestError';
		this.code = code;
		this.details = details;
	}
}

function getJapaneseReadingSessionKey(scope: string, segments: string[]): string {
	return JSON.stringify([scope, segments]);
}

function cloneTranscriptReadings(readings: TranscriptReadingSegments): TranscriptReadingSegments {
	return readings.map(tokens => tokens.map(token => ({ ...token })));
}

function createJapaneseReadingCheckpointStore(scope: string): TranscriptReadingCheckpointStore {
	return createSessionTranscriptCheckpointStore(
		'japanese-readings',
		scope,
		cloneTranscriptReadings
	);
}

function createTranslationCheckpointStore(scope: string): TranscriptTranslationCheckpointStore {
	return createSessionTranscriptCheckpointStore(
		'translations',
		scope,
		translations => [...translations]
	);
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
	return error instanceof LanguageLearningRequestError
		? error.code === 'timeout'
		: error instanceof Error && /\bCLI timed out\b/i.test(error.message);
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
	let executionScope: string = executionMode;
	if (executionMode === 'api') {
		const enabledModels = settings.models.filter(model => model.enabled);
		const model = enabledModels.find(item => item.id === settings.interpreterModel) || enabledModels[0];
		if (!model) {
			throw new Error(getMessage('aiLanguageToolsRequireModel'));
		}
		executionScope = `${executionMode}:${model.id}`;
	}

	const responseLanguage = settings.readerSettings.learningResponseLanguage.trim()
		|| navigator.language
		|| 'English';
	const japaneseReadingSessionKey = executionMode === 'api' || !japaneseReadingSegments
		? undefined
		: getJapaneseReadingSessionKey(executionScope, japaneseReadingSegments);
	const initialJapaneseReadingPromptCharLimit = executionMode === 'grok'
		? GROK_JAPANESE_READING_PROMPT_CHAR_LIMIT
		: CODEX_JAPANESE_READING_PROMPT_CHAR_LIMIT;
	const japaneseReadingPromptCharLimit = executionMode === 'api'
		? undefined
		: japaneseReadingSessionKey
			? japaneseReadingPromptLimits.get(japaneseReadingSessionKey)
				?? initialJapaneseReadingPromptCharLimit
			: initialJapaneseReadingPromptCharLimit;
	const japaneseReadingCheckpoints = createJapaneseReadingCheckpointStore('shared');
	const transcriptTranslationCheckpoints = createTranslationCheckpointStore(
		`shared:${responseLanguage}`
	);
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
			errorCode?: NativeCliErrorCode | 'failed';
			errorDetails?: Record<string, unknown>;
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
				errorCode?: NativeCliErrorCode | 'failed';
				errorDetails?: Record<string, unknown>;
			}>, signal);
		} finally {
			signal?.removeEventListener('abort', cancelRequest);
		}
		if (!response?.success || !Array.isArray(response.promptResponses)) {
			throw new LanguageLearningRequestError(
				response?.errorCode || 'failed',
				response?.error || getMessage('error'),
				response?.errorDetails
			);
		}
		return response.promptResponses;
	}, {
		japaneseReadingPromptCharLimit,
		japaneseReadingCheckpoints,
		transcriptTranslationCheckpoints
	});

	return {
		assistant,
		responseLanguage,
		executionMode,
		japaneseReadingCheckpoints,
		transcriptTranslationCheckpoints,
		japaneseReadingSessionKey,
		japaneseReadingPromptCharLimit
	};
}

export const configuredLanguageLearning = {
	...configuredLanguageLearningVocabulary,
	...configuredJapaneseReadingDictionary,
	async getExecutionInfo() {
		const settings = await loadSettings();
		const mode = settings.interpreterExecutionMode ?? 'api';
		return {
			mode,
			label: getMessage(mode === 'grok'
				? 'interpreterExecutionModeGrok'
				: mode === 'codex'
					? 'interpreterExecutionModeCodex'
					: 'interpreterExecutionModeApi'),
			promptCharLimit: mode === 'grok'
				? GROK_JAPANESE_READING_PROMPT_CHAR_LIMIT
				: mode === 'codex'
					? CODEX_JAPANESE_READING_PROMPT_CHAR_LIMIT
					: 6000
		};
	},

	async setExecutionMode(mode: 'api' | 'grok' | 'codex'): Promise<void> {
		await saveSettings({ interpreterExecutionMode: mode });
	},

	async saveTranscriptTranslations(segments: string[], translations: string[]): Promise<void> {
		if (translations.length !== segments.length) return;
		const { transcriptTranslationCheckpoints } = await loadConfiguredAssistant();
		await transcriptTranslationCheckpoints.save(segments, [...translations]);
	},

	async saveJapaneseReadings(segments: string[], readings: TranscriptReadingSegments): Promise<void> {
		if (readings.length !== segments.length) return;
		const { japaneseReadingCheckpoints } = await loadConfiguredAssistant(segments);
		await japaneseReadingCheckpoints.save(segments, cloneTranscriptReadings(readings));
	},

	async clearJapaneseReadings(segments: string[]): Promise<void> {
		const { japaneseReadingCheckpoints } = await loadConfiguredAssistant(segments);
		await japaneseReadingCheckpoints.clear(segments);
	},

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
		const dictionary = await listJapaneseReadingDictionary();
		const local = resolveJapaneseReadingsFromDictionary(segments, dictionary);
		if (local.unresolvedIndexes.length === 0) {
			onProgress?.({
				completed: 1,
				total: 1,
				completedSegments: segments.length,
				totalSegments: segments.length,
				readings: cloneTranscriptReadings(local.readings)
			});
			return local.readings;
		}
		const unresolvedSegments = local.unresolvedIndexes.map(index => segments[index]);
		const {
			assistant,
			japaneseReadingSessionKey,
			japaneseReadingPromptCharLimit
		} = await loadConfiguredAssistant(unresolvedSegments);
		const mergeReadings = (generated: TranscriptReadingSegments): TranscriptReadingSegments => {
			const withOverrides = applyJapaneseReadingDictionary(generated, dictionary);
			const merged = cloneTranscriptReadings(local.readings);
			local.unresolvedIndexes.forEach((sourceIndex, generatedIndex) => {
				merged[sourceIndex] = withOverrides[generatedIndex] || [];
			});
			return merged;
		};
		try {
			const readings = await assistant.annotateJapaneseTranscript(
				unresolvedSegments,
				progress => onProgress?.({
					...progress,
					completedSegments: segments.length - unresolvedSegments.length + progress.completedSegments,
					totalSegments: segments.length,
					readings: mergeReadings(progress.readings)
				}),
				signal
			);
			const merged = mergeReadings(readings);
			if (japaneseReadingSessionKey && isCompleteTranscriptReadings(merged, segments)) {
				japaneseReadingPromptLimits.delete(japaneseReadingSessionKey);
			}
			return merged;
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
				const message = `${error.message} ${getMessage('readerJapaneseReadingsTimeoutRetry')}`;
				if (error instanceof LanguageLearningRequestError) {
					throw new LanguageLearningRequestError(error.code, message, error.details);
				}
				throw new Error(message);
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
