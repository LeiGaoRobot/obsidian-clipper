import { describe, expect, test, vi } from 'vitest';
import type { AiTaskInput, AiTaskOutput, TranscriptSegment } from '../ai/contracts';
import { AiError } from '../ai/errors';
import {
	createLanguageLearningAssistant,
	isCompleteTranscriptReadings,
	LanguageLearningTask,
	SendLanguageLearningRequest,
	TranscriptReadingCheckpointStore,
	TranscriptReadingProgress,
	TranscriptReadingSegments,
	TranscriptTranslationCheckpointStore,
	TranscriptTranslationProgress,
	replaceTextSelection
} from './language-learning';
import { RequestCancelledError } from './request-cancellation';

type FakeHandlers = {
	[T in LanguageLearningTask]?: (
		input: AiTaskInput<T>,
		callIndex: number
	) => AiTaskOutput<T> | Promise<AiTaskOutput<T>>;
};

interface FakeCall {
	task: LanguageLearningTask;
	input: AiTaskInput<LanguageLearningTask>;
	signal?: AbortSignal;
}

// A fake model that records every task call and answers through per-task handlers.
function fakeModel(handlers: FakeHandlers) {
	const calls: FakeCall[] = [];
	const sendRequest = (async (task: LanguageLearningTask, input: AiTaskInput<LanguageLearningTask>, signal?: AbortSignal) => {
		calls.push({ task, input, signal });
		const handler = handlers[task] as ((value: unknown, index: number) => unknown) | undefined;
		if (!handler) throw new Error(`Unexpected task: ${task}`);
		return handler(input, calls.length - 1);
	}) as SendLanguageLearningRequest;
	return { sendRequest, calls };
}

const TRANSLATION_INSTRUCTION = [
	'Translate each transcript segment into Simplified Chinese.',
	'Preserve meaning and tone. Do not merge or omit segments.'
].join('\n');

const READING_INSTRUCTION = [
	'Annotate each Japanese transcript segment with hiragana readings for every kanji.',
	'Preserve every segment exactly and do not merge or omit text.',
	'Split each segment into tokens. Concatenating the token texts must reproduce the segment exactly.',
	'Give each token that contains kanji its hiragana reading. Use an empty reading for kana, Latin letters, numbers, spaces, and punctuation.',
	'Split mixed kanji and kana into separate tokens so every kanji has its own reading.'
].join('\n');

function segmentsOf(call: FakeCall): TranscriptSegment[] {
	return (call.input as AiTaskInput<'translate'>).segments;
}

function idsOf(call: FakeCall): number[] {
	return segmentsOf(call).map(segment => segment.id);
}

function translateEach(input: AiTaskInput<'translate'>): TranscriptSegment[] {
	return input.segments.map(({ id }) => ({ id, text: `T${id}` }));
}

function memoryTranslationCheckpoints(initial?: string[]) {
	let checkpoint = initial ? [...initial] : undefined;
	const store: TranscriptTranslationCheckpointStore = {
		load: vi.fn(async () => (checkpoint ? [...checkpoint] : undefined)),
		save: vi.fn(async (_segments: string[], translations: string[]) => {
			checkpoint = [...translations];
		}),
		clear: vi.fn(async () => {
			checkpoint = undefined;
		})
	};
	return { store, current: () => checkpoint };
}

describe('Language learning assistant', () => {
	test('user can transform clipped content with a direct AI instruction', async () => {
		const { sendRequest, calls } = fakeModel({ edit: () => 'The fox jumps over the dog.' });
		const assistant = createLanguageLearningAssistant(sendRequest);

		const output = await assistant.transformContent(
			'The quick brown fox jumps over the lazy dog.',
			'  Rewrite at CEFR A2 level. '
		);

		expect(output).toBe('The fox jumps over the dog.');
		expect(calls).toHaveLength(1);
		expect(calls[0].task).toBe('edit');
		expect(calls[0].input).toEqual({
			instruction: 'Rewrite at CEFR A2 level. Return only the revised content in Markdown.',
			content: 'The quick brown fox jumps over the lazy dog.',
			maxTokens: 1600
		});
	});

	test('clipping edits request a bounded length-based output budget', async () => {
		const { sendRequest, calls } = fakeModel({ edit: () => 'Revised content' });
		const assistant = createLanguageLearningAssistant(sendRequest);

		await assistant.transformContent('A'.repeat(2000), 'Simplify.');
		await assistant.transformContent('A'.repeat(20000), 'Create a bilingual version.');

		expect(calls.map(call => (call.input as AiTaskInput<'edit'>).maxTokens)).toEqual([2400, 12000]);
	});

	test('user can ask for an explanation of a word in its transcript context', async () => {
		const { sendRequest, calls } = fakeModel({ explain: () => '**encounter** /ɪnˈkaʊntər/ — 遇到' });
		const assistant = createLanguageLearningAssistant(sendRequest);

		const output = await assistant.explainSelection({
			kind: 'word',
			text: 'encountered',
			context: 'I encountered an unfamiliar word.'
		}, 'Simplified Chinese');

		expect(output).toBe('**encounter** /ɪnˈkaʊntər/ — 遇到');
		expect(calls).toHaveLength(1);
		expect(calls[0].task).toBe('explain');
		expect(calls[0].input).toEqual({
			instruction: 'Explain the selected word for a language learner in Simplified Chinese. Use only Simplified Chinese for all explanation text, labels, and translations. Include its lemma, pronunciation, meaning in this context, one concise usage note, and one example sentence. Return concise plain text.',
			content: 'Selected word: encountered\nContext: I encountered an unfamiliar word.'
		});
	});

	test('user can ask for a sentence translation and grammar breakdown', async () => {
		const { sendRequest, calls } = fakeModel({ explain: () => '自然翻译：我偶然遇到了一个生词。' });
		const assistant = createLanguageLearningAssistant(sendRequest);

		const output = await assistant.explainSelection({
			kind: 'sentence',
			text: 'I encountered an unfamiliar word.',
			context: 'I encountered an unfamiliar word.'
		}, 'Simplified Chinese');

		expect(output).toBe('自然翻译：我偶然遇到了一个生词。');
		expect(calls[0].task).toBe('explain');
		expect(calls[0].input).toEqual({
			instruction: 'Explain the selected sentence for a language learner in Simplified Chinese. Use only Simplified Chinese for all explanation text, labels, and translations. Include a natural translation, its grammar structure, and the key expressions in context. Return concise plain text.',
			content: 'Selected sentence: I encountered an unfamiliar word.\nContext: I encountered an unfamiliar word.'
		});
	});

	test('bilingual transcript translations stay aligned when the model reorders segments', async () => {
		const { sendRequest, calls } = fakeModel({
			translate: () => [
				{ id: 2, text: '再见。' },
				{ id: 0, text: '你好。' },
				{ id: 1, text: '你好吗？' }
			]
		});
		const assistant = createLanguageLearningAssistant(sendRequest);

		const translations = await assistant.translateTranscript(
			['Hello.', 'How are you?', 'Bye.'],
			'Simplified Chinese'
		);

		expect(translations).toEqual(['你好。', '你好吗？', '再见。']);
		expect(calls).toHaveLength(1);
		expect(calls[0].task).toBe('translate');
		expect(calls[0].input).toEqual({
			instruction: TRANSLATION_INSTRUCTION,
			segments: [
				{ id: 0, text: 'Hello.' },
				{ id: 1, text: 'How are you?' },
				{ id: 2, text: 'Bye.' }
			],
			maxTokens: 1600
		});
	});

	test('an incomplete translation group leaves missing segments empty and a retry requests only them', async () => {
		const checkpoints = memoryTranslationCheckpoints();
		const { sendRequest, calls } = fakeModel({
			translate: (input, callIndex) => callIndex === 0
				? [{ id: 1, text: 'T1' }]
				: translateEach(input)
		});
		const assistant = createLanguageLearningAssistant(sendRequest, {
			transcriptTranslationCheckpoints: checkpoints.store
		});
		const segments = ['First.', 'Second.', 'Third.'];
		const progress: TranscriptTranslationProgress[] = [];

		const partial = await assistant.translateTranscript(segments, 'Simplified Chinese', next => progress.push(next));

		expect(partial).toEqual(['', 'T1', '']);
		expect(partial.every(translation => translation.trim())).toBe(false);
		expect(progress[progress.length - 1]).toEqual({ completed: 1, total: 1, translations: ['', 'T1', ''] });
		expect(checkpoints.current()).toEqual(['', 'T1', '']);

		const completed = await assistant.translateTranscript(segments, 'Simplified Chinese');

		expect(completed).toEqual(['T0', 'T1', 'T2']);
		expect(calls).toHaveLength(2);
		expect(segmentsOf(calls[1])).toEqual([
			{ id: 0, text: 'First.' },
			{ id: 2, text: 'Third.' }
		]);
	});

	test('annotates Japanese kanji with aligned hiragana readings', async () => {
		const tokens = [
			{ text: '私', reading: 'わたし' },
			{ text: 'は', reading: '' },
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'を', reading: '' },
			{ text: '勉強', reading: 'べんきょう' },
			{ text: 'します。', reading: '' }
		];
		const { sendRequest, calls } = fakeModel({ reading: () => [{ id: 0, tokens }] });
		const assistant = createLanguageLearningAssistant(sendRequest);

		const readings = await assistant.annotateJapaneseTranscript(['私は日本語を勉強します。']);

		expect(readings).toEqual([tokens]);
		expect(calls).toHaveLength(1);
		expect(calls[0].task).toBe('reading');
		expect(calls[0].input).toEqual({
			instruction: READING_INSTRUCTION,
			segments: [{ id: 0, text: '私は日本語を勉強します。' }],
			maxTokens: 2000
		});
	});

	test('Japanese reading batches request a source-length output budget', async () => {
		const { sendRequest, calls } = fakeModel({
			reading: input => input.segments.map(({ id, text }) => ({ id, tokens: [{ text, reading: 'ひ' }] }))
		});
		const assistant = createLanguageLearningAssistant(sendRequest, { japaneseReadingPromptCharLimit: 10000 });

		await assistant.annotateJapaneseTranscript(['日'.repeat(600), '本'.repeat(600)]);
		await assistant.annotateJapaneseTranscript(['語'.repeat(4000)]);

		expect(calls.map(call => (call.input as AiTaskInput<'reading'>).maxTokens)).toEqual([4800, 12000]);
	});

	test('keeps Japanese readings aligned and drops readings that do not reproduce the source', async () => {
		const segments = ['私は', '日本語', '勉強', 'です。'];
		const { sendRequest } = fakeModel({
			reading: () => [
				// Out of order and correct.
				{ id: 3, tokens: [{ text: 'です。', reading: '' }] },
				// Does not reproduce the source text.
				{ id: 0, tokens: [{ text: '私', reading: 'わたし' }] },
				// Kanji token without a reading.
				{ id: 1, tokens: [{ text: '日本語', reading: ' ' }] },
				{ id: 2, tokens: [{ text: '勉', reading: 'べん' }, { text: '強', reading: 'きょう' }] }
			]
		});
		const assistant = createLanguageLearningAssistant(sendRequest);
		const progress: TranscriptReadingProgress[] = [];

		const readings = await assistant.annotateJapaneseTranscript(segments, next => progress.push(next));

		expect(readings).toEqual([
			[],
			[],
			[{ text: '勉', reading: 'べん' }, { text: '強', reading: 'きょう' }],
			[{ text: 'です。', reading: '' }]
		]);
		expect(isCompleteTranscriptReadings(readings, segments)).toBe(false);
		expect(progress[progress.length - 1]).toMatchObject({ completed: 1, total: 1, completedSegments: 2, totalSegments: 4 });
	});

	test('missing Japanese reading segments stay empty and are never reported complete', async () => {
		const segments = ['日本', '語'];
		const { sendRequest } = fakeModel({
			reading: () => [{ id: 1, tokens: [{ text: '語', reading: 'ご' }] }]
		});
		const assistant = createLanguageLearningAssistant(sendRequest);

		const readings = await assistant.annotateJapaneseTranscript(segments);

		expect(readings).toEqual([[], [{ text: '語', reading: 'ご' }]]);
		expect(isCompleteTranscriptReadings(readings, segments)).toBe(false);
	});

	test('reports progress for sequential Japanese reading batches', async () => {
		const progress: TranscriptReadingProgress[] = [];
		const segments = ['日'.repeat(600), '本'.repeat(600)];
		const { sendRequest, calls } = fakeModel({
			reading: input => input.segments.map(({ id, text }) => ({ id, tokens: [{ text, reading: 'ひ' }] }))
		});
		const assistant = createLanguageLearningAssistant(sendRequest, { japaneseReadingPromptCharLimit: 1000 });

		await assistant.annotateJapaneseTranscript(segments, next => progress.push(next));

		expect(calls.map(idsOf)).toEqual([[0], [1]]);
		expect(progress).toEqual([
			{ completed: 0, total: 2, completedSegments: 0, totalSegments: 2, readings: [[], []] },
			{
				completed: 1,
				total: 2,
				completedSegments: 1,
				totalSegments: 2,
				readings: [[{ text: segments[0], reading: 'ひ' }], []]
			},
			{
				completed: 2,
				total: 2,
				completedSegments: 2,
				totalSegments: 2,
				readings: [
					[{ text: segments[0], reading: 'ひ' }],
					[{ text: segments[1], reading: 'ひ' }]
				]
			}
		]);
	});

	test('retains completed Japanese reading checkpoints so a later Reader can reuse them', async () => {
		let checkpoint: TranscriptReadingSegments | undefined;
		const clear = vi.fn();
		const checkpoints: TranscriptReadingCheckpointStore = {
			load: async () => checkpoint,
			save: async (_segments, readings) => {
				checkpoint = readings.map(tokens => tokens.map(token => ({ ...token })));
			},
			clear: async () => {
				clear();
				checkpoint = undefined;
			}
		};
		const { sendRequest, calls } = fakeModel({
			reading: () => [{ id: 0, tokens: [{ text: '日本語', reading: 'にほんご' }] }]
		});
		const assistant = createLanguageLearningAssistant(sendRequest, {
			japaneseReadingCheckpoints: checkpoints
		});

		await assistant.annotateJapaneseTranscript(['日本語']);
		await assistant.annotateJapaneseTranscript(['日本語']);

		expect(calls).toHaveLength(1);
		expect(checkpoint).toEqual([[{ text: '日本語', reading: 'にほんご' }]]);
		expect(clear).not.toHaveBeenCalled();
	});

	test('resumes Japanese readings by requesting only segments without a complete checkpoint', async () => {
		const segments = ['日本', '語', '勉強'];
		const checkpoints: TranscriptReadingCheckpointStore = {
			load: async () => [
				[{ text: '日本', reading: 'にほん' }],
				[{ text: '語', reading: '' }],
				[]
			],
			save: vi.fn(),
			clear: vi.fn()
		};
		const { sendRequest, calls } = fakeModel({
			reading: input => input.segments.map(({ id, text }) => ({ id, tokens: [{ text, reading: 'よみ' }] }))
		});
		const assistant = createLanguageLearningAssistant(sendRequest, { japaneseReadingCheckpoints: checkpoints });

		const readings = await assistant.annotateJapaneseTranscript(segments);

		expect(calls.map(idsOf)).toEqual([[1, 2]]);
		expect(readings).toEqual([
			[{ text: '日本', reading: 'にほん' }],
			[{ text: '語', reading: 'よみ' }],
			[{ text: '勉強', reading: 'よみ' }]
		]);
	});

	test('long transcripts are translated in bounded provider requests', async () => {
		const { sendRequest, calls } = fakeModel({
			translate: input => input.segments.map(({ id }) => ({ id, text: id === 0 ? '第一段' : '第二段' }))
		});
		const assistant = createLanguageLearningAssistant(sendRequest);

		const translations = await assistant.translateTranscript(
			['A'.repeat(3500), 'B'.repeat(3500)],
			'Simplified Chinese'
		);

		expect({
			translations,
			ids: calls.map(idsOf),
			maxTokens: calls.map(call => (call.input as AiTaskInput<'translate'>).maxTokens)
		}).toEqual({
			translations: ['第一段', '第二段'],
			ids: [[0], [1]],
			// ceil(3500 * 1.2 + 1 segment * 15)
			maxTokens: [4215, 4215]
		});
	});

	test('packs atomic segments greedily under the prompt limit and isolates an oversized segment', async () => {
		const limit = 400;
		const segments = [
			...Array.from({ length: 6 }, (_value, index) => `Short segment number ${index}.`),
			'X'.repeat(600),
			...Array.from({ length: 4 }, (_value, index) => `Tail segment ${index}.`)
		];
		const { sendRequest, calls } = fakeModel({ translate: translateEach });
		const assistant = createLanguageLearningAssistant(sendRequest, { transcriptTranslationPromptCharLimit: limit });

		const translations = await assistant.translateTranscript(segments, 'Simplified Chinese');

		const segmentLength = (segment: TranscriptSegment) => JSON.stringify(segment).length + 1;
		const groupLength = (group: TranscriptSegment[]) => TRANSLATION_INSTRUCTION.length
			+ group.reduce((total, segment) => total + segmentLength(segment), 0);
		const groups = calls.map(segmentsOf);

		expect(translations).toEqual(segments.map((_segment, id) => `T${id}`));
		expect(groups.length).toBeGreaterThan(2);
		// Every segment is sent once, whole, in source order, with its source index as id.
		expect(groups.flat()).toEqual(segments.map((text, id) => ({ id, text })));
		for (const group of groups) {
			if (group.length > 1) expect(groupLength(group)).toBeLessThanOrEqual(limit);
		}
		// Greedy: the next group's first segment would not have fit in the previous group.
		groups.slice(1).forEach((group, index) => {
			expect(groupLength(groups[index]) + segmentLength(group[0])).toBeGreaterThan(limit);
		});
		expect(groups.find(group => group.some(segment => segment.id === 6))).toEqual([
			{ id: 6, text: 'X'.repeat(600) }
		]);
	});

	test('reports translation progress for sequential batches', async () => {
		const progress: TranscriptTranslationProgress[] = [];
		const { sendRequest } = fakeModel({
			translate: input => input.segments.map(({ id }) => ({ id, text: id === 0 ? '第一段' : '第二段' }))
		});
		const assistant = createLanguageLearningAssistant(sendRequest);
		const segments = ['A'.repeat(3500), 'B'.repeat(3500)];

		await assistant.translateTranscript(segments, 'Simplified Chinese', next => progress.push(next));

		expect(progress).toEqual([
			{ completed: 0, total: 2, translations: ['', ''] },
			{ completed: 1, total: 2, translations: ['第一段', ''] },
			{ completed: 2, total: 2, translations: ['第一段', '第二段'] }
		]);
	});

	test('resumes translation from an asynchronous checkpoint and saves each completed batch', async () => {
		const checkpoints = memoryTranslationCheckpoints(['第一段', '']);
		const { sendRequest, calls } = fakeModel({ translate: () => [{ id: 1, text: '第二段' }] });
		const assistant = createLanguageLearningAssistant(sendRequest, {
			transcriptTranslationCheckpoints: checkpoints.store
		});
		const progress: TranscriptTranslationProgress[] = [];

		const translations = await assistant.translateTranscript(
			['First.', 'Second.'],
			'Simplified Chinese',
			next => progress.push(next)
		);

		expect(translations).toEqual(['第一段', '第二段']);
		expect(calls).toHaveLength(1);
		expect(segmentsOf(calls[0])).toEqual([{ id: 1, text: 'Second.' }]);
		expect(checkpoints.store.save).toHaveBeenCalledWith(
			['First.', 'Second.'],
			['第一段', '第二段']
		);
		expect(progress).toEqual([
			{ completed: 0, total: 1, translations: ['第一段', ''] },
			{ completed: 1, total: 1, translations: ['第一段', '第二段'] }
		]);
	});

	test('ignores reply items for segments that were not requested', async () => {
		const checkpoints = memoryTranslationCheckpoints(['第一段', '']);
		const { sendRequest } = fakeModel({
			translate: () => [{ id: 0, text: 'overwritten' }, { id: 1, text: '第二段' }, { id: 5, text: 'extra' }]
		});
		const assistant = createLanguageLearningAssistant(sendRequest, {
			transcriptTranslationCheckpoints: checkpoints.store
		});

		await expect(assistant.translateTranscript(['First.', 'Second.'], 'Simplified Chinese'))
			.resolves.toEqual(['第一段', '第二段']);

		const reading = fakeModel({
			reading: () => [
				{ id: 0, tokens: [{ text: '今日', reading: 'こんにち' }] },
				{ id: 1, tokens: [{ text: '日本', reading: 'にほん' }] }
			]
		});
		const readings = await createLanguageLearningAssistant(reading.sendRequest, {
			japaneseReadingCheckpoints: {
				load: async () => [[{ text: '今日', reading: 'きょう' }], []],
				save: vi.fn(),
				clear: vi.fn()
			}
		}).annotateJapaneseTranscript(['今日', '日本']);
		expect(readings).toEqual([[{ text: '今日', reading: 'きょう' }], [{ text: '日本', reading: 'にほん' }]]);
	});

	test('a rejected group stops the transcript job and keeps earlier groups checkpointed', async () => {
		const checkpoints = memoryTranslationCheckpoints();
		const badResponse = new AiError('bad-response', { detail: 'segments were not an array' });
		const { sendRequest, calls } = fakeModel({
			translate: (input, callIndex) => {
				if (callIndex === 1) throw badResponse;
				return translateEach(input);
			}
		});
		const assistant = createLanguageLearningAssistant(sendRequest, {
			transcriptTranslationCheckpoints: checkpoints.store
		});
		const segments = ['A'.repeat(3500), 'B'.repeat(3500), 'C'.repeat(3500)];
		const progress: TranscriptTranslationProgress[] = [];

		await expect(assistant.translateTranscript(segments, 'Simplified Chinese', next => progress.push(next)))
			.rejects.toBe(badResponse);

		expect(calls.map(idsOf)).toEqual([[0], [1]]);
		expect(checkpoints.current()).toEqual(['T0', '', '']);
		expect(progress[progress.length - 1]).toEqual({ completed: 1, total: 3, translations: ['T0', '', ''] });

		const translations = await assistant.translateTranscript(segments, 'Simplified Chinese');

		expect(translations).toEqual(['T0', 'T1', 'T2']);
		expect(calls.slice(2).map(idsOf)).toEqual([[1], [2]]);
	});

	test('a rejected Japanese reading group stops the job and keeps earlier groups checkpointed', async () => {
		let checkpoint: TranscriptReadingSegments | undefined;
		const checkpoints: TranscriptReadingCheckpointStore = {
			load: async () => checkpoint,
			save: async (_segments, readings) => {
				checkpoint = readings;
			},
			clear: async () => {
				checkpoint = undefined;
			}
		};
		const segments = ['日'.repeat(600), '本'.repeat(600)];
		const { sendRequest, calls } = fakeModel({
			reading: (input, callIndex) => {
				if (callIndex === 1) throw new AiError('bad-response');
				return input.segments.map(({ id, text }) => ({ id, tokens: [{ text, reading: 'ひ' }] }));
			}
		});
		const assistant = createLanguageLearningAssistant(sendRequest, {
			japaneseReadingPromptCharLimit: 1000,
			japaneseReadingCheckpoints: checkpoints
		});

		await expect(assistant.annotateJapaneseTranscript(segments)).rejects.toBeInstanceOf(AiError);
		expect(checkpoint).toEqual([[{ text: segments[0], reading: 'ひ' }], []]);

		const readings = await assistant.annotateJapaneseTranscript(segments);

		expect(isCompleteTranscriptReadings(readings, segments)).toBe(true);
		expect(calls.map(idsOf)).toEqual([[0], [1], [1]]);
	});

	test('stops before the next transcript batch when cancelled', async () => {
		const abortController = new AbortController();
		const { sendRequest, calls } = fakeModel({ translate: () => [] });
		const assistant = createLanguageLearningAssistant(sendRequest);

		await expect(assistant.translateTranscript(
			['A'.repeat(3500), 'B'.repeat(3500)],
			'Simplified Chinese',
			next => {
				if (next.completed === 1) abortController.abort();
			},
			abortController.signal
		)).rejects.toBeInstanceOf(RequestCancelledError);

		expect(calls).toHaveLength(1);
		expect(calls[0].signal).toBe(abortController.signal);
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
