// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { describeAiError, type AiErrorDescription } from '../error-messages';
import { AiError } from '../errors';
import { clearAiErrorCard, renderAiErrorCard } from './error-card';

function container(): HTMLElement {
	const element = document.createElement('div');
	element.hidden = true;
	document.body.appendChild(element);
	return element;
}

function actions(root: HTMLElement): string[] {
	return Array.from(root.querySelectorAll<HTMLButtonElement>('.ai-error-card-action')).map(button => button.textContent ?? '');
}

const timeout: AiErrorDescription = {
	title: 'The model took too long',
	body: 'Try again in a moment.',
	action: 'retry',
	detail: 'No response for 60 seconds.'
};

beforeEach(() => {
	document.body.replaceChildren();
});

describe('renderAiErrorCard', () => {
	test('renders the title, body and a collapsed technical detail from a description', () => {
		const root = container();
		const card = renderAiErrorCard(root, timeout);

		expect(root.hidden).toBe(false);
		expect(root.firstElementChild).toBe(card);
		expect(card.getAttribute('role')).toBe('alert');
		expect(card.querySelector('.ai-error-card-title')?.textContent).toBe('The model took too long');
		expect(card.querySelector('.ai-error-card-body')?.textContent).toBe('Try again in a moment.');
		const details = card.querySelector('details.ai-error-card-detail') as HTMLDetailsElement;
		expect(details.open).toBe(false);
		expect(details.querySelector('summary')?.textContent).toBe('Technical details');
		expect(details.querySelector('code')?.textContent).toBe('No response for 60 seconds.');
		// No handlers, no icon option, no dismiss: no controls and no icon slot.
		expect(card.querySelector('.ai-error-card-actions')).toBeNull();
		expect(card.querySelector('.ai-error-card-icon')).toBeNull();
		expect(card.querySelector('.ai-error-card-dismiss')).toBeNull();
	});

	test('renders a description of a real AiError without a detail disclosure when there is none', () => {
		const card = renderAiErrorCard(container(), describeAiError(new AiError('rate-limited')));
		expect(card.querySelector('.ai-error-card-title')?.textContent).toBe(describeAiError(new AiError('rate-limited')).title);
		expect(card.querySelector('.ai-error-card-detail')).toBeNull();
	});

	test('replaces what the container held', () => {
		const root = container();
		renderAiErrorCard(root, timeout);
		renderAiErrorCard(root, { ...timeout, title: 'Second' });
		expect(root.querySelectorAll('.ai-error-card')).toHaveLength(1);
		expect(root.querySelector('.ai-error-card-title')?.textContent).toBe('Second');
	});

	test('the primary button follows the description\'s action', () => {
		const retry = vi.fn();
		const openSettings = vi.fn();
		const root = container();
		renderAiErrorCard(root, timeout, { handlers: { retry, openSettings } });
		expect(actions(root)).toEqual(['Try again']);

		(root.querySelector('.ai-error-card-action') as HTMLButtonElement).click();
		expect(retry).toHaveBeenCalledOnce();
		expect(retry.mock.calls[0][0]).toBeInstanceOf(Event);
		expect(openSettings).not.toHaveBeenCalled();
	});

	test('retry is rendered as a secondary button after the primary for auth', () => {
		const retry = vi.fn();
		const openSettings = vi.fn();
		const root = container();
		renderAiErrorCard(root, describeAiError(new AiError('auth', { status: 401 })), { handlers: { retry, openSettings } });

		expect(actions(root)).toEqual(['Open AI settings', 'Try again']);
		const [primary, secondary] = Array.from(root.querySelectorAll<HTMLButtonElement>('.ai-error-card-action'));
		expect(primary.dataset.action).toBe('openSettings');
		expect(secondary.dataset.action).toBe('retry');
		primary.click();
		expect(openSettings).toHaveBeenCalledOnce();
		secondary.click();
		expect(retry).toHaveBeenCalledOnce();
	});

	test('an action without a handler is not rendered', () => {
		const root = container();
		renderAiErrorCard(root, describeAiError(new AiError('auth')), { handlers: {} });
		expect(actions(root)).toEqual([]);
		renderAiErrorCard(root, describeAiError(new AiError('auth')), { handlers: { retry: vi.fn() } });
		expect(actions(root)).toEqual(['Try again']);
	});

	test('continueRemaining uses the retry handler, labelled with the counts once work is done', () => {
		const retry = vi.fn();
		const root = container();
		const incomplete = describeAiError(new AiError('incomplete'));
		expect(incomplete.action).toBe('continueRemaining');

		renderAiErrorCard(root, incomplete, { handlers: { retry }, progress: { completed: 3, total: 8 } });
		expect(actions(root)).toEqual(['Continue remaining (3/8 complete)']);
		(root.querySelector('.ai-error-card-action') as HTMLButtonElement).click();
		expect(retry).toHaveBeenCalledOnce();

		renderAiErrorCard(root, incomplete, { handlers: { retry }, progress: { completed: 0, total: 8 } });
		expect(actions(root)).toEqual(['Try again']);
		// Progress relabels a plain retry too, e.g. a timeout after some groups finished.
		renderAiErrorCard(root, timeout, { handlers: { retry }, progress: { completed: 1, total: 2 } });
		expect(actions(root)).toEqual(['Continue remaining (1/2 complete)']);
	});

	test('switchProfile with profiles renders a select that preselects the failed profile', () => {
		const switchProfile = vi.fn();
		const retry = vi.fn();
		const root = container();
		const profiles = [{ id: 'gpt', label: 'OpenAI · gpt-5' }, { id: 'codex', label: 'Codex CLI' }];
		renderAiErrorCard(root, describeAiError(new AiError('quota')), {
			handlers: { switchProfile, retry },
			profiles,
			selectedProfileId: 'codex'
		});

		const select = root.querySelector('select.ai-error-card-profile-select') as HTMLSelectElement;
		expect(select.getAttribute('aria-label')).toBe('Model to retry with');
		expect(Array.from(select.options).map(option => [option.value, option.textContent])).toEqual([
			['gpt', 'OpenAI · gpt-5'],
			['codex', 'Codex CLI']
		]);
		expect(select.value).toBe('codex');
		// The switch leads for a switchProfile error; Retry follows.
		expect(actions(root)).toEqual(['Switch and retry', 'Try again']);
		expect(root.querySelector('.ai-error-card-actions')?.firstElementChild?.classList.contains('ai-error-card-switch')).toBe(true);

		select.value = 'gpt';
		(root.querySelector('[data-action="switchProfile"]') as HTMLButtonElement).click();
		expect(switchProfile).toHaveBeenCalledWith(expect.any(Event), 'gpt');
		expect(retry).not.toHaveBeenCalled();
	});

	test('profiles with a group are listed under it, in order', () => {
		const root = container();
		renderAiErrorCard(root, describeAiError(new AiError('quota')), {
			handlers: { switchProfile: vi.fn() },
			profiles: [
				{ id: 'fast', label: 'Fast', group: 'OpenAI' },
				{ id: 'large', label: 'Large', group: 'OpenAI' },
				{ id: 'codex', label: 'Codex CLI', group: 'Codex CLI' }
			],
			selectedProfileId: 'large'
		});

		const select = root.querySelector('select') as HTMLSelectElement;
		expect(Array.from(select.children, child => [
			child.tagName,
			(child as HTMLOptGroupElement).label,
			Array.from(child.querySelectorAll('option'), option => [option.value, option.textContent])
		])).toEqual([
			['OPTGROUP', 'OpenAI', [['fast', 'Fast'], ['large', 'Large']]],
			['OPTGROUP', 'Codex CLI', [['codex', 'Codex CLI']]]
		]);
		expect(select.value).toBe('large');
	});

	test('the select falls back to the first profile and follows the primary for other actions', () => {
		const root = container();
		renderAiErrorCard(root, timeout, {
			handlers: { retry: vi.fn(), switchProfile: vi.fn() },
			profiles: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
			selectedProfileId: 'gone'
		});
		expect((root.querySelector('select') as HTMLSelectElement).value).toBe('a');
		expect(actions(root)).toEqual(['Try again', 'Switch and retry']);
	});

	test('switchProfile without profiles is a plain button, and only for a switchProfile error', () => {
		const switchProfile = vi.fn();
		const root = container();
		renderAiErrorCard(root, describeAiError(new AiError('model-unavailable')), { handlers: { switchProfile } });
		expect(root.querySelector('select')).toBeNull();
		expect(actions(root)).toEqual(['Choose another model']);
		(root.querySelector('.ai-error-card-action') as HTMLButtonElement).click();
		expect(switchProfile).toHaveBeenCalledOnce();

		renderAiErrorCard(root, timeout, { handlers: { switchProfile } });
		expect(actions(root)).toEqual([]);
	});

	test('openSettings renders Open AI settings', () => {
		const openSettings = vi.fn();
		const root = container();
		renderAiErrorCard(root, describeAiError(new AiError('not-configured', { reason: 'disabled' })), { handlers: { openSettings } });
		expect(actions(root)).toEqual(['Open AI settings']);
		(root.querySelector('[data-action="openSettings"]') as HTMLButtonElement).click();
		expect(openSettings).toHaveBeenCalledOnce();
	});

	test('copyInstallCommand needs its own handler; without it the card leads to Settings', () => {
		const copyInstallCommand = vi.fn();
		const openSettings = vi.fn();
		const root = container();
		const hostMissing = describeAiError(new AiError('host-missing'));

		renderAiErrorCard(root, hostMissing, { handlers: { copyInstallCommand } });
		expect(actions(root)).toEqual(['Copy install command']);
		(root.querySelector('.ai-error-card-action') as HTMLButtonElement).click();
		expect(copyInstallCommand).toHaveBeenCalledOnce();

		renderAiErrorCard(root, hostMissing, { handlers: { openSettings } });
		expect(actions(root)).toEqual(['Open AI settings']);
	});

	test('dismiss calls onDismiss, with a text glyph unless an icon is given', () => {
		const onDismiss = vi.fn();
		const root = container();
		renderAiErrorCard(root, timeout, { onDismiss });
		const dismiss = root.querySelector('.ai-error-card-dismiss') as HTMLButtonElement;
		expect(dismiss.getAttribute('aria-label')).toBe('Close');
		expect(dismiss.textContent).toBe('×');
		dismiss.click();
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	test('the icon option fills the alert and dismiss slots', () => {
		const icon = vi.fn((name: string) => {
			const element = document.createElement('i');
			element.dataset.icon = name;
			return element;
		});
		const root = container();
		renderAiErrorCard(root, timeout, { icon, onDismiss: vi.fn() });
		expect(root.querySelector('.ai-error-card-icon i')?.getAttribute('data-icon')).toBe('alert');
		expect(root.querySelector('.ai-error-card-dismiss i')?.getAttribute('data-icon')).toBe('dismiss');
		expect(root.querySelector('.ai-error-card')?.firstElementChild?.classList.contains('ai-error-card-icon')).toBe(true);
	});

	test('builds elements in the given document', () => {
		const other = document.implementation.createHTMLDocument('host page');
		const root = other.createElement('div');
		other.body.appendChild(root);
		const card = renderAiErrorCard(root, timeout, { doc: other, handlers: { retry: vi.fn() } });
		expect(card.ownerDocument).toBe(other);
		expect(other.querySelector('.ai-error-card-action')).not.toBeNull();
	});

	test('handlers receive synthetic clicks unchanged: the trusted-click check is the caller\'s', () => {
		const retry = vi.fn();
		const root = container();
		renderAiErrorCard(root, timeout, { handlers: { retry } });
		const event = new MouseEvent('click', { bubbles: true });
		expect(event.isTrusted).toBe(false);
		root.querySelector('.ai-error-card-action')!.dispatchEvent(event);
		expect(retry).toHaveBeenCalledWith(event);
	});
});

describe('renderAiErrorCard compact variant', () => {
	const auth: AiErrorDescription = {
		title: 'API key rejected',
		body: 'Check or replace it in Settings.',
		action: 'openSettings',
		detail: 'HTTP 401: invalid key'
	};

	test('shows the source in place of the body, with Retry first and the rest behind Details', () => {
		const root = container();
		const retry = vi.fn();
		const openSettings = vi.fn();
		const card = renderAiErrorCard(root, auth, {
			variant: 'compact',
			source: 'OpenAI · GPT · HTTP 401',
			handlers: { retry, openSettings }
		});

		expect(card.classList.contains('is-compact')).toBe(true);
		expect(card.querySelector('.ai-error-card-title')?.textContent).toBe('API key rejected');
		const line = card.querySelector('.ai-error-card-body') as HTMLElement;
		expect(line.textContent).toBe('OpenAI · GPT · HTTP 401');
		expect(line.title).toBe('OpenAI · GPT · HTTP 401');
		expect(Array.from(card.querySelectorAll<HTMLElement>('.ai-error-card-action'), button => button.dataset.action))
			.toEqual(['retry', 'openSettings']);
		// No <details>: a toggle in the action row opens a panel below it.
		expect(card.querySelector('details')).toBeNull();
		const toggle = card.querySelector('.ai-error-card-details-toggle') as HTMLButtonElement;
		const panel = card.querySelector('.ai-error-card-detail') as HTMLElement;
		expect(toggle.parentElement?.classList.contains('ai-error-card-actions')).toBe(true);
		expect(toggle.textContent).toBe('Details');
		expect(toggle.getAttribute('aria-controls')).toBe(panel.id);
		expect(panel.hidden).toBe(true);
		expect(panel.querySelector('.ai-error-card-explanation')?.textContent).toBe('Check or replace it in Settings.');
		expect(panel.querySelector('code')?.textContent).toBe('HTTP 401: invalid key');

		toggle.click();
		expect(panel.hidden).toBe(false);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		toggle.click();
		expect(panel.hidden).toBe(true);

		(card.querySelector('[data-action="retry"]') as HTMLButtonElement).click();
		expect(retry).toHaveBeenCalledOnce();
	});

	test('without a source the body stays on its line, and Details holds only the raw detail', () => {
		const card = renderAiErrorCard(container(), auth, { variant: 'compact', handlers: { retry: vi.fn() } });

		expect(card.querySelector('.ai-error-card-body')?.textContent).toBe('Check or replace it in Settings.');
		const panel = card.querySelector('.ai-error-card-detail') as HTMLElement;
		expect(panel.querySelector('.ai-error-card-explanation')).toBeNull();
		expect(panel.textContent).toBe('HTTP 401: invalid key');
	});

	test('with nothing to hide there is no Details toggle', () => {
		const card = renderAiErrorCard(container(), { ...auth, detail: undefined }, { variant: 'compact', handlers: { retry: vi.fn() } });

		expect(card.querySelector('.ai-error-card-details-toggle')).toBeNull();
		expect(card.querySelector('.ai-error-card-detail')).toBeNull();
		expect(card.querySelector('.ai-error-card-actions')).not.toBeNull();
	});

	test('keeps the dismiss control', () => {
		const onDismiss = vi.fn();
		const card = renderAiErrorCard(container(), auth, { variant: 'compact', onDismiss });
		(card.querySelector('.ai-error-card-dismiss') as HTMLButtonElement).click();
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	test('the default variant is unchanged by the compact options it does not use', () => {
		const card = renderAiErrorCard(container(), auth, { source: 'ignored', handlers: { retry: vi.fn(), openSettings: vi.fn() } });

		expect(card.classList.contains('is-compact')).toBe(false);
		expect(card.querySelector('.ai-error-card-body')?.textContent).toBe('Check or replace it in Settings.');
		expect(card.querySelector('details.ai-error-card-detail')).not.toBeNull();
		expect(Array.from(card.querySelectorAll<HTMLElement>('.ai-error-card-action'), button => button.dataset.action))
			.toEqual(['openSettings', 'retry']);
	});
});

describe('clearAiErrorCard', () => {
	test('empties and hides the container', () => {
		const root = container();
		renderAiErrorCard(root, timeout);
		clearAiErrorCard(root);
		expect(root.hidden).toBe(true);
		expect(root.childElementCount).toBe(0);
	});
});

describe('error-card module', () => {
	const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'error-card.ts'), 'utf8');
	const imports = Array.from(source.matchAll(/^import[^;]*?from '([^']+)'/gm)).map(match => match[1]);

	test('imports nothing from Settings, icons, or a sanitizer, so the Reader chunk stays lean', () => {
		expect(imports.length).toBeGreaterThan(0);
		for (const specifier of imports) {
			expect(specifier).not.toMatch(/settings|icons|dompurify|lucide/i);
		}
		expect(source).not.toMatch(/isTrusted/);
	});
});
