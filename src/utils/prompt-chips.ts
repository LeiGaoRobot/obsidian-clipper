import { createPromptVariableRegex } from './prompt-variables';

// Popup property values that still hold an Interpreter prompt (`{{"…"}}`) show a compact chip in
// place of the raw prompt. Display only: the input stays in the DOM with its value untouched, so
// what a Clip saves is the same with or without chips. DOM only, no storage or browser imports.

/** `idle`: waiting for a run; `running`: a run is filling it; `failed`: the run left it unfilled. */
export type PromptChipState = 'idle' | 'running' | 'failed';

export interface PromptChipOptions {
	getMessage: (key: string, substitutions?: string | string[]) => string;
	state?: PromptChipState;
}

function chipLabel(state: PromptChipState, getMessage: PromptChipOptions['getMessage']): string {
	switch (state) {
		case 'running': return getMessage('aiPromptChipRunning');
		case 'failed': return getMessage('aiPromptChipNotFilled');
		default: return getMessage('aiPromptChip');
	}
}

/** The prompt texts `value` still holds, in order. */
export function unfilledPrompts(value: string): string[] {
	const regex = createPromptVariableRegex();
	const prompts: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = regex.exec(value)) !== null) prompts.push(match[1]);
	return prompts;
}

/** Shows the input again for editing; it keeps showing raw text from then on. */
function reveal(input: HTMLInputElement, chip: HTMLElement): void {
	input.dataset.promptRevealed = 'true';
	input.hidden = false;
	chip.remove();
	input.focus();
}

function syncPromptChip(input: HTMLInputElement, options: PromptChipOptions): void {
	const container = input.parentElement;
	if (!container) return;
	const doc = input.ownerDocument;
	let chip = container.querySelector<HTMLButtonElement>(':scope > .ai-prompt-chip');
	const prompts = unfilledPrompts(input.value);
	if (prompts.length === 0 || input.dataset.promptRevealed === 'true') {
		chip?.remove();
		input.hidden = false;
		return;
	}
	if (!chip) {
		chip = doc.createElement('button');
		chip.type = 'button';
		chip.className = 'ai-prompt-chip';
		const mark = doc.createElement('span');
		mark.className = 'ai-prompt-chip-mark';
		mark.setAttribute('aria-hidden', 'true');
		mark.textContent = '✦';
		const label = doc.createElement('span');
		label.className = 'ai-prompt-chip-label';
		chip.append(mark, label);
		const owner = chip;
		chip.addEventListener('click', () => reveal(input, owner));
		container.insertBefore(chip, input);
	}
	const state = options.state ?? 'idle';
	chip.dataset.state = state;
	const label = chip.querySelector('.ai-prompt-chip-label');
	const text = chipLabel(state, options.getMessage);
	if (label) label.textContent = text;
	// The row's label names the hidden input, so the chip carries the property name itself.
	const name = container.parentElement?.querySelector('.metadata-property-key label')?.textContent?.trim();
	if (name) chip.setAttribute('aria-label', options.getMessage('aiPromptChipName', [name, text]));
	else chip.removeAttribute('aria-label');
	chip.title = prompts.join('\n');
	input.hidden = true;
}

/**
 * Brings every popup property's chip in line with its input's value: a chip while it still holds a
 * prompt (unless the user revealed it), the plain input once it does not.
 */
export function refreshPromptChips(root: ParentNode, options: PromptChipOptions): void {
	root.querySelectorAll<HTMLInputElement>('.metadata-property-value > input[type="text"]')
		.forEach(input => syncPromptChip(input, options));
}
