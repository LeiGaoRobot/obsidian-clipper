// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CATALOG } from '../../ai/catalog';
import type { TestConnectionOptions } from '../../ai/client';
import { AiError } from '../../ai/errors';
import type { AiTestResult } from '../../ai/types';
import { initializeAiSettings, type InitializeAiSettingsOptions } from './index';
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

async function section(
	settings: FakeSettings,
	confirm: (message: string) => boolean = () => true,
	extra: Partial<InitializeAiSettingsOptions> = {}
) {
	const fake = createFakeStore(settings);
	const handle = await initializeAiSettings({
		store: fake.store,
		createId: sequentialIds(),
		installGuide: installGuideEnvironment(),
		confirm,
		session: null,
		...extra
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

	test('show the name, host, and kind icon, and a Test button', async () => {
		await section({ connections: [API_CONNECTION, CODEX_CONNECTION], credentials: { openai: 'sk' } });
		const card = document.querySelector('[data-connection-id="openai"]')!;
		expect(card.querySelector('.ai-connection-name')?.textContent).toBe('OpenAI');
		expect(card.querySelector('.ai-connection-host')?.textContent).toBe('api.openai.com');
		expect(card.querySelector('.ai-kind-icon')?.className).toContain('icon-openai');
		expect(card.querySelector('.ai-connection-edit')).not.toBeNull();
		expect(document.querySelector('[data-connection-id="codex"] .ai-connection-edit')).toBeNull();
		expect(document.querySelector('[data-connection-id="codex"] .ai-connection-name')?.textContent).toBe('Codex CLI');
		expect(card.querySelector('.ai-connection-test')?.textContent).toBe('Test');
		// OpenAI's own API is only listed: no billable step, no cost note.
		expect(card.querySelector('.ai-connection-cost-note')).toBeNull();
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

describe('Connection Test', () => {
	const DEEPSEEK = {
		id: 'deepseek',
		kind: 'openai-compatible' as const,
		label: 'DeepSeek',
		presetId: 'deepseek',
		baseUrl: 'https://api.deepseek.com/v1/chat/completions',
		apiKeyRequired: true
	};
	const CHAT = { id: 'chat', connectionId: 'deepseek', model: 'deepseek-chat', label: 'Chat', enabled: true };
	const OLD = { id: 'old', connectionId: 'deepseek', model: 'deepseek-old', label: 'Old', enabled: true };

	interface PendingTest {
		connectionId: string;
		options: TestConnectionOptions;
		resolve(result: AiTestResult): void;
		reject(error: unknown): void;
	}

	async function testSection(settings: FakeSettings, extra: Partial<InitializeAiSettingsOptions> = {}) {
		const pending: PendingTest[] = [];
		const runTest = vi.fn((connectionId: string, options: TestConnectionOptions) => new Promise<AiTestResult>((resolve, reject) => {
			pending.push({ connectionId, options, resolve, reject });
			options.signal?.addEventListener('abort', () => reject(new AiError('cancelled')));
		}));
		const result = await section(settings, () => true, { runTest, isTrusted: () => true, ...extra });
		return { ...result, pending, runTest };
	}

	const item = (id: string) => document.querySelector(`.ai-connection-item[data-connection-id="${id}"]`)!;
	const testButton = (id: string) => item(id).querySelector('.ai-connection-test') as HTMLButtonElement;
	const progress = (id: string) => item(id).querySelector('.ai-connection-test-progress')?.textContent;

	test('shows the cost note above Test for billable plans only', async () => {
		await testSection({
			connections: [API_CONNECTION, DEEPSEEK, CODEX_CONNECTION, LOCAL_CONNECTION],
			profiles: [CHAT, GPT_PROFILE],
			credentials: { openai: 'sk', deepseek: 'sk' }
		});
		const note = (id: string) => item(id).querySelector('.ai-connection-cost-note');
		// Listing only: free. Ollama is listed and probed for nothing without a profile.
		expect(note('openai')).toBeNull();
		expect(note('ollama')).toBeNull();
		expect(note('deepseek')?.textContent).toContain('may bill');
		expect(note('codex')?.textContent).toContain('CLI');
		const panel = item('deepseek').querySelector('.ai-connection-test-panel')!;
		expect(panel.firstElementChild?.classList.contains('ai-connection-cost-note')).toBe(true);
	});

	test('an untrusted click does not run Test', async () => {
		const { runTest } = await testSection({ connections: [DEEPSEEK], profiles: [CHAT], credentials: { deepseek: 'sk' } }, { isTrusted: () => false });
		testButton('deepseek').click();
		await settle();
		expect(runTest).not.toHaveBeenCalled();
		expect(progress('deepseek')).toBeUndefined();
	});

	test('the default guard rejects synthetic clicks', async () => {
		const runTest = vi.fn();
		await section({ connections: [DEEPSEEK], profiles: [CHAT], credentials: { deepseek: 'sk' } }, () => true, { runTest });
		testButton('deepseek').click();
		await settle();
		expect(runTest).not.toHaveBeenCalled();
	});

	test('shows steps while running, then the OK badge, and writes the detected structured output', async () => {
		const { pending, runTest, sync, local } = await testSection({ connections: [DEEPSEEK], profiles: [CHAT, OLD], credentials: { deepseek: 'sk' } });
		testButton('deepseek').click();
		await settle();

		// Only the connection id goes to the gateway, which resolves the key itself.
		expect(runTest.mock.calls[0][0]).toBe('deepseek');
		expect(testButton('deepseek').disabled).toBe(true);
		expect(progress('deepseek')).toBeTruthy();
		pending[0].options.onStep?.('listing');
		expect(progress('deepseek')).toContain('listing models');
		pending[0].options.onStep?.('structured');
		expect(progress('deepseek')).toContain('structured output');

		// The gateway stores the status on this device before it answers.
		await local.set({ ai_connection_status: { deepseek: { state: 'ok', testedAt: 1, models: [{ profileId: 'chat', model: 'deepseek-chat', listed: true }, { profileId: 'old', model: 'deepseek-old', listed: false }] } } });
		pending[0].resolve({
			connectionId: 'deepseek',
			state: 'ok',
			testedAt: 1,
			billable: true,
			structuredOutput: 'json_schema',
			listedModels: ['deepseek-chat', 'deepseek-reasoner'],
			models: [{ profileId: 'chat', model: 'deepseek-chat', listed: true }, { profileId: 'old', model: 'deepseek-old', listed: false }]
		});
		await settle();

		expect(badge('deepseek')?.textContent).toBe('OK');
		expect(progress('deepseek')).toBeUndefined();
		expect(testButton('deepseek').disabled).toBe(false);
		const result = item('deepseek').querySelector('.ai-connection-test-result')!;
		expect(result.classList.contains('is-ok')).toBe(true);
		expect(result.textContent).toContain('1 of 2 models');
		expect(result.textContent).toContain('Not listed: deepseek-old');
		expect(result.textContent).toContain('JSON schema');
		expect(result.textContent).toContain('may bill');
		const stored = sync.data.ai_connections as { items: Array<{ id: string; structuredOutput?: string }> };
		expect(stored.items.find(entry => entry.id === 'deepseek')?.structuredOutput).toBe('json_schema');
		// Model not listed on the profile row, only for the unlisted model.
		expect(document.querySelector('[data-profile-id="old"] .ai-profile-model-not-listed')?.textContent).toBe('Model not listed');
		expect(document.querySelector('[data-profile-id="chat"] .ai-profile-model-not-listed')).toBeNull();
		// The last listing feeds the model suggestions.
		(document.querySelector('.ai-profile-group[data-connection-id="deepseek"] .ai-add-profile, [data-connection-id="deepseek"] .ai-add-profile') as HTMLElement).click();
		expect(Array.from(document.querySelectorAll<HTMLOptionElement>('#ai-profile-model-options option')).map(option => option.value))
			.toEqual(['deepseek-chat', 'deepseek-reasoner']);
	});

	test('a failing result shows the error card, whose Try again runs Test again', async () => {
		const { pending, runTest } = await testSection({ connections: [DEEPSEEK], profiles: [CHAT], credentials: { deepseek: 'sk' } });
		testButton('deepseek').click();
		await settle();
		pending[0].resolve({
			connectionId: 'deepseek',
			state: 'failing',
			testedAt: 1,
			billable: false,
			error: { code: 'rate-limited', retryable: true, status: 429, detail: 'slow down' }
		});
		await settle();

		expect(badge('deepseek')?.textContent).toContain('Failing');
		const card = item('deepseek').querySelector('.ai-connection-test-result.is-failing .ai-error-card')!;
		expect(card.querySelector('.ai-error-card-detail code')?.textContent).toBe('slow down');
		const retry = card.querySelector('.ai-error-card-action') as HTMLButtonElement;
		expect(retry.textContent).toBe('Try again');
		retry.click();
		await settle();
		expect(runTest).toHaveBeenCalledTimes(2);
	});

	test('a missing CLI host offers the install command', async () => {
		const copyText = vi.fn(async () => undefined);
		const { pending } = await testSection({ connections: [CODEX_CONNECTION] }, { installGuide: installGuideEnvironment({ copyText }) });
		expect(item('codex').querySelector('.ai-connection-cost-note')).not.toBeNull();
		testButton('codex').click();
		await settle();
		pending[0].options.onStep?.('health');
		expect(progress('codex')).toContain('CLI host');
		pending[0].reject(new AiError('host-missing', { detail: 'Specified native messaging host not found.' }));
		await settle();
		const action = item('codex').querySelector('.ai-error-card-action') as HTMLButtonElement;
		expect(action.textContent).toBe('Copy install command');
		action.click();
		await settle();
		expect(copyText).toHaveBeenCalled();
	});

	test('Cancel stops a running Test without a result', async () => {
		const { pending } = await testSection({ connections: [DEEPSEEK], profiles: [CHAT], credentials: { deepseek: 'sk' } });
		testButton('deepseek').click();
		await settle();
		(item('deepseek').querySelector('.ai-connection-test-cancel') as HTMLButtonElement).click();
		await settle();
		expect(pending[0].options.signal?.aborted).toBe(true);
		expect(item('deepseek').querySelector('.ai-connection-test-result')).toBeNull();
		expect(progress('deepseek')).toBeUndefined();
		expect(badge('deepseek')?.textContent).toBe('Untested');
	});

	test('Test is disabled while a save is pending', async () => {
		const { handle, sync, runTest } = await testSection({ connections: [DEEPSEEK], profiles: [CHAT], credentials: { deepseek: 'sk' } });
		let release!: () => void;
		const set = sync.set.bind(sync);
		sync.set = async values => {
			await new Promise<void>(resolve => { release = resolve; });
			return set(values);
		};
		const saving = handle.controller.setAutoRun(true);
		await settle();
		expect(testButton('deepseek').disabled).toBe(true);
		testButton('deepseek').click();
		await settle();
		expect(runTest).not.toHaveBeenCalled();

		release();
		await saving;
		await settle();
		expect(testButton('deepseek').disabled).toBe(false);
	});
});
