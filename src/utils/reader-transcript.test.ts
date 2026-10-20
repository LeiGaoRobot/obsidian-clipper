// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import * as readerTranscript from './reader-transcript';
import { createTranscriptClickGuard, wireTranscript } from './reader-transcript';
import { createReaderTranscriptLoader, type ReaderTranscriptModules } from './reader-transcript-loader';
import { captureTrustedClicks, flushPromises } from '../reader/learning/test-support';

describe('Transcript click guard', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	test('cancels a pending seek when a second click arrives', () => {
		vi.useFakeTimers();
		const seek = vi.fn(() => true);
		const rollback = vi.fn();
		const guard = createTranscriptClickGuard(350, 1500);

		guard.schedule(seek, rollback);
		vi.advanceTimersByTime(349);
		guard.cancel();
		vi.runAllTimers();

		expect(seek).not.toHaveBeenCalled();
		expect(rollback).not.toHaveBeenCalled();
	});

	test('restores playback when an OS-level double click arrives after the seek delay', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-17T00:00:00Z'));
		const seek = vi.fn(() => true);
		const rollback = vi.fn();
		const guard = createTranscriptClickGuard(350, 1500);

		guard.schedule(seek, rollback);
		vi.advanceTimersByTime(350);
		vi.advanceTimersByTime(650);
		guard.cancel();

		expect(seek).toHaveBeenCalledOnce();
		expect(rollback).toHaveBeenCalledOnce();
	});
});

describe('Transcript layout integration', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	test('moves the same controls between reading and split layouts and persists the choice', () => {
		vi.stubGlobal('CSS', {});
		document.body.innerHTML = `
			<article>
				<a href="https://www.youtube.com/watch?v=test">Video</a>
				<div class="youtube transcript">
					<div class="transcript-segment">
						<strong><span class="timestamp" data-timestamp="0">0:00</span></strong>
						Hello world.
					</div>
				</div>
			</article>
		`;
		const article = document.querySelector('article') as HTMLElement;
		const onSettingChange = vi.fn();

		wireTranscript(
			document,
			article,
			{
				pinPlayer: true,
				autoScroll: true,
				highlightActiveLine: true,
				transcriptLayout: 'reading',
				responseLanguage: 'English'
			},
			{
				getStickyOffset: () => 0,
				scrollTo: vi.fn(),
				programmaticScroll: () => false
			},
			onSettingChange
		);

		const layoutRoot = article.querySelector('.transcript-study-layout') as HTMLElement;
		const playerContainer = layoutRoot.querySelector('.player-container') as HTMLElement;
		const toggleBar = layoutRoot.querySelector('.player-toggles') as HTMLElement;
		const focusButton = layoutRoot.querySelector('[data-transcript-layout="focus"]') as HTMLButtonElement;
		const readingButton = layoutRoot.querySelector('[data-transcript-layout="reading"]') as HTMLButtonElement;
		const notebookButton = layoutRoot.querySelector('[data-transcript-layout="notebook"]') as HTMLButtonElement;

		expect(playerContainer.contains(toggleBar)).toBe(true);
		expect(notebookButton.textContent).toBe('Study tools');

		focusButton.click();

		expect(layoutRoot.classList.contains('transcript-layout-focus')).toBe(true);
		expect(toggleBar.parentElement).toBe(layoutRoot);
		expect(onSettingChange).toHaveBeenLastCalledWith('transcriptLayout', 'focus');

		readingButton.click();

		expect(layoutRoot.classList.contains('transcript-layout-reading')).toBe(true);
		expect(playerContainer.contains(toggleBar)).toBe(true);
		expect(onSettingChange).toHaveBeenLastCalledWith('transcriptLayout', 'reading');
	});

	test('wires a Bilibili native player without starting a language-model request', () => {
		vi.stubGlobal('CSS', {});
		document.body.innerHTML = `
			<article>
				<div class="reader-video-wrapper"><video class="reader-video-player"></video></div>
				<div class="bilibili transcript" data-transcript-platform="bilibili">
					<div class="transcript-segment">
						<strong><span class="timestamp" data-timestamp="0">0:00</span></strong>
						第一句。
					</div>
				</div>
			</article>
		`;
		const article = document.querySelector('article') as HTMLElement;
		const translateTranscript = vi.fn();
		const annotateJapaneseTranscript = vi.fn();
		const explainSelection = vi.fn();

		wireTranscript(document, article, {
			pinPlayer: true,
			autoScroll: true,
			highlightActiveLine: true,
			transcriptLayout: 'reading',
			responseLanguage: 'English'
		}, {
			getStickyOffset: () => 0,
			scrollTo: vi.fn(),
			programmaticScroll: () => false
		}, undefined, {
			translateTranscript,
			annotateJapaneseTranscript,
			explainSelection
		});

		expect(article.querySelector('.transcript-study-layout')).toBeTruthy();
		expect(article.querySelector('.bilibili.transcript .transcript-segment-text')?.textContent).toContain('第一句。');
		expect(translateTranscript).not.toHaveBeenCalled();
		expect(annotateJapaneseTranscript).not.toHaveBeenCalled();
		expect(explainSelection).not.toHaveBeenCalled();
	});

	test('keeps one primary control row and collapses secondary controls by default', () => {
		vi.stubGlobal('CSS', {});
		vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
		document.body.innerHTML = `
			<article>
				<a href="https://www.youtube.com/watch?v=test">Video</a>
				<div class="youtube transcript">
					<div class="transcript-segment">
						<strong><span class="timestamp" data-timestamp="0">0:00</span></strong>
						Hello world.
					</div>
				</div>
			</article>
		`;
		const article = document.querySelector('article') as HTMLElement;

		wireTranscript(
			document,
			article,
			{
				pinPlayer: true,
				autoScroll: true,
				highlightActiveLine: true,
				transcriptLayout: 'reading',
				responseLanguage: 'English'
			},
			{
				getStickyOffset: () => 0,
				scrollTo: vi.fn(),
				programmaticScroll: () => false
			}
		);

		const layoutRoot = article.querySelector('.transcript-study-layout') as HTMLElement;
		const playerContainer = layoutRoot.querySelector('.player-container') as HTMLElement;
		const toggleBar = layoutRoot.querySelector('.player-toggles') as HTMLElement;
		const primaryActions = layoutRoot.querySelector('.player-primary-actions') as HTMLElement;
		const moreControls = layoutRoot.querySelector('.player-controls-more') as HTMLDetailsElement;
		const morePanel = moreControls?.querySelector('.player-controls-panel') as HTMLElement;
		const compactButton = primaryActions?.querySelector('.player-compact-toggle') as HTMLButtonElement;
		const activeSegment = layoutRoot.querySelector('.transcript-segment') as HTMLElement;
		const scrollIntoView = vi.fn();
		const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
		playerContainer.getBoundingClientRect = () => ({
			height: playerContainer.classList.contains('is-compact') ? 44 : 360
		} as DOMRect);
		activeSegment.classList.add('is-active');
		activeSegment.scrollIntoView = scrollIntoView;
		activeSegment.getBoundingClientRect = () => ({
			top: 300,
			bottom: 380,
			height: 80
		} as DOMRect);
		toggleBar.getBoundingClientRect = () => ({ bottom: 420, height: 96 } as DOMRect);
		morePanel.getBoundingClientRect = () => ({ top: 760 } as DOMRect);

		expect(primaryActions).toBeTruthy();
		// The toggles and More are one group, so More wraps with them instead of alone.
		const controlActions = toggleBar.querySelector(':scope > .player-controls-actions') as HTMLElement;
		expect(Array.from(controlActions.children)).toEqual([primaryActions, moreControls]);
		expect(toggleBar.firstElementChild?.classList.contains('transcript-layout-switcher')).toBe(true);
		expect(moreControls.open).toBe(false);
		expect(morePanel.querySelectorAll('.player-toggle')).toHaveLength(3);
		expect(morePanel.querySelectorAll('.player-control-section')).toHaveLength(2);
		expect(morePanel.querySelectorAll('.player-control-section-title')).toHaveLength(2);
		expect(morePanel.querySelector('.player-study')).toBeTruthy();
		expect(compactButton.getAttribute('aria-pressed')).toBe('false');

		compactButton.click();

		expect(playerContainer.classList.contains('is-compact')).toBe(true);
		expect(compactButton.getAttribute('aria-pressed')).toBe('true');
		expect(compactButton.textContent).toBe('Show player');
		expect(layoutRoot.style.getPropertyValue('--transcript-player-height')).toBe('44px');
		expect(layoutRoot.style.getPropertyValue('--transcript-controls-height')).toBe('96px');
		expect(playerContainer.querySelector('a[href*="youtube.com/watch"]')?.isConnected).toBe(true);

		compactButton.click();

		expect(playerContainer.classList.contains('is-compact')).toBe(false);
		expect(compactButton.getAttribute('aria-pressed')).toBe('false');
		expect(compactButton.textContent).toBe('Compact player');
		expect(layoutRoot.style.getPropertyValue('--transcript-player-height')).toBe('360px');

		moreControls.open = true;
		moreControls.dispatchEvent(new Event('toggle'));

		expect(layoutRoot.classList.contains('is-controls-open')).toBe(true);
		expect(morePanel.parentElement).toBe(layoutRoot);
		expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
		expect(scrollBy).toHaveBeenCalledWith({ behavior: 'auto', top: -132 });

		(morePanel.querySelector('.player-controls-close') as HTMLButtonElement).click();

		expect(moreControls.open).toBe(false);
		expect(morePanel.parentElement).toBe(moreControls);
	});

	test('restores the compact-player preference and persists later changes', () => {
		vi.stubGlobal('CSS', {});
		document.body.innerHTML = `
			<article>
				<a href="https://www.youtube.com/watch?v=test">Video</a>
				<div class="youtube transcript">
					<div class="transcript-segment">
						<strong><span class="timestamp" data-timestamp="0">0:00</span></strong>
						Hello world.
					</div>
				</div>
			</article>
		`;
		const article = document.querySelector('article') as HTMLElement;
		const onSettingChange = vi.fn();

		wireTranscript(document, article, {
			pinPlayer: true,
			autoScroll: true,
			highlightActiveLine: true,
			transcriptLayout: 'reading',
			responseLanguage: 'English',
			compactPlayer: true
		}, {
			getStickyOffset: () => 0,
			scrollTo: vi.fn(),
			programmaticScroll: () => false
		}, onSettingChange);

		const player = article.querySelector('.player-container') as HTMLElement;
		const button = article.querySelector('.player-compact-toggle') as HTMLButtonElement;
		expect(player.classList.contains('is-compact')).toBe(true);
		expect(button.getAttribute('aria-pressed')).toBe('true');

		button.click();
		expect(onSettingChange).toHaveBeenLastCalledWith('compactPlayer', false);
	});

	test('uses a modal, keyboard-contained bottom sheet for mobile secondary controls', () => {
		vi.stubGlobal('CSS', {});
		vi.stubGlobal('matchMedia', vi.fn(() => ({
			matches: true,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn()
		})));
		vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
		document.body.innerHTML = `
			<article>
				<a href="https://www.youtube.com/watch?v=test">Video</a>
				<div class="youtube transcript">
					<div class="transcript-segment is-active">
						<strong><span class="timestamp" data-timestamp="0">0:00</span></strong>
						Hello world.
					</div>
				</div>
			</article>
		`;
		const article = document.querySelector('article') as HTMLElement;
		wireTranscript(document, article, {
			pinPlayer: true,
			autoScroll: true,
			highlightActiveLine: true,
			transcriptLayout: 'reading',
			responseLanguage: 'English'
		}, {
			getStickyOffset: () => 0,
			scrollTo: vi.fn(),
			programmaticScroll: () => false
		});

		const root = article.querySelector('.transcript-study-layout') as HTMLElement;
		const details = root.querySelector('.player-controls-more') as HTMLDetailsElement;
		const summary = details.querySelector('summary') as HTMLElement;
		const panel = root.querySelector('.player-controls-panel') as HTMLElement;
		const close = panel.querySelector('.player-controls-close') as HTMLButtonElement;
		const activeSegment = root.querySelector('.transcript-segment.is-active') as HTMLElement;
		activeSegment.scrollIntoView = vi.fn();
		activeSegment.getBoundingClientRect = () => ({ top: 450, bottom: 520 } as DOMRect);
		(root.querySelector('.player-toggles') as HTMLElement).getBoundingClientRect = () => ({ bottom: 400 } as DOMRect);
		panel.getBoundingClientRect = () => ({ top: 760 } as DOMRect);

		details.open = true;
		details.dispatchEvent(new Event('toggle'));

		expect(panel.getAttribute('role')).toBe('dialog');
		expect(panel.getAttribute('aria-modal')).toBe('true');
		expect(panel.getAttribute('aria-labelledby')).toBeTruthy();
		expect(document.activeElement).toBe(close);
		expect(root.querySelector('.player-controls-backdrop')).toBeTruthy();

		document.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'Tab',
			shiftKey: true,
			bubbles: true
		}));
		const lastControl = document.activeElement;
		expect(lastControl).not.toBe(close);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		expect(document.activeElement).toBe(close);

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(details.open).toBe(false);
		expect(document.activeElement).toBe(summary);
		expect(root.querySelector('.player-controls-backdrop')).toBeNull();
	});

	test('moves an open controls drawer when the viewport crosses the mobile breakpoint', () => {
		vi.stubGlobal('CSS', {});
		let viewportListener: ((event: MediaQueryListEvent) => void) | undefined;
		const viewportQuery = {
			matches: false,
			addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
				viewportListener = listener;
			}),
			removeEventListener: vi.fn()
		};
		vi.stubGlobal('matchMedia', vi.fn(() => viewportQuery));
		vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
		document.body.innerHTML = `
			<article>
				<a href="https://www.youtube.com/watch?v=test">Video</a>
				<div class="youtube transcript">
					<div class="transcript-segment is-active">
						<strong><span class="timestamp" data-timestamp="0">0:00</span></strong>
						Hello world.
					</div>
				</div>
			</article>
		`;
		const article = document.querySelector('article') as HTMLElement;

		wireTranscript(document, article, {
			pinPlayer: true,
			autoScroll: true,
			highlightActiveLine: true,
			transcriptLayout: 'focus',
			responseLanguage: 'English'
		}, {
			getStickyOffset: () => 0,
			scrollTo: vi.fn(),
			programmaticScroll: () => false
		});

		const root = article.querySelector('.transcript-study-layout') as HTMLElement;
		const details = root.querySelector('.player-controls-more') as HTMLDetailsElement;
		const panel = root.querySelector('.player-controls-panel') as HTMLElement;
		const activeSegment = root.querySelector('.transcript-segment.is-active') as HTMLElement;
		activeSegment.scrollIntoView = vi.fn();
		activeSegment.getBoundingClientRect = () => ({ top: 450, bottom: 520 } as DOMRect);
		(root.querySelector('.player-toggles') as HTMLElement).getBoundingClientRect = () => ({ bottom: 400 } as DOMRect);
		panel.getBoundingClientRect = () => ({ top: 760 } as DOMRect);

		details.open = true;
		details.dispatchEvent(new Event('toggle'));
		expect(panel.parentElement).toBe(details);

		viewportQuery.matches = true;
		viewportListener?.({ matches: true } as MediaQueryListEvent);
		expect(panel.parentElement).toBe(root);
		expect(activeSegment.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });

		viewportQuery.matches = false;
		viewportListener?.({ matches: false } as MediaQueryListEvent);
		expect(panel.parentElement).toBe(details);
	});

	test('removes the previous study controls when the transcript is wired again', () => {
		vi.stubGlobal('CSS', {});
		document.body.innerHTML = `
			<article>
				<a href="https://www.youtube.com/watch?v=test">Video</a>
				<div class="youtube transcript">
					<div class="transcript-segment">
						<strong><span class="timestamp" data-timestamp="0">0:00</span></strong>
						Hello world.
					</div>
				</div>
			</article>
		`;
		const article = document.querySelector('article') as HTMLElement;
		const settings = {
			pinPlayer: true,
			autoScroll: true,
			highlightActiveLine: true,
			transcriptLayout: 'reading' as const,
			responseLanguage: 'English'
		};
		const scroll = {
			getStickyOffset: () => 0,
			scrollTo: vi.fn(),
			programmaticScroll: () => false
		};

		wireTranscript(document, article, settings, scroll);
		const oldCompactButton = article.querySelector('.player-compact-toggle') as HTMLButtonElement;
		const oldPlayer = article.querySelector('.player-container') as HTMLElement;
		wireTranscript(document, article, settings, scroll);
		oldCompactButton.click();

		expect(article.querySelectorAll('.transcript-study-layout')).toHaveLength(1);
		expect(article.querySelectorAll('.player-primary-actions')).toHaveLength(1);
		expect(article.querySelectorAll('.player-controls-more')).toHaveLength(1);
		expect(article.querySelectorAll('.player-current-pos')).toHaveLength(1);
		expect(article.querySelectorAll('.transcript-scrub-track')).toHaveLength(1);
		expect(article.querySelectorAll('.player-study')).toHaveLength(1);
		expect(article.querySelectorAll('.transcript-segment-text')).toHaveLength(1);
		expect(article.querySelector('.transcript-segment-text .transcript-segment-text')).toBeNull();
		expect(oldPlayer.classList.contains('is-compact')).toBe(false);
	});

	test('cancels a pending transcript seek when the Reader is wired again', () => {
		vi.useFakeTimers();
		vi.stubGlobal('CSS', {});
		document.body.innerHTML = `
			<article>
				<div class="reader-video-wrapper"><video class="reader-video-player"></video></div>
				<div class="youtube transcript">
					<div class="transcript-segment">
						<strong><span class="timestamp" data-timestamp="0">0:00</span></strong>
						Hello world.
					</div>
				</div>
			</article>
		`;
		const article = document.querySelector('article') as HTMLElement;
		const video = article.querySelector('video') as HTMLVideoElement;
		const settings = {
			pinPlayer: true,
			autoScroll: true,
			highlightActiveLine: true,
			transcriptLayout: 'reading' as const,
			responseLanguage: 'English'
		};
		const scroll = {
			getStickyOffset: () => 0,
			scrollTo: vi.fn(),
			programmaticScroll: () => false
		};

		wireTranscript(document, article, settings, scroll);
		const segment = article.querySelector('.transcript-segment') as HTMLElement;
		segment.getBoundingClientRect = () => ({ top: 0, height: 100 } as DOMRect);
		segment.dispatchEvent(new MouseEvent('click', {
			bubbles: true,
			clientX: 10,
			clientY: 50,
			detail: 1
		}));

		wireTranscript(document, article, settings, scroll);
		vi.advanceTimersByTime(350);

		expect(video.currentTime).toBe(0);
	});

	test('does not seek when the Japanese learning line is clicked', () => {
		vi.useFakeTimers();
		vi.stubGlobal('CSS', {});
		document.body.innerHTML = `
			<article>
				<div class="reader-video-wrapper"><video class="reader-video-player"></video></div>
				<div class="youtube transcript">
					<div class="transcript-segment">
						<strong><span class="timestamp" data-timestamp="10">0:10</span></strong>
						Hello world.
						<div class="transcript-segment-japanese"><ruby>世界<rt>せかい</rt></ruby></div>
					</div>
				</div>
			</article>
		`;
		const article = document.querySelector('article') as HTMLElement;
		const video = article.querySelector('video') as HTMLVideoElement;
		wireTranscript(document, article, {
			pinPlayer: true,
			autoScroll: true,
			highlightActiveLine: true,
			transcriptLayout: 'reading',
			responseLanguage: 'English'
		}, {
			getStickyOffset: () => 0,
			scrollTo: vi.fn(),
			programmaticScroll: () => false
		});
		const segment = article.querySelector('.transcript-segment') as HTMLElement;
		segment.getBoundingClientRect = () => ({ top: 0, height: 100 } as DOMRect);
		const japanese = article.querySelector('.transcript-segment-japanese') as HTMLElement;
		japanese.dispatchEvent(new MouseEvent('click', {
			bubbles: true,
			clientX: 10,
			clientY: 50,
			detail: 1
		}));
		vi.advanceTimersByTime(350);

		expect(video.currentTime).toBe(0);
	});
});

describe('Transcript cleanup on Reader navigation', () => {
	afterEach(() => {
		readerTranscript.cleanupTranscript(document);
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	const settings = {
		pinPlayer: true,
		autoScroll: true,
		highlightActiveLine: true,
		transcriptLayout: 'reading' as const,
		responseLanguage: 'English'
	};
	const scroll = {
		getStickyOffset: () => 0,
		scrollTo: () => {},
		programmaticScroll: () => false
	};
	const transcriptArticle = () => {
		document.body.innerHTML = `
			<main>
				<article>
					<a href="https://www.youtube.com/watch?v=test">Video</a>
					<div class="youtube transcript">
						<div class="transcript-segment"><strong><span class="timestamp" data-timestamp="0">0:00</span></strong>Hello world.</div>
					</div>
				</article>
			</main>
		`;
		return document.querySelector('article') as HTMLElement;
	};
	const plainArticle = () => {
		const main = document.querySelector('main') as HTMLElement;
		main.innerHTML = '<article><p>A plain article.</p></article>';
		return main.querySelector('article') as HTMLElement;
	};

	test('navigating from a transcript to a plain article removes the learning UI and aborts its request', async () => {
		vi.stubGlobal('CSS', {});
		const clicks = captureTrustedClicks();
		const selectionSignals: AbortSignal[] = [];
		const addListener = Document.prototype.addEventListener;
		vi.spyOn(Document.prototype, 'addEventListener').mockImplementation(function (
			this: Document,
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: boolean | AddEventListenerOptions
		) {
			if (type === 'selectionchange' && typeof options === 'object' && options.signal) selectionSignals.push(options.signal);
			return addListener.call(this, type, listener, options);
		});
		let requestSignal: AbortSignal | undefined;
		const translateTranscript = vi.fn((_segments: string[], _onProgress?: unknown, signal?: AbortSignal) => {
			requestSignal = signal;
			return new Promise<string[]>(() => {});
		});
		const load = vi.fn(async () => ({ transcript: readerTranscript, runtime: {} }) as unknown as ReaderTranscriptModules);
		const loader = createReaderTranscriptLoader(load);

		const article = transcriptArticle();
		const prepared = await loader.prepare(document, article);
		prepared?.modules.transcript.wireTranscript(document, article, settings, scroll, undefined, {
			translateTranscript,
			annotateJapaneseTranscript: vi.fn(),
			explainSelection: vi.fn()
		});
		await clicks.click(document.querySelector('.player-learning-bilingual'));
		await flushPromises();
		clicks.restore();
		expect(requestSignal?.aborted).toBe(false);
		expect(document.querySelector('.language-learning-card')).not.toBeNull();
		expect(document.querySelector('.language-learning-selection-action')).not.toBeNull();
		expect(selectionSignals).toHaveLength(1);

		await expect(loader.prepare(document, plainArticle())).resolves.toBeUndefined();

		expect(load).toHaveBeenCalledOnce();
		expect(requestSignal?.aborted).toBe(true);
		expect(selectionSignals[0].aborted).toBe(true);
		expect(document.querySelector('.language-learning-card')).toBeNull();
		expect(document.querySelector('.language-learning-selection-action')).toBeNull();
		expect(document.documentElement.hasAttribute('data-transcript-layout')).toBe(false);
	});

	test('the transcript task bar sits outside More, so a running task shows progress and Cancel', async () => {
		vi.stubGlobal('CSS', {});
		const clicks = captureTrustedClicks();
		const article = transcriptArticle();
		wireTranscript(document, article, settings, scroll, undefined, {
			translateTranscript: vi.fn(() => new Promise<string[]>(() => {})),
			annotateJapaneseTranscript: vi.fn(),
			explainSelection: vi.fn()
		});
		const moreControls = document.querySelector('.player-controls-more') as HTMLDetailsElement;
		const taskBar = document.querySelector('.player-learning-task') as HTMLElement;
		expect(taskBar.parentElement?.classList.contains('player-toggles')).toBe(true);
		expect(moreControls.contains(taskBar)).toBe(false);
		expect(taskBar.hidden).toBe(true);

		await clicks.click(document.querySelector('.player-learning-bilingual'));
		await flushPromises();
		clicks.restore();

		expect(moreControls.open).toBe(false);
		expect(taskBar.hidden).toBe(false);
		expect(taskBar.getAttribute('aria-busy')).toBe('true');
		expect((taskBar.querySelector('.player-learning-cancel') as HTMLButtonElement).hidden).toBe(false);

		readerTranscript.cleanupTranscript(document);
		expect(document.querySelector('.player-learning-task')).toBeNull();
	});

	test('cleanupTranscript leaves the document as before the transcript was wired', () => {
		vi.stubGlobal('CSS', {});
		const article = transcriptArticle();
		wireTranscript(document, article, settings, scroll, undefined, {
			translateTranscript: vi.fn(),
			annotateJapaneseTranscript: vi.fn(),
			explainSelection: vi.fn()
		});

		readerTranscript.cleanupTranscript(document);

		expect(document.querySelector('.language-learning-card')).toBeNull();
		expect(document.querySelector('.language-learning-selection-action')).toBeNull();
		expect(document.querySelector('.player-learning-bilingual')).toBeNull();
	});
});
