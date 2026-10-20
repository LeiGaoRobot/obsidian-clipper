import {
	isCompleteTranscriptReadings,
	type AiTaskInput,
	type AiTaskOutput,
	type TranscriptSegment
} from '../ai/contracts';
import type {
	RunTranscriptJobOptions,
	TranscriptJobInput,
	TranscriptJobProgress,
	TranscriptJobResult
} from '../ai/job-client';
import type { TranscriptJobIdentity, TranscriptJobTask } from '../ai/job-identity';
import { isEmptySourceSegment } from '../ai/job-limits';
import { throwIfRequestAborted } from '../ai/abort';
import type { AiTask } from '../ai/types';

// Reading completeness is part of the reading contract; re-exported for restore validation.
export { isCompleteTranscriptReadings };

export type LanguageLearningTask = Extract<AiTask, 'edit' | 'explain' | 'reading' | 'translate'>;

/** Runs one model task. Rejects when the reply does not satisfy the task's output contract. */
export type SendLanguageLearningRequest = <T extends LanguageLearningTask>(
	task: T,
	input: AiTaskInput<T>,
	signal?: AbortSignal
) => Promise<AiTaskOutput<T>>;

export interface LearningSelection {
	kind: 'word' | 'sentence';
	text: string;
	context: string;
}

export interface LearningVocabularyEntry extends LearningSelection {
	id: string;
	explanation: string;
	responseLanguage: string;
	createdAt: number;
}

export interface TranscriptReadingToken {
	text: string;
	reading: string;
}

export type TranscriptReadingSegments = TranscriptReadingToken[][];

/** A group of the transcript job is backing off after a rate limit or a transient provider error. */
export interface TranscriptRetryStatus {
	delayMs: number;
	attempt: number;
}

export interface TranscriptBatchProgress {
	completed: number;
	total: number;
	/** Present while a group waits to retry; the next progress without it ends the wait. */
	retry?: TranscriptRetryStatus;
}

export interface TranscriptReadingProgress extends TranscriptBatchProgress {
	completedSegments: number;
	totalSegments: number;
	readings: TranscriptReadingSegments;
}

export type TranscriptReadingProgressHandler = (progress: TranscriptReadingProgress) => void;
export interface TranscriptTranslationProgress extends TranscriptBatchProgress {
	completedSegments: number;
	totalSegments: number;
	translations: string[];
}
export type TranscriptTranslationProgressHandler = (progress: TranscriptTranslationProgress) => void;

/** Runs one transcript task as a durable background job (`runTranscriptJob` in production). */
export type RunLanguageLearningJob = <T extends TranscriptJobTask>(
	task: T,
	input: TranscriptJobInput,
	options: Pick<RunTranscriptJobOptions<T>, 'signal' | 'onProgress' | 'onRetry'>
) => Promise<TranscriptJobResult<T>>;

export interface LanguageLearningAssistantOptions {
	runJob?: RunLanguageLearningJob;
}

export interface TranscriptTranslationOptions {
	/** The job scope; defaults to `shared:<targetLanguage>`. */
	scope?: string;
}

/** Job namespace of transcript translations; the scope names the target language. */
export const TRANSCRIPT_TRANSLATION_JOB_NAMESPACE = 'translations';
/** Japanese readings are shared by every Reader that shows the same Japanese text. */
export const JAPANESE_READING_JOB_IDENTITY: Readonly<TranscriptJobIdentity> = {
	namespace: 'japanese-readings',
	scope: 'shared'
};

export function transcriptTranslationJobIdentity(scope: string): TranscriptJobIdentity {
	return { namespace: TRANSCRIPT_TRANSLATION_JOB_NAMESPACE, scope };
}

/** Job segments are addressed by their source index. */
export function toTranscriptJobSegments(texts: readonly string[]): TranscriptSegment[] {
	return texts.map((text, id) => ({ id, text }));
}

/**
 * A translated segment is complete when it has text, or when its source is blank: the job never
 * requests a blank source and counts it as complete with an empty translation.
 */
export function isCompleteTranscriptTranslationSegment(translation: string | undefined, source: string): boolean {
	return isEmptySourceSegment('translate', source) || Boolean(translation?.trim());
}

/** True when there is one complete translation per source segment, in order. */
export function isCompleteTranscriptTranslations(translations: readonly string[], sources: readonly string[]): boolean {
	return translations.length === sources.length
		&& sources.every((source, index) => isCompleteTranscriptTranslationSegment(translations[index], source));
}

export interface LanguageLearningAssistant {
	transformContent(content: string, instruction: string, signal?: AbortSignal): Promise<string>;
	explainSelection(selection: LearningSelection, responseLanguage: string, signal?: AbortSignal): Promise<string>;
	translateTranscript(
		segments: string[],
		targetLanguage: string,
		onProgress?: TranscriptTranslationProgressHandler,
		signal?: AbortSignal,
		options?: TranscriptTranslationOptions
	): Promise<string[]>;
	annotateJapaneseTranscript(
		segments: string[],
		onProgress?: TranscriptReadingProgressHandler,
		signal?: AbortSignal
	): Promise<TranscriptReadingSegments>;
}

function cloneTranscriptReadings(readings: TranscriptReadingSegments): TranscriptReadingSegments {
	return readings.map(tokens => tokens.map(token => ({ ...token })));
}

export function replaceTextSelection(
	value: string,
	selectionStart: number,
	selectionEnd: number,
	replacement: string
): { value: string; selectionStart: number; selectionEnd: number } {
	return {
		value: value.slice(0, selectionStart) + replacement + value.slice(selectionEnd),
		selectionStart,
		selectionEnd: selectionStart + replacement.length
	};
}

export function createLanguageLearningAssistant(
	sendRequest: SendLanguageLearningRequest,
	options: LanguageLearningAssistantOptions = {}
): LanguageLearningAssistant {
	// One background job per transcript: the runner groups, checkpoints, and retries. A retry
	// notice repeats the latest progress with the backoff, so the UI can show the wait.
	const runTranscriptTask = async <T extends TranscriptJobTask>(
		task: T,
		input: TranscriptJobInput,
		signal: AbortSignal | undefined,
		report?: (progress: TranscriptJobProgress<T>, retry?: TranscriptRetryStatus) => void
	): Promise<TranscriptJobResult<T>> => {
		if (!options.runJob) throw new Error('Transcript tasks need a background job runner.');
		let latest: TranscriptJobProgress<T> = {
			completedGroups: 0,
			totalGroups: 0,
			completedSegments: 0,
			totalSegments: input.segments.length,
			values: input.segments.map(() => (task === 'translate' ? '' : [])) as TranscriptJobProgress<T>['values']
		};
		const result = await options.runJob(task, input, {
			...(signal ? { signal } : {}),
			...(report ? {
				onProgress: (progress: TranscriptJobProgress<T>) => {
					latest = progress;
					report(progress);
				},
				onRetry: ({ delayMs, attempt }) => report(latest, { delayMs, attempt })
			} : {})
		});
		throwIfRequestAborted(signal);
		return result;
	};

	return {
		async transformContent(content: string, instruction: string, signal?: AbortSignal): Promise<string> {
			throwIfRequestAborted(signal);
			const revised = await sendRequest('edit', {
				instruction: `${instruction.trim()} Return only the revised content in Markdown.`,
				content,
				maxTokens: Math.min(12000, Math.max(1600, Math.ceil(content.length * 1.2)))
			}, signal);
			throwIfRequestAborted(signal);
			return revised;
		},

		async explainSelection(selection: LearningSelection, responseLanguage: string, signal?: AbortSignal): Promise<string> {
			throwIfRequestAborted(signal);
			const languageInstruction = `Use only ${responseLanguage} for all explanation text, labels, and translations.`;
			const prompt = selection.kind === 'word'
				? `Explain the selected word for a language learner in ${responseLanguage}. ${languageInstruction} Include its lemma, pronunciation, meaning in this context, one concise usage note, and one example sentence. Return concise plain text.`
				: `Explain the selected sentence for a language learner in ${responseLanguage}. ${languageInstruction} Include a natural translation, its grammar structure, and the key expressions in context. Return concise plain text.`;
			const explanation = await sendRequest('explain', {
				instruction: prompt,
				content: `Selected ${selection.kind}: ${selection.text}\nContext: ${selection.context}`
			}, signal);
			throwIfRequestAborted(signal);
			return explanation;
		},

		async annotateJapaneseTranscript(
			segments: string[],
			onProgress?: TranscriptReadingProgressHandler,
			signal?: AbortSignal
		): Promise<TranscriptReadingSegments> {
			throwIfRequestAborted(signal);
			if (segments.length === 0) return [];
			const instruction = [
				'Annotate each Japanese transcript segment with hiragana readings for every kanji.',
				'Preserve every segment exactly and do not merge or omit text.',
				'Split each segment into tokens. Concatenating the token texts must reproduce the segment exactly.',
				'Give each token that contains kanji its hiragana reading. Use an empty reading for kana, Latin letters, numbers, spaces, and punctuation.',
				'Split mixed kanji and kana into separate tokens so every kanji has its own reading.'
			].join('\n');
			const result = await runTranscriptTask(
				'reading',
				{ instruction, segments: toTranscriptJobSegments(segments), identity: { ...JAPANESE_READING_JOB_IDENTITY } },
				signal,
				onProgress && ((progress, retry) => onProgress({
					completed: progress.completedGroups,
					total: progress.totalGroups,
					completedSegments: progress.completedSegments,
					totalSegments: progress.totalSegments,
					readings: cloneTranscriptReadings(progress.values),
					...(retry ? { retry } : {})
				}))
			);
			// Values are aligned: a segment without an accepted reading is [], which the caller's
			// completeness check rejects unless its source is empty.
			return result.values;
		},

		async translateTranscript(
			segments: string[],
			targetLanguage: string,
			onProgress?: TranscriptTranslationProgressHandler,
			signal?: AbortSignal,
			translationOptions: TranscriptTranslationOptions = {}
		): Promise<string[]> {
			throwIfRequestAborted(signal);
			if (segments.length === 0) return [];
			const instruction = [
				`Translate each transcript segment into ${targetLanguage}.`,
				'Preserve meaning and tone. Do not merge or omit segments.'
			].join('\n');
			const scope = translationOptions.scope?.trim() || `shared:${targetLanguage}`;
			const result = await runTranscriptTask(
				'translate',
				{ instruction, segments: toTranscriptJobSegments(segments), identity: transcriptTranslationJobIdentity(scope) },
				signal,
				onProgress && ((progress, retry) => onProgress({
					completed: progress.completedGroups,
					total: progress.totalGroups,
					completedSegments: progress.completedSegments,
					totalSegments: progress.totalSegments,
					translations: [...progress.values],
					...(retry ? { retry } : {})
				}))
			);
			return result.values;
		}
	};
}
