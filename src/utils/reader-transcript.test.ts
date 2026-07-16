// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createTranscriptClickGuard } from './reader-transcript';

describe('Transcript click guard', () => {
	afterEach(() => {
		vi.useRealTimers();
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
