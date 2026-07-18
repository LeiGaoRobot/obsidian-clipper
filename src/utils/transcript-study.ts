import { getMessage } from './i18n';

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5] as const;
const LOOP_THRESHOLD_SECONDS = 0.08;

export interface TranscriptStudyPlayer {
	seekTo: (seconds: number) => void;
	play: () => void;
	pause: () => void;
	setPlaybackRate: (rate: number) => void;
	getCurrentTime: () => number;
}

interface TranscriptStudyOptions {
	doc: Document;
	controls: HTMLElement;
	segmentTimes: number[];
	getSegmentEnd: (index: number) => number;
	getActiveIndex: () => number;
	player: TranscriptStudyPlayer;
}

export interface TranscriptStudyController {
	onTimeUpdate: (currentTime: number, activeIndex: number) => void;
	toggleRepeat: () => void;
	toggleAutoPause: () => void;
	setPointA: () => void;
	setPointB: () => void;
	clearRange: () => void;
	cleanup: () => void;
}

function formatTime(seconds: number): string {
	const rounded = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(rounded / 60);
	return `${minutes}:${String(rounded % 60).padStart(2, '0')}`;
}

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function wireTranscriptStudy({
	doc,
	controls,
	segmentTimes,
	getSegmentEnd,
	getActiveIndex,
	player
}: TranscriptStudyOptions): TranscriptStudyController {
	const events = new AbortController();
	let repeatIndex: number | null = null;
	let autoPause = false;
	let pausedIndex: number | null = null;
	let pointA: number | null = null;
	let pointB: number | null = null;
	let playbackRateIndex = PLAYBACK_RATES.indexOf(1);
	let lastObservedTime: number | null = null;
	let lastObservedIndex = -1;

	const details = doc.createElement('details');
	details.className = 'player-study';
	const summary = doc.createElement('summary');
	summary.textContent = getMessage('readerStudyMode');
	summary.setAttribute('aria-label', getMessage('readerStudyModeDescription'));
	const panel = doc.createElement('div');
	panel.className = 'player-study-panel';

	const repeatButton = doc.createElement('button');
	repeatButton.type = 'button';
	repeatButton.className = 'player-study-action player-study-repeat';
	repeatButton.textContent = getMessage('readerRepeatSentence');
	repeatButton.setAttribute('aria-pressed', 'false');

	const autoPauseButton = doc.createElement('button');
	autoPauseButton.type = 'button';
	autoPauseButton.className = 'player-study-action player-study-auto-pause';
	autoPauseButton.textContent = getMessage('readerAutoPause');
	autoPauseButton.setAttribute('aria-pressed', 'false');

	const range = doc.createElement('div');
	range.className = 'player-study-range';
	const rangeStatus = doc.createElement('span');
	rangeStatus.className = 'player-study-range-status';
	const pointAButton = doc.createElement('button');
	pointAButton.type = 'button';
	pointAButton.className = 'player-study-action player-study-point-a';
	pointAButton.textContent = getMessage('readerSetPointA');
	const pointBButton = doc.createElement('button');
	pointBButton.type = 'button';
	pointBButton.className = 'player-study-action player-study-point-b';
	pointBButton.textContent = getMessage('readerSetPointB');
	const clearRangeButton = doc.createElement('button');
	clearRangeButton.type = 'button';
	clearRangeButton.className = 'player-study-action player-study-clear-range';
	clearRangeButton.textContent = getMessage('readerClearLoop');

	const speedLabel = doc.createElement('label');
	speedLabel.className = 'player-study-speed';
	const speedText = doc.createElement('span');
	speedText.textContent = getMessage('readerPlaybackSpeed');
	const speedSelect = doc.createElement('select');
	for (const rate of PLAYBACK_RATES) {
		const option = doc.createElement('option');
		option.value = String(rate);
		option.textContent = `${rate}×`;
		speedSelect.appendChild(option);
	}
	speedSelect.value = '1';
	speedLabel.append(speedText, speedSelect);

	const shortcuts = doc.createElement('small');
	shortcuts.className = 'player-study-shortcuts';
	shortcuts.textContent = getMessage('readerStudyShortcuts');
	range.append(pointAButton, pointBButton, clearRangeButton, rangeStatus);
	panel.append(repeatButton, autoPauseButton, range, speedLabel, shortcuts);
	details.append(summary, panel);
	controls.appendChild(details);

	const updateRangeStatus = () => {
		if (pointA === null && pointB === null) {
			rangeStatus.textContent = getMessage('readerLoopNotSet');
			return;
		}
		const start = pointA === null ? '—' : formatTime(pointA);
		const end = pointB === null ? '—' : formatTime(pointB);
		rangeStatus.textContent = `${start}–${end}`;
	};

	const updateRepeatButton = () => {
		const enabled = repeatIndex !== null;
		repeatButton.setAttribute('aria-pressed', String(enabled));
		repeatButton.classList.toggle('is-enabled', enabled);
	};

	const updateAutoPauseButton = () => {
		autoPauseButton.setAttribute('aria-pressed', String(autoPause));
		autoPauseButton.classList.toggle('is-enabled', autoPause);
	};

	const toggleRepeat = () => {
		const activeIndex = getActiveIndex();
		if (activeIndex < 0 || activeIndex >= segmentTimes.length) return;
		repeatIndex = repeatIndex === activeIndex ? null : activeIndex;
		if (repeatIndex !== null) {
			pointA = null;
			pointB = null;
			updateRangeStatus();
		}
		updateRepeatButton();
	};

	const toggleAutoPause = () => {
		autoPause = !autoPause;
		pausedIndex = null;
		updateAutoPauseButton();
	};

	const setPointA = () => {
		pointA = Math.max(0, player.getCurrentTime());
		if (pointB !== null && pointB <= pointA) pointB = null;
		repeatIndex = null;
		updateRepeatButton();
		updateRangeStatus();
	};

	const setPointB = () => {
		const currentTime = Math.max(0, player.getCurrentTime());
		if (pointA === null || currentTime <= pointA) {
			pointA = currentTime;
			pointB = null;
		} else {
			pointB = currentTime;
		}
		repeatIndex = null;
		updateRepeatButton();
		updateRangeStatus();
	};

	const clearRange = () => {
		pointA = null;
		pointB = null;
		updateRangeStatus();
	};

	const setPlaybackRate = (rateIndex: number) => {
		playbackRateIndex = Math.max(0, Math.min(PLAYBACK_RATES.length - 1, rateIndex));
		const rate = PLAYBACK_RATES[playbackRateIndex];
		speedSelect.value = String(rate);
		player.setPlaybackRate(rate);
	};

	const onTimeUpdate = (currentTime: number, activeIndex: number) => {
		const rememberPosition = (time: number, index: number) => {
			lastObservedTime = time;
			lastObservedIndex = index;
		};
		if (pointA !== null && pointB !== null && currentTime >= pointB - LOOP_THRESHOLD_SECONDS) {
			player.seekTo(pointA);
			player.play();
			rememberPosition(pointA, activeIndex);
			return;
		}
		if (repeatIndex !== null) {
			const end = getSegmentEnd(repeatIndex);
			const crossedEnd = lastObservedTime !== null
				&& lastObservedTime < end
				&& currentTime >= end;
			const nearEnd = activeIndex === repeatIndex
				&& currentTime >= end - LOOP_THRESHOLD_SECONDS;
			if (crossedEnd || nearEnd) {
				player.seekTo(segmentTimes[repeatIndex]);
				player.play();
				rememberPosition(segmentTimes[repeatIndex], repeatIndex);
				return;
			}
			rememberPosition(currentTime, activeIndex);
			return;
		}
		if (!autoPause || activeIndex < 0) {
			rememberPosition(currentTime, activeIndex);
			return;
		}
		let boundaryIndex = activeIndex;
		if (lastObservedIndex >= 0 && lastObservedIndex !== activeIndex && lastObservedTime !== null) {
			const previousEnd = getSegmentEnd(lastObservedIndex);
			if (lastObservedTime < previousEnd && currentTime >= previousEnd) {
				boundaryIndex = lastObservedIndex;
			}
		}
		const end = getSegmentEnd(boundaryIndex);
		if (currentTime < end - 0.25 && pausedIndex === activeIndex) pausedIndex = null;
		const crossedEnd = lastObservedTime !== null
			&& lastObservedTime < end
			&& currentTime >= end;
		const nearEnd = boundaryIndex === activeIndex
			&& currentTime >= end - LOOP_THRESHOLD_SECONDS;
		if ((crossedEnd || nearEnd) && pausedIndex !== boundaryIndex) {
			pausedIndex = boundaryIndex;
			if (currentTime > end) player.seekTo(end);
			player.pause();
		}
		rememberPosition(currentTime, activeIndex);
	};

	repeatButton.addEventListener('click', toggleRepeat, { signal: events.signal });
	autoPauseButton.addEventListener('click', toggleAutoPause, { signal: events.signal });
	pointAButton.addEventListener('click', setPointA, { signal: events.signal });
	pointBButton.addEventListener('click', setPointB, { signal: events.signal });
	clearRangeButton.addEventListener('click', clearRange, { signal: events.signal });
	speedSelect.addEventListener('change', () => {
		const index = PLAYBACK_RATES.indexOf(Number(speedSelect.value) as typeof PLAYBACK_RATES[number]);
		if (index >= 0) setPlaybackRate(index);
	}, { signal: events.signal });
	doc.addEventListener('keydown', event => {
		if (isEditableTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
		let handled = true;
		switch (event.code) {
			case 'KeyR': toggleRepeat(); break;
			case 'KeyP': toggleAutoPause(); break;
			case 'BracketLeft': setPlaybackRate(playbackRateIndex - 1); break;
			case 'BracketRight': setPlaybackRate(playbackRateIndex + 1); break;
			case 'KeyA':
				if (event.shiftKey) setPointA(); else handled = false;
				break;
			case 'KeyB':
				if (event.shiftKey) setPointB(); else handled = false;
				break;
			default: handled = false;
		}
		if (handled) event.preventDefault();
	}, { capture: true, signal: events.signal });

	updateRangeStatus();
	return {
		onTimeUpdate,
		toggleRepeat,
		toggleAutoPause,
		setPointA,
		setPointB,
		clearRange,
		cleanup: () => {
			events.abort();
			details.remove();
		}
	};
}
