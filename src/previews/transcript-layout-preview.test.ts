// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from 'vitest';
import { setTranscriptPreviewLayout } from './transcript-layout-preview';

describe('transcript layout preview', () => {
	beforeEach(() => {
		document.documentElement.className = '';
		document.documentElement.removeAttribute('data-preview-layout');
		document.body.innerHTML = `
			<section class="transcript-study-layout transcript-layout-focus">
				<div class="player-container"></div>
				<div class="player-toggles">
					<button data-transcript-layout="reading" aria-pressed="false">Reading</button>
					<button data-transcript-layout="notebook" aria-pressed="false">Study tools</button>
					<button data-transcript-layout="focus" aria-pressed="true">Split view</button>
				</div>
				<div class="youtube transcript"></div>
			</section>
		`;
	});

	test.each(['reading', 'notebook', 'focus'] as const)(
		'exposes the %s layout for deterministic screenshots',
		(mode) => {
			const player = document.querySelector('.player-container') as HTMLElement;
			player.getBoundingClientRect = () => ({ height: 321.2 } as DOMRect);
			setTranscriptPreviewLayout(document, mode);

			const root = document.querySelector('.transcript-study-layout') as HTMLElement;
			const controls = root.querySelector('.player-toggles') as HTMLElement;

			expect(root.classList.contains(`transcript-layout-${mode}`)).toBe(true);
			expect(document.documentElement.classList.contains(`transcript-layout-${mode}`)).toBe(true);
			expect(document.documentElement.dataset.previewLayout).toBe(mode);
			expect(root.style.getPropertyValue('--transcript-player-height')).toBe('322px');
			expect(root.querySelector(`[data-transcript-layout="${mode}"]`)?.getAttribute('aria-pressed')).toBe('true');
			expect(player.contains(controls)).toBe(mode === 'reading');
		}
	);
});
