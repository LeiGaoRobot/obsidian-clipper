import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'dist_safari');
const appName = 'Obsidian Clipper Package Test';
const bundleIdentifier = 'md.obsidian.clipper.package-test';

function run(command, args, cwd = root) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding('utf8');
			stream.on('data', chunk => { output += chunk; });
		}
		child.on('error', reject);
		child.on('close', code => {
			if (code === 0) resolve(output);
			else reject(new Error(`${command} exited with ${code}.\n${output.slice(-12_000)}`));
		});
	});
}

if (!existsSync(path.join(extensionPath, 'manifest.json'))) {
	throw new Error('Built Safari extension is missing. Run npm run build:safari first.');
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'obsidian-clipper-safari-'));
try {
	const conversionOutput = await run('xcrun', [
		'safari-web-extension-converter',
		extensionPath,
		'--project-location', temporaryRoot,
		'--app-name', appName,
		'--bundle-identifier', bundleIdentifier,
		'--copy-resources',
		'--no-open',
		'--no-prompt',
		'--force'
	]);
	if (conversionOutput.includes('not supported by your current version of Safari')) {
		throw new Error(`Safari reported unsupported manifest keys.\n${conversionOutput}`);
	}

	const project = path.join(temporaryRoot, appName, `${appName}.xcodeproj`);
	const derivedData = path.join(temporaryRoot, 'DerivedData');
	await run('xcodebuild', [
		'-project', project,
		'-scheme', `${appName} (macOS)`,
		'-configuration', 'Debug',
		'-destination', 'platform=macOS',
		'-derivedDataPath', derivedData,
		'CODE_SIGNING_ALLOWED=NO',
		'-quiet',
		'build'
	]);

	const resources = path.join(
		derivedData,
		'Build',
		'Products',
		'Debug',
		`${appName}.app`,
		'Contents',
		'PlugIns',
		`${appName} Extension.appex`,
		'Contents',
		'Resources'
	);
	for (const resource of [
		'manifest.json',
		'reader-script.js',
		'chunks/reader-content-extraction.js',
		'chunks/reader-syntax-highlighting.js',
		'_locales/en/messages.json',
		'_locales/zh_CN/messages.json'
	]) {
		if (!existsSync(path.join(resources, resource))) {
			throw new Error(`Converted Safari app is missing ${resource}.`);
		}
	}

	console.log('Safari Web Extension conversion and unsigned macOS app build passed.');
} finally {
	await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
