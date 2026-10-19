// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AiError } from '../../ai/errors';
import { createAiSettingsController } from './controller';
import { renderErrorCard } from './error-card';
import { initializeAiSettings } from './index';
import { createNativeCliPanel } from './native-cli';
import {
	API_CONNECTION,
	CODEX_CONNECTION,
	createFakeStore,
	installGuideEnvironment,
	loadSettingsDocument,
	settle,
	type FakeSettings
} from './test-support';
import type { NativeCliInstallEnvironment } from './native-cli';

const INSTALL_COMMAND = "npm --prefix '/Users/example/obsidian-clipper' run install:native-host -- --extension-id abcdefghijklmnopabcdefghijklmnop";

async function section(settings: FakeSettings, installGuide: NativeCliInstallEnvironment = installGuideEnvironment()) {
	const fake = createFakeStore(settings);
	let next = 0;
	const handle = await initializeAiSettings({
		store: fake.store,
		createId: prefix => `${prefix}-${++next}`,
		installGuide
	});
	return { ...fake, handle };
}

function control(): HTMLElement {
	return document.getElementById('ai-add-local-cli')!;
}

// jsdom resolves `#id` through getElementById, which finds the old Interpreter section's copy of
// the guide ids first; an attribute selector stays inside the AI section.
function guide(id: string): HTMLElement | null {
	return control().querySelector(`[id="${id}"]`);
}

function addButton(kind: string): HTMLButtonElement {
	return control().querySelector(`.ai-add-cli-button[data-kind="${kind}"]`) as HTMLButtonElement;
}

beforeEach(() => {
	loadSettingsDocument();
});

describe('Add local CLI', () => {
	test('is hidden where the browser has no Native Messaging', async () => {
		await section({ connections: [CODEX_CONNECTION], nativeMessaging: 'none' });
		expect(control().hidden).toBe(true);
	});

	test.each(['port', 'message'] as const)('is shown with the install guide when Native Messaging is %s', async nativeMessaging => {
		await section({ nativeMessaging });
		expect(control().hidden).toBe(false);
		expect(guide('native-cli-install-command')?.textContent).toBe(INSTALL_COMMAND);
	});

	test('allows one connection per CLI kind', async () => {
		const { sync } = await section({ connections: [API_CONNECTION] });
		expect(addButton('cli-codex').disabled).toBe(false);
		expect(addButton('cli-grok').disabled).toBe(false);

		addButton('cli-grok').click();
		await settle();

		expect(addButton('cli-grok').disabled).toBe(true);
		expect(addButton('cli-grok').title).toBe('Grok CLI is already added.');
		expect(addButton('cli-codex').disabled).toBe(false);
		expect((sync.data.ai_connections as { items: unknown[] }).items).toEqual([
			API_CONNECTION,
			{ id: 'cli-1', kind: 'cli-grok', label: '' }
		]);
		expect(sync.data.ai_profiles).toEqual({ v: 1, items: [{ id: 'profile-2', connectionId: 'cli-1', label: '', enabled: true }] });
		expect(document.querySelector('[data-connection-id="cli-1"] .ai-connection-name')?.textContent).toBe('Grok CLI');
		expect(document.querySelector('.ai-profile-group[data-connection-id="cli-1"] .ai-profile-name')?.textContent).toBe('CLI default model');
	});

	test('an existing CLI connection disables its kind on load', async () => {
		await section({ connections: [CODEX_CONNECTION] });
		expect(addButton('cli-codex').disabled).toBe(true);
	});
});

describe('Native CLI install guide in the AI section', () => {
	test('keeps the guide element ids and copies the exact command', async () => {
		const copyText = vi.fn(async () => undefined);
		await section({}, installGuideEnvironment({ copyText }));
		for (const id of ['native-cli-install-description', 'native-cli-install-command', 'native-cli-install-copy', 'native-cli-install-status']) {
			expect(guide(id)).not.toBeNull();
		}

		(guide('native-cli-install-copy') as HTMLButtonElement).click();
		await settle();

		expect(copyText).toHaveBeenCalledWith(INSTALL_COMMAND);
		expect(guide('native-cli-install-status')?.className).toContain('is-success');
	});

	test('explains when the installer is not offered on this browser', async () => {
		await section({}, installGuideEnvironment({ isChrome: false }));
		expect(guide('native-cli-install-description')?.textContent).toContain('Chrome');
		expect((guide('native-cli-install-copy') as HTMLButtonElement).hidden).toBe(true);
	});

	test('the error card copy action uses the guide', async () => {
		const copyText = vi.fn(async () => undefined);
		const { store } = createFakeStore({});
		const controller = createAiSettingsController({ store });
		await controller.load();
		const panel = createNativeCliPanel({
			doc: document,
			controller,
			container: control(),
			installGuide: installGuideEnvironment({ copyText })
		});
		panel.render(controller.state);
		const card = document.getElementById('ai-settings-error')!;

		renderErrorCard(card, new AiError('host-missing'), { handlers: { copyInstallCommand: () => panel.copyInstallCommand() } });
		expect(card.querySelector('.ai-error-card-title')?.textContent).toBe('Local CLI host not installed');
		(card.querySelector('.ai-error-card-action') as HTMLButtonElement).click();
		await panel.pendingCopy();

		expect(copyText).toHaveBeenCalledWith(INSTALL_COMMAND);
	});
});
