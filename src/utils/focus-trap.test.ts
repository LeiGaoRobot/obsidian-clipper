// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { getFocusableElements, trapFocus } from './focus-trap';

describe('Focus trap', () => {
	test('includes a closed details summary but skips its hidden controls', () => {
		document.body.innerHTML = `
			<div id="dialog" tabindex="-1">
				<button id="first">First</button>
				<details>
					<summary id="summary">Study</summary>
					<button id="hidden-control">Hidden control</button>
				</details>
			</div>
		`;
		const dialog = document.querySelector('#dialog') as HTMLElement;
		const first = document.querySelector('#first') as HTMLButtonElement;
		const summary = document.querySelector('#summary') as HTMLElement;

		expect(getFocusableElements(dialog)).toEqual([first, summary]);
		summary.focus();
		const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
		expect(trapFocus(event, dialog)).toBe(true);
		expect(document.activeElement).toBe(first);
	});
});
