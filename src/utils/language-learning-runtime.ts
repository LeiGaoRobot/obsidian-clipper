import { runAiTask } from '../ai/client';
import { describeAiError } from '../ai/error-messages';
import { toAiError, type AiErrorCode } from '../ai/errors';
import {
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
import { RequestCancelledError, throwIfRequestAborted } from './request-cancellation';
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

const GROK_JAPANESE_READING_PROMPT_CHAR_LIMIT = 1600;
const CODEX_JAPANESE_READING_PROMPT_CHAR_LIMIT = 2500;
const MIN_CLI_JAPANESE_READING_PROMPT_CHAR_LIMIT = 600;
const CLI_TRANSCRIPT_TRANSLATION_PROMPT_CHAR_LIMIT = 6000;
const MIN_CLI_TRANSCRIPT_TRANSLATION_PROMPT_CHAR_LIMIT = 1200;
const MAX_AUTOMATIC_TRANSCRIPT_TIMEOUT_RETRIES = 3;
const MAX_ADAPTIVE_SESSION_ENTRIES = 20;
const JAPANESE_TRANSLATION_CHECKPOINT_SCOPE = 'japanese-readings:Japanese';
const japaneseReadingPromptLimits = new Map<string, number>();
const transcriptTranslationPromptLimits = new Map<string, number>();

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

function getTranscriptTranslationSessionKey(
	executionScope: string,
	checkpointScope: string,
	segments: string[]
): string {
	return JSON.stringify([executionScope, checkpointScope, segments]);
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
	while (japaneseReadingPromptLimits.size > MAX_ADAPTIVE_SESSION_ENTRIES) {
		const oldestKey = japaneseReadingPromptLimits.keys().next().value;
		if (oldestKey === undefined) break;
		japaneseReadingPromptLimits.delete(oldestKey);
	}
}

function reduceTranscriptTranslationPromptLimit(key: string, currentLimit: number): void {
	const nextLimit = Math.max(
		MIN_CLI_TRANSCRIPT_TRANSLATION_PROMPT_CHAR_LIMIT,
		Math.floor(currentLimit / 2)
	);
	if (transcriptTranslationPromptLimits.has(key)) transcriptTranslationPromptLimits.delete(key);
	transcriptTranslationPromptLimits.set(key, nextLimit);
	while (transcriptTranslationPromptLimits.size > MAX_ADAPTIVE_SESSION_ENTRIES) {
		const oldestKey = transcriptTranslationPromptLimits.keys().next().value;
		if (oldestKey === undefined) break;
		transcriptTranslationPromptLimits.delete(oldestKey);
	}
}

function isCliTimeoutError(error: unknown): error is Error {
	return error instanceof LanguageLearningRequestError
		? error.code === 'timeout'
		: error instanceof Error && /\bCLI timed out\b/i.test(error.message);
}

// Gateway errors keep the legacy codes the Reader card already localizes until the Reader moves to AiError.
const LEGACY_ERROR_CODES: Partial<Record<AiErrorCode, NativeCliErrorCode>> = {
	'host-missing': 'unavailable',
	'host-outdated': 'protocol-mismatch',
	'cli-missing': 'launch-failed'
};

const NATIVE_HOST_ERROR_CODES: ReadonlySet<string> = new Set<NativeCliErrorCode>([
	'cli-failed',
	'config',
	'invalid',
	'launch-failed',
	'protocol-mismatch',
	'response-too-large',
	'timeout',
	'unavailable'
]);

function toLanguageLearningError(error: unknown, mode: string): Error {
	const aiError = toAiError(error);
	if (aiError.code === 'cancelled') return new RequestCancelledError();
	// Host codes keep their mode-specific Reader copy and the adaptive CLI timeout retry.
	const code = aiError.nativeCode && NATIVE_HOST_ERROR_CODES.has(aiError.nativeCode)
		? aiError.nativeCode as NativeCliErrorCode
		: LEGACY_ERROR_CODES[aiError.code] ?? 'failed';
	const description = describeAiError(aiError);
	return new LanguageLearningRequestError(code, description.body, {
		mode,
		aiCode: aiError.code,
		retryable: aiError.retryable,
		...(aiError.timeoutSeconds !== undefined ? { timeoutSeconds: aiError.timeoutSeconds } : {}),
		...(description.detail ? { technicalDetail: description.detail } : {})
	});
}

interface ConfiguredAssistantOptions {
	japaneseReadingSegments?: string[];
	transcriptTranslationSegments?: string[];
	transcriptTargetLanguage?: string;
	transcriptCheckpointScope?: string;
}

async function loadConfiguredAssistant({
	japaneseReadingSegments,
	transcriptTranslationSegments,
	transcriptTargetLanguage,
	transcriptCheckpointScope
}: ConfiguredAssistantOptions = {}) {
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
	const resolvedTranscriptTargetLanguage = transcriptTargetLanguage?.trim() || responseLanguage;
	const resolvedTranscriptCheckpointScope = transcriptCheckpointScope?.trim()
		|| `shared:${resolvedTranscriptTargetLanguage}`;
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
	const transcriptTranslationSessionKey = executionMode === 'api' || !transcriptTranslationSegments
		? undefined
		: getTranscriptTranslationSessionKey(
			executionScope,
			resolvedTranscriptCheckpointScope,
			transcriptTranslationSegments
		);
	const transcriptTranslationPromptCharLimit = executionMode === 'api'
		? undefined
		: transcriptTranslationSessionKey
			? transcriptTranslationPromptLimits.get(transcriptTranslationSessionKey)
				?? CLI_TRANSCRIPT_TRANSLATION_PROMPT_CHAR_LIMIT
			: CLI_TRANSCRIPT_TRANSLATION_PROMPT_CHAR_LIMIT;
	const japaneseReadingCheckpoints = createJapaneseReadingCheckpointStore('shared');
	const transcriptTranslationCheckpoints = createTranslationCheckpointStore(
		resolvedTranscriptCheckpointScope
	);
	const assistant = createLanguageLearningAssistant(async (task, input, signal) => {
		throwIfRequestAborted(signal);
		try {
			return (await runAiTask(task, input, { signal })).output;
		} catch (error) {
			throw toLanguageLearningError(error, executionMode);
		}
	}, {
		japaneseReadingPromptCharLimit,
		transcriptTranslationPromptCharLimit,
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
		japaneseReadingPromptCharLimit,
		transcriptTranslationSessionKey,
		transcriptTranslationPromptCharLimit
	};
}

async function translateConfiguredTranscript(
	segments: string[],
	transcriptTargetLanguage: string | undefined,
	transcriptCheckpointScope: string | undefined,
	onProgress?: TranscriptTranslationProgressHandler,
	signal?: AbortSignal
): Promise<string[]> {
	let automaticRetryCount = 0;
	while (true) {
		const {
			assistant,
			responseLanguage,
			executionMode,
			transcriptTranslationSessionKey,
			transcriptTranslationPromptCharLimit
		} = await loadConfiguredAssistant({
			transcriptTranslationSegments: segments,
			transcriptTargetLanguage,
			transcriptCheckpointScope
		});
		const targetLanguage = transcriptTargetLanguage?.trim() || responseLanguage;
		try {
			const translations = await assistant.translateTranscript(
				segments,
				targetLanguage,
				onProgress,
				signal
			);
			if (
				transcriptTranslationSessionKey
				&& translations.length === segments.length
				&& translations.every(translation => translation.trim())
			) {
				transcriptTranslationPromptLimits.delete(transcriptTranslationSessionKey);
			}
			return translations;
		} catch (error) {
			const timeoutRetryKey = transcriptTranslationSessionKey;
			const timeoutRetryLimit = transcriptTranslationPromptCharLimit;
			if (
				timeoutRetryKey
				&& timeoutRetryLimit
				&& executionMode !== 'api'
				&& isCliTimeoutError(error)
				&& !signal?.aborted
			) {
				if (
					timeoutRetryLimit > MIN_CLI_TRANSCRIPT_TRANSLATION_PROMPT_CHAR_LIMIT
					&& automaticRetryCount < MAX_AUTOMATIC_TRANSCRIPT_TIMEOUT_RETRIES
				) {
					automaticRetryCount += 1;
					reduceTranscriptTranslationPromptLimit(timeoutRetryKey, timeoutRetryLimit);
					continue;
				}
				throw new LanguageLearningRequestError(
					'failed',
					getMessage('readerTranscriptTranslationBatchFailed'),
					{
						...(error instanceof LanguageLearningRequestError ? error.details : {}),
						mode: executionMode,
						automaticBatchRetry: true
					}
				);
			}
			throw error;
		}
	}
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

	async loadTranscriptTranslations(segments: string[]): Promise<string[] | undefined> {
		const settings = await loadSettings();
		const responseLanguage = settings.readerSettings.learningResponseLanguage.trim()
			|| (typeof navigator !== 'undefined' ? navigator.language : '')
			|| 'English';
		const translations = await createTranslationCheckpointStore(
			`shared:${responseLanguage}`
		).load(segments);
		return translations?.length === segments.length
			&& translations.every(translation => translation.trim())
			? [...translations]
			: undefined;
	},

	async loadJapaneseTranscriptTranslations(segments: string[]): Promise<string[] | undefined> {
		const translations = await createTranslationCheckpointStore(
			JAPANESE_TRANSLATION_CHECKPOINT_SCOPE
		).load(segments);
		return translations?.length === segments.length
			&& translations.every(translation => translation.trim())
			? [...translations]
			: undefined;
	},

	async loadJapaneseReadings(segments: string[]): Promise<TranscriptReadingSegments | undefined> {
		const readings = await createJapaneseReadingCheckpointStore('shared').load(segments);
		return readings && isCompleteTranscriptReadings(readings, segments)
			? cloneTranscriptReadings(readings)
			: undefined;
	},

	async saveTranscriptTranslations(segments: string[], translations: string[]): Promise<void> {
		if (translations.length !== segments.length) return;
		const { transcriptTranslationCheckpoints } = await loadConfiguredAssistant();
		await transcriptTranslationCheckpoints.save(segments, [...translations]);
	},

	async saveJapaneseReadings(segments: string[], readings: TranscriptReadingSegments): Promise<void> {
		if (readings.length !== segments.length) return;
		const { japaneseReadingCheckpoints } = await loadConfiguredAssistant({
			japaneseReadingSegments: segments
		});
		await japaneseReadingCheckpoints.save(segments, cloneTranscriptReadings(readings));
	},

	async clearJapaneseReadings(segments: string[]): Promise<void> {
		const { japaneseReadingCheckpoints } = await loadConfiguredAssistant({
			japaneseReadingSegments: segments
		});
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
		} = await loadConfiguredAssistant({ japaneseReadingSegments: unresolvedSegments });
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
		return translateConfiguredTranscript(segments, undefined, undefined, onProgress, signal);
	},

	async translateTranscriptToJapanese(
		segments: string[],
		onProgress?: TranscriptTranslationProgressHandler,
		signal?: AbortSignal
	): Promise<string[]> {
		return translateConfiguredTranscript(
			segments,
			'Japanese',
			JAPANESE_TRANSLATION_CHECKPOINT_SCOPE,
			onProgress,
			signal
		);
	}
};
