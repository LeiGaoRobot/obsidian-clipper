import { PromptVariable } from '../types/types';

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
	request: LanguageLearningRequest
) => Promise<LanguageLearningResponse[]>;

export interface LearningSelection {
	kind: 'word' | 'sentence';
	text: string;
	context: string;
}

export interface LanguageLearningAssistant {
	transformContent(content: string, instruction: string): Promise<string>;
	explainSelection(selection: LearningSelection, responseLanguage: string): Promise<string>;
	translateTranscript(segments: string[], targetLanguage: string): Promise<string[]>;
}

const MAX_TRANSCRIPT_PROMPT_CHARS = 6000;

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
		async transformContent(content: string, instruction: string): Promise<string> {
			const prompt = `${instruction.trim()} Return only the revised content in Markdown.`;
			const responses = await sendRequest({
				context: content,
				prompts: [{ key: 'prompt_1', prompt }]
			});
			const response = responses.find(item => item.key === 'prompt_1')?.user_response;
			return typeof response === 'string' ? response : '';
		},

		async explainSelection(selection: LearningSelection, responseLanguage: string): Promise<string> {
			const prompt = selection.kind === 'word'
				? `Explain the selected word for a language learner in ${responseLanguage}. Include its lemma, pronunciation, meaning in this context, one concise usage note, and one example sentence. Return concise plain text.`
				: `Explain the selected sentence for a language learner in ${responseLanguage}. Include a natural translation, its grammar structure, and the key expressions in context. Return concise plain text.`;
			const responses = await sendRequest({
				context: `Selected ${selection.kind}: ${selection.text}\nContext: ${selection.context}`,
				prompts: [{ key: 'prompt_1', prompt }]
			});
			const response = responses.find(item => item.key === 'prompt_1')?.user_response;
			return typeof response === 'string' ? response : '';
		},

		async translateTranscript(segments: string[], targetLanguage: string): Promise<string[]> {
			const promptHeader = [
				`Translate each transcript segment into ${targetLanguage}.`,
				'Preserve meaning and tone. Do not merge or omit segments.',
				'Return exactly one line per segment using: ID|||translation'
			];
			const promptGroups: string[][] = [];
			let currentGroup: string[] = [];
			let currentLength = promptHeader.join('\n').length;
			segments.forEach((segment, index) => {
				const line = `${index}|||${segment}`;
				if (currentGroup.length > 0 && currentLength + line.length + 1 > MAX_TRANSCRIPT_PROMPT_CHARS) {
					promptGroups.push(currentGroup);
					currentGroup = [];
					currentLength = promptHeader.join('\n').length;
				}
				currentGroup.push(line);
				currentLength += line.length + 1;
			});
			if (currentGroup.length > 0) promptGroups.push(currentGroup);

			const prompts = promptGroups.map((group, index) => ({
				key: `prompt_${index + 1}`,
				prompt: [...promptHeader, ...group].join('\n')
			}));
			const responses = await sendRequest({
				context: 'Translate timed transcript segments without changing their alignment.',
				prompts,
				maxTokens: Math.min(12000, Math.max(1600, Math.ceil(
					segments.reduce((total, segment) => total + segment.length, 0) * 1.2
				)))
			});
			const translations = new Array<string>(segments.length).fill('');
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
			return translations;
		}
	};
}
