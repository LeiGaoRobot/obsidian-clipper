import { getMessage } from '../../utils/i18n';
import type { AiActionStatus } from '../../ai/ui/action';
import type { TranscriptJobTask } from '../../ai/job-identity';
import type {
	TranscriptExecutionInfo,
	TranscriptLanguageLearning,
	TranscriptProfileOption,
	TranscriptTaskRange
} from './types';

// The transcript task controls: the AI range select and the task bar (engine, segment count or
// progress, elapsed time, progress bar, Cancel, status line). The bar is a view of the transcript
// action's state; it starts no model work. The engine and segment count stay empty until
// `getExecutionInfo` answers. The bar shows only while a run is running, or says that it was
// cancelled: a finished run hides it, so a bar on screen with no Cancel never looks like a run.

export interface TaskBar {
	/** The AI range control, appended before the bilingual button. */
	rangeControl: HTMLElement;
	element: HTMLElement;
	getTaskRange(): TranscriptTaskRange;
	setTaskRange(range: TranscriptTaskRange): void;
	/** Source indexes of the selected range: the active segment, the next five minutes, or all. */
	getTaskIndexes(): number[];
	/** The latest answer of `getExecutionInfo`, if any. */
	readonly executionInfo: TranscriptExecutionInfo | undefined;
	/** Asks `getExecutionInfo` for `task` and shows its engine and the segment count of `taskTexts`. */
	loadExecutionInfo(task: TranscriptJobTask, taskTexts: string[]): Promise<void>;
	/** Records the profile Switch and retry routed the task to; the retry refreshes the engine. */
	useProfile(option: TranscriptProfileOption): void;
	/** A transcript run started: busy, elapsed timer, empty progress, Cancel shown. */
	begin(startedAt: number): void;
	/** `completed` of `total` segments are done in `phase` (e.g. Translating subtitles). */
	setProgress(completed: number, total: number, phase: string, retry?: { delayMs: number }): void;
	/** A transcript run ended: the timer stops and Cancel hides; a cancelled run says so, any other run hides the bar. */
	finish(status: AiActionStatus): void;
	setStatus(message: string): void;
	clearStatus(): void;
	setCancelVisible(visible: boolean): void;
	dispose(): void;
}

export interface TaskBarOptions {
	doc: Document;
	segments: HTMLElement[];
	tools: Pick<TranscriptLanguageLearning, 'getExecutionInfo'>;
	/** A trusted click on Cancel. */
	onCancel: () => void;
	now?: () => number;
}

function getSegmentTimestamp(segment: HTMLElement): number | null {
	const timestamp = segment.querySelector<HTMLElement>('.timestamp[data-timestamp]')?.dataset.timestamp;
	if (timestamp == null) return null;
	const parsed = Number(timestamp);
	return Number.isFinite(parsed) ? parsed : null;
}

function segmentCount(total: number): string {
	return total === 1
		? getMessage('readerTaskSegmentsOne', '1')
		: getMessage('readerTaskSegments', String(total));
}

function segmentProgress(completed: number, total: number): string {
	const counts = [String(completed), String(total)];
	return total === 1
		? getMessage('readerTaskSegmentProgressOne', counts)
		: getMessage('readerTaskSegmentProgress', counts);
}

export function createTaskBar({ doc, segments, tools, onCancel, now = Date.now }: TaskBarOptions): TaskBar {
	const view = doc.defaultView ?? window;

	const rangeControl = doc.createElement('label');
	rangeControl.className = 'player-learning-range';
	const rangeLabel = doc.createElement('span');
	rangeLabel.textContent = getMessage('readerTaskRange');
	const rangeSelect = doc.createElement('select');
	const rangeOptions: Array<{ value: TranscriptTaskRange; label: string }> = [
		{ value: 'current', label: getMessage('readerTaskRangeCurrent') },
		{ value: 'next-five-minutes', label: getMessage('readerTaskRangeNextFiveMinutes') },
		{ value: 'all', label: getMessage('readerTaskRangeAll') }
	];
	rangeOptions.forEach(({ value, label }) => {
		const option = doc.createElement('option');
		option.value = value;
		option.textContent = label;
		rangeSelect.appendChild(option);
	});
	rangeSelect.value = 'all';
	rangeControl.append(rangeLabel, rangeSelect);

	const getTaskRange = (): TranscriptTaskRange => rangeSelect.value as TranscriptTaskRange;
	const getActiveSegmentIndex = () => {
		const activeIndex = segments.findIndex(segment => segment.classList.contains('is-active'));
		return activeIndex >= 0 ? activeIndex : 0;
	};
	const getTaskIndexes = (): number[] => {
		const range = getTaskRange();
		if (range === 'all') return segments.map((_, index) => index);
		const activeIndex = getActiveSegmentIndex();
		if (range === 'current') return [activeIndex];
		const startTime = getSegmentTimestamp(segments[activeIndex]);
		if (startTime == null) return [activeIndex];
		return segments
			.map((segment, index) => ({ index, timestamp: getSegmentTimestamp(segment) }))
			.filter(({ index, timestamp }) => index >= activeIndex && timestamp != null && timestamp <= startTime + 300)
			.map(({ index }) => index);
	};

	const bar = doc.createElement('div');
	bar.className = 'player-learning-task';
	bar.hidden = true;
	bar.setAttribute('aria-busy', 'false');
	const engine = doc.createElement('span');
	engine.className = 'player-learning-task-engine';
	const estimate = doc.createElement('span');
	estimate.className = 'player-learning-task-estimate';
	const elapsed = doc.createElement('span');
	elapsed.className = 'player-learning-task-elapsed';
	elapsed.setAttribute('aria-hidden', 'true');
	const progress = doc.createElement('progress');
	progress.className = 'player-learning-task-progress';
	progress.max = 1;
	progress.value = 0;
	const cancelButton = doc.createElement('button');
	cancelButton.type = 'button';
	cancelButton.className = 'player-learning-action player-learning-cancel';
	cancelButton.textContent = getMessage('cancel');
	cancelButton.hidden = true;
	cancelButton.addEventListener('click', event => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		onCancel();
	});
	const status = doc.createElement('span');
	status.className = 'player-learning-progress';
	status.setAttribute('role', 'status');
	status.setAttribute('aria-live', 'polite');
	status.hidden = true;
	bar.append(engine, estimate, elapsed, progress, cancelButton, status);

	let executionInfo: TranscriptExecutionInfo | undefined;
	let hasProgress = false;
	let elapsedTimer: number | undefined;
	const stopTimer = () => {
		if (elapsedTimer !== undefined) view.clearInterval(elapsedTimer);
		elapsedTimer = undefined;
	};
	const runParts = [estimate, elapsed, progress];
	const setStatus = (message: string) => {
		status.textContent = message;
		status.hidden = false;
	};
	const clearStatus = () => {
		status.textContent = '';
		status.hidden = true;
	};

	return {
		rangeControl,
		element: bar,
		getTaskRange,
		setTaskRange(range) {
			rangeSelect.value = range;
		},
		getTaskIndexes,
		get executionInfo() {
			return executionInfo;
		},
		async loadExecutionInfo(task, taskTexts) {
			if (!tools.getExecutionInfo) return;
			let info: TranscriptExecutionInfo;
			try {
				info = await tools.getExecutionInfo(task);
			} catch {
				// Execution errors are reported by the requested task itself.
				return;
			}
			executionInfo = info;
			engine.textContent = info.label;
			// Progress that already arrived says more than the count.
			if (!hasProgress) estimate.textContent = segmentCount(taskTexts.length);
		},
		useProfile(option) {
			executionInfo = executionInfo
				? { ...executionInfo, profileId: option.id, kind: option.kind, label: option.label }
				: undefined;
		},
		begin(startedAt) {
			bar.hidden = false;
			bar.setAttribute('aria-busy', 'true');
			runParts.forEach(part => { part.hidden = false; });
			hasProgress = false;
			estimate.textContent = '';
			progress.removeAttribute('aria-label');
			progress.max = 1;
			progress.value = 0;
			const updateElapsed = () => {
				elapsed.textContent = getMessage('readerTaskElapsed', String(Math.max(0, Math.floor((now() - startedAt) / 1000))));
			};
			updateElapsed();
			stopTimer();
			elapsedTimer = view.setInterval(updateElapsed, 1000);
			cancelButton.hidden = false;
			clearStatus();
		},
		setProgress(completed, total, phase, retry) {
			hasProgress = true;
			progress.max = Math.max(1, total);
			progress.value = Math.min(completed, progress.max);
			estimate.textContent = getMessage('readerTaskEstimate', [phase, segmentProgress(completed, total)]);
			progress.setAttribute('aria-label', estimate.textContent);
			// A group backing off after a rate limit shows the wait; the next progress clears it.
			if (retry) setStatus(getMessage('readerTranscriptRetrying', String(Math.max(1, Math.ceil(retry.delayMs / 1000)))));
			else clearStatus();
		},
		finish(endStatus) {
			stopTimer();
			bar.setAttribute('aria-busy', 'false');
			cancelButton.hidden = true;
			if (endStatus === 'cancelled') {
				// Only the engine and the status stay: nothing on the bar suggests the run goes on.
				runParts.forEach(part => { part.hidden = true; });
				setStatus(getMessage('readerAiCancelled'));
				return;
			}
			// The result (or the error card) speaks for a finished run.
			clearStatus();
			bar.hidden = true;
		},
		setStatus,
		clearStatus,
		setCancelVisible(visible) {
			cancelButton.hidden = !visible;
		},
		dispose: stopTimer
	};
}
