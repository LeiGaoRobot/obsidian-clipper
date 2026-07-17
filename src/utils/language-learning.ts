import { PromptVariable } from '../types/types';
import { throwIfRequestAborted } from './request-cancellation';

export interface LanguageLearningResponse {
	key: string;
	prompt: string;
	user_response: unknown;
}

export interface LanguageLearningRequest {
	context: string;
	prompts: PromptVariable[];
	maxTokens?: number;
}

export type SendLanguageLearningRequest = (
	request: LanguageLearningRequest,
	signal?: AbortSignal
) => Promise<LanguageLearningResponse[]>;

export interface LearningSelection {
	kind: 'word' | 'sentence';
	text: string;
	context: string;
}

export interface TranscriptReadingToken {
	text: string;
	reading: string;
}

export type TranscriptReadingSegments = TranscriptReadingToken[][];

export interface TranscriptReadingProgress {
	completed: number;
	total: number;
}

export type TranscriptReadingProgressHandler = (progress: TranscriptReadingProgress) => void;
export type TranscriptTranslationProgress = TranscriptReadingProgress;
export type TranscriptTranslationProgressHandler = (progress: TranscriptTranslationProgress) => void;

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
	lines: string[];
	sourceChars: number;
}

function buildTranscriptPromptGroups(
	segments: string[],
	promptHeader: string[]
): TranscriptPromptGroup[] {
	const promptGroups: TranscriptPromptGroup[] = [];
	let currentGroup: string[] = [];
	let currentSourceChars = 0;
	let currentLength = promptHeader.join('\n').length;
	segments.forEach((segment, index) => {
		const line = `${index}|||${segment}`;
		if (currentGroup.length > 0 && currentLength + line.length + 1 > MAX_TRANSCRIPT_PROMPT_CHARS) {
			promptGroups.push({ lines: currentGroup, sourceChars: currentSourceChars });
			currentGroup = [];
			currentSourceChars = 0;
			currentLength = promptHeader.join('\n').length;
		}
		currentGroup.push(line);
		currentSourceChars += segment.length;
		currentLength += line.length + 1;
	});
	if (currentGroup.length > 0) {
		promptGroups.push({ lines: currentGroup, sourceChars: currentSourceChars });
	}
	return promptGroups;
}

function parseTranscriptReadingTokens(value: string): TranscriptReadingToken[] | null {
	let json = value.trim();
	if (json.startsWith('```')) {
		json = json.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
	}
	try {
		const parsed: unknown = JSON.parse(json);
		if (!Array.isArray(parsed)) return null;
		const tokens: TranscriptReadingToken[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== 'object') return null;
			const candidate = item as { text?: unknown; reading?: unknown };
			if (
				typeof candidate.text !== 'string'
				|| typeof candidate.reading !== 'string'
				|| !candidate.text
			) return null;
			tokens.push({ text: candidate.text, reading: candidate.reading });
		}
		return tokens;
	} catch {
		return null;
	}
}

export function isCompleteTranscriptReadings(
	readings: TranscriptReadingSegments,
	segments: string[]
): boolean {
	return readings.length === segments.length && readings.every((tokens, index) => {
		const source = segments[index];
		if (!source) return tokens.length === 0;
		return tokens.length > 0
			&& tokens.map(token => token.text).join('') === source
			&& tokens.every(token => !JAPANESE_KANJI.test(token.text) || Boolean(token.reading.trim()));
	});
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
	sendRequest: SendLanguageLearningRequest
): LanguageLearningAssistant {
	return {
		async transformContent(content: string, instruction: string, signal?: AbortSignal): Promise<string> {
			throwIfRequestAborted(signal);
			const prompt = `${instruction.trim()} Return only the revised content in Markdown.`;
			const responses = await sendRequest({
				context: content,
				prompts: [{ key: 'prompt_1', prompt }],
				maxTokens: Math.min(12000, Math.max(1600, Math.ceil(content.length * 1.2)))
			}, signal);
			throwIfRequestAborted(signal);
			const response = responses.find(item => item.key === 'prompt_1')?.user_response;
			return typeof response === 'string' ? response : '';
		},

		async explainSelection(selection: LearningSelection, responseLanguage: string, signal?: AbortSignal): Promise<string> {
			throwIfRequestAborted(signal);
			const languageInstruction = `Use only ${responseLanguage} for all explanation text, labels, and translations.`;
			const prompt = selection.kind === 'word'
				? `Explain the selected word for a language learner in ${responseLanguage}. ${languageInstruction} Include its lemma, pronunciation, meaning in this context, one concise usage note, and one example sentence. Return concise plain text.`
				: `Explain the selected sentence for a language learner in ${responseLanguage}. ${languageInstruction} Include a natural translation, its grammar structure, and the key expressions in context. Return concise plain text.`;
			const responses = await sendRequest({
				context: `Selected ${selection.kind}: ${selection.text}\nContext: ${selection.context}`,
				prompts: [{ key: 'prompt_1', prompt }]
			}, signal);
			throwIfRequestAborted(signal);
			const response = responses.find(item => item.key === 'prompt_1')?.user_response;
			return typeof response === 'string' ? response : '';
		},

		async annotateJapaneseTranscript(
			segments: string[],
			onProgress?: TranscriptReadingProgressHandler,
			signal?: AbortSignal
		): Promise<TranscriptReadingSegments> {
			throwIfRequestAborted(signal);
			const promptHeader = [
				'Annotate each Japanese transcript segment with hiragana readings for every kanji.',
				'Preserve every segment exactly and do not merge or omit text.',
				'Return exactly one line per segment using: ID|||JSON',
				'The JSON must be an array of objects with "text" and "reading" fields.',
				'Concatenate all "text" fields to reproduce the source exactly.',
				'Use an empty reading for kana, Latin letters, numbers, spaces, and punctuation.',
				'Split mixed kanji and kana into separate objects so every kanji has its own reading.'
			];
			const promptGroups = buildTranscriptPromptGroups(segments, promptHeader);
			const readings: TranscriptReadingSegments = segments.map(() => []);
			if (promptGroups.length > 0) {
				onProgress?.({ completed: 0, total: promptGroups.length });
			}
			for (const [groupIndex, group] of promptGroups.entries()) {
				throwIfRequestAborted(signal);
				const responses = await sendRequest({
					context: 'Annotate Japanese transcript segments with aligned ruby readings.',
					prompts: [{
						key: 'prompt_1',
						prompt: [...promptHeader, ...group.lines].join('\n')
					}],
					maxTokens: Math.min(12000, Math.max(2000, Math.ceil(group.sourceChars * 2.5)))
				}, signal);
				throwIfRequestAborted(signal);
				for (const response of responses) {
					if (typeof response.user_response !== 'string') continue;
					for (const line of response.user_response.split('\n')) {
						const match = line.match(/^\s*(\d+)\|\|\|(.*)$/);
						if (!match) continue;
						const index = Number(match[1]);
						if (index < 0 || index >= segments.length) continue;
						const tokens = parseTranscriptReadingTokens(match[2]);
						if (tokens && isCompleteTranscriptReadings([tokens], [segments[index]])) {
							readings[index] = tokens;
						}
					}
				}
				onProgress?.({ completed: groupIndex + 1, total: promptGroups.length });
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
			const promptHeader = [
				`Translate each transcript segment into ${targetLanguage}.`,
				'Preserve meaning and tone. Do not merge or omit segments.',
				'Return exactly one line per segment using: ID|||translation'
			];
			const promptGroups = buildTranscriptPromptGroups(segments, promptHeader);

			const translations = new Array<string>(segments.length).fill('');
			if (promptGroups.length > 0) {
				onProgress?.({ completed: 0, total: promptGroups.length });
			}
			for (const [groupIndex, group] of promptGroups.entries()) {
				throwIfRequestAborted(signal);
				const responses = await sendRequest({
					context: 'Translate timed transcript segments without changing their alignment.',
					prompts: [{
						key: 'prompt_1',
						prompt: [...promptHeader, ...group.lines].join('\n')
					}],
					maxTokens: Math.min(8000, Math.max(1600, Math.ceil(group.sourceChars * 1.2)))
				}, signal);
				throwIfRequestAborted(signal);
				for (const response of responses) {
					if (typeof response.user_response !== 'string') continue;
					for (const line of response.user_response.split('\n')) {
						const match = line.match(/^\s*(\d+)\|\|\|(.*)$/);
						if (!match) continue;
						const index = Number(match[1]);
						if (index >= 0 && index < translations.length) {
							translations[index] = match[2].trim();
						}
					}
				}
				onProgress?.({ completed: groupIndex + 1, total: promptGroups.length });
			}
			return translations;
		}
	};
}
