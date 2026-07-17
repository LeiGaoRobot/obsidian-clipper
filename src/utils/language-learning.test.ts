import { describe, expect, test, vi } from 'vitest';
import {
	createLanguageLearningAssistant,
	LanguageLearningRequest,
	replaceTextSelection
} from './language-learning';
import { RequestCancelledError } from './request-cancellation';

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
			prompt: 'Explain the selected word for a language learner in Simplified Chinese. Use only Simplified Chinese for all explanation text, labels, and translations. Include its lemma, pronunciation, meaning in this context, one concise usage note, and one example sentence. Return concise plain text.'
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
			prompt: 'Explain the selected sentence for a language learner in Simplified Chinese. Use only Simplified Chinese for all explanation text, labels, and translations. Include a natural translation, its grammar structure, and the key expressions in context. Return concise plain text.'
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

	test('annotates Japanese kanji with aligned hiragana readings', async () => {
		let request: LanguageLearningRequest | undefined;
		const assistant = createLanguageLearningAssistant(async (nextRequest) => {
			request = nextRequest;
			return [{
				key: 'prompt_1',
				prompt: nextRequest.prompts[0].prompt,
				user_response: '0|||[{"text":"私","reading":"わたし"},{"text":"は","reading":""},{"text":"日本語","reading":"にほんご"},{"text":"を","reading":""},{"text":"勉強","reading":"べんきょう"},{"text":"します。","reading":""}]'
			}];
		});

		const readings = await assistant.annotateJapaneseTranscript(['私は日本語を勉強します。']);

		expect({
			readings,
			context: request?.context,
			prompt: request?.prompts[0].prompt
		}).toEqual({
			readings: [[
				{ text: '私', reading: 'わたし' },
				{ text: 'は', reading: '' },
				{ text: '日本語', reading: 'にほんご' },
				{ text: 'を', reading: '' },
				{ text: '勉強', reading: 'べんきょう' },
				{ text: 'します。', reading: '' }
			]],
			context: 'Annotate Japanese transcript segments with aligned ruby readings.',
			prompt: [
				'Annotate each Japanese transcript segment with hiragana readings for every kanji.',
				'Preserve every segment exactly and do not merge or omit text.',
				'Return exactly one line per segment using: ID|||JSON',
				'The JSON must be an array of objects with "text" and "reading" fields.',
				'Concatenate all "text" fields to reproduce the source exactly.',
				'Use an empty reading for kana, Latin letters, numbers, spaces, and punctuation.',
				'Split mixed kanji and kana into separate objects so every kanji has its own reading.',
				'0|||私は日本語を勉強します。'
			].join('\n')
		});
	});

	test('reports progress for sequential Japanese reading batches', async () => {
		const progress: Array<{ completed: number; total: number }> = [];
		const assistant = createLanguageLearningAssistant(async () => []);
		const segments = ['日'.repeat(3500), '日'.repeat(3500)];

		await assistant.annotateJapaneseTranscript(segments, next => progress.push(next));

		expect(progress).toEqual([
			{ completed: 0, total: 2 },
			{ completed: 1, total: 2 },
			{ completed: 2, total: 2 }
		]);
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

	test('reports translation progress for sequential batches', async () => {
		const progress: Array<{ completed: number; total: number }> = [];
		const assistant = createLanguageLearningAssistant(async () => []);
		const segments = ['A'.repeat(3500), 'B'.repeat(3500)];

		await assistant.translateTranscript(segments, 'Simplified Chinese', next => progress.push(next));

		expect(progress).toEqual([
			{ completed: 0, total: 2 },
			{ completed: 1, total: 2 },
			{ completed: 2, total: 2 }
		]);
	});

	test('stops before the next transcript batch when cancelled', async () => {
		const abortController = new AbortController();
		const requests: LanguageLearningRequest[] = [];
		const sendRequest = vi.fn(async (request: LanguageLearningRequest, signal?: AbortSignal) => {
			requests.push(request);
			expect(signal).toBe(abortController.signal);
			return [];
		});
		const assistant = createLanguageLearningAssistant(sendRequest);
		const progress: Array<{ completed: number; total: number }> = [];

		await expect(assistant.translateTranscript(
			['A'.repeat(3500), 'B'.repeat(3500)],
			'Simplified Chinese',
			next => {
				progress.push(next);
				if (next.completed === 1) abortController.abort();
			},
			abortController.signal
		)).rejects.toBeInstanceOf(RequestCancelledError);

		expect(requests).toHaveLength(1);
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
