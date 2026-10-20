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

describe('Reader task bar', () => {
	let clicks: ReturnType<typeof captureTrustedClicks>;

	beforeEach(() => {
		clicks = captureTrustedClicks();
	});

	afterEach(() => {
		clicks.restore();
		vi.useRealTimers();
	});

	test('keeps the engine and estimate empty until getExecutionInfo answers', async () => {
		const { segments } = createTranscript(['First.', 'Second.']);
		let answer!: (info: TranscriptExecutionInfo) => void;
		const taskBar = createTaskBar({
			doc: document,
			segments,
			tools: { getExecutionInfo: vi.fn(() => new Promise<TranscriptExecutionInfo>(resolve => { answer = resolve; })) },
			onCancel: vi.fn()
		});
		const engine = taskBar.element.querySelector('.player-learning-task-engine');
		const estimate = taskBar.element.querySelector('.player-learning-task-estimate');

		taskBar.begin(Date.now());
		const loading = taskBar.loadExecutionInfo('translate', ['First.', 'Second.']);
		expect(engine?.textContent).toBe('');
		expect(estimate?.textContent).toBe('');

		answer({ label: 'OpenAI · B', promptCharLimit: 7 });
		await loading;
		expect(engine?.textContent).toBe('OpenAI · B');
		expect(estimate?.textContent).toBe('readerTaskEstimate:readerTaskSegments:2,readerTaskBatches:2');
		expect(taskBar.executionInfo?.label).toBe('OpenAI · B');
	});

	test('the estimate uses the singular message for one segment or one batch', async () => {
		const { segments } = createTranscript(['First.', 'Second.']);
		const taskBar = createTaskBar({
			doc: document,
			segments,
			tools: { getExecutionInfo: vi.fn().mockResolvedValue({ label: 'OpenAI · B', promptCharLimit: 1000 }) },
			onCancel: vi.fn()
		});
		const estimate = () => taskBar.element.querySelector('.player-learning-task-estimate')?.textContent;

		await taskBar.loadExecutionInfo('translate', ['First.', 'Second.']);
		expect(estimate()).toBe('readerTaskEstimate:readerTaskSegments:2,readerTaskBatchesOne:1');
		await taskBar.loadExecutionInfo('translate', ['First.']);
		expect(estimate()).toBe('readerTaskEstimate:readerTaskSegmentsOne:1,readerTaskBatchesOne:1');
	});

	test('leaves the estimate empty when getExecutionInfo fails', async () => {
		const { segments } = createTranscript();
		const taskBar = createTaskBar({
			doc: document,
			segments,
			tools: { getExecutionInfo: vi.fn().mockRejectedValue(new Error('storage')) },
			onCancel: vi.fn()
		});

		taskBar.begin(Date.now());
		await taskBar.loadExecutionInfo('reading', ['Hello world.']);

		expect(taskBar.element.querySelector('.player-learning-task-estimate')?.textContent).toBe('');
		expect(taskBar.executionInfo).toBeUndefined();
	});

	test('starts the elapsed timer with a run and stops it when the run ends', () => {
		vi.useFakeTimers();
		const { segments } = createTranscript();
		const taskBar = createTaskBar({ doc: document, segments, tools: {}, onCancel: vi.fn() });
		const elapsed = taskBar.element.querySelector('.player-learning-task-elapsed');

		taskBar.begin(Date.now());
		expect(taskBar.element.hidden).toBe(false);
		expect(taskBar.element.getAttribute('aria-busy')).toBe('true');
		expect(elapsed?.textContent).toBe('readerTaskElapsed:0');
		vi.advanceTimersByTime(2000);
		expect(elapsed?.textContent).toBe('readerTaskElapsed:2');

		taskBar.finish('done');
		vi.advanceTimersByTime(5000);
		expect(elapsed?.textContent).toBe('readerTaskElapsed:2');
		expect(taskBar.element.getAttribute('aria-busy')).toBe('false');
		expect(vi.getTimerCount()).toBe(0);
	});

	test('shows the retry wait, then the progress label, and says when a run was cancelled', () => {
		const { segments } = createTranscript();
		const taskBar = createTaskBar({ doc: document, segments, tools: {}, onCancel: vi.fn() });
		const status = taskBar.element.querySelector('.player-learning-progress') as HTMLElement;
		const progress = taskBar.element.querySelector('progress') as HTMLProgressElement;

		taskBar.begin(Date.now());
		taskBar.setProgress(1, 4, 'readerTranslationProgress:1,4', { delayMs: 4200 });
		expect(status.textContent).toBe('readerTranscriptRetrying:5');
		taskBar.setProgress(2, 4, 'readerTranslationProgress:2,4');
		expect(status.textContent).toBe('readerTranslationProgress:2,4');
		expect([progress.value, progress.max]).toEqual([2, 4]);

		taskBar.finish('cancelled');
		expect(status.textContent).toBe('readerAiCancelled');
		expect(status.hidden).toBe(false);
	});

	test('Cancel is shown while running and calls onCancel only for a trusted click', async () => {
		const { segments } = createTranscript();
		const onCancel = vi.fn();
		const taskBar = createTaskBar({ doc: document, segments, tools: {}, onCancel });
		const cancel = taskBar.element.querySelector('.player-learning-cancel') as HTMLButtonElement;

		expect(cancel.hidden).toBe(true);
		taskBar.begin(Date.now());
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
