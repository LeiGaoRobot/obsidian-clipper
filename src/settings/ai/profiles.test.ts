// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest';
import { getCatalogEntry } from '../../ai/catalog';
import { CODEX_REASONING_EFFORTS } from '../../utils/codex-reasoning-effort';
import { initializeAiSettings } from './index';
import { CODEX_MODEL_SUGGESTIONS } from './profiles';
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

const GROK_CONNECTION = { id: 'grok', kind: 'cli-grok' as const, label: '' };

async function section(settings: FakeSettings) {
	const fake = createFakeStore(settings);
	let next = 0;
	const handle = await initializeAiSettings({
		store: fake.store,
		clearConnectionStatus: fake.clearConnectionStatus,
		createId: prefix => `${prefix}-${++next}`,
		installGuide: installGuideEnvironment(),
		confirm: () => true
	});
	return { ...fake, handle };
}

function group(connectionId: string): HTMLElement {
	return document.querySelector(`.ai-profile-group[data-connection-id="${connectionId}"]`) as HTMLElement;
}

function row(profileId: string): HTMLElement {
	return document.querySelector(`.ai-profile-row[data-profile-id="${profileId}"]`) as HTMLElement;
}

function openAdd(connectionId: string): void {
	(group(connectionId).querySelector('.ai-add-profile') as HTMLAnchorElement).click();
}

function field<T extends HTMLElement = HTMLInputElement>(id: string): T {
	return document.getElementById(id) as T;
}

function save(): void {
	(document.querySelector('#ai-profile-modal .ai-profile-confirm-btn') as HTMLButtonElement).click();
}

beforeEach(() => {
	loadSettingsDocument();
});

describe('Models in connection cards', () => {
	test('are nested in their connection card in creation order', async () => {
		await section({
			connections: [API_CONNECTION, LOCAL_CONNECTION, CODEX_CONNECTION],
			profiles: [LLAMA_PROFILE, MINI_PROFILE, CODEX_PROFILE, GPT_PROFILE, { ...GPT_PROFILE, id: 'orphan', connectionId: 'gone' }],
			routing: { defaultProfileId: 'gpt', taskProfiles: {} }
		});

		expect(document.getElementById('ai-profiles')).toBeNull();
		const cards = Array.from(document.querySelectorAll<HTMLElement>('#ai-connections .ai-connection-item'));
		expect(cards.map(item => item.dataset.connectionId)).toEqual(['openai', 'ollama', 'codex', '']);
		expect(cards.map(item => item.querySelector('.ai-connection-name')?.textContent))
			.toEqual(['OpenAI', 'Ollama', 'Codex CLI', 'Missing connection']);
		for (const card of cards) {
			expect(card.querySelector('.ai-profile-group')?.getAttribute('data-connection-id')).toBe(card.dataset.connectionId);
		}
		expect(Array.from(group('openai').querySelectorAll<HTMLElement>('.ai-profile-row')).map(item => item.dataset.profileId))
			.toEqual(['mini', 'gpt']);
		expect(row('mini').querySelector('.ai-profile-name')?.textContent).toBe('gpt-5.6-mini');
		// The default model is marked in its row.
		expect(row('gpt').querySelector('.ai-profile-default-badge')?.textContent).toBe('Default');
		expect(row('mini').querySelector('.ai-profile-default-badge')).toBeNull();
		// Every connection has its own "+ Add model"; the orphans card has none.
		expect(group('ollama').querySelector('.ai-add-profile')?.getAttribute('aria-label')).toBe('Add model to Ollama');
		expect(group('').querySelector('.ai-add-profile')).toBeNull();
		expect(row('gpt').querySelector('.ai-profile-details')?.textContent).toBe('gpt-5.6');
		expect(row('codex-high').querySelector('.ai-profile-details')?.textContent).toBe('gpt-5.6-sol · Effort: high');
		// An orphan can only be deleted.
		expect(row('orphan').querySelector('.ai-profile-edit')).toBeNull();
		expect(row('orphan').querySelector('.ai-profile-delete')).not.toBeNull();
	});

	test('the effort select is shown only for Codex, with every effort', async () => {
		await section({ connections: [API_CONNECTION, CODEX_CONNECTION, GROK_CONNECTION] });
		const effortItem = field<HTMLElement>('ai-profile-effort-item');
		const modelItem = field<HTMLElement>('ai-profile-model-item');

		openAdd('openai');
		expect(effortItem.hidden).toBe(true);
		expect(modelItem.hidden).toBe(false);

		openAdd('codex');
		expect(effortItem.hidden).toBe(false);
		expect(Array.from(field<HTMLSelectElement>('ai-profile-effort').options).map(option => option.value))
			.toEqual(['', ...CODEX_REASONING_EFFORTS]);
		expect(field('ai-profile-model').maxLength).toBe(200);

		openAdd('grok');
		expect(effortItem.hidden).toBe(true);
		expect(modelItem.hidden).toBe(true);
	});

	test('the model datalist comes from the catalog', async () => {
		await section({ connections: [API_CONNECTION, CODEX_CONNECTION] });
		const options = () => Array.from(document.querySelectorAll<HTMLOptionElement>('#ai-profile-model-options option'))
			.map(option => option.value);

		openAdd('openai');
		expect(field('ai-profile-model').getAttribute('list')).toBe('ai-profile-model-options');
		expect(options()).toEqual(getCatalogEntry('openai')!.popularModels.map(model => model.id));
		expect(document.querySelector('#ai-profile-model-description a')?.getAttribute('href')).toBe(getCatalogEntry('openai')!.modelsList);

		openAdd('codex');
		expect(options()).toEqual([...CODEX_MODEL_SUGGESTIONS]);
	});

	test('adding a model requires a model id for API connections and saves the profile', async () => {
		const { sync } = await section({ connections: [API_CONNECTION], profiles: [GPT_PROFILE], routing: { defaultProfileId: 'gpt', taskProfiles: {} } });
		openAdd('openai');
		expect(document.getElementById('ai-profile-connection-name')?.textContent).toBe('OpenAI');

		save();
		expect(document.getElementById('ai-profile-error')?.textContent).toBe('Enter a model ID.');

		field('ai-profile-model').value = 'gpt-5.6-nano';
		field('ai-profile-label').value = 'Nano';
		save();
		await settle();

		expect(document.getElementById('ai-profile-modal')?.style.display).toBe('none');
		expect(sync.data.ai_profiles).toEqual({
			v: 1,
			items: [GPT_PROFILE, { id: 'profile-1', connectionId: 'openai', model: 'gpt-5.6-nano', label: 'Nano', enabled: true }]
		});
		expect(row('profile-1').querySelector('.ai-profile-name')?.textContent).toBe('Nano');
	});

	test('editing a Codex profile saves its model and effort', async () => {
		const { sync } = await section({ connections: [CODEX_CONNECTION], profiles: [CODEX_PROFILE] });
		(row('codex-high').querySelector('.ai-profile-edit') as HTMLButtonElement).click();
		expect(field('ai-profile-model').value).toBe('gpt-5.6-sol');
		expect(field<HTMLSelectElement>('ai-profile-effort').value).toBe('high');

		field('ai-profile-model').value = '';
		field<HTMLSelectElement>('ai-profile-effort').value = 'ultra';
		save();
		await settle();

		expect(sync.data.ai_profiles).toEqual({
			v: 1,
			items: [{ id: 'codex-high', connectionId: 'codex', label: 'Codex high', options: { reasoningEffort: 'ultra' }, enabled: true }]
		});
	});

	test('saving a profile deleted on another device closes the dialog and says so', async () => {
		const { sync } = await section({ connections: [API_CONNECTION], profiles: [GPT_PROFILE] });
		(row('gpt').querySelector('.ai-profile-edit') as HTMLButtonElement).click();
		await sync.set({ ai_profiles: { v: 1, items: [] } });
		await settle();

		field('ai-profile-label').value = 'Renamed';
		save();
		await settle();

		expect(document.getElementById('ai-profile-modal')!.style.display).toBe('none');
		expect(document.querySelector('#ai-settings-error .ai-error-card-title')?.textContent).toBe('This model was deleted');
		expect(sync.data.ai_profiles).toEqual({ v: 1, items: [] });
	});

	test('adding a model to a connection deleted on another device closes the dialog and says so', async () => {
		const { sync } = await section({ connections: [API_CONNECTION] });
		openAdd('openai');
		await sync.set({ ai_connections: { v: 1, items: [] } });
		await settle();

		field('ai-profile-model').value = 'gpt-5.6';
		save();
		await settle();

		expect(document.getElementById('ai-profile-modal')!.style.display).toBe('none');
		expect(document.querySelector('#ai-settings-error .ai-error-card-title')?.textContent).toBe('This connection was deleted');
		expect(sync.data.ai_profiles).toEqual({ v: 1, items: [] });
	});

	test('focus returns to the Edit button when the dialog closes', async () => {
		await section({ connections: [API_CONNECTION], profiles: [GPT_PROFILE] });
		const edit = row('gpt').querySelector('.ai-profile-edit') as HTMLButtonElement;
		edit.focus();
		edit.click();
		expect((document.querySelector('#ai-profile-modal .modal') as HTMLElement).contains(document.activeElement)).toBe(true);
		document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(document.getElementById('ai-profile-modal')!.style.display).toBe('none');
		expect(document.activeElement).toBe(edit);
	});

	test('toggles, duplicates, and deletes a profile', async () => {
		const { sync } = await section({
			connections: [API_CONNECTION],
			profiles: [GPT_PROFILE],
			routing: { defaultProfileId: 'gpt', taskProfiles: { edit: 'gpt' } }
		});

		const toggle = document.getElementById('ai-profile-enabled-gpt') as HTMLInputElement;
		toggle.checked = false;
		toggle.dispatchEvent(new Event('change'));
		await settle();
		expect((sync.data.ai_profiles as { items: { enabled: boolean }[] }).items[0].enabled).toBe(false);
		expect(row('gpt').classList.contains('is-disabled')).toBe(true);

		(row('gpt').querySelector('.ai-profile-duplicate') as HTMLButtonElement).click();
		await settle();
		expect(row('profile-1').querySelector('.ai-profile-name')?.textContent).toBe('GPT (copy)');

		(row('gpt').querySelector('.ai-profile-delete') as HTMLButtonElement).click();
		await settle();
		expect((sync.data.ai_profiles as { items: { id: string }[] }).items.map(item => item.id)).toEqual(['profile-1']);
		expect(sync.data.ai_routing).toEqual({ v: 1, taskProfiles: {} });
	});
});
