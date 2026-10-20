// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from 'vitest';
import { refreshPromptChips, unfilledPrompts } from './prompt-chips';

const getMessage = (key: string) => key;

// The popup's property markup; values are set as properties, as the popup fills them.
function property(name: string, type = 'text'): string {
	return `<div class="metadata-property"><div class="metadata-property-value"><input id="${name}" type="${type}"></div></div>`;
}

function setUp(properties: Array<[string, string, string?]>): void {
	document.body.innerHTML = `<div class="metadata-properties">${properties.map(([name, , type]) => property(name, type)).join('')}</div>`;
	for (const [name, value] of properties) {
		const input = document.getElementById(name) as HTMLInputElement;
		if (input.type === 'checkbox') input.checked = value === 'true';
		else input.value = value;
	}
}

/** What a Clip reads: every property input's value, as `getPropertiesFromDOM` does. */
function savedValues(): Array<[string, string | boolean]> {
	return Array.from(document.querySelectorAll<HTMLInputElement>('.metadata-property input'),
		input => [input.id, input.type === 'checkbox' ? input.checked : input.value]);
}

function chipFor(name: string): HTMLButtonElement | null {
	return document.getElementById(name)?.parentElement?.querySelector('.ai-prompt-chip') ?? null;
}

describe('prompt chips', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	test('lists the prompts a value still holds', () => {
		expect(unfilledPrompts('{{"a summary"}} and {{prompt:"tags"|lower}}')).toEqual(['a summary', 'tags']);
		expect(unfilledPrompts('{{title}} plain text')).toEqual([]);
	});

	test('shows a chip with the prompt as its tooltip in place of a raw prompt', () => {
		setUp([['summary', '{{"a one-sentence summary"}}'], ['source', 'https://example.com']]);

		refreshPromptChips(document, { getMessage });

		const chip = chipFor('summary')!;
		expect(chip).not.toBeNull();
		expect(chip.type).toBe('button');
		expect(chip.textContent).toContain('aiPromptChip');
		expect(chip.title).toBe('a one-sentence summary');
		expect(chip.dataset.state).toBe('idle');
		expect((document.getElementById('summary') as HTMLInputElement).hidden).toBe(true);
		// A plain value keeps its input.
		expect(chipFor('source')).toBeNull();
		expect((document.getElementById('source') as HTMLInputElement).hidden).toBe(false);
	});

	test('what a Clip saves is the same with chips shown', () => {
		const properties: Array<[string, string, string?]> = [
			['summary', '{{"a summary"|lower}}'],
			['mixed', 'Topic: {{"the topic"}} ({{"tags"}})'],
			['done', 'true', 'checkbox']
		];
		setUp(properties);
		const before = savedValues();

		refreshPromptChips(document, { getMessage });
		refreshPromptChips(document, { getMessage, state: 'running' });

		expect(savedValues()).toEqual(before);
		expect(chipFor('mixed')?.title).toBe('the topic\ntags');
		expect(chipFor('done')).toBeNull();
	});

	test('clicking the chip reveals the original editable input, which stays revealed', () => {
		setUp([['summary', '{{"a summary"}}']]);
		refreshPromptChips(document, { getMessage });
		const input = document.getElementById('summary') as HTMLInputElement;

		chipFor('summary')!.click();

		expect(chipFor('summary')).toBeNull();
		expect(input.hidden).toBe(false);
		expect(input.value).toBe('{{"a summary"}}');
		expect(document.activeElement).toBe(input);

		refreshPromptChips(document, { getMessage, state: 'failed' });
		expect(chipFor('summary')).toBeNull();
		expect(input.hidden).toBe(false);
	});

	test('a filled value drops the chip and shows the value', () => {
		setUp([['summary', '{{"a summary"}}']]);
		refreshPromptChips(document, { getMessage });
		const input = document.getElementById('summary') as HTMLInputElement;

		input.value = 'Tidal energy is reliable.';
		refreshPromptChips(document, { getMessage });

		expect(chipFor('summary')).toBeNull();
		expect(input.hidden).toBe(false);
	});

	test('the chip label follows the run state, reusing one chip', () => {
		setUp([['summary', '{{"a summary"}}']]);
		refreshPromptChips(document, { getMessage });
		const chip = chipFor('summary');

		refreshPromptChips(document, { getMessage, state: 'running' });
		expect(chipFor('summary')).toBe(chip);
		expect(chip?.textContent).toContain('aiPromptChipRunning');

		refreshPromptChips(document, { getMessage, state: 'failed' });
		expect(chip?.dataset.state).toBe('failed');
		expect(chip?.textContent).toContain('aiPromptChipNotFilled');
		expect(document.querySelectorAll('.ai-prompt-chip')).toHaveLength(1);
	});
});
