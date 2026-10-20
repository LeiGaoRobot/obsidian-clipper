// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest';
import {
	buildNativeCliInstallCommand,
	wireNativeCliInstallGuide
} from './native-cli-install';

function installGuideFixture(): void {
	document.body.innerHTML = `
		<div id="native-cli-install-description"></div>
		<code id="native-cli-install-command"></code>
		<button id="native-cli-install-copy"></button>
		<div id="native-cli-install-status"></div>`;
}

describe('Native CLI install guide', () => {
	test('builds the installer command for the current extension', () => {
		expect(buildNativeCliInstallCommand(
			'abcdefghijklmnopabcdefghijklmnop',
			'/Users/example/Workspace/obsidian-clipper'
		)).toBe(
			"npm --prefix '/Users/example/Workspace/obsidian-clipper' run install:native-host -- --extension-id abcdefghijklmnopabcdefghijklmnop"
		);
		expect(buildNativeCliInstallCommand('abcdefghijklmnopabcdefghijklmnop', "/tmp/Paul's clipper"))
			.toContain("'/tmp/Paul'\\''s clipper'");
	});

	test('copies the exact command on supported Chrome platforms', async () => {
		installGuideFixture();
		const copyText = vi.fn().mockResolvedValue(undefined);
		const controller = wireNativeCliInstallGuide({
			doc: document,
			extensionId: 'abcdefghijklmnopabcdefghijklmnop',
			platform: 'mac',
			isChrome: true,
			workspaceRoot: '/Users/example/Workspace/obsidian-clipper',
			copyText
		});

		(document.getElementById('native-cli-install-copy') as HTMLButtonElement).click();
		await controller.pendingCopy();

		expect(copyText).toHaveBeenCalledWith(
			"npm --prefix '/Users/example/Workspace/obsidian-clipper' run install:native-host -- --extension-id abcdefghijklmnopabcdefghijklmnop"
		);
		expect(document.getElementById('native-cli-install-status')?.textContent)
			.toContain('copied');
		expect(document.getElementById('native-cli-install-status')?.className)
			.toContain('is-success');
	});

	test('does not offer the Chrome installer on unsupported browsers', () => {
		installGuideFixture();
		wireNativeCliInstallGuide({
			doc: document,
			extensionId: 'abcdefghijklmnopabcdefghijklmnop',
			platform: 'mac',
			isChrome: false,
			copyText: vi.fn()
		});

		expect((document.getElementById('native-cli-install-copy') as HTMLButtonElement).hidden).toBe(true);
		expect((document.getElementById('native-cli-install-command') as HTMLElement).hidden).toBe(true);
		expect(document.getElementById('native-cli-install-description')?.textContent)
			.toContain('Google Chrome on macOS and Linux');
	});

	test('keeps the command selectable when clipboard copying fails', async () => {
		installGuideFixture();
		const controller = wireNativeCliInstallGuide({
			doc: document,
			extensionId: 'abcdefghijklmnopabcdefghijklmnop',
			platform: 'linux',
			isChrome: true,
			workspaceRoot: '/home/example/obsidian-clipper',
			copyText: vi.fn().mockRejectedValue(new Error('denied'))
		});

		(document.getElementById('native-cli-install-copy') as HTMLButtonElement).click();
		await controller.pendingCopy();

		expect(document.getElementById('native-cli-install-status')?.textContent)
			.toContain('Select and copy');
		expect(document.getElementById('native-cli-install-status')?.className)
			.toContain('is-error');
		expect(document.getElementById('native-cli-install-command')?.textContent)
			.toContain('abcdefghijklmnopabcdefghijklmnop');
	});

	test('does not copy a cwd-dependent command when local source metadata is absent', () => {
		installGuideFixture();
		wireNativeCliInstallGuide({
			doc: document,
			extensionId: 'abcdefghijklmnopabcdefghijklmnop',
			platform: 'mac',
			isChrome: true,
			copyText: vi.fn()
		});

		expect((document.getElementById('native-cli-install-copy') as HTMLButtonElement).hidden).toBe(true);
		expect(document.getElementById('native-cli-install-description')?.textContent)
			.toContain('does not contain its local source path');
	});
});
