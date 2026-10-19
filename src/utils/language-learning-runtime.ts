import { runAiTask } from '../ai/client';
import { describeAiError } from '../ai/error-messages';
import { toAiError, type AiErrorCode } from '../ai/errors';
import {
	clearTranscriptCheckpoint,
	loadTranscriptCheckpoint,
	runTranscriptJob,
	saveTranscriptCheckpoint,
	transcriptJobAttempts,
	type TranscriptJobValues
} from '../ai/job-client';
import type { TranscriptJobIdentity, TranscriptJobTask } from '../ai/job-identity';
import { TRANSCRIPT_GROUP_BUDGETS } from '../ai/job-runner';
import {
	JAPANESE_READING_JOB_IDENTITY,
	LearningSelection,
	TranscriptReadingProgressHandler,
	TranscriptReadingSegments,
	TranscriptTranslationProgressHandler,
	createLanguageLearningAssistant,
	isCompleteTranscriptReadings,
	isCompleteTranscriptTranslations,
	toTranscriptJobSegments,
	transcriptTranslationJobIdentity
} from './language-learning';
import { getMessage } from './i18n';
import type { NativeCliErrorCode } from './native-cli-contract';
import { RequestCancelledError, throwIfRequestAborted } from './request-cancellation';
import { saveSettings } from './storage-utils';
import { loadAiSettings } from './ai-settings';
import { configuredLanguageLearningVocabulary } from './language-learning-vocabulary';
import {
	applyJapaneseReadingDictionary,
	resolveJapaneseReadingsFromDictionary
} from './japanese-reading-dictionary';
import {
	configuredJapaneseReadingDictionary,
	listJapaneseReadingDictionary
} from './japanese-reading-dictionary-storage';
import { resolveResponseLanguage } from '../ai/resolve';
import { legacyExecutionMode } from '../ai/settings-view';
import type { AiSettingsView } from '../ai/types';

// The scope of the fixed Japanese translation that feeds readings of a non-Japanese transcript.
const JAPANESE_TRANSLATION_CHECKPOINT_SCOPE = 'japanese-readings:Japanese';

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

function cloneTranscriptReadings(readings: TranscriptReadingSegments): TranscriptReadingSegments {
	return readings.map(tokens => tokens.map(token => ({ ...token })));
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
	// Host codes keep their mode-specific Reader copy.
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

/**
 * A CLI timeout after the job already split its groups (the runner halves a CLI group on timeout)
 * means even the smaller groups did not finish: the Reader offers Continue remaining instead of
 * the single-request timeout card.
 */
function toTranscriptJobError(error: unknown, mode: string): Error {
	const aiError = toAiError(error);
	const converted = toLanguageLearningError(aiError, mode);
	if (
		aiError.code === 'timeout'
		&& aiError.nativeCode === 'timeout'
		&& (transcriptJobAttempts(aiError)?.splits ?? 0) > 0
	) {
		return new LanguageLearningRequestError('failed', getMessage('readerTranscriptTranslationBatchFailed'), {
			...(converted instanceof LanguageLearningRequestError ? converted.details : {}),
			mode,
			automaticBatchRetry: true
		});
	}
	return converted;
}

function responseLanguageOf(view: AiSettingsView): string {
	return resolveResponseLanguage(view, typeof navigator !== 'undefined' ? navigator.language : '');
}

async function loadResponseLanguage(): Promise<string> {
	return responseLanguageOf(await loadAiSettings());
}

async function loadConfiguredAssistant() {
	const view = await loadAiSettings();
	if (!view.enabled) {
		throw new Error(getMessage('aiLanguageToolsRequireInterpreter'));
	}

	// The mode keeps the Reader's mode-specific error copy until the Reader moves to profiles.
	const executionMode = legacyExecutionMode(view);
	if (executionMode === 'api' && !view.routing.defaultProfileId) {
		throw new Error(getMessage('aiLanguageToolsRequireModel'));
	}

	const responseLanguage = responseLanguageOf(view);
	const assistant = createLanguageLearningAssistant(async (task, input, signal) => {
		throwIfRequestAborted(signal);
		try {
			return (await runAiTask(task, input, { signal })).output;
		} catch (error) {
			throw toLanguageLearningError(error, executionMode);
		}
	}, {
		runJob: async (task, input, options) => {
			throwIfRequestAborted(options.signal);
			try {
				return await runTranscriptJob(task, input, options);
			} catch (error) {
				throw toTranscriptJobError(error, executionMode);
			}
		}
	});

	return { assistant, responseLanguage, executionMode };
}

/**
 * Reads a stored transcript job without starting or resuming anything. Only a `completed` record
 * counts: a `running` one seen from a fresh Reader may be stale, and partial work is continued by
 * an explicit user action. A transport failure reads as nothing saved.
 */
async function loadCompletedTranscriptJob<T extends TranscriptJobTask>(
	task: T,
	identity: TranscriptJobIdentity,
	segments: string[]
) {
	if (segments.length === 0) return undefined;
	try {
		const checkpoint = await loadTranscriptCheckpoint(task, identity, toTranscriptJobSegments(segments));
		return checkpoint?.status === 'completed' && checkpoint.values.length === segments.length
			? checkpoint.values
			: undefined;
	} catch {
		return undefined;
	}
}

async function loadCompletedTranslations(scope: string, segments: string[]): Promise<string[] | undefined> {
	const translations = await loadCompletedTranscriptJob(
		'translate',
		transcriptTranslationJobIdentity(scope),
		segments
	);
	return translations && isCompleteTranscriptTranslations(translations, segments) ? [...translations] : undefined;
}

/** Best effort, like the Reader's other local saves: a refused or failed write is not an error. */
async function saveTranscriptJob<T extends TranscriptJobTask>(
	task: T,
	identity: TranscriptJobIdentity,
	segments: string[],
	values: TranscriptJobValues<T>
): Promise<void> {
	if (segments.length === 0) return;
	try {
		await saveTranscriptCheckpoint(task, identity, toTranscriptJobSegments(segments), values);
	} catch {
		// The session record is a convenience; the visible work is unaffected.
	}
}

async function clearTranscriptJob(task: TranscriptJobTask, identity: TranscriptJobIdentity, segments: string[]): Promise<void> {
	if (segments.length === 0) return;
	try {
		await clearTranscriptCheckpoint(task, identity, toTranscriptJobSegments(segments));
	} catch {
		// Nothing more to clear when the background cannot be reached.
	}
}

async function translateConfiguredTranscript(
	segments: string[],
	transcriptTargetLanguage: string | undefined,
	transcriptCheckpointScope: string | undefined,
	onProgress?: TranscriptTranslationProgressHandler,
	signal?: AbortSignal
): Promise<string[]> {
	const { assistant, responseLanguage } = await loadConfiguredAssistant();
	const targetLanguage = transcriptTargetLanguage?.trim() || responseLanguage;
	return assistant.translateTranscript(segments, targetLanguage, onProgress, signal, {
		scope: transcriptCheckpointScope?.trim() || `shared:${targetLanguage}`
	});
}

export const configuredLanguageLearning = {
	...configuredLanguageLearningVocabulary,
	...configuredJapaneseReadingDictionary,
	async getExecutionInfo() {
		const mode = legacyExecutionMode(await loadAiSettings());
		return {
			mode,
			label: getMessage(mode === 'grok'
				? 'interpreterExecutionModeGrok'
				: mode === 'codex'
					? 'interpreterExecutionModeCodex'
					: 'interpreterExecutionModeApi'),
			promptCharLimit: mode === 'grok'
				? TRANSCRIPT_GROUP_BUDGETS['cli-grok'].reading
				: mode === 'codex'
					? TRANSCRIPT_GROUP_BUDGETS['cli-codex'].reading
					: TRANSCRIPT_GROUP_BUDGETS.api.translate
		};
	},

	async setExecutionMode(mode: 'api' | 'grok' | 'codex'): Promise<void> {
		await saveSettings({ interpreterExecutionMode: mode });
	},

	async loadTranscriptTranslations(segments: string[]): Promise<string[] | undefined> {
		return loadCompletedTranslations(`shared:${await loadResponseLanguage()}`, segments);
	},

	async loadJapaneseTranscriptTranslations(segments: string[]): Promise<string[] | undefined> {
		return loadCompletedTranslations(JAPANESE_TRANSLATION_CHECKPOINT_SCOPE, segments);
	},

	async loadJapaneseReadings(segments: string[]): Promise<TranscriptReadingSegments | undefined> {
		const readings = await loadCompletedTranscriptJob('reading', { ...JAPANESE_READING_JOB_IDENTITY }, segments);
		return readings && isCompleteTranscriptReadings(readings, segments)
			? cloneTranscriptReadings(readings)
			: undefined;
	},

	async saveTranscriptTranslations(segments: string[], translations: string[]): Promise<void> {
		if (translations.length !== segments.length) return;
		const responseLanguage = await loadResponseLanguage();
		await saveTranscriptJob(
			'translate',
			transcriptTranslationJobIdentity(`shared:${responseLanguage}`),
			segments,
			[...translations]
		);
	},

	async saveJapaneseReadings(segments: string[], readings: TranscriptReadingSegments): Promise<void> {
		if (readings.length !== segments.length) return;
		await saveTranscriptJob('reading', { ...JAPANESE_READING_JOB_IDENTITY }, segments, cloneTranscriptReadings(readings));
	},

	async clearJapaneseReadings(segments: string[]): Promise<void> {
		// The record of these texts, and the job of the subset the personal dictionary leaves to the
		// model, which is what the next annotation of these texts starts.
		const local = resolveJapaneseReadingsFromDictionary(segments, await listJapaneseReadingDictionary());
		const unresolved = local.unresolvedIndexes.map(index => segments[index]);
		await clearTranscriptJob('reading', { ...JAPANESE_READING_JOB_IDENTITY }, segments);
		if (unresolved.length > 0 && unresolved.length < segments.length) {
			await clearTranscriptJob('reading', { ...JAPANESE_READING_JOB_IDENTITY }, unresolved);
		}
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
		const { assistant } = await loadConfiguredAssistant();
		const mergeReadings = (generated: TranscriptReadingSegments): TranscriptReadingSegments => {
			const withOverrides = applyJapaneseReadingDictionary(generated, dictionary);
			const merged = cloneTranscriptReadings(local.readings);
			local.unresolvedIndexes.forEach((sourceIndex, generatedIndex) => {
				merged[sourceIndex] = withOverrides[generatedIndex] || [];
			});
			return merged;
		};
		// The job covers only what the dictionary left unresolved, under the shared readings identity.
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
		return mergeReadings(readings);
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
