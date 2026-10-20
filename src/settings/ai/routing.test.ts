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

function badge(row: string): HTMLElement {
	return document.querySelector(`.ai-routing-row[data-row="${row}"] .ai-status-badge`) as HTMLElement;
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
	test('has Default on top and one row per task', async () => {
		await section(SETTINGS);
		const rows = Array.from(document.querySelectorAll<HTMLElement>('#ai-routing .ai-routing-row')).map(row => row.dataset.row);
		expect(rows).toEqual(['default', ...AI_TASKS]);
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

	test('the badge follows the resolved profile', async () => {
		await section(SETTINGS);
		expect(badge('default').textContent).toBe('OK');
		// Use default follows the default's connection.
		expect(badge('translate').textContent).toBe('OK');
		expect(badge('explain').textContent).toBe('Untested');

		choose('default', 'llama');
		await settle();
		expect(badge('translate').textContent).toBe('Untested');
		expect(badge('interpret').textContent).toBe('Untested');
	});

	test('the badge reports a missing key, an unsupported CLI, and an unset default', async () => {
		await section({
			connections: [API_CONNECTION, CODEX_CONNECTION],
			profiles: [GPT_PROFILE, CODEX_PROFILE],
			routing: { taskProfiles: { edit: 'gpt', explain: 'codex-high' } },
			nativeMessaging: 'none'
		});
		expect(badge('default').textContent).toBe('Not set');
		expect(badge('translate').textContent).toBe('Not set');
		expect(badge('edit').textContent).toBe('Key missing on this device');
		expect(badge('explain').textContent).toBe('Unsupported in this browser');
	});

	test('a routed profile that is disabled stays selected and is marked unavailable', async () => {
		await section({ ...SETTINGS, routing: { defaultProfileId: 'gpt', taskProfiles: { reading: 'off', edit: 'deleted' } } });
		expect(select('reading').value).toBe('off');
		expect(select('reading').selectedOptions[0].textContent).toBe('Off (disabled)');
		expect(badge('reading').textContent).toBe('Model unavailable');
		expect(select('edit').selectedOptions[0].textContent).toBe('Deleted model');
	});

	test('the badge updates when a key arrives from another context', async () => {
		const { local } = await section({ ...SETTINGS, credentials: {} });
		expect(badge('default').textContent).toBe('Key missing on this device');
		await local.set({ ai_credentials: { openai: 'sk' } });
		await settle();
		expect(badge('default').textContent).toBe('OK');
	});
});
