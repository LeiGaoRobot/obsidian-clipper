// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
	createTranscriptLayoutSwitcher,
	normalizeTranscriptLayoutMode,
	syncTranscriptControlsRows
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

describe('transcript controls rows', () => {
	const rect = (top: number, height: number) => ({ top, bottom: top + height, height } as DOMRect);
	const setup = () => {
		document.body.innerHTML = `
			<div class="player-toggles">
				<div class="transcript-layout-switcher"></div>
				<div class="player-controls-actions"><div class="player-primary-actions"></div><details class="player-controls-more"><summary>More</summary></details></div>
			</div>`;
		const controls = document.querySelector('.player-toggles') as HTMLElement;
		const switcher = controls.querySelector('.transcript-layout-switcher') as HTMLElement;
		const actions = controls.querySelector('.player-controls-actions') as HTMLElement;
		return { controls, switcher, actions };
	};

	test('stacks the controls when the toggles and More wrap below the layout switcher', () => {
		const { controls, switcher, actions } = setup();
		switcher.getBoundingClientRect = () => rect(10, 34);
		actions.getBoundingClientRect = () => rect(54, 30);
		syncTranscriptControlsRows(controls);
		expect(controls.classList.contains('is-controls-stacked')).toBe(true);

		// Wider again: measured on the one-row layout, the group fits beside the switcher.
		actions.getBoundingClientRect = () => rect(12, 30);
		syncTranscriptControlsRows(controls);
		expect(controls.classList.contains('is-controls-stacked')).toBe(false);
	});

	test('leaves layouts that dissolve the group, and unlaid-out controls, as they are', () => {
		const { controls, switcher, actions } = setup();
		switcher.getBoundingClientRect = () => rect(10, 34);
		actions.getBoundingClientRect = () => rect(54, 30);
		actions.style.display = 'contents';
		syncTranscriptControlsRows(controls);
		expect(controls.classList.contains('is-controls-stacked')).toBe(false);

		actions.style.display = '';
		controls.classList.add('is-controls-stacked');
		switcher.getBoundingClientRect = () => rect(0, 0);
		syncTranscriptControlsRows(controls);
		expect(controls.classList.contains('is-controls-stacked')).toBe(true);
	});
});
