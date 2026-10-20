// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest';
import { initializeAiSettings } from './index';
import { formatRelativeTime } from './status';
import {
	API_CONNECTION,
	CODEX_CONNECTION,
	CODEX_PROFILE,
	GPT_PROFILE,
	createFakeStore,
	installGuideEnvironment,
	loadSettingsDocument,
	settle,
	type FakeSettings
} from './test-support';

async function section(settings: FakeSettings) {
	const fake = createFakeStore(settings);
	const handle = await initializeAiSettings({ store: fake.store, installGuide: installGuideEnvironment(), session: null });
	return { ...fake, handle };
}

function checkbox(): HTMLInputElement {
	return document.getElementById('ai-interpreter-enabled') as HTMLInputElement;
}

function toggle(checked: boolean): void {
	checkbox().checked = checked;
	checkbox().dispatchEvent(new Event('change'));
}

function checks(): [string, string, string][] {
	return Array.from(document.querySelectorAll<HTMLElement>('#ai-status .ai-status-check')).map(item => [
		item.dataset.check ?? '',
		item.className.replace('ai-status-check is-', ''),
		item.querySelector('.ai-status-check-label')?.textContent ?? ''
	]);
}

function title(): string | null | undefined {
	return document.getElementById('ai-status-title')?.textContent;
}

const hint = () => document.querySelector<HTMLElement>('#ai-status .ai-enabled-hint')!;

beforeEach(() => {
	loadSettingsDocument();
});

describe('Status card', () => {
	test('is the first group of the AI section, with the master switch, above Providers and models', async () => {
		await section({ enabled: false });
		const aiSection = document.getElementById('ai-section')!;
		expect(aiSection.querySelector('.setting-group')?.id).toBe('ai-status-group');
		expect(checkbox().closest('#ai-status')).not.toBeNull();
		expect(document.getElementById('ai-interpreter')?.contains(checkbox())).toBe(false);
		const providers = document.getElementById('ai-providers-group')!;
		expect(checkbox().compareDocumentPosition(providers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(checkbox().getAttribute('aria-label')).toBe('Enable AI features');
		expect(title()).toBe('AI features are off');
	});

	test('a fresh install lists what is missing, with no "Not set" anywhere', async () => {
		await section({ enabled: false });
		expect(checkbox().checked).toBe(false);
		expect(checks()).toEqual([
			['provider', 'todo', 'Add a provider'],
			['model', 'todo', 'Add a model']
		]);
		expect(document.getElementById('ai-section')!.textContent).not.toContain('Not set');
		expect(document.querySelectorAll('#ai-tasks-group .ai-status-badge')).toHaveLength(0);
	});

	test('a configured, tested setup is all checked', async () => {
		await section({
			connections: [API_CONNECTION],
			profiles: [GPT_PROFILE],
			routing: { defaultProfileId: 'gpt', taskProfiles: {} },
			credentials: { openai: 'sk' },
			status: { openai: { state: 'ok', testedAt: Date.now() - 2 * 60_000 } }
		});
		expect(title()).toBe('AI features are on');
		expect(checks()).toEqual([
			['provider', 'done', 'Provider connected'],
			['model', 'done', 'Default model: GPT'],
			['test', 'done', 'Tested 2 minutes ago']
		]);
		expect(document.querySelector('#ai-status .ai-status-check.is-done svg, #ai-status .ai-status-check.is-done [data-lucide]')).not.toBeNull();
	});

	test('reports a missing key, an unavailable default, and a failed Test', async () => {
		await section({
			connections: [API_CONNECTION, { ...API_CONNECTION, id: 'second', label: 'Second' }],
			profiles: [{ ...GPT_PROFILE, enabled: false }],
			routing: { defaultProfileId: 'gpt', taskProfiles: {} },
			credentials: { second: 'sk' },
			status: { second: { state: 'failing', code: 'auth', testedAt: Date.now() - 3 * 3_600_000 } }
		});
		expect(checks()).toEqual([
			['provider', 'warn', 'Key missing on this device'],
			['model', 'warn', 'Default model unavailable'],
			['test', 'warn', 'Last Test failed 3 hours ago']
		]);
	});

	test('counts connected providers and asks for a default model and a Test', async () => {
		await section({
			connections: [API_CONNECTION, { ...API_CONNECTION, id: 'second' }, CODEX_CONNECTION],
			profiles: [GPT_PROFILE, CODEX_PROFILE],
			credentials: { openai: 'sk', second: 'sk' },
			status: { openai: { state: 'ok', testedAt: 1 }, second: { state: 'ok', testedAt: 2 } }
		});
		expect(checks().slice(0, 2)).toEqual([
			['provider', 'done', '2 providers connected'],
			['model', 'todo', 'Choose a default model']
		]);

		loadSettingsDocument();
		await section({ connections: [API_CONNECTION], credentials: { openai: 'sk' } });
		expect(checks()).toEqual([
			['provider', 'todo', 'Provider added, not tested yet'],
			['model', 'todo', 'Add a model'],
			['test', 'todo', 'Not tested yet']
		]);
	});

	test('the checklist follows changes from another context', async () => {
		const { local } = await section({ connections: [API_CONNECTION], credentials: { openai: 'sk' } });
		await local.set({ ai_connection_status: { openai: { state: 'ok', testedAt: Date.now() } } });
		await settle();
		expect(checks()[0]).toEqual(['provider', 'done', 'Provider connected']);
		expect(checks()[2][1]).toBe('done');
	});

	test('the title follows the switch', async () => {
		await section({ enabled: false });
		toggle(true);
		expect(title()).toBe('AI features are on');
		await settle();
		expect(title()).toBe('AI features are on');
	});

	test('adding the first model while AI is off shows a hint next to the switch until it is on', async () => {
		const { handle } = await section({ enabled: false, connections: [API_CONNECTION] });
		expect(hint().hidden).toBe(true);

		await handle.controller.addProfile({ connectionId: 'openai', label: '', model: 'gpt-5' });
		await settle();
		expect(hint().hidden).toBe(false);
		expect(hint().textContent).toBe("AI features are off, so the models you add aren't used yet. Turn this on to use them.");
		expect(hint().getAttribute('role')).toBe('status');
		expect(checkbox().checked).toBe(false);

		toggle(true);
		expect(hint().hidden).toBe(true);
		await settle();
		expect(hint().hidden).toBe(true);
	});

	test('no hint for models already stored, or when AI is on', async () => {
		await section({ enabled: false, connections: [API_CONNECTION], profiles: [GPT_PROFILE] });
		expect(hint().hidden).toBe(true);

		loadSettingsDocument();
		const { handle } = await section({ enabled: true, connections: [API_CONNECTION] });
		await handle.controller.addProfile({ connectionId: 'openai', label: '', model: 'gpt-5' });
		await settle();
		expect(hint().hidden).toBe(true);
	});

	test('the template editor prompt context follows the master switch', async () => {
		await section({ enabled: false });
		const container = document.getElementById('prompt-context-container')!;
		expect(container.style.display).toBe('none');
		toggle(true);
		expect(container.style.display).toBe('block');
	});

	test('a refused write puts the toggle back', async () => {
		const { sync } = await section({ enabled: false });
		sync.failNextSet = new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded');
		toggle(true);
		await settle();
		expect(checkbox().checked).toBe(false);
		expect(title()).toBe('AI features are off');
		expect(document.getElementById('ai-settings-error')?.hidden).toBe(false);
	});
});

describe('formatRelativeTime', () => {
	test('uses seconds, minutes, hours, and days', () => {
		const now = 10 * 86_400_000;
		expect(formatRelativeTime(now - 5_000, now, 'en')).toBe('now');
		expect(formatRelativeTime(now - 60_000, now, 'en')).toBe('1 minute ago');
		expect(formatRelativeTime(now - 5 * 3_600_000, now, 'en')).toBe('5 hours ago');
		expect(formatRelativeTime(now - 86_400_000, now, 'en')).toBe('yesterday');
		expect(formatRelativeTime(now + 5_000, now, 'en')).toBe('now');
	});

	test('accepts the extension language codes the page uses as its lang', () => {
		expect(formatRelativeTime(0, 120_000, 'zh_CN')).toBe(new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(-2, 'minute'));
		expect(() => formatRelativeTime(0, 120_000, 'not a locale')).not.toThrow();
	});
});
