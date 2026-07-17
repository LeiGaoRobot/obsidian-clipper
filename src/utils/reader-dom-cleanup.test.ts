// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import { cloneBodyIfSafe } from './reader-dom-cleanup';

describe('cloneBodyIfSafe', () => {
	test('keeps the live document when it contains a sandboxed iframe', () => {
		document.body.innerHTML = `
			<main>
				<button id="ordinary-element">Reader content</button>
				<iframe id="player" sandbox src="about:blank"></iframe>
			</main>
		`;

		const iframe = document.querySelector('#player');
		const ordinaryElement = document.querySelector('#ordinary-element');
		const originalBody = document.body;

		expect(cloneBodyIfSafe(document)).toBe(false);

		expect(document.body).toBe(originalBody);
		expect(document.querySelector('#player')).toBe(iframe);
		expect(document.querySelector('#player')?.hasAttribute('sandbox')).toBe(true);
		expect(document.querySelector('#ordinary-element')).toBe(ordinaryElement);
	});

	test('clones the body when no live iframe needs to be preserved', () => {
		document.body.innerHTML = '<button id="ordinary-element">Reader content</button>';
		const originalBody = document.body;
		const ordinaryElement = document.querySelector('#ordinary-element');

		expect(cloneBodyIfSafe(document)).toBe(true);

		expect(document.body).not.toBe(originalBody);
		expect(document.querySelector('#ordinary-element')).not.toBe(ordinaryElement);
	});
});
