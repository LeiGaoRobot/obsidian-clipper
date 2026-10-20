import { getMessage } from '../../utils/i18n';
import type { AiActionStatus } from '../../ai/ui/action';
import type { TranscriptJobTask } from '../../ai/job-identity';
import type {
	TranscriptExecutionInfo,
	TranscriptLanguageLearning,
	TranscriptProfileOption,
	TranscriptTaskRange
} from './types';

// The transcript task controls: the AI range select and the progress pill that sits in the transcript
// toolbar (spinner, phase and segment progress, progress bar, engine, Cancel, status line). The pill
// is a view of the transcript action's state; it starts no model work. The engine and segment count
// stay empty until `getExecutionInfo` answers. The pill shows only while a run (or an explanation)
// is running, or says that it was cancelled: a finished run hides it, so a pill on screen with no
// Cancel never looks like a run.

export interface TaskBar {
	/** The AI range control, appended before the bilingual button. */
	rangeControl: HTMLElement;
	/** The progress pill. */
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
	/** A transcript run started: busy, empty progress, Cancel shown. */
	begin(): void;
	/** `completed` of `total` segments are done in `phase` (e.g. Translating subtitles). */
	setProgress(completed: number, total: number, phase: string, retry?: { delayMs: number }): void;
	/** A transcript run ended: Cancel hides; a cancelled run says so, any other run hides the pill. */
	finish(status: AiActionStatus): void;
	/**
	 * Shows a status (a retry wait, Thinking…, cancelled) in place of the progress text. A `quiet`
	 * status is not announced, for one that another live region (the explanation card) speaks.
	 */
	setStatus(message: string, options?: { quiet?: boolean }): void;
	clearStatus(): void;
	/** Something is running (a transcript run or an explanation): spinner and Cancel show. */
	setCancelVisible(visible: boolean): void;
	dispose(): void;
}

export interface TaskBarOptions {
	doc: Document;
	segments: HTMLElement[];
	tools: Pick<TranscriptLanguageLearning, 'getExecutionInfo'>;
	/** A trusted click on Cancel. */
	onCancel: () => void;
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

function segmentFraction(completed: number, total: number): string {
	return getMessage('readerTaskSegmentFraction', [String(completed), String(total)]);
}

export function createTaskBar({ doc, segments, tools, onCancel }: TaskBarOptions): TaskBar {
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
	const spinner = doc.createElement('span');
	spinner.className = 'player-learning-task-spinner';
	spinner.setAttribute('aria-hidden', 'true');
	// The phase and the segment progress (or, before progress, the segment count).
	const estimate = doc.createElement('span');
	estimate.className = 'player-learning-task-estimate';
	const phaseText = doc.createElement('span');
	phaseText.className = 'player-learning-task-phase';
	const countText = doc.createElement('strong');
	countText.className = 'player-learning-task-count';
	estimate.append(phaseText, countText);
	const status = doc.createElement('span');
	status.className = 'player-learning-progress';
	status.setAttribute('role', 'status');
	status.setAttribute('aria-live', 'polite');
	status.hidden = true;
	const progress = doc.createElement('progress');
	progress.className = 'player-learning-task-progress';
	progress.max = 1;
	progress.value = 0;
	// Truncates first when the toolbar is short of space; the tooltip keeps the full name.
	const engine = doc.createElement('span');
	engine.className = 'player-learning-task-engine';
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
	bar.append(spinner, estimate, status, progress, engine, cancelButton);

	let executionInfo: TranscriptExecutionInfo | undefined;
	// Only the latest `loadExecutionInfo` call may land: an older answer would name the wrong
	// engine and profile.
	let executionInfoRequest = 0;
	let hasProgress = false;
	// A transcript run is running; `statusMessage` is a retry wait, an explanation's Thinking… or a
	// cancelled run; `active` means something can be cancelled.
	let running = false;
	let statusMessage = '';
	let active = false;
	const render = () => {
		bar.hidden = !running && !statusMessage && !active;
		bar.setAttribute('aria-busy', String(running || active));
		spinner.hidden = !running && !active;
		estimate.hidden = !running || Boolean(statusMessage);
		progress.hidden = !running;
		engine.hidden = !running || !engine.textContent;
		status.textContent = statusMessage;
		status.hidden = !statusMessage;
		cancelButton.hidden = !active;
	};
	const updateTooltip = () => {
		const parts = [progress.getAttribute('aria-label') || '', engine.textContent || ''].filter(Boolean);
		bar.title = parts.length === 2 ? getMessage('readerTaskEstimate', parts) : parts[0] || '';
		engine.title = engine.textContent || '';
	};
	const setStatus = (message: string, options?: { quiet?: boolean }) => {
		statusMessage = message;
		status.setAttribute('aria-live', options?.quiet ? 'off' : 'polite');
		render();
	};
	const clearStatus = () => setStatus('');

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
			const request = ++executionInfoRequest;
			let info: TranscriptExecutionInfo;
			try {
				info = await tools.getExecutionInfo(task);
			} catch {
				// Execution errors are reported by the requested task itself.
				return;
			}
			if (request !== executionInfoRequest) return;
			executionInfo = info;
			engine.textContent = info.label;
			// Progress that already arrived says more than the count.
			if (!hasProgress) countText.textContent = segmentCount(taskTexts.length);
			updateTooltip();
			render();
		},
		useProfile(option) {
			executionInfo = executionInfo
				? { ...executionInfo, profileId: option.id, kind: option.kind, label: option.label }
				: undefined;
		},
		begin() {
			running = true;
			active = true;
			statusMessage = '';
			hasProgress = false;
			phaseText.textContent = '';
			countText.textContent = '';
			// The new run's engine (and profile) shows once its getExecutionInfo answers.
			executionInfo = undefined;
			engine.textContent = '';
			progress.removeAttribute('aria-label');
			progress.max = 1;
			progress.value = 0;
			updateTooltip();
			render();
		},
		setProgress(completed, total, phase, retry) {
			// A report that arrives after the run ended changes nothing.
			if (!running) return;
			hasProgress = true;
			progress.max = Math.max(1, total);
			progress.value = Math.min(completed, progress.max);
			phaseText.textContent = phase;
			countText.textContent = segmentFraction(completed, total);
			progress.setAttribute('aria-label', getMessage('readerTaskEstimate', [phase, segmentProgress(completed, total)]));
			updateTooltip();
			// A group backing off after a rate limit shows the wait; the next progress clears it.
			setStatus(retry
				? getMessage('readerTranscriptRetrying', String(Math.max(1, Math.ceil(retry.delayMs / 1000))))
				: '');
		},
		finish(endStatus) {
			running = false;
			active = false;
			// A cancelled pill must not keep the running run's tooltip.
			bar.title = '';
			engine.title = '';
			// The result (or the error card) speaks for a finished run; a cancelled one says so until
			// the next task starts.
			setStatus(endStatus === 'cancelled' ? getMessage('readerAiCancelled') : '');
		},
		setStatus,
		clearStatus,
		setCancelVisible(visible) {
			active = visible;
			render();
		},
		dispose() {
			running = false;
			active = false;
			statusMessage = '';
		}
	};
}
