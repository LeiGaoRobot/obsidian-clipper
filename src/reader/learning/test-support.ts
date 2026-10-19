import { vi } from 'vitest';

// Shared DOM fixtures for the Reader transcript learning tests.

export function createTranscript(texts = ['Hello world.']) {
	document.body.innerHTML = `
		<div class="player-toggle-group"></div>
		<div class="youtube transcript">
			${texts.map((text, index) => `
				<div class="transcript-segment">
					<strong class="timestamp" data-timestamp="${index * 200}">${index}:00</strong>
					<div class="transcript-segment-text">${text}</div>
				</div>
			`).join('')}
		</div>
	`;
	return {
		controls: document.querySelector('.player-toggle-group') as HTMLElement,
		transcript: document.querySelector('.youtube.transcript') as HTMLElement,
		segments: Array.from(document.querySelectorAll('.transcript-segment')) as HTMLElement[]
	};
}

export function selectText(startNode: Node, start: number, endNode: Node, end: number) {
	const range = document.createRange();
	range.setStart(startNode, start);
	range.setEnd(endNode, end);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
}

/**
 * Page-DOM controls reject synthetic events, so a test records every click listener added while
 * it runs and invokes an element's listeners with a trusted-looking event, the only way a user
 * click can reach them.
 */
export function captureTrustedClicks() {
	const listeners = new Map<EventTarget, EventListener[]>();
	const original = HTMLElement.prototype.addEventListener;
	const spy = vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (
		this: HTMLElement,
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions
	) {
		if (type === 'click' && typeof listener === 'function') {
			listeners.set(this, [...(listeners.get(this) ?? []), listener]);
		}
		return original.call(this, type, listener, options);
	});
	return {
		restore: () => spy.mockRestore(),
		click: async (element: Element | null) => {
			if (!element) throw new Error('Missing element to click');
			const event = {
				isTrusted: true,
				target: element,
				currentTarget: element,
				preventDefault() {},
				stopPropagation() {}
			} as unknown as Event;
			await Promise.all((listeners.get(element) ?? []).map(listener => listener(event)));
		}
	};
}

export async function flushPromises() {
	for (let index = 0; index < 5; index++) await Promise.resolve();
}
