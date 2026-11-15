import {
	isCompleteTranscriptReadings,
	parseJsonCandidates,
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
import { AiError } from '../ai/errors';
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

/** A transcript line sent for grammar analysis: its source index, timestamp label, and text. */
export interface TranscriptGrammarLine {
	id: number;
	time?: string;
	text: string;
}

/** A line of the transcript where a grammar point is used, by source index. */
export interface TranscriptGrammarExample {
	id: number;
	quote: string;
}

export interface TranscriptGrammarPoint {
	pattern: string;
	meaning: string;
	level?: string;
	examples: TranscriptGrammarExample[];
}

export interface TranscriptGrammarAnalysis {
	points: TranscriptGrammarPoint[];
	/** Lines sent to the model; fewer than requested when the range exceeded the size limit. */
	analyzedLines: number;
	totalLines: number;
}

/** Source characters one grammar analysis sends; a longer range is analyzed from its start. */
export const MAX_GRAMMAR_SOURCE_CHARS = 24_000;
const MAX_GRAMMAR_POINTS = 20;
const MAX_GRAMMAR_EXAMPLES = 4;

/** The leading lines of `lines` that fit the grammar size limit; at least one. */
export function limitGrammarLines(lines: readonly TranscriptGrammarLine[]): TranscriptGrammarLine[] {
	const limited: TranscriptGrammarLine[] = [];
	let chars = 0;
	for (const line of lines) {
		chars += line.text.length + 12;
		if (limited.length > 0 && chars > MAX_GRAMMAR_SOURCE_CHARS) break;
		limited.push(line);
	}
	return limited;
}

function grammarText(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * The grammar points of a model reply. A point needs a pattern and a meaning; its examples keep
 * only lines that were sent, first-seen, and fall back to the line's own text for a missing quote.
 * A reply with no usable point is a bad response.
 */
export function parseTranscriptGrammar(text: string, lines: readonly TranscriptGrammarLine[]): TranscriptGrammarPoint[] {
	const sources = new Map(lines.map(line => [line.id, line.text]));
	let best: TranscriptGrammarPoint[] = [];
	for (const candidate of parseJsonCandidates(text)) {
		const list = Array.isArray(candidate)
			? candidate
			: candidate && typeof candidate === 'object' && Array.isArray((candidate as { points?: unknown }).points)
				? (candidate as { points: unknown[] }).points
				: undefined;
		if (!list) continue;
		const points: TranscriptGrammarPoint[] = [];
		for (const item of list) {
			if (!item || typeof item !== 'object') continue;
			const record = item as Record<string, unknown>;
			const pattern = grammarText(record.pattern);
			const meaning = grammarText(record.meaning);
			if (!pattern || !meaning) continue;
			const seen = new Set<number>();
			const examples: TranscriptGrammarExample[] = [];
			for (const example of Array.isArray(record.examples) ? record.examples : []) {
				if (!example || typeof example !== 'object') continue;
				const rawId = (example as Record<string, unknown>).id;
				const id = typeof rawId === 'string' && /^\d+$/.test(rawId.trim()) ? Number(rawId) : rawId;
				if (typeof id !== 'number' || !sources.has(id) || seen.has(id)) continue;
				seen.add(id);
				examples.push({ id, quote: grammarText((example as Record<string, unknown>).quote) || sources.get(id) || '' });
				if (examples.length >= MAX_GRAMMAR_EXAMPLES) break;
			}
			const level = grammarText(record.level);
			points.push({ pattern, meaning, ...(level ? { level } : {}), examples });
			if (points.length >= MAX_GRAMMAR_POINTS) break;
		}
		if (points.length > best.length) best = points;
	}
	if (best.length === 0) {
		throw new AiError('bad-response', {
			task: 'explain',
			detail: `The reply did not contain any grammar point.\n${text.trim().slice(0, 500)}`
		});
	}
	return best;
}

export interface LanguageLearningAssistant {
	transformContent(content: string, instruction: string, signal?: AbortSignal): Promise<string>;
	explainSelection(selection: LearningSelection, responseLanguage: string, signal?: AbortSignal): Promise<string>;
	/** One `explain` request over the leading lines that fit `MAX_GRAMMAR_SOURCE_CHARS`. */
	analyzeTranscriptGrammar(
		lines: TranscriptGrammarLine[],
		responseLanguage: string,
		signal?: AbortSignal
	): Promise<TranscriptGrammarAnalysis>;
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

		async analyzeTranscriptGrammar(
			lines: TranscriptGrammarLine[],
			responseLanguage: string,
			signal?: AbortSignal
		): Promise<TranscriptGrammarAnalysis> {
			throwIfRequestAborted(signal);
			const analyzed = limitGrammarLines(lines.filter(line => line.text.trim()));
			if (analyzed.length === 0) return { points: [], analyzedLines: 0, totalLines: lines.length };
			const instruction = [
				`You are a language teacher. List the grammar patterns a learner should study in this transcript, in ${responseLanguage}.`,
				`Use only ${responseLanguage} for meanings; keep each pattern in the transcript's language (for example 〜っていう or 〜ばいい).`,
				`Pick at most ${MAX_GRAMMAR_POINTS} patterns, most useful first; skip trivial particles unless used in a notable way.`,
				'For each pattern give a short meaning and usage note, an optional level (such as JLPT N3 or CEFR B1), and up to 3 example lines from the transcript by their id, quoting the relevant part of the line exactly.',
				'Respond with one JSON object of the form {"points":[{"pattern":"…","meaning":"…","level":"…","examples":[{"id":0,"quote":"…"}]}]}, with no Markdown code fence.'
			].join('\n');
			const content = JSON.stringify({
				lines: analyzed.map(line => ({ id: line.id, ...(line.time ? { time: line.time } : {}), text: line.text }))
			});
			const reply = await sendRequest('explain', { instruction, content, maxTokens: 6000 }, signal);
			throwIfRequestAborted(signal);
			return {
				points: parseTranscriptGrammar(reply, analyzed),
				analyzedLines: analyzed.length,
				totalLines: lines.length
			};
		},

		async annotateJapaneseTranscript(
			segments: string[],
			onProgress?: TranscriptReadingProgressHandler,
			signal?: AbortSignal
		): Promise<TranscriptReadingSegments> {
			throwIfRequestAborted(signal);
			if (segments.length === 0) return [];
			const instruction = [
				'Give the hiragana reading of every kanji in each Japanese transcript segment.',
				'For each segment, list every word that contains kanji, in the order it appears, with its reading. List a word again each time it appears.',
				'Copy each word exactly as written in the segment, including transcription errors; do not correct or normalize it.',
				'Keep okurigana out of the word where you can (部分, 憧 in 憧れてる) so the reading covers the kanji only.',
				'Leave out kana-only words, Latin letters, numbers, spaces, and punctuation.'
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
