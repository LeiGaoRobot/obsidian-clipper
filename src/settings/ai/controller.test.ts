// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getCatalogEntry } from '../../ai/catalog';
import { AiSettingsStorageError, type AiSettingsSnapshot } from '../../ai/settings';
import { createAiSettingsController } from './controller';
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

function sequentialIds() {
	let next = 0;
	return (prefix: string) => `${prefix}-${++next}`;
}

async function controllerFor(settings: FakeSettings = {}) {
	const fake = createFakeStore(settings);
	const onError = vi.fn();
	const controller = createAiSettingsController({ store: fake.store, createId: sequentialIds(), onError });
	await controller.load();
	return { ...fake, controller, onError };
}

const openai = getCatalogEntry('openai')!;

describe('AI settings controller: connections', () => {
	test('adding a catalog connection writes the connection without the key and the key to local storage', async () => {
		const { controller, sync, local } = await controllerFor();
		const connection = await controller.addApiConnection({
			presetId: openai.id,
			label: openai.name,
			baseUrl: openai.baseUrl,
			apiKey: ' sk-test ',
			apiKeyRequired: openai.apiKeyRequired
		});

		expect(connection).toEqual({
			id: 'connection-1',
			kind: 'openai-compatible',
			label: 'OpenAI',
			presetId: 'openai',
			baseUrl: 'https://api.openai.com/v1/chat/completions',
			apiKeyRequired: true
		});
		expect(sync.data.ai_connections).toEqual({ v: 1, items: [connection] });
		expect(JSON.stringify(sync.data)).not.toContain('sk-test');
		expect(local.data.ai_credentials).toEqual({ 'connection-1': 'sk-test' });
		expect(controller.state.view.credentials).toEqual({ 'connection-1': 'sk-test' });
	});

	test('a custom connection infers its kind and keeps an optional key absent', async () => {
		const { controller, local } = await controllerFor();
		const connection = await controller.addApiConnection({
			label: 'Work Claude',
			baseUrl: 'https://api.anthropic.com/v1/messages',
			apiKey: '',
			apiKeyRequired: false,
			maxConcurrency: 2
		});

		expect(connection).toMatchObject({ kind: 'anthropic', label: 'Work Claude', apiKeyRequired: false, maxConcurrency: 2 });
		expect(connection).not.toHaveProperty('presetId');
		expect(local.data.ai_credentials).toBeUndefined();
	});

	test('editing the base URL deletes the status entry and the detected structured-output mode', async () => {
		const { controller, sync, local } = await controllerFor({
			connections: [{ ...API_CONNECTION, structuredOutput: 'json_schema' }],
			credentials: { openai: 'sk-old' },
			status: { openai: { state: 'ok', testedAt: 1 }, ollama: { state: 'failing', testedAt: 2, code: 'network' } }
		});

		await controller.updateConnection('openai', {
			presetId: 'openai',
			label: 'OpenAI',
			baseUrl: 'https://proxy.example.com/v1/chat/completions',
			apiKey: 'sk-old',
			apiKeyRequired: true
		});

		expect((sync.data.ai_connections as { items: unknown[] }).items[0]).toEqual({
			...API_CONNECTION,
			baseUrl: 'https://proxy.example.com/v1/chat/completions'
		});
		expect(local.data.ai_connection_status).toEqual({ ollama: { state: 'failing', testedAt: 2, code: 'network' } });
		expect(controller.state.connectionStatus).not.toHaveProperty('openai');
	});

	test('changing only the key replaces the credential and deletes the status entry', async () => {
		const { controller, sync, local } = await controllerFor({
			connections: [API_CONNECTION],
			credentials: { openai: 'sk-old' },
			status: { openai: { state: 'failing', testedAt: 1, code: 'auth' } }
		});
		const syncWrites = sync.sets.length;

		await controller.updateConnection('openai', {
			presetId: 'openai',
			label: 'OpenAI',
			baseUrl: API_CONNECTION.baseUrl!,
			apiKey: 'sk-new',
			apiKeyRequired: true
		});

		expect(sync.sets.length).toBe(syncWrites);
		expect(local.data.ai_credentials).toEqual({ openai: 'sk-new' });
		expect(local.data.ai_connection_status).toEqual({});
	});

	test('a label-only edit keeps the status entry', async () => {
		const { controller, local } = await controllerFor({
			connections: [API_CONNECTION],
			credentials: { openai: 'sk' },
			status: { openai: { state: 'ok', testedAt: 1 } }
		});

		await controller.updateConnection('openai', {
			presetId: 'openai',
			label: 'Work OpenAI',
			baseUrl: API_CONNECTION.baseUrl!,
			apiKey: 'sk',
			apiKeyRequired: true
		});

		expect(controller.state.view.connections[0].label).toBe('Work OpenAI');
		expect(local.data.ai_connection_status).toEqual({ openai: { state: 'ok', testedAt: 1 } });
	});

	test('deleting a connection cascades to its profiles, credential, status, and routing', async () => {
		const { controller, sync, local } = await controllerFor({
			connections: [API_CONNECTION, LOCAL_CONNECTION],
			profiles: [GPT_PROFILE, MINI_PROFILE, LLAMA_PROFILE],
			routing: { defaultProfileId: 'gpt', taskProfiles: { translate: 'mini', explain: 'llama' }, responseLanguage: 'Japanese' },
			credentials: { openai: 'sk', other: 'keep' },
			status: { openai: { state: 'ok', testedAt: 1 }, ollama: { state: 'ok', testedAt: 2 } }
		});

		expect(await controller.deleteConnection('openai')).toBe(true);

		expect(sync.data.ai_connections).toEqual({ v: 1, items: [LOCAL_CONNECTION] });
		expect(sync.data.ai_profiles).toEqual({ v: 1, items: [LLAMA_PROFILE] });
		expect(sync.data.ai_routing).toEqual({ v: 1, taskProfiles: { explain: 'llama' }, responseLanguage: 'Japanese' });
		expect(local.data.ai_credentials).toEqual({ other: 'keep' });
		expect(local.data.ai_connection_status).toEqual({ ollama: { state: 'ok', testedAt: 2 } });
		expect(controller.state.view.profiles).toEqual([LLAMA_PROFILE]);
	});

	test('adding a local CLI creates one connection with a default enabled profile that becomes the default', async () => {
		const { controller, sync } = await controllerFor();

		const connection = await controller.addCliConnection('cli-codex');

		expect(connection).toEqual({ id: 'cli-1', kind: 'cli-codex', label: '' });
		expect(sync.data.ai_profiles).toEqual({ v: 1, items: [{ id: 'profile-2', connectionId: 'cli-1', label: '', enabled: true }] });
		expect(sync.data.ai_routing).toEqual({ v: 1, defaultProfileId: 'profile-2', taskProfiles: {} });
		expect(await controller.addCliConnection('cli-codex')).toBeUndefined();
		expect((sync.data.ai_connections as { items: unknown[] }).items).toHaveLength(1);
	});
});

describe('AI settings controller: profiles and routing', () => {
	test('adds, duplicates, and deletes profiles', async () => {
		const { controller, sync } = await controllerFor({
			connections: [API_CONNECTION, CODEX_CONNECTION],
			profiles: [GPT_PROFILE],
			routing: { defaultProfileId: 'gpt', taskProfiles: {} }
		});

		const added = await controller.addProfile({ connectionId: 'codex', label: ' Codex ', model: ' gpt-5.6-terra ', reasoningEffort: 'max' });
		expect(added).toEqual({
			id: 'profile-1',
			connectionId: 'codex',
			model: 'gpt-5.6-terra',
			label: 'Codex',
			options: { reasoningEffort: 'max' },
			enabled: true
		});
		// An existing default is kept.
		expect(controller.state.view.routing.defaultProfileId).toBe('gpt');

		const copy = await controller.duplicateProfile('profile-1', 'Codex (copy)');
		expect(copy).toEqual({ ...added, id: 'profile-2', label: 'Codex (copy)' });

		await controller.setTaskProfile('explain', 'profile-2');
		expect(await controller.deleteProfile('profile-2')).toBe(true);

		expect((sync.data.ai_profiles as { items: { id: string }[] }).items.map(profile => profile.id)).toEqual(['gpt', 'profile-1']);
		expect(sync.data.ai_routing).toEqual({ v: 1, defaultProfileId: 'gpt', taskProfiles: {} });
	});

	test('the effort is kept only for Codex profiles', async () => {
		const { controller } = await controllerFor({ connections: [API_CONNECTION] });
		const profile = await controller.addProfile({ connectionId: 'openai', label: '', model: 'gpt-5.6', reasoningEffort: 'high' });
		expect(profile).not.toHaveProperty('options');
		// The first profile becomes the default.
		expect(controller.state.view.routing.defaultProfileId).toBe(profile?.id);
	});

	test('routing writes defaultProfileId and taskProfiles[task], and Use default clears the entry', async () => {
		const { controller, sync } = await controllerFor({
			connections: [API_CONNECTION],
			profiles: [GPT_PROFILE, MINI_PROFILE]
		});

		await controller.setDefaultProfile('gpt');
		await controller.setTaskProfile('translate', 'mini');
		expect(sync.data.ai_routing).toEqual({ v: 1, defaultProfileId: 'gpt', taskProfiles: { translate: 'mini' } });

		await controller.setTaskProfile('translate', undefined);
		await controller.setDefaultProfile(undefined);
		expect(sync.data.ai_routing).toEqual({ v: 1, taskProfiles: {} });
	});

	test('the response language is trimmed into ai_routing', async () => {
		const { controller, sync } = await controllerFor({ routing: { defaultProfileId: 'gpt', taskProfiles: {} } });
		await controller.setResponseLanguage('  Japanese ');
		expect(sync.data.ai_routing).toEqual({ v: 1, defaultProfileId: 'gpt', taskProfiles: {}, responseLanguage: 'Japanese' });
		await controller.setResponseLanguage(' ');
		expect(sync.data.ai_routing).toEqual({ v: 1, defaultProfileId: 'gpt', taskProfiles: {} });
	});
});

describe('AI settings controller: errors', () => {
	test('a quota error is reported and leaves the view unchanged', async () => {
		const { controller, sync, onError } = await controllerFor({ connections: [API_CONNECTION], profiles: [GPT_PROFILE] });
		const before = controller.state.view;
		sync.failNextSet = new Error('QUOTA_BYTES quota exceeded');

		expect(await controller.addProfile({ connectionId: 'openai', label: '', model: 'gpt-5.6-mini' })).toBeUndefined();

		expect(controller.state.view).toEqual(before);
		expect(controller.error).toBeInstanceOf(AiSettingsStorageError);
		expect(controller.error).toMatchObject({ reason: 'total-quota' });
		expect(onError).toHaveBeenLastCalledWith(controller.error);

		await controller.addProfile({ connectionId: 'openai', label: '', model: 'gpt-5.6-mini' });
		expect(controller.error).toBeUndefined();
		expect(onError).toHaveBeenLastCalledWith(undefined);
	});

	test('derived mode refuses writes instead of building on the v1 view', async () => {
		const { controller, sync } = await controllerFor({ derived: true });
		expect(controller.state.mode).toBe('derived');

		expect(await controller.setInterpreterEnabled(true)).toBe(false);
		expect(controller.error).toMatchObject({ name: 'AiSettingsNotWritableError' });
		expect(sync.sets).toEqual([]);
	});
});

describe('AI settings section', () => {
	beforeEach(() => {
		loadSettingsDocument();
	});

	async function section(settings: FakeSettings) {
		const fake = createFakeStore(settings);
		const handle = await initializeAiSettings({
			store: fake.store,
			createId: sequentialIds(),
			installGuide: installGuideEnvironment(),
			confirm: () => true,
			promptContextDebounceMs: 0
		});
		return { ...fake, handle };
	}

	test('a quota error shows in the section error card with a clear message', async () => {
		const { sync, handle } = await section({ connections: [API_CONNECTION], profiles: [GPT_PROFILE] });
		const card = document.getElementById('ai-settings-error')!;
		expect(card.hidden).toBe(true);

		sync.failNextSet = new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
		await handle.controller.setTaskProfile('translate', 'gpt');

		expect(card.hidden).toBe(false);
		expect(card.querySelector('.ai-error-card-title')?.textContent).toBe("Couldn't save AI settings");
		expect(card.querySelector('.ai-error-card-body')?.textContent).toContain('8 KB per item');
		expect((document.getElementById('ai-routing-translate') as HTMLSelectElement).value).toBe('');

		(card.querySelector('.ai-error-card-dismiss') as HTMLButtonElement).click();
		expect(card.hidden).toBe(true);
	});

	test('a bootstrap error from loadSnapshot is shown in the error card', async () => {
		const fake = createFakeStore({ connections: [API_CONNECTION] });
		const loadSnapshot = fake.store.loadSnapshot.bind(fake.store);
		fake.store.loadSnapshot = async (): Promise<AiSettingsSnapshot> => ({
			...(await loadSnapshot()),
			bootstrapError: new AiSettingsStorageError('total-quota', { key: 'ai_connections' })
		});

		await initializeAiSettings({ store: fake.store, installGuide: installGuideEnvironment() });

		const card = document.getElementById('ai-settings-error')!;
		expect(card.hidden).toBe(false);
		expect(card.querySelector('.ai-error-card-title')?.textContent).toBe("Couldn't set up AI settings on this device");
		expect(card.querySelector('.ai-error-card-body')?.textContent).toContain('sync storage is full');
		expect(card.querySelector('.ai-error-card-detail code')?.textContent).toBe('ai_connections');
	});

	test('an observe event for ai_credentials re-renders only the connections panel', async () => {
		const { local, handle } = await section({
			connections: [API_CONNECTION, LOCAL_CONNECTION],
			profiles: [LLAMA_PROFILE],
			routing: { defaultProfileId: 'llama', taskProfiles: {} }
		});
		const first = (id: string) => document.getElementById(id)!.firstElementChild;
		const before = {
			connections: document.querySelector('#ai-connection-list .ai-connection-card'),
			profiles: first('ai-profiles'),
			routing: first('ai-routing'),
			language: document.getElementById('ai-response-language'),
			interpreter: first('ai-interpreter')
		};
		expect(document.querySelector('[data-connection-id="openai"] .ai-status-badge')?.textContent).toBe('Key missing on this device');

		// Another context (or a second tab) stores the key.
		await local.set({ ai_credentials: { openai: 'sk-other-tab' } });
		await settle();

		expect(handle.controller.state.view.credentials).toEqual({ openai: 'sk-other-tab' });
		expect(document.querySelector('#ai-connection-list .ai-connection-card')).not.toBe(before.connections);
		expect(document.querySelector('[data-connection-id="openai"] .ai-status-badge')?.textContent).toBe('Untested');
		expect(first('ai-profiles')).toBe(before.profiles);
		expect(first('ai-routing')).toBe(before.routing);
		expect(document.getElementById('ai-response-language')).toBe(before.language);
		expect(first('ai-interpreter')).toBe(before.interpreter);
	});

	test('an observed change with nothing new to show skips the render', async () => {
		const { sync } = await section({ connections: [API_CONNECTION], profiles: [GPT_PROFILE] });
		const card = document.querySelector('#ai-connection-list .ai-connection-card');
		const profilesRoot = document.getElementById('ai-profiles')!.firstElementChild;

		await sync.set({ ai_profiles: { v: 1, items: [GPT_PROFILE] } });
		await settle();

		expect(document.getElementById('ai-profiles')!.firstElementChild).toBe(profilesRoot);
		expect(document.querySelector('#ai-connection-list .ai-connection-card')).toBe(card);
	});

	test('codex connections render with their profiles and a routing badge', async () => {
		await section({
			connections: [CODEX_CONNECTION],
			profiles: [CODEX_PROFILE],
			routing: { defaultProfileId: 'codex-high', taskProfiles: {} }
		});
		expect(document.querySelector('[data-connection-id="codex"] .ai-connection-name')?.textContent).toBe('Codex CLI');
		expect(document.querySelector('[data-row="default"] .ai-status-badge')?.textContent).toBe('Untested');
	});
});
