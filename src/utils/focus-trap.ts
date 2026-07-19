const FOCUSABLE_SELECTOR = [
	'a[href]',
	'button:not([disabled]):not([tabindex="-1"])',
	'input:not([disabled]):not([tabindex="-1"])',
	'select:not([disabled]):not([tabindex="-1"])',
	'textarea:not([disabled]):not([tabindex="-1"])',
	'summary',
	'[contenteditable="true"]',
	'[tabindex]:not([tabindex="-1"])'
].join(',');

function isFocusable(element: HTMLElement): boolean {
	if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
	const closedDetails = element.closest('details:not([open])');
	if (closedDetails) {
		const summary = closedDetails.querySelector(':scope > summary');
		if (!summary?.contains(element)) return false;
	}
	return true;
}

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
		.filter(isFocusable);
}

export function trapFocus(event: KeyboardEvent, container: HTMLElement): boolean {
	if (event.key !== 'Tab') return false;
	const focusable = getFocusableElements(container);
	if (focusable.length === 0) {
		event.preventDefault();
		container.focus();
		return true;
	}

	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	const active = container.ownerDocument.activeElement;
	if (event.shiftKey && (active === first || !container.contains(active))) {
		event.preventDefault();
		last.focus();
		return true;
	}
	if (!event.shiftKey && (active === last || !container.contains(active))) {
		event.preventDefault();
		first.focus();
		return true;
	}
	return false;
}
