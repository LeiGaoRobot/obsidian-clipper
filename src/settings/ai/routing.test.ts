// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest';
import { AI_TASKS } from '../../ai/types';
import { initializeAiSettings } from './index';
import {
	API_CONNECTION,
	CODEX_CONNECTION,
	CODEX_PROFILE,
	GPT_PROFILE,
	LLAMA_PROFILE,
	LOCAL_CONNECTION,
	MINI_PROFILE,
	createFakeStore,
	installGuideEnvironment,
	loadSettingsDocument,
	settle,
	type FakeSettings
} from './test-support';

async function section(settings: FakeSettings) {
	const fake = createFakeStore(settings);
	const handle = await initializeAiSettings({ store: fake.store, installGuide: installGuideEnvironment() });
	return { ...fake, handle };
}

function select(row: string): HTMLSelectElement {
	return document.getElementById(`ai-routing-${row}`) as HTMLSelectElement;
}

function badge(row: string): HTMLElement | null {
	return document.querySelector(`.ai-routing-row[data-row="${row}"] .ai-status-badge`);
}

function customize(): HTMLDetailsElement {
	return document.getElementById('ai-routing-customize') as HTMLDetailsElement;
}

function choose(row: string, value: string): void {
	select(row).value = value;
	select(row).dispatchEvent(new Event('change'));
}

const SETTINGS: FakeSettings = {
	connections: [API_CONNECTION, LOCAL_CONNECTION],
	profiles: [GPT_PROFILE, MINI_PROFILE, LLAMA_PROFILE, { ...GPT_PROFILE, id: 'off', label: 'Off', enabled: false }],
	routing: { defaultProfileId: 'gpt', taskProfiles: { explain: 'llama' } },
	credentials: { openai: 'sk' },
	status: { openai: { state: 'ok', testedAt: 1 } }
};

beforeEach(() => {
	loadSettingsDocument();
});

describe('Task routing', () => {
	test('has Default and the response language on top, and one row per task in a collapsed disclosure', async () => {
		await section(SETTINGS);
		const rows = Array.from(document.querySelectorAll<HTMLElement>('#ai-tasks-group .ai-routing-row')).map(row => row.dataset.row);
		expect(rows).toEqual(['default', ...AI_TASKS]);
		expect(document.querySelector('#ai-routing .ai-routing-row')?.getAttribute('data-row')).toBe('default');
		const language = document.getElementById('ai-response-language')!;
		expect(select('default').compareDocumentPosition(language) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(language.compareDocumentPosition(customize()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(customize().open).toBe(false);
		expect(Array.from(customize().querySelectorAll<HTMLElement>('.ai-routing-row')).map(row => row.dataset.row)).toEqual([...AI_TASKS]);
		// The Language section is gone; its row lives in Tasks.
		expect(document.getElementById('ai-language-group')).toBeNull();
		expect(document.getElementById('ai-tasks-group')?.contains(language)).toBe(true);
		expect(AI_TASKS).toHaveLength(5);
		expect(document.querySelector('[data-row="translate"] label')?.textContent).toBe('Subtitle translation');
		expect(document.querySelector('[data-row="translate"] label')?.getAttribute('for')).toBe('ai-routing-translate');
	});

	test('lists enabled profiles grouped by connection, with Use default on task rows', async () => {
		await section(SETTINGS);
		expect(select('default').options[0].textContent).toBe('None');
		expect(select('translate').options[0].textContent).toBe('Use default');
		expect(Array.from(select('translate').querySelectorAll('optgroup')).map(group => group.label)).toEqual(['OpenAI', 'Ollama']);
		expect(Array.from(select('translate').options).map(option => option.value)).toEqual(['', 'gpt', 'mini', 'llama']);
		expect(select('default').value).toBe('gpt');
		expect(select('translate').value).toBe('');
		expect(select('explain').value).toBe('llama');
	});

	test('a task set to the default model counts as changed and keeps that model when the default changes', async () => {
		const { sync } = await section({ ...SETTINGS, routing: { defaultProfileId: 'gpt', taskProfiles: {} } });
		choose('edit', 'gpt');
		await settle();
		expect(select('edit').value).toBe('gpt');
		expect(customize().querySelector('.ai-routing-customize-count')?.textContent).toBe('(1 changed)');

		choose('default', 'llama');
		await settle();
		expect(sync.data.ai_routing).toMatchObject({ defaultProfileId: 'llama', taskProfiles: { edit: 'gpt' } });
		expect(select('edit').value).toBe('gpt');
		expect(customize().querySelector('.ai-routing-customize-count')?.textContent).toBe('(1 changed)');
	});

	test('writes the default and task entries, and Use default clears the entry', async () => {
		const { sync } = await section(SETTINGS);

		choose('translate', 'mini');
		await settle();
		expect(sync.data.ai_routing).toEqual({ v: 1, defaultProfileId: 'gpt', taskProfiles: { translate: 'mini', explain: 'llama' } });

		choose('explain', '');
		choose('default', 'llama');
		await settle();
		expect(sync.data.ai_routing).toEqual({ v: 1, defaultProfileId: 'llama', taskProfiles: { translate: 'mini' } });
		expect(select('translate').value).toBe('mini');
	});

	test('the summary counts tasks set to a model, and the disclosure stays open across renders', async () => {
		await section({ ...SETTINGS, routing: { defaultProfileId: 'gpt', taskProfiles: { explain: 'llama' } } });
		expect(customize().querySelector('summary')?.textContent).toBe('Customize per task(1 changed)');
		customize().open = true;

		choose('translate', 'mini');
		await settle();
		expect(customize().open).toBe(true);
		expect(customize().querySelector('.ai-routing-customize-count')?.textContent).toBe('(2 changed)');

		choose('translate', '');
		choose('explain', '');
		await settle();
		expect(customize().querySelector('.ai-routing-customize-count')?.textContent).toBe('');
	});

	test('rows show a badge only for a problem', async () => {
		await section(SETTINGS);
		// OK and Untested routes show nothing.
		for (const row of ['default', ...AI_TASKS]) expect(badge(row)).toBeNull();
		expect(customize().querySelector('summary .ai-status-badge')).toBeNull();
	});

	test('the badge reports a missing key and an unsupported CLI, but no unset default', async () => {
		await section({
			connections: [API_CONNECTION, CODEX_CONNECTION],
			profiles: [GPT_PROFILE, CODEX_PROFILE],
			routing: { taskProfiles: { edit: 'gpt', explain: 'codex-high' } },
			nativeMessaging: 'none'
		});
		expect(badge('default')).toBeNull();
		expect(badge('translate')).toBeNull();
		expect(badge('edit')?.textContent).toBe('Key missing on this device');
		expect(badge('explain')?.textContent).toBe('Unsupported in this browser');
		expect(customize().querySelector('summary .ai-status-badge')?.textContent).toBe('Needs attention (2)');
	});

	test("a default's problem is shown once, on the Default row", async () => {
		await section({ ...SETTINGS, credentials: {}, routing: { defaultProfileId: 'gpt', taskProfiles: { explain: 'llama' } } });
		expect(badge('default')?.textContent).toBe('Key missing on this device');
		expect(badge('translate')).toBeNull();
		expect(badge('explain')).toBeNull();
	});

	test('a failing Test shows on the rows that use it', async () => {
		await section({ ...SETTINGS, status: { openai: { state: 'failing', code: 'auth', testedAt: 1 } }, routing: { defaultProfileId: 'llama', taskProfiles: { edit: 'gpt' } } });
		expect(badge('default')).toBeNull();
		expect(badge('edit')?.textContent).toBe('Failing: API key rejected');
	});

	test('a routed profile that is disabled stays selected and is marked unavailable', async () => {
		await section({ ...SETTINGS, routing: { defaultProfileId: 'gpt', taskProfiles: { reading: 'off', edit: 'deleted' } } });
		expect(select('reading').value).toBe('off');
		expect(select('reading').selectedOptions[0].textContent).toBe('Off (disabled)');
		expect(badge('reading')?.textContent).toBe('Model unavailable');
		expect(select('edit').selectedOptions[0].textContent).toBe('Deleted model');
	});

	test('the badge updates when a key arrives from another context', async () => {
		const { local } = await section({ ...SETTINGS, credentials: {} });
		expect(badge('default')?.textContent).toBe('Key missing on this device');
		await local.set({ ai_credentials: { openai: 'sk' } });
		await settle();
		expect(badge('default')).toBeNull();
	});
});
