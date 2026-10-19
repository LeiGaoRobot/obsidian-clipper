// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CATALOG } from '../../ai/catalog';
import { initializeAiSettings } from './index';
import {
	API_CONNECTION,
	CODEX_CONNECTION,
	GPT_PROFILE,
	LOCAL_CONNECTION,
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

async function section(settings: FakeSettings, confirm: (message: string) => boolean = () => true) {
	const fake = createFakeStore(settings);
	const handle = await initializeAiSettings({
		store: fake.store,
		createId: sequentialIds(),
		installGuide: installGuideEnvironment(),
		confirm
	});
	return { ...fake, handle };
}

function badge(connectionId: string): HTMLElement | null {
	return document.querySelector(`[data-connection-id="${connectionId}"] .ai-status-badge`);
}

function input(id: string): HTMLInputElement {
	return document.getElementById(id) as HTMLInputElement;
}

function modalVisible(id: string): boolean {
	return document.getElementById(id)!.style.display === 'flex';
}

function clickSave(): void {
	(document.querySelector('#ai-connection-modal .ai-connection-confirm-btn') as HTMLButtonElement).click();
}

beforeEach(() => {
	loadSettingsDocument();
});

describe('Connection cards', () => {
	test('show a badge for every state', async () => {
		await section({
			connections: [
				{ ...API_CONNECTION, id: 'untested' },
				{ ...API_CONNECTION, id: 'ok' },
				{ ...API_CONNECTION, id: 'failing' },
				{ ...API_CONNECTION, id: 'missing' },
				LOCAL_CONNECTION,
				CODEX_CONNECTION
			],
			credentials: { untested: 'sk', ok: 'sk', failing: 'sk' },
			status: {
				ok: { state: 'ok', testedAt: 1 },
				failing: { state: 'failing', testedAt: 1, code: 'auth', status: 401, detail: 'invalid_api_key' }
			},
			nativeMessaging: 'none'
		});

		expect(badge('untested')?.textContent).toBe('Untested');
		expect(badge('untested')?.className).toContain('is-untested');
		expect(badge('ok')?.textContent).toBe('OK');
		expect(badge('failing')?.textContent).toBe('Failing: API key rejected');
		expect(badge('failing')?.title).toBe('Failing: API key rejected (HTTP 401 · invalid_api_key)');
		expect(badge('missing')?.textContent).toBe('Key missing on this device');
		// A keyless local endpoint is never missing a key.
		expect(badge('ollama')?.textContent).toBe('Untested');
		expect(badge('codex')?.textContent).toBe('Unsupported in this browser');
		expect(badge('codex')?.className).toContain('is-unsupported');
	});

	test('show the name, host, and kind icon, with no Test or cost note before 5c', async () => {
		await section({ connections: [API_CONNECTION, CODEX_CONNECTION], credentials: { openai: 'sk' } });
		const card = document.querySelector('[data-connection-id="openai"]')!;
		expect(card.querySelector('.ai-connection-name')?.textContent).toBe('OpenAI');
		expect(card.querySelector('.ai-connection-host')?.textContent).toBe('api.openai.com');
		expect(card.querySelector('.ai-kind-icon')?.className).toContain('icon-openai');
		expect(card.querySelector('.ai-connection-edit')).not.toBeNull();
		expect(document.querySelector('[data-connection-id="codex"] .ai-connection-edit')).toBeNull();
		expect(document.querySelector('[data-connection-id="codex"] .ai-connection-name')?.textContent).toBe('Codex CLI');
		expect(document.querySelector('#ai-section .ai-connection-test, #ai-section .ai-connection-cost-note')).toBeNull();
		expect(document.getElementById('ai-settings-error')?.hidden).toBe(true);
	});

	test('an empty list explains how to start', async () => {
		await section({});
		expect(document.querySelector('#ai-connection-list .ai-empty-state')?.textContent).toContain('No connections yet');
	});
});

describe('Catalog picker and connection dialog', () => {
	test('the picker lists every catalog entry plus Custom', async () => {
		await section({});
		(document.getElementById('ai-add-api-provider') as HTMLAnchorElement).click();

		expect(modalVisible('ai-catalog-modal')).toBe(true);
		const options = Array.from(document.querySelectorAll<HTMLButtonElement>('#ai-catalog-list .ai-catalog-option'));
		expect(options.map(option => option.dataset.presetId)).toEqual([...CATALOG.map(entry => entry.id), '']);
		expect(options[options.length - 1]?.textContent).toContain('Custom');
	});

	test('picking OpenAI and saving with the catalog base URL creates a connection and stores the key locally', async () => {
		const { sync, local } = await section({ connections: [LOCAL_CONNECTION] });
		(document.getElementById('ai-add-api-provider') as HTMLAnchorElement).click();
		(document.querySelector('#ai-catalog-list [data-preset-id="openai"]') as HTMLButtonElement).click();

		expect(modalVisible('ai-catalog-modal')).toBe(false);
		expect(modalVisible('ai-connection-modal')).toBe(true);
		expect(input('ai-connection-label').value).toBe('OpenAI');
		expect(input('ai-connection-base-url').value).toBe('https://api.openai.com/v1/chat/completions');
		expect(input('ai-connection-api-key-required').checked).toBe(true);
		const keyLink = document.querySelector('#ai-connection-api-key-description a') as HTMLAnchorElement;
		expect(keyLink.href).toContain('platform.openai.com');

		input('ai-connection-api-key').value = 'sk-new';
		clickSave();
		await settle();

		expect(modalVisible('ai-connection-modal')).toBe(false);
		expect((sync.data.ai_connections as { items: unknown[] }).items).toEqual([
			LOCAL_CONNECTION,
			{
				id: 'connection-1',
				kind: 'openai-compatible',
				label: 'OpenAI',
				presetId: 'openai',
				baseUrl: 'https://api.openai.com/v1/chat/completions',
				apiKeyRequired: true
			}
		]);
		expect(local.data.ai_credentials).toEqual({ 'connection-1': 'sk-new' });
		expect(badge('connection-1')?.textContent).toBe('Untested');
	});

	test('the API key is a password field with a Show toggle', async () => {
		await section({});
		(document.getElementById('ai-add-api-provider') as HTMLAnchorElement).click();
		(document.querySelector('#ai-catalog-list [data-preset-id=""]') as HTMLButtonElement).click();
		const key = input('ai-connection-api-key');
		const toggle = document.getElementById('ai-connection-api-key-toggle') as HTMLButtonElement;

		expect(key.type).toBe('password');
		expect(toggle.textContent).toBe('Show');
		toggle.click();
		expect(key.type).toBe('text');
		expect(toggle.textContent).toBe('Hide');
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
		toggle.click();
		expect(key.type).toBe('password');
	});

	test('a custom connection validates its fields before saving', async () => {
		const { sync } = await section({});
		(document.getElementById('ai-add-api-provider') as HTMLAnchorElement).click();
		(document.querySelector('#ai-catalog-list [data-preset-id=""]') as HTMLButtonElement).click();
		const error = () => document.getElementById('ai-connection-error')!;
		const writes = sync.sets.length;

		clickSave();
		expect(error().textContent).toBe('Enter a name for this connection.');

		input('ai-connection-label').value = 'Azure';
		input('ai-connection-base-url').value = 'https://{resource-name}.openai.azure.com/openai/deployments/x/chat/completions';
		clickSave();
		expect(error().textContent).toContain('starting with https://');

		input('ai-connection-base-url').value = 'https://work.openai.azure.com/openai/deployments/x/chat/completions';
		input('ai-connection-max-concurrency').value = '0';
		clickSave();
		expect(error().textContent).toBe('Enter a whole number from 1 to 32, or leave it blank.');
		expect((document.getElementById('ai-connection-advanced') as HTMLDetailsElement).open).toBe(true);

		input('ai-connection-max-concurrency').value = '4';
		clickSave();
		await settle();

		expect(sync.sets.length).toBeGreaterThan(writes);
		expect((sync.data.ai_connections as { items: unknown[] }).items).toEqual([{
			id: 'connection-1',
			kind: 'azure-openai',
			label: 'Azure',
			baseUrl: 'https://work.openai.azure.com/openai/deployments/x/chat/completions',
			apiKeyRequired: true,
			maxConcurrency: 4
		}]);
	});

	test('editing shows the stored key and a base URL change deletes the status entry', async () => {
		const { local } = await section({
			connections: [{ ...API_CONNECTION, maxConcurrency: 2 }],
			credentials: { openai: 'sk-stored' },
			status: { openai: { state: 'ok', testedAt: 1 } }
		});
		expect(badge('openai')?.textContent).toBe('OK');

		(document.querySelector('[data-connection-id="openai"] .ai-connection-edit') as HTMLButtonElement).click();
		expect(input('ai-connection-api-key').value).toBe('sk-stored');
		expect(input('ai-connection-max-concurrency').value).toBe('2');
		expect((document.getElementById('ai-connection-advanced') as HTMLDetailsElement).open).toBe(true);

		input('ai-connection-base-url').value = 'https://proxy.example.com/v1/chat/completions';
		input('ai-connection-max-concurrency').value = '';
		clickSave();
		await settle();

		expect(local.data.ai_connection_status).toEqual({});
		expect(badge('openai')?.textContent).toBe('Untested');
		expect(document.querySelector('[data-connection-id="openai"] .ai-connection-host')?.textContent).toBe('proxy.example.com');
	});

	test('a refused save keeps the dialog open and shows the quota message', async () => {
		const { sync } = await section({});
		(document.getElementById('ai-add-api-provider') as HTMLAnchorElement).click();
		(document.querySelector('#ai-catalog-list [data-preset-id="openai"]') as HTMLButtonElement).click();
		sync.failNextSet = new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded');

		clickSave();
		await settle();

		expect(modalVisible('ai-connection-modal')).toBe(true);
		expect(document.querySelector('#ai-connection-error .ai-error-card-body')?.textContent).toContain('Wait a minute');
		expect(document.querySelectorAll('#ai-connection-list .ai-connection-card')).toHaveLength(0);
	});
});

describe('Deleting a connection', () => {
	test('asks first and cascades', async () => {
		const confirm = vi.fn(() => false);
		const { sync, local } = await section({
			connections: [API_CONNECTION],
			profiles: [GPT_PROFILE],
			routing: { defaultProfileId: 'gpt', taskProfiles: {} },
			credentials: { openai: 'sk' }
		}, confirm);
		const remove = () => (document.querySelector('[data-connection-id="openai"] .ai-connection-delete') as HTMLButtonElement).click();

		remove();
		expect(confirm).toHaveBeenCalledWith('Delete “OpenAI”? Its 1 model(s) and its API key on this device are deleted too.');
		expect((sync.data.ai_connections as { items: unknown[] }).items).toHaveLength(1);

		confirm.mockReturnValue(true);
		remove();
		await settle();

		expect(sync.data.ai_connections).toEqual({ v: 1, items: [] });
		expect(sync.data.ai_profiles).toEqual({ v: 1, items: [] });
		expect(sync.data.ai_routing).toEqual({ v: 1, taskProfiles: {} });
		expect(local.data.ai_credentials).toEqual({});
		expect(document.querySelector('[data-connection-id="openai"]')).toBeNull();
		expect(document.querySelector('#ai-profiles .ai-empty-state')).not.toBeNull();
	});
});
