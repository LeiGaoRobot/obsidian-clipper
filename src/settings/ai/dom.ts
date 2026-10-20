import { initializeIcons } from '../../icons/icons';
import { initializeToggles, updateToggleState } from '../../utils/ui-utils';

// Small DOM helpers shared by the AI settings panels. Panels build their content imperatively
// into static containers in settings.html; text always goes through `textContent`.

export function createElement<K extends keyof HTMLElementTagNameMap>(
	doc: Document,
	tag: K,
	className?: string,
	text?: string
): HTMLElementTagNameMap[K] {
	const element = doc.createElement(tag);
	if (className) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

/** A Lucide placeholder; `renderIcons` turns it into an SVG. */
export function createIcon(doc: Document, name: string): HTMLElement {
	const icon = doc.createElement('i');
	icon.setAttribute('data-lucide', name);
	icon.setAttribute('aria-hidden', 'true');
	return icon;
}

export function createIconButton(doc: Document, iconName: string, label: string, className: string): HTMLButtonElement {
	const button = createElement(doc, 'button', `clickable-icon ${className}`);
	button.type = 'button';
	button.setAttribute('aria-label', label);
	button.title = label;
	button.appendChild(createIcon(doc, iconName));
	return button;
}

export function createTextButton(doc: Document, label: string, className = ''): HTMLButtonElement {
	const button = createElement(doc, 'button', className, label);
	button.type = 'button';
	return button;
}

/** A `+ Add …` link styled like the rest of Settings. */
export function createAddLink(doc: Document, label: string, id?: string): { container: HTMLElement; link: HTMLAnchorElement } {
	const container = createElement(doc, 'div', 'add-btn');
	const link = createElement(doc, 'a', undefined, label);
	link.setAttribute('role', 'button');
	link.tabIndex = 0;
	if (id) link.id = id;
	link.addEventListener('keydown', event => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			link.click();
		}
	});
	container.appendChild(link);
	return { container, link };
}

export interface SettingItemParts {
	item: HTMLElement;
	info: HTMLElement;
	control: HTMLElement;
	label: HTMLLabelElement;
	description: HTMLElement;
}

/** A `.setting-item.mod-horizontal` row with a label, a description, and a control slot. */
export function createSettingItem(
	doc: Document,
	options: { label: string; description?: string; forId?: string; toggle?: boolean }
): SettingItemParts {
	const item = createElement(doc, 'div', `setting-item mod-horizontal${options.toggle ? ' mod-toggle' : ''}`);
	const info = createElement(doc, 'div', 'setting-item-info');
	const label = createElement(doc, 'label', undefined, options.label);
	if (options.forId) label.htmlFor = options.forId;
	const description = createElement(doc, 'div', 'setting-item-description', options.description ?? '');
	info.append(label, description);
	const control = createElement(doc, 'div', 'setting-item-control');
	item.append(info, control);
	return { item, info, control, label, description };
}

/** A checkbox inside the `.checkbox-container` toggle used across Settings. */
export function createToggle(doc: Document, id: string, checked: boolean, small = false): {
	container: HTMLElement;
	input: HTMLInputElement;
} {
	const container = createElement(doc, 'div', `checkbox-container${small ? ' mod-small' : ''}`);
	const input = createElement(doc, 'input');
	input.type = 'checkbox';
	input.id = id;
	input.checked = checked;
	container.appendChild(input);
	return { container, input };
}

/** Updates a toggle's look after its checkbox was set from code. */
export function syncToggle(input: HTMLInputElement): void {
	const container = input.closest('.checkbox-container');
	if (container) updateToggleState(container as HTMLElement, input);
}

/** Wires toggles and icons inside a freshly rendered subtree. */
export function finishRender(root: HTMLElement): void {
	initializeToggles(root);
	if (root.querySelector('[data-lucide]')) initializeIcons(root);
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): {
	(...args: A): void;
	flush(): void;
	cancel(): void;
	/** Whether a call is waiting for the timer. */
	pending(): boolean;
} {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: A | undefined;
	const run = () => {
		timer = undefined;
		const args = pending;
		pending = undefined;
		if (args) fn(...args);
	};
	const debounced = (...args: A) => {
		pending = args;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(run, waitMs);
	};
	debounced.flush = () => {
		if (timer !== undefined) clearTimeout(timer);
		run();
	};
	debounced.cancel = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		pending = undefined;
	};
	debounced.pending = () => pending !== undefined;
	return debounced;
}

/** Whether the element (or something inside it) has keyboard focus, so a re-render can skip it. */
export function hasFocus(element: Element | null): boolean {
	const active = element?.ownerDocument.activeElement;
	return !!element && !!active && (element === active || element.contains(active));
}
