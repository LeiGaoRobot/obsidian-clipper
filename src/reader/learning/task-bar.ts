import { getMessage } from '../../utils/i18n';
import type { AiActionStatus } from '../../ai/ui/action';
import type { TranscriptJobTask } from '../../ai/job-identity';
import type {
	TranscriptExecutionInfo,
	TranscriptLanguageLearning,
	TranscriptProfileOption,
	TranscriptTaskRange
} from './types';

// The transcript task controls: the AI range select and the task bar (engine, estimate, elapsed
// time, progress, Cancel, status line). The bar is a view of the transcript action's state; it
// starts no model work. The estimate and engine stay empty until `getExecutionInfo` answers.

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
	/** Asks `getExecutionInfo` for `task` and shows its engine and batch estimate for `taskTexts`. */
	loadExecutionInfo(task: TranscriptJobTask, taskTexts: string[]): Promise<void>;
	/** Records the profile Switch and retry routed the task to; the retry refreshes the budget. */
	useProfile(option: TranscriptProfileOption): void;
	/** A transcript run started: busy, elapsed timer, empty progress, Cancel shown. */
	begin(startedAt: number): void;
	setProgress(value: number, max: number, label: string, retry?: { delayMs: number }): void;
	/** A transcript run ended: the timer stops, and a cancelled run says so. */
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
	let elapsedTimer: number | undefined;
	const stopTimer = () => {
		if (elapsedTimer !== undefined) view.clearInterval(elapsedTimer);
		elapsedTimer = undefined;
	};
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
			const sourceChars = taskTexts.reduce((total, text) => total + text.length, 0);
			const batches = Math.max(1, Math.ceil(sourceChars / Math.max(1, info.promptCharLimit)));
			estimate.textContent = getMessage('readerTaskEstimate', [String(taskTexts.length), String(batches)]);
		},
		useProfile(option) {
			executionInfo = executionInfo
				? { ...executionInfo, profileId: option.id, kind: option.kind, label: option.label }
				: undefined;
		},
		begin(startedAt) {
			bar.hidden = false;
			bar.setAttribute('aria-busy', 'true');
			estimate.textContent = '';
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
		setProgress(value, max, label, retry) {
			progress.max = Math.max(1, max);
			progress.value = value;
			// A group backing off after a rate limit shows the wait; the next progress replaces it.
			setStatus(retry
				? getMessage('readerTranscriptRetrying', String(Math.max(1, Math.ceil(retry.delayMs / 1000))))
				: label);
		},
		finish(endStatus) {
			stopTimer();
			bar.setAttribute('aria-busy', 'false');
			cancelButton.hidden = true;
			if (endStatus === 'cancelled') setStatus(getMessage('readerAiCancelled'));
			else clearStatus();
		},
		setStatus,
		clearStatus,
		setCancelVisible(visible) {
			cancelButton.hidden = !visible;
		},
		dispose: stopTimer
	};
}
