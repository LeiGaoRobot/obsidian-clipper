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
import { isCliKind } from '../ai/connection-kind';
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
import {
	executionModeOfKind,
	findProfileConnection,
	listEnabledProfileGroups,
	profileDisplayLabel,
	routedProfileId,
	saveTaskProfile
} from './ai-profiles';
import { configuredLanguageLearningVocabulary } from './language-learning-vocabulary';
import type {
	ReaderAiTask,
	TranscriptExecutionInfo,
	TranscriptProfileOption
} from './transcript-language-learning';
import {
	applyJapaneseReadingDictionary,
	resolveJapaneseReadingsFromDictionary
} from './japanese-reading-dictionary';
import {
	configuredJapaneseReadingDictionary,
	listJapaneseReadingDictionary
} from './japanese-reading-dictionary-storage';
import { resolveResponseLanguage } from '../ai/resolve';
import type { AiSettingsView, AiTask, Connection, ModelProfile } from '../ai/types';
import type { InterpreterExecutionMode } from '../types/types';

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

/** What a failed request ran on: the v1 mode keeps the CLI error copy, `task` names the routing entry. */
interface RequestContext {
	mode: InterpreterExecutionMode;
	task: AiTask;
	profileId?: string;
}

function toLanguageLearningError(error: unknown, context: RequestContext): Error {
	const aiError = toAiError(error);
	if (aiError.code === 'cancelled') return new RequestCancelledError();
	// Host codes keep their mode-specific Reader copy.
	const code = aiError.nativeCode && NATIVE_HOST_ERROR_CODES.has(aiError.nativeCode)
		? aiError.nativeCode as NativeCliErrorCode
		: LEGACY_ERROR_CODES[aiError.code] ?? 'failed';
	const description = describeAiError(aiError);
	return new LanguageLearningRequestError(code, description.body, {
		...context,
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
function toTranscriptJobError(error: unknown, context: RequestContext): Error {
	const aiError = toAiError(error);
	const converted = toLanguageLearningError(aiError, context);
	if (
		aiError.code === 'timeout'
		&& aiError.nativeCode === 'timeout'
		&& (transcriptJobAttempts(aiError)?.splits ?? 0) > 0
	) {
		return new LanguageLearningRequestError('failed', getMessage('readerTranscriptTranslationBatchFailed'), {
			...(converted instanceof LanguageLearningRequestError ? converted.details : {}),
			...context,
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

/**
 * The profile routing names for a task and its connection kind, from profile → connection. The
 * Reader is a content script whose view reports no Native Messaging, so this deliberately skips
 * `resolveProfile`'s availability checks: the background decides whether a CLI can run.
 */
function routedProfile(view: AiSettingsView, task: AiTask): { profile: ModelProfile; connection: Connection } | undefined {
	const found = findProfileConnection(view, routedProfileId(view, task));
	return found?.profile.enabled ? found : undefined;
}

function requestContext(view: AiSettingsView, task: AiTask): RequestContext {
	const routed = routedProfile(view, task);
	return {
		mode: executionModeOfKind(routed?.connection.kind),
		task,
		...(routed ? { profileId: routed.profile.id } : {})
	};
}

async function loadConfiguredAssistant() {
	const view = await loadAiSettings();
	// These pre-checks keep the Reader's own copy, which `not-configured` from the resolver does not
	// match (decision 6 drops them in Task 9 once the copy is reconciled). The model check is per
	// task: in derived mode a task has a profile exactly when v1 is in a CLI mode or has an enabled
	// model, as the former `api && !defaultProfileId` check required.
	if (!view.enabled) {
		throw new Error(getMessage('aiLanguageToolsRequireInterpreter'));
	}
	const requireProfile = (task: AiTask): RequestContext => {
		if (!routedProfileId(view, task)) throw new Error(getMessage('aiLanguageToolsRequireModel'));
		return requestContext(view, task);
	};

	const responseLanguage = responseLanguageOf(view);
	const assistant = createLanguageLearningAssistant(async (task, input, signal) => {
		throwIfRequestAborted(signal);
		const context = requireProfile(task);
		try {
			return (await runAiTask(task, input, { signal })).output;
		} catch (error) {
			throw toLanguageLearningError(error, context);
		}
	}, {
		runJob: async (task, input, options) => {
			throwIfRequestAborted(options.signal);
			const context = requireProfile(task);
			try {
				return await runTranscriptJob(task, input, options);
			} catch (error) {
				throw toTranscriptJobError(error, context);
			}
		}
	});

	return { assistant, responseLanguage };
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
	/** The profile routing names for a transcript task, its kind, and the kind's group budget. */
	async getExecutionInfo(task: TranscriptJobTask): Promise<TranscriptExecutionInfo> {
		const view = await loadAiSettings();
		const routed = routedProfile(view, task);
		const kind = routed?.connection.kind;
		const budgetKind = kind && isCliKind(kind) ? kind : 'api';
		return {
			...(routed ? { profileId: routed.profile.id, kind } : {}),
			label: routed
				? profileDisplayLabel(routed.profile, routed.connection)
				: getMessage('aiErrorNotConfiguredTitle'),
			promptCharLimit: TRANSCRIPT_GROUP_BUDGETS[budgetKind][task]
		};
	},

	/** Every enabled profile, CLI included; whether one can run here is the background's call. */
	async listProfiles(): Promise<TranscriptProfileOption[]> {
		const view = await loadAiSettings();
		return listEnabledProfileGroups(view).flatMap(group => group.profiles.map(profile => ({
			id: profile.id,
			label: profileDisplayLabel(profile, group.connection),
			kind: group.connection.kind
		})));
	},

	/** Routes a Reader task to a profile (the error card's Switch and retry). */
	async setTaskProfile(task: ReaderAiTask, profileId: string): Promise<void> {
		const { written, view } = await saveTaskProfile(task, profileId);
		if (written) return;
		// DERIVED-MODE FALLBACK — delete in Phase 5 Task 9 (the AI_V2_BOOTSTRAP switch), with the
		// `saveSettings` import. Until v2 is stored the store write is a no-op, so the switch keeps
		// its v1 effect, which is global rather than per task: a CLI profile sets
		// `interpreterExecutionMode` (as `setExecutionMode` did) and an API profile sets the `api`
		// mode with that profile as `interpreterModel` (its id is the v1 model id).
		const mode = executionModeOfKind(findProfileConnection(view, profileId)?.connection.kind);
		await saveSettings(mode === 'api'
			? { interpreterExecutionMode: 'api', interpreterModel: profileId }
			: { interpreterExecutionMode: mode });
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
