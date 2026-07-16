import { describe, expect, test } from 'vitest';
import {
	createLanguageLearningAssistant,
	LanguageLearningRequest,
	replaceTextSelection
} from './language-learning';

describe('Language learning assistant', () => {
	test('user can transform clipped content with a direct AI instruction', async () => {
		let request: LanguageLearningRequest | undefined;
		const assistant = createLanguageLearningAssistant(async (nextRequest) => {
			request = nextRequest;
			return [{
				key: 'prompt_1',
				prompt: nextRequest.prompts[0].prompt,
				user_response: 'The fox jumps over the dog.'
			}];
		});

		const output = await assistant.transformContent(
			'The quick brown fox jumps over the lazy dog.',
			'Rewrite at CEFR A2 level.'
		);

		expect({
			output,
			context: request?.context,
			prompt: request?.prompts[0].prompt,
			maxTokens: request?.maxTokens
		}).toEqual({
			output: 'The fox jumps over the dog.',
			context: 'The quick brown fox jumps over the lazy dog.',
			prompt: 'Rewrite at CEFR A2 level. Return only the revised content in Markdown.',
			maxTokens: 1600
		});
	});

	test('long clipping edits request a bounded length-based output budget', async () => {
		let request: LanguageLearningRequest | undefined;
		const assistant = createLanguageLearningAssistant(async (nextRequest) => {
			request = nextRequest;
			return [{
				key: 'prompt_1',
				prompt: nextRequest.prompts[0].prompt,
				user_response: 'Revised content'
			}];
		});

		await assistant.transformContent('A'.repeat(20000), 'Create a bilingual version.');

		expect(request?.maxTokens).toBe(12000);
	});

	test('user can ask for an explanation of a word in its transcript context', async () => {
		let request: LanguageLearningRequest | undefined;
		const assistant = createLanguageLearningAssistant(async (nextRequest) => {
			request = nextRequest;
			return [{
				key: 'prompt_1',
				prompt: nextRequest.prompts[0].prompt,
				user_response: '**encounter** /ɪnˈkaʊntər/ — 遇到'
			}];
		});

		const output = await assistant.explainSelection({
			kind: 'word',
			text: 'encountered',
			context: 'I encountered an unfamiliar word.'
		}, 'Simplified Chinese');

		expect({
			output,
			context: request?.context,
			prompt: request?.prompts[0].prompt
		}).toEqual({
			output: '**encounter** /ɪnˈkaʊntər/ — 遇到',
			context: 'Selected word: encountered\nContext: I encountered an unfamiliar word.',
			prompt: 'Explain the selected word for a language learner in Simplified Chinese. Include its lemma, pronunciation, meaning in this context, one concise usage note, and one example sentence. Return concise plain text.'
		});
	});

	test('user can ask for a sentence translation and grammar breakdown', async () => {
		let request: LanguageLearningRequest | undefined;
		const assistant = createLanguageLearningAssistant(async (nextRequest) => {
			request = nextRequest;
			return [{
				key: 'prompt_1',
				prompt: nextRequest.prompts[0].prompt,
				user_response: '自然翻译：我偶然遇到了一个生词。'
			}];
		});

		const output = await assistant.explainSelection({
			kind: 'sentence',
			text: 'I encountered an unfamiliar word.',
			context: 'I encountered an unfamiliar word.'
		}, 'Simplified Chinese');

		expect({
			output,
			context: request?.context,
			prompt: request?.prompts[0].prompt
		}).toEqual({
			output: '自然翻译：我偶然遇到了一个生词。',
			context: 'Selected sentence: I encountered an unfamiliar word.\nContext: I encountered an unfamiliar word.',
			prompt: 'Explain the selected sentence for a language learner in Simplified Chinese. Include a natural translation, its grammar structure, and the key expressions in context. Return concise plain text.'
		});
	});

	test('bilingual transcript translations stay aligned when the model reorders lines', async () => {
		let request: LanguageLearningRequest | undefined;
		const assistant = createLanguageLearningAssistant(async (nextRequest) => {
			request = nextRequest;
			return [{
				key: 'prompt_1',
				prompt: nextRequest.prompts[0].prompt,
				user_response: '1|||你好吗？\n0|||你好。'
			}];
		});

		const translations = await assistant.translateTranscript(
			['Hello.', 'How are you?'],
			'Simplified Chinese'
		);

		expect({
			translations,
			context: request?.context,
			prompt: request?.prompts[0].prompt
		}).toEqual({
			translations: ['你好。', '你好吗？'],
			context: 'Translate timed transcript segments without changing their alignment.',
			prompt: [
				'Translate each transcript segment into Simplified Chinese.',
				'Preserve meaning and tone. Do not merge or omit segments.',
				'Return exactly one line per segment using: ID|||translation',
				'0|||Hello.',
				'1|||How are you?'
			].join('\n')
		});
	});

	test('long transcripts are translated in bounded provider requests', async () => {
		const requests: LanguageLearningRequest[] = [];
		const assistant = createLanguageLearningAssistant(async (nextRequest) => {
			requests.push(nextRequest);
			const segmentId = nextRequest.prompts[0].prompt.includes('0|||') ? 0 : 1;
			return [{
				key: 'prompt_1',
				prompt: nextRequest.prompts[0].prompt,
				user_response: `${segmentId}|||${segmentId === 0 ? '第一段' : '第二段'}`
			}];
		});

		const translations = await assistant.translateTranscript(
			['A'.repeat(3500), 'B'.repeat(3500)],
			'Simplified Chinese'
		);

		expect({
			translations,
			requestCount: requests.length,
			promptsPerRequest: requests.map(request => request.prompts.length),
			maxTokens: requests.map(request => request.maxTokens)
		}).toEqual({
			translations: ['第一段', '第二段'],
			requestCount: 2,
			promptsPerRequest: [1, 1],
			maxTokens: [4200, 4200]
		});
	});

	test('AI edits replace only the selected clipped text', () => {
		expect(replaceTextSelection(
			'Before difficult wording after.',
			7,
			24,
			'simple words'
		)).toEqual({
			value: 'Before simple words after.',
			selectionStart: 7,
			selectionEnd: 19
		});
	});
});
