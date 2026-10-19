import type { AiTaskInput, AiTaskOutput, TranscriptSegment } from '../ai/contracts';
import type { AiTask } from '../ai/types';
import { throwIfRequestAborted } from './request-cancellation';

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

export interface TranscriptBatchProgress {
	completed: number;
	total: number;
}

export interface TranscriptReadingProgress extends TranscriptBatchProgress {
	completedSegments: number;
	totalSegments: number;
	readings: TranscriptReadingSegments;
}

export type TranscriptReadingProgressHandler = (progress: TranscriptReadingProgress) => void;
export interface TranscriptTranslationProgress extends TranscriptBatchProgress {
	translations: string[];
}
export type TranscriptTranslationProgressHandler = (progress: TranscriptTranslationProgress) => void;

type MaybePromise<T> = T | Promise<T>;

export interface TranscriptReadingCheckpointStore {
	load(segments: string[]): MaybePromise<TranscriptReadingSegments | undefined>;
	save(segments: string[], readings: TranscriptReadingSegments): MaybePromise<void>;
	clear(segments: string[]): MaybePromise<void>;
}

export interface TranscriptTranslationCheckpointStore {
	load(segments: string[]): MaybePromise<string[] | undefined>;
	save(segments: string[], translations: string[]): MaybePromise<void>;
	clear(segments: string[]): MaybePromise<void>;
}

export interface LanguageLearningAssistantOptions {
	japaneseReadingPromptCharLimit?: number;
	transcriptTranslationPromptCharLimit?: number;
	japaneseReadingCheckpoints?: TranscriptReadingCheckpointStore;
	transcriptTranslationCheckpoints?: TranscriptTranslationCheckpointStore;
}

export interface LanguageLearningAssistant {
	transformContent(content: string, instruction: string, signal?: AbortSignal): Promise<string>;
	explainSelection(selection: LearningSelection, responseLanguage: string, signal?: AbortSignal): Promise<string>;
	translateTranscript(
		segments: string[],
		targetLanguage: string,
		onProgress?: TranscriptTranslationProgressHandler,
		signal?: AbortSignal
	): Promise<string[]>;
	annotateJapaneseTranscript(
		segments: string[],
		onProgress?: TranscriptReadingProgressHandler,
		signal?: AbortSignal
	): Promise<TranscriptReadingSegments>;
}

const MAX_TRANSCRIPT_PROMPT_CHARS = 6000;
const JAPANESE_KANJI = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々]/;

interface TranscriptPromptGroup {
	segments: TranscriptSegment[];
	sourceChars: number;
}

// Groups segments under a prompt-size budget. Each segment keeps its source index as a stable
// id and stays atomic, so one oversized segment may exceed the budget on its own.
function buildTranscriptPromptGroups(
	segments: string[],
	instruction: string,
	maxPromptChars = MAX_TRANSCRIPT_PROMPT_CHARS,
	includeSegment: (index: number) => boolean = () => true
): TranscriptPromptGroup[] {
	const promptGroups: TranscriptPromptGroup[] = [];
	let current: TranscriptSegment[] = [];
	let currentSourceChars = 0;
	let currentLength = instruction.length;
	segments.forEach((text, id) => {
		if (!includeSegment(id)) return;
		const segment = { id, text };
		const length = JSON.stringify(segment).length + 1;
		if (current.length > 0 && currentLength + length > maxPromptChars) {
			promptGroups.push({ segments: current, sourceChars: currentSourceChars });
			current = [];
			currentSourceChars = 0;
			currentLength = instruction.length;
		}
		current.push(segment);
		currentSourceChars += text.length;
		currentLength += length;
	});
	if (current.length > 0) promptGroups.push({ segments: current, sourceChars: currentSourceChars });
	return promptGroups;
}

function cloneTranscriptReadings(readings: TranscriptReadingSegments): TranscriptReadingSegments {
	return readings.map(tokens => tokens.map(token => ({ ...token })));
}

function isCompleteTranscriptReadingSegment(tokens: TranscriptReadingToken[], source: string): boolean {
	if (!source) return tokens.length === 0;
	return tokens.length > 0
		&& tokens.map(token => token.text).join('') === source
		&& tokens.every(token => !JAPANESE_KANJI.test(token.text) || Boolean(token.reading.trim()));
}

function countCompleteTranscriptReadingSegments(
	readings: TranscriptReadingSegments,
	segments: string[]
): number {
	return readings.reduce((count, tokens, index) => (
		count + (isCompleteTranscriptReadingSegment(tokens, segments[index]) ? 1 : 0)
	), 0);
}

export function isCompleteTranscriptReadings(
	readings: TranscriptReadingSegments,
	segments: string[]
): boolean {
	return readings.length === segments.length
		&& readings.every((tokens, index) => isCompleteTranscriptReadingSegment(tokens, segments[index]));
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
			const instruction = [
				'Annotate each Japanese transcript segment with hiragana readings for every kanji.',
				'Preserve every segment exactly and do not merge or omit text.',
				'Split each segment into tokens. Concatenating the token texts must reproduce the segment exactly.',
				'Give each token that contains kanji its hiragana reading. Use an empty reading for kana, Latin letters, numbers, spaces, and punctuation.',
				'Split mixed kanji and kana into separate tokens so every kanji has its own reading.'
			].join('\n');
			const checkpoint = await options.japaneseReadingCheckpoints?.load(segments);
			const readings: TranscriptReadingSegments = segments.map((segment, index) => {
				const tokens = checkpoint?.[index];
				return tokens && isCompleteTranscriptReadingSegment(tokens, segment)
					? tokens.map(token => ({ ...token }))
					: [];
			});
			const promptGroups = buildTranscriptPromptGroups(
				segments,
				instruction,
				options.japaneseReadingPromptCharLimit,
				index => !isCompleteTranscriptReadingSegment(readings[index], segments[index])
			);
			onProgress?.({
				completed: 0,
				total: promptGroups.length,
				completedSegments: countCompleteTranscriptReadingSegments(readings, segments),
				totalSegments: segments.length,
				readings: cloneTranscriptReadings(readings)
			});
			for (const [groupIndex, group] of promptGroups.entries()) {
				throwIfRequestAborted(signal);
				const generated = await sendRequest('reading', {
					instruction,
					segments: group.segments,
					// Token objects cost more output than the source text they annotate.
					maxTokens: Math.min(12000, Math.max(2000, Math.ceil(group.sourceChars * 4)))
				}, signal);
				throwIfRequestAborted(signal);
				// Accept only requested ids, and only readings that reproduce their source.
				const requested = new Set(group.segments.map(segment => segment.id));
				for (const { id, tokens } of generated) {
					if (requested.has(id) && isCompleteTranscriptReadings([tokens], [segments[id]])) readings[id] = tokens;
				}
				await options.japaneseReadingCheckpoints?.save(segments, cloneTranscriptReadings(readings));
				onProgress?.({
					completed: groupIndex + 1,
					total: promptGroups.length,
					completedSegments: countCompleteTranscriptReadingSegments(readings, segments),
					totalSegments: segments.length,
					readings: cloneTranscriptReadings(readings)
				});
			}
			return readings;
		},

		async translateTranscript(
			segments: string[],
			targetLanguage: string,
			onProgress?: TranscriptTranslationProgressHandler,
			signal?: AbortSignal
		): Promise<string[]> {
			throwIfRequestAborted(signal);
			const instruction = [
				`Translate each transcript segment into ${targetLanguage}.`,
				'Preserve meaning and tone. Do not merge or omit segments.'
			].join('\n');
			const checkpoint = await options.transcriptTranslationCheckpoints?.load(segments);
			const translations = segments.map((_segment, index) => checkpoint?.[index]?.trim() || '');
			const promptGroups = buildTranscriptPromptGroups(
				segments,
				instruction,
				options.transcriptTranslationPromptCharLimit ?? MAX_TRANSCRIPT_PROMPT_CHARS,
				index => !translations[index]
			);
			onProgress?.({ completed: 0, total: promptGroups.length, translations: [...translations] });
			for (const [groupIndex, group] of promptGroups.entries()) {
				throwIfRequestAborted(signal);
				const translated = await sendRequest('translate', {
					instruction,
					segments: group.segments,
					// Each item adds a small JSON wrapper around its translation.
					maxTokens: Math.min(8000, Math.max(1600, Math.ceil(group.sourceChars * 1.2 + group.segments.length * 15)))
				}, signal);
				throwIfRequestAborted(signal);
				const requested = new Set(group.segments.map(segment => segment.id));
				for (const { id, text } of translated) {
					if (requested.has(id)) translations[id] = text;
				}
				await options.transcriptTranslationCheckpoints?.save(segments, [...translations]);
				onProgress?.({
					completed: groupIndex + 1,
					total: promptGroups.length,
					translations: [...translations]
				});
			}
			return translations;
		}
	};
}
