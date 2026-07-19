import { getMessage } from './i18n';
import {
	TranscriptLanguageLearning,
	cleanupTranscriptLanguageLearning,
	wireTranscriptLanguageLearning
} from './transcript-language-learning';
import type { TranscriptLayoutMode } from '../types/types';
import {
	clearTranscriptLayoutMode,
	createTranscriptLayoutSwitcher,
	normalizeTranscriptLayoutMode,
	syncTranscriptControlsPanel,
	updateTranscriptPlayerHeight
} from './transcript-layout';
import { TranscriptStudyController, wireTranscriptStudy } from './transcript-study';

// CJK-aware text boundary helpers
const SENT_END = /[.!?。！？]/;
const SOFT_STOP = /[,、，]/;
const CJK_SENT_END = /[。！？]/;
const CJK_PUNCT = /[。！？、，]/;
const CJK_CHAR = /[\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
const transcriptLayoutResizeObservers = new WeakMap<Document, ResizeObserver>();
const transcriptStudyControllers = new WeakMap<Document, TranscriptStudyController>();
const transcriptEventControllers = new WeakMap<Document, AbortController>();

function removePreviousTranscriptLayout(article: HTMLElement): void {
	const root = article.querySelector<HTMLElement>('.transcript-study-layout');
	if (!root || !root.parentNode) return;
	const parent = root.parentNode;
	const player = Array.from(root.children)
		.find(child => child.classList.contains('player-container')) as HTMLElement | undefined;
	const playerElement = player && Array.from(player.children).find(child => child.matches(
		'.reader-video-wrapper, iframe[src*="youtube.com/embed/"], a[href*="youtube.com/watch"]'
	));
	const transcript = Array.from(root.children)
		.find(child => child.matches('.youtube.transcript')) as HTMLElement | undefined;
	if (playerElement) parent.insertBefore(playerElement, root);
	if (transcript) {
		transcript.querySelectorAll('.player-current-pos, .transcript-scrub-track')
			.forEach(element => element.remove());
		parent.insertBefore(transcript, root);
	}
	root.remove();
}

export interface TranscriptClickGuard {
	schedule: (action: () => boolean | void, rollback?: () => void) => void;
	cancel: () => void;
}

export function createTranscriptClickGuard(
	delay = 350,
	rollbackWindow = 1500
): TranscriptClickGuard {
	let timer: number | undefined;
	let rollback: (() => void) | undefined;
	let executedAt = 0;

	return {
		schedule(action, rollbackAction) {
			if (timer !== undefined) window.clearTimeout(timer);
			timer = undefined;
			rollback = rollbackAction;
			executedAt = 0;
			timer = window.setTimeout(() => {
				timer = undefined;
				if (action() !== false) executedAt = Date.now();
			}, delay);
		},
		cancel() {
			if (timer !== undefined) {
				window.clearTimeout(timer);
				timer = undefined;
			} else if (rollback && executedAt > 0 && Date.now() - executedAt <= rollbackWindow) {
				rollback();
			}
			rollback = undefined;
			executedAt = 0;
		}
	};
}

// CJK punctuation doesn't require trailing whitespace
function isSentBoundary(text: string, punctPos: number, nextPos: number): boolean {
	const ch = text[punctPos];
	if (CJK_SENT_END.test(ch)) return true;
	if (/[.!?]/.test(ch)) return nextPos >= text.length || /\s/.test(text[nextPos]);
	return false;
}

function isSentOrSoftBoundary(text: string, punctPos: number, nextPos: number): boolean {
	const ch = text[punctPos];
	if (CJK_PUNCT.test(ch)) return true;
	if (/[.!?,]/.test(ch)) return nextPos >= text.length || /\s/.test(text[nextPos]);
	return false;
}

// In CJK text each character acts as its own word
function isWordStep(text: string, pos: number): boolean {
	if (CJK_CHAR.test(text[pos])) return true;
	if (pos > 0 && CJK_CHAR.test(text[pos - 1]) && !CJK_CHAR.test(text[pos]) && /\S/.test(text[pos])) return true;
	return false;
}

interface TranscriptSettings {
	pinPlayer: boolean;
	autoScroll: boolean;
	highlightActiveLine: boolean;
	transcriptLayout: TranscriptLayoutMode;
	learningResponseLanguage?: string;
}

type TranscriptSettingChange = <K extends keyof TranscriptSettings>(
	key: K,
	value: TranscriptSettings[K]
) => void;

interface ScrollHelper {
	getStickyOffset: () => number;
	scrollTo: (targetY: number) => void;
	programmaticScroll: () => boolean;
}

export function wireTranscript(
	doc: Document,
	article: HTMLElement,
	settings: TranscriptSettings,
	scroll: ScrollHelper,
	onSettingChange?: TranscriptSettingChange,
	languageLearning?: TranscriptLanguageLearning
): void {
	transcriptEventControllers.get(doc)?.abort();
	transcriptEventControllers.delete(doc);
	cleanupTranscriptLanguageLearning(doc);
	transcriptStudyControllers.get(doc)?.cleanup();
	transcriptStudyControllers.delete(doc);
	clearTranscriptLayoutMode(doc);
	transcriptLayoutResizeObservers.get(doc)?.disconnect();
	transcriptLayoutResizeObservers.delete(doc);
	removePreviousTranscriptLayout(article);
	const transcript = article.querySelector('.youtube.transcript') as HTMLElement | null;
	if (!transcript) return;

	const iframe = article.querySelector('iframe[src*="youtube.com/embed/"]') as HTMLIFrameElement | null;
	const videoWrapper = article.querySelector('.reader-video-wrapper') as HTMLElement | null;
	const videoEl = videoWrapper?.querySelector('video.reader-video-player') as HTMLVideoElement | null;
	const thumbnailLink = article.querySelector('a[href*="youtube.com/watch"]') as HTMLAnchorElement | null;
	const playerEl = (videoWrapper || iframe || thumbnailLink) as HTMLElement | null;
	if (!playerEl) return;

	const playerParent = playerEl.parentNode;
	if (!playerParent) return;
	const EventAbortController = doc.defaultView?.AbortController || AbortController;
	const eventController = new EventAbortController();
	const listenerOptions = { signal: eventController.signal };
	transcriptEventControllers.set(doc, eventController);

	// Keep the player, controls, and transcript in one layout surface so the
	// same live transcript can move between reading, notebook, and split views.
	const layoutRoot = doc.createElement('section');
	layoutRoot.className = 'transcript-study-layout';
	layoutRoot.setAttribute('aria-label', getMessage('readerTranscripts'));
	playerParent.insertBefore(layoutRoot, playerEl);

	const playerContainer = doc.createElement('div');
	const pinDefault = settings.pinPlayer;
	const autoScrollDefault = settings.autoScroll;
	const highlightDefault = settings.highlightActiveLine;
	const initialLayout = normalizeTranscriptLayoutMode(settings.transcriptLayout);
	playerContainer.className = 'player-container' + (pinDefault ? ' pin-player' : '');
	layoutRoot.classList.toggle('is-player-pinned', pinDefault);
	layoutRoot.appendChild(playerContainer);
	playerContainer.appendChild(playerEl);
	layoutRoot.appendChild(transcript);

	let autoScrollEnabled = autoScrollDefault;
	let highlightEnabled = highlightDefault;
	const transcriptClickGuard = createTranscriptClickGuard();
	eventController.signal.addEventListener('abort', transcriptClickGuard.cancel, { once: true });

	const toggleBar = doc.createElement('div');
	toggleBar.className = 'player-toggles';

	const createToggle = (label: string, defaultOn: boolean, onChange: (on: boolean) => void) => {
		const wrapper = doc.createElement('label');
		wrapper.className = 'player-toggle' + (defaultOn ? ' is-enabled' : '');
		wrapper.setAttribute('role', 'switch');
		wrapper.setAttribute('aria-checked', String(defaultOn));
		wrapper.setAttribute('tabindex', '0');

		const toggle = doc.createElement('div');
		toggle.className = 'player-toggle-switch';
		const input = doc.createElement('input');
		input.type = 'checkbox';
		input.checked = defaultOn;
		toggle.appendChild(input);

		const text = doc.createElement('span');
		text.textContent = label;

		wrapper.appendChild(text);
		wrapper.appendChild(toggle);

		const toggleValue = () => {
			input.checked = !input.checked;
			wrapper.classList.toggle('is-enabled', input.checked);
			wrapper.setAttribute('aria-checked', String(input.checked));
			onChange(input.checked);
		};
		wrapper.addEventListener('click', (e) => {
			e.preventDefault();
			toggleValue();
		}, listenerOptions);
		wrapper.addEventListener('keydown', event => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			toggleValue();
		}, listenerOptions);

		return wrapper;
	};

	const pinToggle = createToggle(getMessage('readerPinPlayer'), pinDefault, (on) => {
		playerContainer.classList.toggle('pin-player', on);
		layoutRoot.classList.toggle('is-player-pinned', on);
		// Reset nav scroll tracking so hide-on-scroll-down works immediately
		window.dispatchEvent(new CustomEvent('reader-show-nav'));
		onSettingChange?.('pinPlayer', on);
	});

	const autoScrollToggle = createToggle(getMessage('readerAutoScroll'), autoScrollDefault, (on) => {
		autoScrollEnabled = on;
		onSettingChange?.('autoScroll', on);
	});

	const highlightToggle = createToggle(getMessage('readerHighlightActiveLine'), highlightDefault, (on) => {
		highlightEnabled = on;
		if (!on) {
			const ph = (CSS as any).highlights?.get('transcript-playback');
			if (ph) ph.clear();
		}
		onSettingChange?.('highlightActiveLine', on);
	});

	// Floating "current position" button — appended to body,
	// shown only when the active segment is scrolled out of view
	const currentPosButton = doc.createElement('button');
	currentPosButton.className = 'player-current-pos';
	currentPosButton.textContent = getMessage('readerCurrentPosition');
	transcript.style.position = 'relative';
	transcript.appendChild(currentPosButton);

	const toggleGroup = doc.createElement('div');
	toggleGroup.className = 'player-toggle-group is-open';
	toggleGroup.appendChild(pinToggle);
	toggleGroup.appendChild(autoScrollToggle);
	toggleGroup.appendChild(highlightToggle);

	const primaryActions = doc.createElement('div');
	primaryActions.className = 'player-primary-actions';
	const compactPlayerButton = doc.createElement('button');
	compactPlayerButton.type = 'button';
	compactPlayerButton.className = 'player-learning-action player-compact-toggle';
	compactPlayerButton.setAttribute('aria-pressed', 'false');
	const updateCompactPlayer = () => {
		const compact = playerContainer.classList.contains('is-compact');
		compactPlayerButton.setAttribute('aria-pressed', String(compact));
		compactPlayerButton.classList.toggle('is-enabled', compact);
		compactPlayerButton.textContent = getMessage(compact ? 'readerShowPlayer' : 'readerCompactPlayer');
	};
	compactPlayerButton.addEventListener('click', () => {
		playerContainer.classList.toggle('is-compact');
		updateCompactPlayer();
		updatePlayerHeight();
	}, listenerOptions);
	primaryActions.appendChild(compactPlayerButton);
	updateCompactPlayer();

	const moreControls = doc.createElement('details');
	moreControls.className = 'player-controls-more';
	const moreSummary = doc.createElement('summary');
	moreSummary.textContent = getMessage('readerMoreControls');
	moreSummary.setAttribute('aria-label', getMessage('readerMoreControlsDescription'));
	moreSummary.setAttribute('aria-expanded', 'false');
	const morePanel = doc.createElement('div');
	morePanel.className = 'player-controls-panel';
	const morePanelHeader = doc.createElement('div');
	morePanelHeader.className = 'player-controls-panel-header';
	const morePanelTitle = doc.createElement('strong');
	morePanelTitle.textContent = getMessage('readerMoreControls');
	const closeMoreButton = doc.createElement('button');
	closeMoreButton.type = 'button';
	closeMoreButton.className = 'player-controls-close';
	closeMoreButton.textContent = getMessage('done');
	morePanelHeader.append(morePanelTitle, closeMoreButton);
	morePanel.append(morePanelHeader, toggleGroup);
	moreControls.append(moreSummary, morePanel);
	const controlsViewport = doc.defaultView?.matchMedia?.('(max-width: 768px)');
	const syncMoreControls = () => {
		syncTranscriptControlsPanel({
			doc,
			root: layoutRoot,
			details: moreControls,
			panel: morePanel,
			controls: toggleBar,
			isMobile: controlsViewport?.matches === true
		});
	};
	const closeMoreControls = () => {
		moreControls.open = false;
		syncMoreControls();
	};
	closeMoreButton.addEventListener('click', closeMoreControls, listenerOptions);
	moreControls.addEventListener('toggle', syncMoreControls, listenerOptions);
	controlsViewport?.addEventListener?.('change', syncMoreControls, listenerOptions);

	const placeToggleBar = (mode: TranscriptLayoutMode) => {
		if (mode === 'reading') {
			playerContainer.appendChild(toggleBar);
		} else {
			layoutRoot.insertBefore(toggleBar, transcript);
		}
	};
	const layoutSwitcher = createTranscriptLayoutSwitcher({
		doc,
		root: layoutRoot,
		initialMode: initialLayout,
		groupLabel: getMessage('readerTranscriptLayout'),
		labels: {
			reading: getMessage('readerTranscriptLayoutReading'),
			notebook: getMessage('readerTranscriptLayoutNotebook'),
			focus: getMessage('readerTranscriptLayoutFocus')
		},
		onChange: mode => {
			closeMoreControls();
			placeToggleBar(mode);
			onSettingChange?.('transcriptLayout', mode);
			window.dispatchEvent(new CustomEvent('reader-show-nav'));
		}
	});
	toggleBar.appendChild(layoutSwitcher.element);
	toggleBar.appendChild(primaryActions);
	toggleBar.appendChild(moreControls);
	placeToggleBar(initialLayout);

	const updatePlayerHeight = () => updateTranscriptPlayerHeight(layoutRoot, playerContainer);
	updatePlayerHeight();
	if (typeof ResizeObserver !== 'undefined') {
		const resizeObserver = new ResizeObserver(updatePlayerHeight);
		resizeObserver.observe(playerContainer);
		transcriptLayoutResizeObservers.set(doc, resizeObserver);
	}

	if (iframe) {
		// Enable JS API on the embed
		const src = new URL(iframe.src);
		src.searchParams.set('enablejsapi', '1');
		src.searchParams.set('origin', window.location.origin);
		iframe.src = src.toString();

		// Initialize postMessage connection once iframe loads
		iframe.addEventListener('load', () => {
			if (iframe.contentWindow) {
				iframe.contentWindow.postMessage(JSON.stringify({
					event: 'listening'
				}), '*');
			}
		}, listenerOptions);
	}

	// Build a sorted list of segments with their start times
	const segments = Array.from(transcript.querySelectorAll('.transcript-segment')) as HTMLElement[];
	segments.forEach(seg => {
		// Pull the timestamp out into its own element
		// and wrap remaining text in a span
		const strong = seg.querySelector('strong');
		if (!strong) return;
		if (Array.from(seg.children).some(child => child.classList.contains('transcript-segment-text'))) return;

		if (strong.nextSibling?.nodeType === Node.TEXT_NODE) {
			strong.nextSibling.textContent = strong.nextSibling.textContent!.replace(/^\s*·\s*/, '');
		}

		// Move timestamp strong out, wrap the rest in a div
		const textWrapper = doc.createElement('div');
		textWrapper.className = 'transcript-segment-text';
		strong.remove();
		while (seg.firstChild) {
			textWrapper.appendChild(seg.firstChild);
		}
		seg.appendChild(strong);
		seg.appendChild(textWrapper);
	});
	if (languageLearning) {
		wireTranscriptLanguageLearning({
			doc,
			transcript,
				segments,
				controls: toggleGroup,
				tools: languageLearning,
				responseLanguage: settings.learningResponseLanguage,
			cancelPendingSeek: transcriptClickGuard.cancel
		});
		for (const selector of ['.player-learning-bilingual', '.player-learning-readings']) {
			const primaryAction = toggleGroup.querySelector(selector);
			if (primaryAction) primaryActions.appendChild(primaryAction);
		}
	}
	// Set timestamp column width to the widest timestamp
	let maxWidth = 0;
	segments.forEach(seg => {
		const strong = seg.querySelector('strong');
		if (strong) {
			maxWidth = Math.max(maxWidth, strong.getBoundingClientRect().width);
		}
	});
	transcript.style.setProperty('--timestamp-width', Math.ceil(maxWidth) + 'px');

	const segmentTimes = segments.map(seg => {
		const ts = seg.querySelector('.timestamp');
		return parseFloat(ts?.getAttribute('data-timestamp') || '0');
	});

	const FALLBACK_SEGMENT_DURATION = 30;
	const AUTO_SCROLL_COOLDOWN = 2000;
	const getSegmentEnd = (i: number) =>
		i < segmentTimes.length - 1 ? segmentTimes[i + 1] : segmentTimes[i] + FALLBACK_SEGMENT_DURATION;

	// Map each segment to its preceding chapter heading for outline tracking
	const segmentChapters: (Element | null)[] = [];
	const segmentIndexMap = new Map(segments.map((s, i) => [s, i]));
	let currentChapter: Element | null = null;
	const transcriptChildren = Array.from(transcript.children);
	for (const child of transcriptChildren) {
		if (/^H[2-6]$/.test(child.tagName)) {
			currentChapter = child;
		} else if (child.classList.contains('transcript-segment')) {
			const idx = segmentIndexMap.get(child as HTMLElement);
			if (idx !== undefined) segmentChapters[idx] = currentChapter;
		}
	}
	let activeChapter: Element | null = null;

	// Track active segment based on video current time
	let activeSegment: HTMLElement | null = null;

	currentPosButton.addEventListener('click', () => {
		if (activeSegment) {
			const rect = activeSegment.getBoundingClientRect();
			const stickyOffset = scroll.getStickyOffset();
			const targetY = (window.pageYOffset || doc.documentElement.scrollTop)
				+ rect.top - stickyOffset - 20;
			scroll.scrollTo(targetY);
		}
	}, listenerOptions);
	let activeIndex = -1;
	let studyController: TranscriptStudyController | undefined;
	let suppressScroll = false;
	let lastUserScroll = 0;
	let lastCurrentTime = -1;
	let scrubbing = false;
	let lastScrub = 0;

	window.addEventListener('scroll', () => {
		if (scroll.programmaticScroll() || scrubbing) return;
		lastUserScroll = Date.now();
	}, { passive: true, signal: eventController.signal });

	const updateActiveSegment = (currentTime: number) => {
		if (Math.abs(currentTime - lastCurrentTime) < 0.05) return;
		lastCurrentTime = currentTime;
		let newIndex = -1;
		for (let i = segmentTimes.length - 1; i >= 0; i--) {
			if (currentTime >= segmentTimes[i]) {
				newIndex = i;
				break;
			}
		}
		if (newIndex !== activeIndex) {
			// Resume auto-scroll once segment changes after scrub ends
			if (suppressScroll && !scrubbing) {
				suppressScroll = false;
			}
			activeSegment?.classList.remove('is-active');
			if (newIndex >= 0) {
				segments[newIndex].classList.add('is-active');
				// Auto-scroll to keep active segment visible
				if (autoScrollEnabled && !suppressScroll && Date.now() - lastUserScroll > AUTO_SCROLL_COOLDOWN) {
					const rect = segments[newIndex].getBoundingClientRect();
					const stickyOffset = scroll.getStickyOffset();
					const targetY = (window.pageYOffset || doc.documentElement.scrollTop)
						+ rect.top - stickyOffset - 20;
					scroll.scrollTo(targetY);
				}
			}
			activeSegment = newIndex >= 0 ? segments[newIndex] : null;
			activeIndex = newIndex;

			// Update in-progress chapter in outline
			const chapter = newIndex >= 0 ? segmentChapters[newIndex] : null;
			if (chapter !== activeChapter) {
				if (activeChapter?.id) {
					doc.querySelector(`.obsidian-reader-outline-item[data-heading-id="${activeChapter.id}"]`)
						?.classList.remove('in-progress');
				}
				if (chapter?.id) {
					doc.querySelector(`.obsidian-reader-outline-item[data-heading-id="${chapter.id}"]`)
						?.classList.add('in-progress');
				}
				activeChapter = chapter;
			}
		}
		studyController?.onTimeUpdate(currentTime, newIndex);
		// Show floating button when active segment is out of view
		if (activeSegment) {
			const rect = activeSegment.getBoundingClientRect();
			const stickyOffset = scroll.getStickyOffset();
			const isVisible = rect.bottom > stickyOffset && rect.top < window.innerHeight;
			currentPosButton.classList.toggle('is-visible', !isVisible);
		} else {
			currentPosButton.classList.remove('is-visible');
		}
		// Update progress line on the scrub track
		if (activeSegment && activeIndex >= 0) {
			const segRect = activeSegment.getBoundingClientRect();
			const trackRect = scrubTrack.getBoundingClientRect();
			const start = segmentTimes[activeIndex];
			const end = getSegmentEnd(activeIndex);
			const segProgress = Math.min(1, Math.max(0, (currentTime - start) / (end - start)));
			const yInTrack = (segRect.top - trackRect.top) + segProgress * segRect.height;
			const trackProgress = yInTrack / trackRect.height;
			scrubTrack.style.setProperty('--track-progress', (trackProgress * 100) + '%');

			// Update playback highlight — underline the current line
			if (playbackHighlight && highlightEnabled) {
				playbackHighlight.clear();
				const textEl = activeSegment.querySelector('.transcript-segment-text');
				const textNode = textEl?.firstChild;
				if (textNode && textNode.nodeType === Node.TEXT_NODE) {
					const totalLen = (textNode.textContent || '').length;
					const charPos = Math.min(totalLen - 1, Math.max(0, Math.round(segProgress * totalLen)));

					// Find lines around the current position
					const probe = doc.createRange();
					const getLineY = (pos: number) => {
						probe.setStart(textNode!, Math.min(pos, totalLen - 1));
						probe.setEnd(textNode!, Math.min(pos + 1, totalLen));
						return probe.getClientRects()[0]?.top;
					};

					const lineY = getLineY(charPos);
					if (lineY === undefined) return;

					// Scan backward to find start of current sentence
					// but limit to ~2 lines back so run-ons don't over-highlight
					const text = textNode.textContent || '';
					let hlStart = 0;
					if (segProgress > 0.05) {
						hlStart = charPos;
						let backLineChanges = 0;
						let backLastY = lineY;
						while (hlStart > 0) {
							if (isSentBoundary(text, hlStart - 1, hlStart)) {
								while (hlStart < charPos && /\s/.test(text[hlStart])) hlStart++;
								break;
							}
							// Check line changes in steps to reduce layout queries
							if (hlStart % 8 === 0 || hlStart === 1) {
								const y = getLineY(hlStart - 1);
								if (y !== undefined && Math.abs(y - backLastY) > 2) {
									backLineChanges++;
									if (backLineChanges >= 2) break;
									backLastY = y;
								}
							}
							hlStart--;
						}
					}

					// Scan forward: up to 3 lines total, stop at sentence end or comma
					let hlEnd = charPos + 1;
					let fwdLines = 0;
					let fwdLastY = lineY;
					while (hlEnd < totalLen && fwdLines < 3) {
						// Check line changes in steps
						if (hlEnd % 8 === 0 || hlEnd === charPos + 1) {
							const y = getLineY(hlEnd);
							if (y === undefined) break;
							if (Math.abs(y - fwdLastY) > 2) {
								fwdLines++;
								if (fwdLines >= 3) break;
								fwdLastY = y;
							}
						}
						if (hlEnd > charPos + 1 && isSentOrSoftBoundary(text, hlEnd - 1, hlEnd)) break;
						hlEnd++;
					}

					const range = doc.createRange();
					range.setStart(textNode, hlStart);
					range.setEnd(textNode, hlEnd);
					playbackHighlight.add(range);
				}
			}
		}
	};

	// Set up time tracking and seeking based on player type
	let seekTo: (seconds: number) => void;
	let iframePlaying = false;

	if (videoEl) {
		// Native video element: use HTML5 API directly
		seekTo = (seconds: number) => {
			videoEl.currentTime = seconds;
		};
		videoEl.addEventListener('timeupdate', () => {
			updateActiveSegment(videoEl.currentTime);
		}, listenerOptions);
		// Prevent native video controls from handling seek shortcuts
		videoEl.addEventListener('keydown', (e) => {
			if (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'KeyJ' || e.code === 'KeyL') {
				e.preventDefault();
			}
		}, listenerOptions);
	} else if (iframe) {
		// Iframe embed: use postMessage API
		seekTo = (seconds: number) => {
			if (!iframe.contentWindow) return;
			iframe.contentWindow.postMessage(JSON.stringify({
				event: 'command',
				func: 'seekTo',
				args: [seconds, true]
			}), '*');
		};

		const onMessage = (e: MessageEvent) => {
			if (e.source !== iframe.contentWindow) return;
			try {
				const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
				if (data?.info?.currentTime !== undefined) {
					updateActiveSegment(data.info.currentTime);
				}
				if (data?.info?.playerState !== undefined) {
					iframePlaying = data.info.playerState === 1;
				}
			} catch {} // Ignore non-YouTube postMessage events
		};
		window.addEventListener('message', onMessage, listenerOptions);

		const poll = setInterval(() => {
			if (!iframe.contentWindow || !doc.contains(iframe)) {
				clearInterval(poll);
				window.removeEventListener('message', onMessage);
				return;
			}
			iframe.contentWindow.postMessage(JSON.stringify({
				event: 'command',
				func: 'getCurrentTime',
				args: []
			}), '*');
		}, 500);
		eventController.signal.addEventListener('abort', () => clearInterval(poll), { once: true });
	} else {
		seekTo = () => {};
	}

	// Keyboard shortcuts for video playback
	const togglePlayPause = () => {
		if (videoEl) {
			videoEl.paused ? videoEl.play() : videoEl.pause();
		} else if (iframe?.contentWindow) {
			iframe.contentWindow.postMessage(JSON.stringify({
				event: 'command',
				func: iframePlaying ? 'pauseVideo' : 'playVideo',
				args: []
			}), '*');
		}
	};

	const seekRelative = (delta: number) => {
		if (videoEl) {
			videoEl.currentTime = Math.max(0, videoEl.currentTime + delta);
		} else if (iframe?.contentWindow) {
			seekTo(Math.max(0, lastCurrentTime + delta));
		}
	};

	const play = () => {
		if (videoEl) {
			void videoEl.play();
		} else if (iframe?.contentWindow) {
			iframe.contentWindow.postMessage(JSON.stringify({
				event: 'command',
				func: 'playVideo',
				args: []
			}), '*');
		}
	};
	const pause = () => {
		if (videoEl) {
			videoEl.pause();
		} else if (iframe?.contentWindow) {
			iframe.contentWindow.postMessage(JSON.stringify({
				event: 'command',
				func: 'pauseVideo',
				args: []
			}), '*');
		}
	};
	const setPlaybackRate = (rate: number) => {
		if (videoEl) {
			videoEl.playbackRate = rate;
		} else if (iframe?.contentWindow) {
			iframe.contentWindow.postMessage(JSON.stringify({
				event: 'command',
				func: 'setPlaybackRate',
				args: [rate]
			}), '*');
		}
	};
	studyController = wireTranscriptStudy({
		doc,
		controls: toggleGroup,
		segmentTimes,
		getSegmentEnd,
		getActiveIndex: () => activeIndex,
		player: {
			seekTo,
			play,
			pause,
			setPlaybackRate,
			getCurrentTime: () => videoEl?.currentTime ?? Math.max(0, lastCurrentTime)
		}
	});
	transcriptStudyControllers.set(doc, studyController);

	// Use capture phase so we intercept before YouTube's own keyboard
	// handlers on the page — the original page scripts are still running
	doc.addEventListener('keydown', (e: KeyboardEvent) => {
		const tag = (e.target as HTMLElement).tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

		switch (e.code) {
			case 'Space':
				// Only handle Space for iframe embeds — native video
				// controls handle Space themselves and would double-toggle
				if (!videoEl) {
					e.preventDefault();
					e.stopImmediatePropagation();
					togglePlayPause();
				}
				break;
			case 'KeyK':
				// K is not a native video shortcut, so handle it for both
				e.preventDefault();
				e.stopImmediatePropagation();
				togglePlayPause();
				break;
			case 'ArrowLeft':
				e.preventDefault();
				e.stopImmediatePropagation();
				seekRelative(-5);
				break;
			case 'ArrowRight':
				e.preventDefault();
				e.stopImmediatePropagation();
				seekRelative(5);
				break;
			case 'KeyJ':
				e.preventDefault();
				e.stopImmediatePropagation();
				seekRelative(-10);
				break;
			case 'KeyL':
				e.preventDefault();
				e.stopImmediatePropagation();
				seekRelative(10);
				break;
		}
	}, { capture: true, signal: eventController.signal });

	// YouTube handles Space on keyup — block that too
	doc.addEventListener('keyup', (e: KeyboardEvent) => {
		if (e.code === 'Space' && !videoEl) {
			const tag = (e.target as HTMLElement).tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	}, { capture: true, signal: eventController.signal });

	// Add a scrub track behind the timestamps
	const scrubTrack = doc.createElement('div');
	scrubTrack.className = 'transcript-scrub-track';
	const scrubHover = doc.createElement('div');
	scrubHover.className = 'transcript-scrub-hover';
	scrubTrack.appendChild(scrubHover);
	transcript.style.position = 'relative';
	transcript.appendChild(scrubTrack);

	// Word highlights using CSS Custom Highlight API
	const hasHighlights = !!(CSS as any).highlights;
	const playbackHighlight = hasHighlights ? new (window as any).Highlight() : null;
	const hoverHighlight = hasHighlights ? new (window as any).Highlight() : null;
	if (hasHighlights) {
		(CSS as any).highlights.set('transcript-playback', playbackHighlight);
		(CSS as any).highlights.set('transcript-hover', hoverHighlight);
	}

	const getCaretNode = (x: number, y: number): { node: Node; offset: number } | null => {
		if ('caretPositionFromPoint' in doc) {
			const pos = (doc as any).caretPositionFromPoint(x, y);
			if (pos) return { node: pos.offsetNode, offset: pos.offset };
		} else if ('caretRangeFromPoint' in doc) {
			const range = (doc as any).caretRangeFromPoint(x, y) as Range | null;
			if (range) return { node: range.startContainer, offset: range.startOffset };
		}
		return null;
	};

	const getHoverRange = (textNode: Node, offset: number): Range | null => {
		const text = textNode.textContent || '';
		const totalWords = 8;

		// Forward first: up to 6 words, stop at sentence boundary
		// Commas act as soft stops — prefer stopping at a comma if we have 4+ words
		let end = offset;
		let wordsForward = 0;
		let lastComma = -1;
		let wordsAtComma = 0;
		while (end < text.length && wordsForward < 6) {
			if (isSentBoundary(text, end - 1, end)) break;
			if (SOFT_STOP.test(text[end - 1]) && wordsForward >= 3) {
				lastComma = end;
				wordsAtComma = wordsForward;
			}
			end++;
			if (end < text.length && ((/\s/.test(text[end - 1]) && /\S/.test(text[end])) || isWordStep(text, end))) wordsForward++;
		}
		// Prefer comma stop if we went past it
		if (lastComma > 0 && wordsForward > wordsAtComma) {
			end = lastComma;
			wordsForward = wordsAtComma;
		}

		// Backward: if forward hit punctuation, limit to 2 words back
		const hitPunctuation = end < text.length && SENT_END.test(text[end - 1]);
		const maxBack = hitPunctuation ? 2 : Math.max(1, totalWords - wordsForward);
		let start = offset;
		let wordsBack = 0;
		while (start > 0 && wordsBack < maxBack) {
			if (isSentBoundary(text, start - 1, start)) break;
			start--;
			if (start > 0 && ((/\s/.test(text[start]) && /\S/.test(text[start - 1])) || isWordStep(text, start))) wordsBack++;
		}

		// Trim whitespace at edges
		while (start < offset && /\s/.test(text[start])) start++;
		while (end > offset && /\s/.test(text[end - 1])) end--;
		if (start >= end) return null;
		const range = doc.createRange();
		range.setStart(textNode, start);
		range.setEnd(textNode, end);
		return range;
	};

	const updateHoverHighlight = (e: MouseEvent) => {
		if (!hoverHighlight) return;
		hoverHighlight.clear();
		const seg = (e.target as HTMLElement).closest('.transcript-segment-text');
		if (!seg) return;
		const caret = getCaretNode(e.clientX, e.clientY);
		if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !seg.contains(caret.node)) return;
		const range = getHoverRange(caret.node, caret.offset);
		if (range) hoverHighlight.add(range);
	};

	transcript.addEventListener('mousemove', (e: MouseEvent) => {
		const rect = scrubTrack.getBoundingClientRect();
		scrubHover.style.top = (e.clientY - rect.top) + 'px';
		updateHoverHighlight(e);
	}, listenerOptions);
	transcript.addEventListener('mouseleave', () => {
		scrubHover.style.top = '';
		if (hoverHighlight) hoverHighlight.clear();
	}, listenerOptions);
	// Position from first segment to bottom
	const positionTrack = () => {
		const transcriptRect = transcript.getBoundingClientRect();
		const firstSegRect = segments[0].getBoundingClientRect();
		scrubTrack.style.top = (firstSegRect.top - transcriptRect.top) + 'px';
	};
	positionTrack();

	const getTimeFromY = (clientY: number): number => {
		// Find which segment the Y position falls within
		for (let i = segments.length - 1; i >= 0; i--) {
			const rect = segments[i].getBoundingClientRect();
			if (clientY >= rect.top) {
				const progress = Math.min(1, (clientY - rect.top) / rect.height);
				const start = segmentTimes[i];
				const end = getSegmentEnd(i);
				return start + progress * (end - start);
			}
		}
		return segmentTimes[0] || 0;
	};

	scrubTrack.addEventListener('mousedown', (e) => {
		scrubbing = true;
		suppressScroll = true;
		seekTo(getTimeFromY(e.clientY));
		e.preventDefault();
	}, listenerOptions);

	window.addEventListener('mousemove', (e) => {
		if (!scrubbing) return;
		const now = Date.now();
		if (now - lastScrub < 100) return;
		lastScrub = now;
		seekTo(getTimeFromY(e.clientY));
	}, listenerOptions);

	window.addEventListener('mouseup', () => {
		scrubbing = false;
	}, listenerOptions);

	const seekFromTranscriptClick = (target: HTMLElement, clientX: number, clientY: number): boolean => {
		if (doc.body.classList.contains('obsidian-highlighter-active')) return false;
		const seg = target.closest('.transcript-segment') as HTMLElement | null;
		if (!seg) return false;
		const idx = segments.indexOf(seg);
		if (idx < 0) return false;

		const start = segmentTimes[idx];
		const end = getSegmentEnd(idx);

		// Use caret position to estimate character-level progress
		const textEl = seg.querySelector('.transcript-segment-text');
		if (textEl) {
			const originalTextNode = textEl.firstChild;
			const totalLen = originalTextNode?.nodeType === Node.TEXT_NODE
				? (originalTextNode.textContent || '').length
				: 0;
			if (totalLen > 0) {
				const caret = getCaretNode(clientX, clientY);
				let charOffset = totalLen;
				if (caret && caret.node === originalTextNode) {
					charOffset = caret.offset;
				}
				const progress = Math.min(1, Math.max(0, charOffset / totalLen));
				seekTo(start + progress * (end - start));
				return true;
			}
		}

		// Fallback to Y position
		const rect = seg.getBoundingClientRect();
		const progress = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
		seekTo(start + progress * (end - start));
		return true;
	};

	// Delay single-click seeking so a double-click can explain a word. If the
	// OS double-click interval is longer, restore the position after the seek.
	transcript.addEventListener('click', (e: MouseEvent) => {
		const target = e.target as HTMLElement;
		if (target.closest('.transcript-segment-translation, .transcript-reading-token, .player-learning-action, .language-learning-selection-action')) return;
		if (e.detail > 1) {
			transcriptClickGuard.cancel();
			return;
		}
		const selection = doc.getSelection();
		if (selection && !selection.isCollapsed) return;
		const { clientX, clientY } = e;
		const originalTime = videoEl?.currentTime ?? (lastCurrentTime >= 0 ? lastCurrentTime : undefined);
		transcriptClickGuard.schedule(
			() => seekFromTranscriptClick(target, clientX, clientY),
			originalTime === undefined ? undefined : () => seekTo(originalTime)
		);
	}, listenerOptions);
}
