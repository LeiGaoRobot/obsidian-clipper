// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
	clearTranscriptLayoutMode,
	clearTranscriptScrollbarWidth,
	createTranscriptLayoutSwitcher,
	normalizeTranscriptLayoutMode,
	syncTranscriptControlsPanel,
	syncTranscriptToolbarLayout,
	updateTranscriptScrollbarWidth
} from './transcript-layout';

describe('transcript scrollbar width', () => {
	test('publishes the page scrollbar width that 100vw includes; a layout change keeps it, cleanup clears it', () => {
		const innerWidth = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000);
		const clientWidth = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(985);
		updateTranscriptScrollbarWidth(document);
		expect(document.documentElement.style.getPropertyValue('--transcript-scrollbar-width')).toBe('15px');

		clientWidth.mockReturnValue(1000);
		updateTranscriptScrollbarWidth(document);
		expect(document.documentElement.style.getPropertyValue('--transcript-scrollbar-width')).toBe('0px');

		clearTranscriptLayoutMode(document);
		expect(document.documentElement.style.getPropertyValue('--transcript-scrollbar-width')).toBe('0px');
		clearTranscriptScrollbarWidth(document);
		expect(document.documentElement.style.getPropertyValue('--transcript-scrollbar-width')).toBe('');
		innerWidth.mockRestore();
		clientWidth.mockRestore();
	});
});

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

	test('switching the layout keeps the published scrollbar width', () => {
		const root = document.querySelector('.transcript-study-layout') as HTMLElement;
		document.documentElement.style.setProperty('--transcript-scrollbar-width', '15px');
		const switcher = createTranscriptLayoutSwitcher({
			doc: document,
			root,
			initialMode: 'reading',
			groupLabel: 'Transcript layout',
			labels: { reading: 'Reading', notebook: 'Notebook', focus: 'Focus' }
		});
		switcher.setMode('focus');
		(switcher.element.querySelector('[data-transcript-layout="notebook"]') as HTMLButtonElement).click();
		expect(document.documentElement.style.getPropertyValue('--transcript-scrollbar-width')).toBe('15px');
		document.documentElement.style.removeProperty('--transcript-scrollbar-width');
	});

	test('falls back to reading for unsupported stored values', () => {
		expect(normalizeTranscriptLayoutMode('focus')).toBe('focus');
		expect(normalizeTranscriptLayoutMode('unsupported')).toBe('reading');
		expect(normalizeTranscriptLayoutMode(undefined)).toBe('reading');
	});
});

describe('transcript toolbar layout', () => {
	// A small flex-wrap model of the toolbar: items take their width for the toolbar's classes and
	// wrap onto a new row when they reach its end, as the real row would.
	const WIDTHS = {
		switcher: { full: 250, short: 190 },
		primary: { full: 320, short: 200 },
		pill: { full: 380, compact: 290, minimal: 220, tight: 150 },
		more: 32
	};
	const setup = (toolbarWidth: number, running: boolean) => {
		document.body.innerHTML = `
			<div class="player-toggles" style="padding: 0">
				<div class="transcript-layout-switcher"><button data-transcript-layout="reading">Reading</button></div>
				<span class="player-controls-divider"></span>
				<div class="player-primary-actions"><button>Bilingual subtitles</button><button>Japanese readings</button></div>
				<div class="player-learning-task"${running ? '' : ' hidden'}><span class="player-learning-task-estimate"></span><button>Cancel</button></div>
				<details class="player-controls-more"><summary>More</summary></details>
			</div>`;
		const toolbar = document.querySelector('.player-toggles') as HTMLElement;
		const item = (selector: string) => toolbar.querySelector(selector) as HTMLElement;
		const switcher = item(':scope > .transcript-layout-switcher');
		const divider = item(':scope > .player-controls-divider');
		const primary = item(':scope > .player-primary-actions');
		const pill = item(':scope > .player-learning-task');
		const summary = item('summary');
		const layout = () => {
			const has = (name: string) => toolbar.classList.contains(name);
			const short = has('is-short-labels');
			const width = new Map<HTMLElement, number>([
				[switcher, short ? WIDTHS.switcher.short : WIDTHS.switcher.full],
				[divider, has('is-controls-stacked') ? 0 : 1],
				[primary, short ? WIDTHS.primary.short : WIDTHS.primary.full],
				[pill, pill.hidden ? 0 : has('is-task-tight') ? WIDTHS.pill.tight
					: has('is-task-minimal') ? WIDTHS.pill.minimal
					: has('is-task-compact') ? WIDTHS.pill.compact : WIDTHS.pill.full],
				[summary, WIDTHS.more]
			]);
			// Row items in visual order: a stacked toolbar puts More beside the switcher, then the
			// toggles, then the pill; a pill row comes after the controls.
			const ownRow = new Set<HTMLElement>();
			let order = [switcher, divider, primary, pill, summary];
			if (has('is-controls-stacked')) {
				order = [switcher, summary, primary, pill];
				ownRow.add(primary).add(pill);
			} else if (has('is-task-row')) {
				order = [switcher, divider, primary, summary, pill];
				ownRow.add(pill);
			}
			const rects = new Map<HTMLElement, DOMRect>();
			let x = 0;
			let row = 0;
			order.forEach(element => {
				const w = width.get(element) || 0;
				if (w === 0) {
					rects.set(element, new DOMRect(0, 0, 0, 0));
					return;
				}
				if ((ownRow.has(element) && x > 0) || (x > 0 && x + w > toolbarWidth)) {
					row++;
					x = 0;
				}
				rects.set(element, new DOMRect(x, row * 40, w, 32));
				x = ownRow.has(element) ? toolbarWidth : x + w;
			});
			return rects;
		};
		[switcher, divider, primary, pill, summary].forEach(element => {
			element.getBoundingClientRect = () => layout().get(element) ?? new DOMRect(0, 0, 0, 0);
		});
		const inner = (parent: HTMLElement) => () => parent.getBoundingClientRect();
		primary.querySelectorAll<HTMLElement>(':scope > *').forEach(child => { child.getBoundingClientRect = inner(primary); });
		pill.querySelectorAll<HTMLElement>(':scope > *').forEach(child => { child.getBoundingClientRect = inner(pill); });
		toolbar.getBoundingClientRect = () => new DOMRect(0, 0, toolbarWidth, 48);
		return { toolbar, pill };
	};
	const classes = (toolbar: HTMLElement) => Array.from(toolbar.classList).filter(name => name !== 'player-toggles');

	test('keeps full labels on one row when everything fits', () => {
		const { toolbar } = setup(1000, true);
		syncTranscriptToolbarLayout(toolbar);
		expect(classes(toolbar)).toEqual([]);
	});

	test('idle, it shortens the labels before it would wrap, and stacks only as a last resort', () => {
		const { toolbar } = setup(560, false);
		syncTranscriptToolbarLayout(toolbar);
		expect(classes(toolbar)).toEqual(['is-short-labels']);

		const narrow = setup(300, false);
		syncTranscriptToolbarLayout(narrow.toolbar);
		expect(classes(narrow.toolbar)).toEqual(['is-short-labels', 'is-controls-stacked']);
	});

	test('running, the pill drops its engine, its bar, then its phase, then takes its own row', () => {
		const steps: Array<[number, string[]]> = [
			[1000, []],
			[820, ['is-short-labels']],
			[720, ['is-short-labels', 'is-task-compact']],
			[650, ['is-short-labels', 'is-task-minimal']],
			[580, ['is-short-labels', 'is-task-tight']],
			[460, ['is-short-labels', 'is-task-row']],
			[300, ['is-short-labels', 'is-controls-stacked']]
		];
		for (const [width, expected] of steps) {
			const { toolbar } = setup(width, true);
			syncTranscriptToolbarLayout(toolbar);
			expect([width, classes(toolbar)]).toEqual([width, expected]);
		}
	});

	test('refits when the pill shows and hides', () => {
		const { toolbar, pill } = setup(720, false);
		syncTranscriptToolbarLayout(toolbar);
		expect(classes(toolbar)).toEqual([]);
		pill.hidden = false;
		syncTranscriptToolbarLayout(toolbar);
		expect(classes(toolbar)).toEqual(['is-short-labels', 'is-task-compact']);
		pill.hidden = true;
		syncTranscriptToolbarLayout(toolbar);
		expect(classes(toolbar)).toEqual([]);
	});

	test('an unchanged toolbar keeps its fit without measuring the steps again', () => {
		const { toolbar, pill } = setup(720, true);
		const count = pill.querySelector('.player-learning-task-estimate') as HTMLElement;
		const summary = toolbar.querySelector('summary') as HTMLElement;
		const measure = vi.spyOn(summary, 'getBoundingClientRect');
		count.textContent = '1 / 33';
		syncTranscriptToolbarLayout(toolbar);
		expect(classes(toolbar)).toEqual(['is-short-labels', 'is-task-compact']);
		expect(measure).toHaveBeenCalled();

		// A progress report that changes a digit, or a toolbar that only grew taller, is no change.
		measure.mockClear();
		count.textContent = '2 / 33';
		toolbar.getBoundingClientRect = () => new DOMRect(0, 0, 720, 96);
		syncTranscriptToolbarLayout(toolbar);
		expect(measure).not.toHaveBeenCalled();
		expect(classes(toolbar)).toEqual(['is-short-labels', 'is-task-compact']);

		// A longer count, a new label, or the pill hiding refits.
		count.textContent = '10 / 33';
		syncTranscriptToolbarLayout(toolbar);
		expect(measure).toHaveBeenCalled();
		measure.mockClear();
		(toolbar.querySelector('.player-primary-actions > button') as HTMLElement).textContent = 'Show player';
		syncTranscriptToolbarLayout(toolbar);
		expect(measure).toHaveBeenCalled();
		measure.mockClear();
		pill.hidden = true;
		syncTranscriptToolbarLayout(toolbar);
		expect(measure).toHaveBeenCalled();
		expect(classes(toolbar)).toEqual([]);
	});

	test('leaves the Study tools rail, and a toolbar that is not laid out, as they are', () => {
		const rail = setup(200, true);
		rail.toolbar.style.display = 'flex';
		rail.toolbar.style.flexDirection = 'column';
		rail.toolbar.classList.add('is-short-labels');
		syncTranscriptToolbarLayout(rail.toolbar);
		expect(classes(rail.toolbar)).toEqual([]);

		const hidden = setup(400, true);
		hidden.toolbar.classList.add('is-short-labels', 'is-task-row');
		hidden.toolbar.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
		syncTranscriptToolbarLayout(hidden.toolbar);
		expect(classes(hidden.toolbar)).toEqual(['is-short-labels', 'is-task-row']);
	});
});

describe('transcript controls panel', () => {
	test('open off a phone, the panel is the toolbar\'s last row; closed, it goes back into More', () => {
		document.body.innerHTML = `
			<section class="transcript-study-layout">
				<div class="player-toggles">
					<details class="player-controls-more"><summary>More</summary><div class="player-controls-panel"></div></details>
				</div>
			</section>`;
		const root = document.querySelector('.transcript-study-layout') as HTMLElement;
		const controls = root.querySelector('.player-toggles') as HTMLElement;
		const details = root.querySelector('details') as HTMLDetailsElement;
		const panel = root.querySelector('.player-controls-panel') as HTMLElement;
		const sync = (isMobile: boolean) => syncTranscriptControlsPanel({ doc: document, root, details, panel, controls, isMobile });

		details.open = true;
		sync(false);
		expect(panel.parentElement).toBe(controls);
		expect(controls.lastElementChild).toBe(panel);
		expect(details.querySelector('summary')?.getAttribute('aria-expanded')).toBe('true');

		sync(true);
		expect(panel.parentElement).toBe(root);

		details.open = false;
		sync(false);
		expect(panel.parentElement).toBe(details);
		expect(root.classList.contains('is-controls-open')).toBe(false);
	});
});
