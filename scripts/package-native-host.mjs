import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageMetadata.version;
const buildsDirectory = path.join(root, 'builds');
const output = path.join(buildsDirectory, `obsidian-web-clipper-${version}-native-host.zip`);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'obsidian-clipper-native-host-'));

try {
	const packageRoot = path.join(temporaryRoot, 'obsidian-web-clipper-native-host');
	await mkdir(path.join(packageRoot, 'native-host'), { recursive: true });
	await mkdir(path.join(packageRoot, 'scripts'), { recursive: true });
	await mkdir(buildsDirectory, { recursive: true });
	await Promise.all([
		copyFile(
			path.join(root, 'native-host', 'obsidian-clipper-host.mjs'),
			path.join(packageRoot, 'native-host', 'obsidian-clipper-host.mjs')
		),
		copyFile(
			path.join(root, 'scripts', 'install-native-host.mjs'),
			path.join(packageRoot, 'scripts', 'install-native-host.mjs')
		),
		copyFile(path.join(root, 'LICENSE'), path.join(packageRoot, 'LICENSE'))
	]);
	await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
		name: 'obsidian-web-clipper-native-host',
		version,
		private: true,
		type: 'module',
		scripts: {
			'install:native-host': 'node scripts/install-native-host.mjs'
		}
	}, null, 2) + '\n');
	await writeFile(path.join(packageRoot, 'README.md'), `# Obsidian Web Clipper Native Messaging Host

This companion enables the Chrome extension to run a locally installed Grok CLI or Codex CLI. It supports macOS and Linux and requires Node.js 20.19 or newer.

1. Install and authenticate the Grok CLI or Codex CLI.
2. Copy the extension ID from \`chrome://extensions\`.
3. From this extracted directory, run:

\`\`\`sh
npm run install:native-host -- --extension-id <chrome-extension-id>
\`\`\`

You can override detected executable paths with \`--grok-path <path>\` or \`--codex-path <path>\`. Rerun the installer after updating either this companion or the browser extension so their protocol versions remain aligned.
`);

	await rm(output, { force: true });
	await execFileAsync('zip', ['-q', '-r', output, '.'], { cwd: packageRoot });
	console.log(`Native Messaging Host package: ${output}`);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
