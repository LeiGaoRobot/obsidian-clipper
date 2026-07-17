import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.obsidian.web_clipper';

function parseArgs(argv) {
	const args = {};
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
		const key = value.slice(2);
		const next = argv[index + 1];
		if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}.`);
		args[key] = next;
		index++;
	}
	return args;
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveCliPath(command, explicitPath) {
	if (explicitPath) return path.resolve(explicitPath);
	try {
		return execFileSync('which', [command], { encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
}

function chromeNativeMessagingDirectory(platform, home, env) {
	if (platform === 'darwin') {
		return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
	}
	if (platform === 'linux') {
		return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'google-chrome', 'NativeMessagingHosts');
	}
	throw new Error('Native CLI installation currently supports macOS and Linux only.');
}

function validateExtensionId(extensionId) {
	if (!/^[a-p]{32}$/.test(extensionId)) {
		throw new Error('Chrome extension ID must be 32 lowercase letters from a through p.');
	}
}

export function installNativeHost({
	extensionId,
	grokPath,
	codexPath,
	home = os.homedir(),
	platform = process.platform,
	env = process.env,
	nodePath = process.execPath,
	workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}) {
	validateExtensionId(extensionId);
	const sourceHost = path.join(workspaceRoot, 'native-host', 'obsidian-clipper-host.mjs');
	const installDirectory = path.join(home, '.config', 'obsidian-web-clipper', 'native-host');
	const nativeMessagingDirectory = chromeNativeMessagingDirectory(platform, home, env);
	const installedHost = path.join(installDirectory, 'obsidian-clipper-host.mjs');
	const configFile = path.join(installDirectory, 'config.json');
	const launcher = path.join(installDirectory, 'obsidian-clipper-host-launcher');
	const manifestFile = path.join(nativeMessagingDirectory, `${HOST_NAME}.json`);

	mkdirSync(installDirectory, { recursive: true });
	mkdirSync(nativeMessagingDirectory, { recursive: true });
	copyFileSync(sourceHost, installedHost);
	writeFileSync(configFile, JSON.stringify({
		grokPath: resolveCliPath('grok', grokPath),
		codexPath: resolveCliPath('codex', codexPath)
	}, null, 2) + '\n');
	writeFileSync(launcher, `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(installedHost)} "$@"\n`);
	chmodSync(launcher, 0o755);
	writeFileSync(manifestFile, JSON.stringify({
		name: HOST_NAME,
		description: 'Obsidian Web Clipper local Grok and Codex CLI bridge',
		path: launcher,
		type: 'stdio',
		allowed_origins: [`chrome-extension://${extensionId}/`]
	}, null, 2) + '\n');

	return { configFile, launcher, manifestFile };
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args['extension-id']) {
		throw new Error('Usage: npm run install:native-host -- --extension-id <chrome-extension-id> [--grok-path <path>] [--codex-path <path>]');
	}
	const result = installNativeHost({
		extensionId: args['extension-id'],
		grokPath: args['grok-path'],
		codexPath: args['codex-path']
	});
	console.log(`Installed ${HOST_NAME} for chrome-extension://${args['extension-id']}/`);
	console.log(`Native host manifest: ${result.manifestFile}`);
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
