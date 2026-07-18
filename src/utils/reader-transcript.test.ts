// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createTranscriptClickGuard, wireTranscript } from './reader-transcript';

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
				transcriptLayout: 'reading'
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

		expect(playerContainer.contains(toggleBar)).toBe(true);

		focusButton.click();

		expect(layoutRoot.classList.contains('transcript-layout-focus')).toBe(true);
		expect(toggleBar.parentElement).toBe(layoutRoot);
		expect(onSettingChange).toHaveBeenLastCalledWith('transcriptLayout', 'focus');

		readingButton.click();

		expect(layoutRoot.classList.contains('transcript-layout-reading')).toBe(true);
		expect(playerContainer.contains(toggleBar)).toBe(true);
		expect(onSettingChange).toHaveBeenLastCalledWith('transcriptLayout', 'reading');
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
			transcriptLayout: 'reading' as const
		};
		const scroll = {
			getStickyOffset: () => 0,
			scrollTo: vi.fn(),
			programmaticScroll: () => false
		};

		wireTranscript(document, article, settings, scroll);
		wireTranscript(document, article, settings, scroll);

		expect(article.querySelectorAll('.player-study')).toHaveLength(1);
	});
});
