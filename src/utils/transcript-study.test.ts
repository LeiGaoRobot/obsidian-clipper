// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest';
import { wireTranscriptStudy } from './transcript-study';

function createStudyFixture() {
	document.body.innerHTML = '<div id="controls"></div>';
	let currentTime = 12;
	let activeIndex = 1;
	const player = {
		seekTo: vi.fn((seconds: number) => { currentTime = seconds; }),
		play: vi.fn(),
		pause: vi.fn(),
		setPlaybackRate: vi.fn(),
		getCurrentTime: () => currentTime
	};
	const controller = wireTranscriptStudy({
		doc: document,
		controls: document.getElementById('controls') as HTMLElement,
		segmentTimes: [0, 10, 20],
		getSegmentEnd: index => [10, 20, 30][index],
		getActiveIndex: () => activeIndex,
		player
	});
	return {
		controller,
		player,
		setCurrentTime: (value: number) => { currentTime = value; },
		setActiveIndex: (value: number) => { activeIndex = value; }
	};
}

describe('Transcript study controls', () => {
	test('repeats the active sentence at its end', () => {
		const { controller, player } = createStudyFixture();

		controller.toggleRepeat();
		controller.onTimeUpdate(19.95, 1);

		expect(player.seekTo).toHaveBeenCalledWith(10);
		expect(player.play).toHaveBeenCalledOnce();
		expect(document.querySelector('.player-study-repeat')?.getAttribute('aria-pressed')).toBe('true');
	});

	test('sets and loops an A-B range from the current position', () => {
		const { controller, player, setCurrentTime } = createStudyFixture();

		setCurrentTime(12.5);
		controller.setPointA();
		setCurrentTime(17.25);
		controller.setPointB();
		controller.onTimeUpdate(17.24, 1);

		expect(player.seekTo).toHaveBeenLastCalledWith(12.5);
		expect(player.play).toHaveBeenCalledOnce();
		expect(document.querySelector('.player-study-range')?.textContent).toContain('0:12–0:17');
	});

	test('auto-pauses once at the end of each sentence', () => {
		const { controller, player } = createStudyFixture();

		controller.toggleAutoPause();
		controller.onTimeUpdate(19.95, 1);
		controller.onTimeUpdate(19.98, 1);
		controller.onTimeUpdate(20.1, 2);
		controller.onTimeUpdate(29.95, 2);

		expect(player.pause).toHaveBeenCalledTimes(2);
	});

	test('does not miss sentence boundaries between iframe polling updates', () => {
		const repeat = createStudyFixture();
		repeat.controller.toggleRepeat();
		repeat.controller.onTimeUpdate(19.7, 1);
		repeat.controller.onTimeUpdate(20.2, 2);
		expect(repeat.player.seekTo).toHaveBeenCalledWith(10);

		repeat.controller.cleanup();
		const autoPause = createStudyFixture();
		autoPause.controller.toggleAutoPause();
		autoPause.controller.onTimeUpdate(19.7, 1);
		autoPause.controller.onTimeUpdate(20.2, 2);
		expect(autoPause.player.seekTo).toHaveBeenCalledWith(20);
		expect(autoPause.player.pause).toHaveBeenCalledOnce();
	});

	test('changes speed and exposes keyboard shortcuts outside form fields', () => {
		const { player } = createStudyFixture();

		document.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketRight', bubbles: true }));
		document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true }));

		expect(player.setPlaybackRate).toHaveBeenCalledWith(1.25);
		expect(document.querySelector('.player-study-repeat')?.getAttribute('aria-pressed')).toBe('true');

		const input = document.createElement('input');
		document.body.appendChild(input);
		input.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketRight', bubbles: true }));
		expect(player.setPlaybackRate).toHaveBeenCalledTimes(1);
	});
});
