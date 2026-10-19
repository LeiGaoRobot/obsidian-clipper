import { describe, expect, test } from 'vitest';
import type { AiTaskInput, AiTaskOutput } from '../ai/contracts';
import { AiError } from '../ai/errors';
import type {
	TranscriptJobInput,
	TranscriptJobProgress,
	TranscriptJobResult,
	TranscriptJobRetry
} from '../ai/job-client';
import type { TranscriptJobTask } from '../ai/job-identity';
import {
	createLanguageLearningAssistant,
	isCompleteTranscriptReadings,
	isCompleteTranscriptTranslations,
	LanguageLearningTask,
	RunLanguageLearningJob,
	SendLanguageLearningRequest,
	TranscriptReadingProgress,
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

interface FakeJobCall {
	task: TranscriptJobTask;
	input: TranscriptJobInput;
	signal?: AbortSignal;
}

interface FakeJobScript {
	/** Progress reports and retry notices the fake gateway sends before it settles. */
	events?: Array<
		| { progress: Omit<TranscriptJobProgress, 'values'> & { values: unknown[] } }
		| { retry: TranscriptJobRetry }
	>;
	status?: 'completed' | 'incomplete';
	values: unknown[];
	reject?: unknown;
}

// A fake background job: records each call, replays scripted events, then settles.
function fakeJobs(script: (call: FakeJobCall) => FakeJobScript) {
	const calls: FakeJobCall[] = [];
	const runJob = (async (task: TranscriptJobTask, input: TranscriptJobInput, options: {
		signal?: AbortSignal;
		onProgress?: (progress: TranscriptJobProgress) => void;
		onRetry?: (retry: TranscriptJobRetry) => void;
	}) => {
		const call = { task, input, signal: options.signal };
		calls.push(call);
		const { events = [], status = 'completed', values, reject } = script(call);
		for (const event of events) {
			if ('progress' in event) options.onProgress?.(event.progress as TranscriptJobProgress);
			else options.onRetry?.(event.retry);
		}
		if (reject) throw reject;
		const total = input.segments.length;
		return {
			status,
			values,
			results: [],
			attempts: { requests: 1, retries: 0, splits: 0 },
			completedGroups: 1,
			totalGroups: 1,
			completedSegments: total,
			totalSegments: total
		} as unknown as TranscriptJobResult;
	}) as RunLanguageLearningJob;
	return { runJob, calls };
}

const counts = (completedGroups: number, totalGroups: number, completedSegments: number, totalSegments: number) => ({
	completedGroups,
	totalGroups,
	completedSegments,
	totalSegments
});

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

	test('translates a whole transcript as one background job with index ids and the shared scope', async () => {
		const { runJob, calls } = fakeJobs(() => ({ values: ['你好。', '你好吗？', '再见。'] }));
		const { sendRequest, calls: requests } = fakeModel({});
		const assistant = createLanguageLearningAssistant(sendRequest, { runJob });

		const translations = await assistant.translateTranscript(
			['Hello.', 'How are you?', 'Bye.'],
			'Simplified Chinese'
		);

		expect(translations).toEqual(['你好。', '你好吗？', '再见。']);
		expect(requests).toHaveLength(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].task).toBe('translate');
		expect(calls[0].input).toEqual({
			instruction: TRANSLATION_INSTRUCTION,
			segments: [
				{ id: 0, text: 'Hello.' },
				{ id: 1, text: 'How are you?' },
				{ id: 2, text: 'Bye.' }
			],
			identity: { namespace: 'translations', scope: 'shared:Simplified Chinese' }
		});
	});

	test('a translation job can use a caller scope, such as the fixed Japanese stage', async () => {
		const { runJob, calls } = fakeJobs(() => ({ values: ['こんにちは。'] }));
		const assistant = createLanguageLearningAssistant(fakeModel({}).sendRequest, { runJob });

		await assistant.translateTranscript(['Hello.'], 'Japanese', undefined, undefined, {
			scope: 'japanese-readings:Japanese'
		});

		expect(calls[0].input.identity).toEqual({ namespace: 'translations', scope: 'japanese-readings:Japanese' });
		expect(calls[0].input.instruction).toContain('Translate each transcript segment into Japanese.');
	});

	test('maps job progress to translation progress and surfaces a retry backoff', async () => {
		const { runJob } = fakeJobs(() => ({
			events: [
				{ progress: { ...counts(0, 2, 0, 3), values: ['', '', ''] } },
				{ progress: { ...counts(1, 2, 2, 3), values: ['T0', 'T1', ''] } },
				{ retry: { code: 'rate-limited', status: 429, delayMs: 2500, attempt: 1 } },
				{ progress: { ...counts(2, 2, 3, 3), values: ['T0', 'T1', 'T2'] } }
			],
			values: ['T0', 'T1', 'T2']
		}));
		const assistant = createLanguageLearningAssistant(fakeModel({}).sendRequest, { runJob });
		const progress: TranscriptTranslationProgress[] = [];

		await assistant.translateTranscript(['A', 'B', 'C'], 'Simplified Chinese', next => progress.push(next));

		expect(progress).toEqual([
			{ completed: 0, total: 2, translations: ['', '', ''] },
			{ completed: 1, total: 2, translations: ['T0', 'T1', ''] },
			{ completed: 1, total: 2, translations: ['T0', 'T1', ''], retry: { delayMs: 2500, attempt: 1 } },
			{ completed: 2, total: 2, translations: ['T0', 'T1', 'T2'] }
		]);
	});

	test('an incomplete translation job resolves with aligned gaps', async () => {
		const { runJob } = fakeJobs(() => ({ status: 'incomplete', values: ['', 'T1', ''] }));
		const assistant = createLanguageLearningAssistant(fakeModel({}).sendRequest, { runJob });
		const segments = ['First.', 'Second.', 'Third.'];

		const partial = await assistant.translateTranscript(segments, 'Simplified Chinese');

		expect(partial).toEqual(['', 'T1', '']);
		expect(isCompleteTranscriptTranslations(partial, segments)).toBe(false);
	});

	test('a translation is complete when every non-blank source has text', () => {
		expect(isCompleteTranscriptTranslations(['你好', ''], ['Hello', ''])).toBe(true);
		expect(isCompleteTranscriptTranslations(['你好', ''], ['Hello', '  '])).toBe(true);
		expect(isCompleteTranscriptTranslations(['你好', ' '], ['Hello', 'World'])).toBe(false);
		expect(isCompleteTranscriptTranslations(['你好'], ['Hello', 'World'])).toBe(false);
	});

	test('annotates Japanese readings as one background job under the shared readings identity', async () => {
		const tokens = [
			{ text: '私', reading: 'わたし' },
			{ text: 'は', reading: '' },
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'を', reading: '' },
			{ text: '勉強', reading: 'べんきょう' },
			{ text: 'します。', reading: '' }
		];
		const { runJob, calls } = fakeJobs(() => ({ values: [tokens, []] }));
		const assistant = createLanguageLearningAssistant(fakeModel({}).sendRequest, { runJob });
		const segments = ['私は日本語を勉強します。', ''];

		const readings = await assistant.annotateJapaneseTranscript(segments);

		expect(readings).toEqual([tokens, []]);
		expect(isCompleteTranscriptReadings(readings, segments)).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].task).toBe('reading');
		expect(calls[0].input).toEqual({
			instruction: READING_INSTRUCTION,
			segments: [{ id: 0, text: '私は日本語を勉強します。' }, { id: 1, text: '' }],
			identity: { namespace: 'japanese-readings', scope: 'shared' }
		});
	});

	test('maps job progress to reading progress, including segment counts and retries', async () => {
		const first = [{ text: '日本', reading: 'にほん' }];
		const { runJob } = fakeJobs(() => ({
			events: [
				{ progress: { ...counts(0, 2, 0, 2), values: [[], []] } },
				{ retry: { code: 'provider-error', status: 503, delayMs: 900, attempt: 2 } },
				{ progress: { ...counts(1, 2, 1, 2), values: [first, []] } }
			],
			status: 'incomplete',
			values: [first, []]
		}));
		const assistant = createLanguageLearningAssistant(fakeModel({}).sendRequest, { runJob });
		const progress: TranscriptReadingProgress[] = [];

		const readings = await assistant.annotateJapaneseTranscript(['日本', '語'], next => progress.push(next));

		expect(readings).toEqual([first, []]);
		expect(isCompleteTranscriptReadings(readings, ['日本', '語'])).toBe(false);
		expect(progress).toEqual([
			{ completed: 0, total: 2, completedSegments: 0, totalSegments: 2, readings: [[], []] },
			{ completed: 0, total: 2, completedSegments: 0, totalSegments: 2, readings: [[], []], retry: { delayMs: 900, attempt: 2 } },
			{ completed: 1, total: 2, completedSegments: 1, totalSegments: 2, readings: [first, []] }
		]);
	});

	test('passes the abort signal to the job and surfaces a job error', async () => {
		const controller = new AbortController();
		const failure = new AiError('auth', { status: 401 });
		const { runJob, calls } = fakeJobs(() => ({ values: [], reject: failure }));
		const assistant = createLanguageLearningAssistant(fakeModel({}).sendRequest, { runJob });

		await expect(assistant.translateTranscript(['A'], 'Simplified Chinese', undefined, controller.signal))
			.rejects.toBe(failure);
		expect(calls[0].signal).toBe(controller.signal);
	});

	test('does not start a job when already cancelled, and rejects a result that arrives after cancel', async () => {
		const controller = new AbortController();
		const { runJob, calls } = fakeJobs(() => {
			controller.abort();
			return { values: ['T0'] };
		});
		const assistant = createLanguageLearningAssistant(fakeModel({}).sendRequest, { runJob });

		await expect(assistant.translateTranscript(['A'], 'Simplified Chinese', undefined, controller.signal))
			.rejects.toBeInstanceOf(RequestCancelledError);
		await expect(assistant.annotateJapaneseTranscript(['日本'], undefined, controller.signal))
			.rejects.toBeInstanceOf(RequestCancelledError);
		expect(calls).toHaveLength(1);
	});

	test('an empty transcript needs no job', async () => {
		const { runJob, calls } = fakeJobs(() => ({ values: [] }));
		const assistant = createLanguageLearningAssistant(fakeModel({}).sendRequest, { runJob });

		await expect(assistant.translateTranscript([], 'Simplified Chinese')).resolves.toEqual([]);
		await expect(assistant.annotateJapaneseTranscript([])).resolves.toEqual([]);
		expect(calls).toHaveLength(0);
	});

	test('transcript tasks need a job runner', async () => {
		const assistant = createLanguageLearningAssistant(fakeModel({}).sendRequest);

		await expect(assistant.translateTranscript(['A'], 'Simplified Chinese')).rejects.toThrow('background job runner');
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
