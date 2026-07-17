// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
	createTranscriptLayoutSwitcher,
	normalizeTranscriptLayoutMode
} from './transcript-layout';

describe('transcript layout switcher', () => {
	beforeEach(() => {
		document.documentElement.className = '';
		document.body.innerHTML = '<section class="transcript-study-layout"></section>';
	});

	test('switches the visible layout and exposes the selected state', () => {
		const root = document.querySelector('.transcript-study-layout') as HTMLElement;
		const onChange = vi.fn();
		const switcher = createTranscriptLayoutSwitcher({
			doc: document,
			root,
			initialMode: 'reading',
			groupLabel: 'Transcript layout',
			labels: {
				reading: 'Reading',
				notebook: 'Notebook',
				focus: 'Focus'
			},
			onChange
		});
		document.body.prepend(switcher.element);

		const readingButton = switcher.element.querySelector('[data-transcript-layout="reading"]') as HTMLButtonElement;
		const notebookButton = switcher.element.querySelector('[data-transcript-layout="notebook"]') as HTMLButtonElement;
		const focusButton = switcher.element.querySelector('[data-transcript-layout="focus"]') as HTMLButtonElement;

		expect(root.classList.contains('transcript-layout-reading')).toBe(true);
		expect(document.documentElement.classList.contains('transcript-layout-reading')).toBe(true);
		expect(readingButton.getAttribute('aria-pressed')).toBe('true');
		expect(notebookButton.getAttribute('aria-pressed')).toBe('false');

		notebookButton.click();

		expect(root.classList.contains('transcript-layout-reading')).toBe(false);
		expect(root.classList.contains('transcript-layout-notebook')).toBe(true);
		expect(document.documentElement.classList.contains('transcript-layout-notebook')).toBe(true);
		expect(notebookButton.getAttribute('aria-pressed')).toBe('true');
		expect(readingButton.getAttribute('aria-pressed')).toBe('false');
		expect(onChange).toHaveBeenLastCalledWith('notebook');

		focusButton.click();

		expect(root.classList.contains('transcript-layout-focus')).toBe(true);
		expect(document.documentElement.classList.contains('transcript-layout-focus')).toBe(true);
		expect(focusButton.getAttribute('aria-pressed')).toBe('true');
		expect(onChange).toHaveBeenLastCalledWith('focus');
	});

	test('falls back to reading for unsupported stored values', () => {
		expect(normalizeTranscriptLayoutMode('focus')).toBe('focus');
		expect(normalizeTranscriptLayoutMode('unsupported')).toBe('reading');
		expect(normalizeTranscriptLayoutMode(undefined)).toBe('reading');
	});
});
