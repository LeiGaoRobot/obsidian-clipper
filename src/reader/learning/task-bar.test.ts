// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../utils/i18n', () => ({
	getMessage: (key: string, substitutions?: string | string[]) => substitutions
		? `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
		: key
}));

import { createTaskBar } from './task-bar';
import { captureTrustedClicks, createTranscript } from './test-support';
import type { TranscriptExecutionInfo } from './types';

function pillParts(pill: HTMLElement) {
	const part = <T extends HTMLElement>(selector: string) => pill.querySelector(selector) as T;
	return {
		spinner: part('.player-learning-task-spinner'),
		estimate: part('.player-learning-task-estimate'),
		phase: part('.player-learning-task-phase'),
		count: part('.player-learning-task-count'),
		status: part('.player-learning-progress'),
		progress: part<HTMLProgressElement>('progress'),
		engine: part('.player-learning-task-engine'),
		cancel: part<HTMLButtonElement>('.player-learning-cancel')
	};
}

describe('Reader progress pill', () => {
	let clicks: ReturnType<typeof captureTrustedClicks>;

	beforeEach(() => {
		clicks = captureTrustedClicks();
	});

	afterEach(() => {
		clicks.restore();
	});

	test('is hidden until a run starts, then shows the spinner, progress, and Cancel in order', () => {
		const { segments } = createTranscript();
		const taskBar = createTaskBar({ doc: document, segments, tools: {}, onCancel: vi.fn() });
		const pill = taskBar.element;
		const parts = pillParts(pill);

		expect(pill.hidden).toBe(true);
		expect(pill.getAttribute('aria-busy')).toBe('false');
		expect(Array.from(pill.children)).toEqual([
			parts.spinner, parts.estimate, parts.status, parts.progress, parts.engine, parts.cancel
		]);
		expect(parts.spinner.getAttribute('aria-hidden')).toBe('true');
		expect(parts.status.getAttribute('role')).toBe('status');

		taskBar.begin();
		expect(pill.hidden).toBe(false);
		expect(pill.getAttribute('aria-busy')).toBe('true');
		expect([parts.spinner.hidden, parts.estimate.hidden, parts.progress.hidden, parts.cancel.hidden])
			.toEqual([false, false, false, false]);
		// No engine until getExecutionInfo answers.
		expect(parts.engine.hidden).toBe(true);
		expect(parts.status.hidden).toBe(true);
	});

	test('keeps the engine and segment count empty until getExecutionInfo answers', async () => {
		const { segments } = createTranscript(['First.', 'Second.']);
		let answer!: (info: TranscriptExecutionInfo) => void;
		const taskBar = createTaskBar({
			doc: document,
			segments,
			tools: { getExecutionInfo: vi.fn(() => new Promise<TranscriptExecutionInfo>(resolve => { answer = resolve; })) },
			onCancel: vi.fn()
		});
		const { engine, estimate } = pillParts(taskBar.element);

		taskBar.begin();
		const loading = taskBar.loadExecutionInfo('translate', ['First.', 'Second.']);
		expect(engine.textContent).toBe('');
		expect(estimate.textContent).toBe('');

		answer({ label: 'OpenAI · B' });
		await loading;
		expect(engine.textContent).toBe('OpenAI · B');
		expect(engine.hidden).toBe(false);
		// The engine truncates when space is short; its tooltip keeps the full name.
		expect(engine.title).toBe('OpenAI · B');
		expect(estimate.textContent).toBe('readerTaskSegments:2');
		expect(taskBar.executionInfo?.label).toBe('OpenAI · B');
	});

	test('the segment count uses the singular message for one segment', async () => {
		const { segments } = createTranscript(['First.', 'Second.']);
		const taskBar = createTaskBar({
			doc: document,
			segments,
			tools: { getExecutionInfo: vi.fn().mockResolvedValue({ label: 'OpenAI · B' }) },
			onCancel: vi.fn()
		});
		const { estimate } = pillParts(taskBar.element);

		await taskBar.loadExecutionInfo('translate', ['First.', 'Second.']);
		expect(estimate.textContent).toBe('readerTaskSegments:2');
		await taskBar.loadExecutionInfo('translate', ['First.']);
		expect(estimate.textContent).toBe('readerTaskSegmentsOne:1');
	});

	test('leaves the estimate empty when getExecutionInfo fails', async () => {
		const { segments } = createTranscript();
		const taskBar = createTaskBar({
			doc: document,
			segments,
			tools: { getExecutionInfo: vi.fn().mockRejectedValue(new Error('storage')) },
			onCancel: vi.fn()
		});

		taskBar.begin();
		await taskBar.loadExecutionInfo('reading', ['Hello world.']);

		expect(pillParts(taskBar.element).estimate.textContent).toBe('');
		expect(taskBar.executionInfo).toBeUndefined();
	});

	test('a running pill shows the phase, x / N, the bar, and a full-text tooltip', async () => {
		const { segments } = createTranscript();
		const taskBar = createTaskBar({
			doc: document,
			segments,
			tools: { getExecutionInfo: vi.fn().mockResolvedValue({ label: 'Anthropic · Claude Sonnet' }) },
			onCancel: vi.fn()
		});
		const pill = taskBar.element;
		const { phase, count, progress } = pillParts(pill);

		taskBar.begin();
		await taskBar.loadExecutionInfo('translate', ['Hello world.']);
		taskBar.setProgress(12, 33, 'readerTaskPhaseTranslate');
		expect(phase.textContent).toBe('readerTaskPhaseTranslate');
		expect(count.textContent).toBe('readerTaskSegmentFraction:12,33');
		expect([progress.value, progress.max]).toEqual([12, 33]);
		// The bar and the tooltip say it in full: phase, x of N segments, and the engine.
		expect(progress.getAttribute('aria-label'))
			.toBe('readerTaskEstimate:readerTaskPhaseTranslate,readerTaskSegmentProgress:12,33');
		expect(pill.title).toBe(
			'readerTaskEstimate:readerTaskEstimate:readerTaskPhaseTranslate,readerTaskSegmentProgress:12,33,Anthropic · Claude Sonnet'
		);
		taskBar.setProgress(0, 1, 'readerTaskPhaseReadings');
		expect(progress.getAttribute('aria-label'))
			.toBe('readerTaskEstimate:readerTaskPhaseReadings,readerTaskSegmentProgressOne:0,1');
		taskBar.dispose();
	});

	test('progress that arrived before getExecutionInfo answers is not replaced by the count', async () => {
		const { segments } = createTranscript(['First.', 'Second.']);
		let answer!: (info: TranscriptExecutionInfo) => void;
		const taskBar = createTaskBar({
			doc: document,
			segments,
			tools: { getExecutionInfo: vi.fn(() => new Promise<TranscriptExecutionInfo>(resolve => { answer = resolve; })) },
			onCancel: vi.fn()
		});
		const { count } = pillParts(taskBar.element);

		taskBar.begin();
		const loading = taskBar.loadExecutionInfo('translate', ['First.', 'Second.']);
		taskBar.setProgress(1, 2, 'readerTaskPhaseTranslate');
		answer({ label: 'OpenAI · B' });
		await loading;
		expect(count.textContent).toBe('readerTaskSegmentFraction:1,2');
		taskBar.dispose();
	});

	test('a finished run hides the pill, so a pill without Cancel never looks like a running task', async () => {
		const { segments } = createTranscript(['First.', 'Second.']);
		const taskBar = createTaskBar({
			doc: document,
			segments,
			tools: { getExecutionInfo: vi.fn().mockResolvedValue({ label: 'Anthropic · Claude Sonnet' }) },
			onCancel: vi.fn()
		});
		const pill = taskBar.element;
		const { cancel, estimate } = pillParts(pill);

		for (const ended of ['done', 'error'] as const) {
			taskBar.begin();
			await taskBar.loadExecutionInfo('translate', ['First.', 'Second.']);
			taskBar.setProgress(1, 2, 'readerTaskPhaseTranslate');
			expect(pill.hidden).toBe(false);
			expect(cancel.hidden).toBe(false);

			taskBar.finish(ended);
			// The result, or the error card, speaks for a finished run.
			expect(pill.hidden).toBe(true);
			expect(cancel.hidden).toBe(true);
			expect(pill.getAttribute('aria-busy')).toBe('false');
		}

		// The next run shows the pill again with fresh progress and Cancel.
		taskBar.begin();
		expect(pill.hidden).toBe(false);
		expect(cancel.hidden).toBe(false);
		expect(estimate.textContent).toBe('');
		taskBar.dispose();
	});

	test('shows the retry wait in place of the progress text until the next progress', () => {
		const { segments } = createTranscript();
		const taskBar = createTaskBar({ doc: document, segments, tools: {}, onCancel: vi.fn() });
		const { status, estimate, progress } = pillParts(taskBar.element);

		taskBar.begin();
		taskBar.setProgress(1, 4, 'readerTaskPhaseTranslate', { delayMs: 4200 });
		expect(status.textContent).toBe('readerTranscriptRetrying:5');
		expect([status.hidden, estimate.hidden, progress.hidden]).toEqual([false, true, false]);
		taskBar.setProgress(2, 4, 'readerTaskPhaseTranslate');
		expect([status.hidden, estimate.hidden]).toEqual([true, false]);
		expect([progress.value, progress.max]).toEqual([2, 4]);
		taskBar.dispose();
	});

	test('a cancelled run says so in the pill until the next task starts', () => {
		const { segments } = createTranscript();
		const taskBar = createTaskBar({ doc: document, segments, tools: {}, onCancel: vi.fn() });
		const pill = taskBar.element;
		const parts = pillParts(pill);

		taskBar.begin();
		taskBar.setProgress(1, 4, 'readerTaskPhaseTranslate');
		taskBar.finish('cancelled');
		expect(pill.hidden).toBe(false);
		expect(pill.getAttribute('aria-busy')).toBe('false');
		expect(parts.status.textContent).toBe('readerAiCancelled');
		expect(parts.status.hidden).toBe(false);
		// Nothing left on the pill suggests the run goes on.
		expect([parts.spinner.hidden, parts.estimate.hidden, parts.progress.hidden, parts.engine.hidden, parts.cancel.hidden])
			.toEqual([true, true, true, true, true]);

		taskBar.begin();
		expect([parts.spinner.hidden, parts.estimate.hidden, parts.progress.hidden, parts.cancel.hidden, parts.status.hidden])
			.toEqual([false, false, false, false, true]);
		taskBar.dispose();
	});

	test('an explanation shows Thinking… with Cancel, and its pill hides once it settles', () => {
		const { segments } = createTranscript();
		const taskBar = createTaskBar({ doc: document, segments, tools: {}, onCancel: vi.fn() });
		const pill = taskBar.element;
		const parts = pillParts(pill);

		taskBar.setStatus('thinking');
		taskBar.setCancelVisible(true);
		expect(pill.hidden).toBe(false);
		expect(pill.getAttribute('aria-busy')).toBe('true');
		expect([parts.spinner.hidden, parts.status.hidden, parts.cancel.hidden]).toEqual([false, false, false]);
		// No transcript run: no progress text, bar, or engine.
		expect([parts.estimate.hidden, parts.progress.hidden, parts.engine.hidden]).toEqual([true, true, true]);

		taskBar.clearStatus();
		taskBar.setCancelVisible(false);
		expect(pill.hidden).toBe(true);
	});

	test('Cancel is shown while running and calls onCancel only for a trusted click', async () => {
		const { segments } = createTranscript();
		const onCancel = vi.fn();
		const taskBar = createTaskBar({ doc: document, segments, tools: {}, onCancel });
		const { cancel } = pillParts(taskBar.element);

		expect(cancel.hidden).toBe(true);
		taskBar.begin();
		expect(cancel.hidden).toBe(false);
		cancel.click();
		expect(onCancel).not.toHaveBeenCalled();
		await clicks.click(cancel);
		expect(onCancel).toHaveBeenCalledOnce();

		taskBar.finish('cancelled');
		expect(cancel.hidden).toBe(true);
		taskBar.dispose();
	});

	test('selects the current segment or the next five minutes from the active segment', () => {
		const { segments } = createTranscript(['Zero.', 'One.', 'Two.', 'Three.']);
		segments[1].classList.add('is-active');
		const taskBar = createTaskBar({ doc: document, segments, tools: {}, onCancel: vi.fn() });

		expect(taskBar.getTaskIndexes()).toEqual([0, 1, 2, 3]);
		taskBar.setTaskRange('current');
		expect(taskBar.getTaskIndexes()).toEqual([1]);
		taskBar.setTaskRange('next-five-minutes');
		// The fixture's segments are 200 seconds apart.
		expect(taskBar.getTaskIndexes()).toEqual([1, 2]);
	});
});
