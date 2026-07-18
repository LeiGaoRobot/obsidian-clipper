import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'dev');
const verify = process.argv.includes('--verify');
const mimeTypes = new Map([
	['.css', 'text/css; charset=utf-8'],
	['.html', 'text/html; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'],
	['.map', 'application/json; charset=utf-8']
]);

function findChrome() {
	const candidates = [
		process.env.CHROME_PATH,
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium'
	].filter(Boolean);
	return candidates.find(candidate => existsSync(candidate));
}

function isCompleteScreenshot(screenshot) {
	if (!existsSync(screenshot) || statSync(screenshot).size < 10_000) return false;
	const image = readFileSync(screenshot);
	return image.subarray(1, 4).toString() === 'PNG'
		&& image.readUInt32BE(16) === 1440
		&& image.readUInt32BE(20) === 1000
		&& image.subarray(-8, -4).toString() === 'IEND';
}

function stopProcessGroup(child) {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, 'SIGTERM');
	} catch {
		// The browser may already have exited after writing the screenshot.
	}
}

function captureScreenshot(chrome, args, screenshot) {
	return new Promise((resolve, reject) => {
		const child = spawn(chrome, args, {
			detached: true,
			stdio: ['ignore', 'ignore', 'pipe']
		});
		let stderr = '';
		let settled = false;
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => {
			stderr += chunk;
		});

		const finish = error => {
			if (settled) return;
			settled = true;
			clearInterval(poll);
			clearTimeout(timeout);
			stopProcessGroup(child);
			if (error) reject(error);
			else resolve();
		};
		const poll = setInterval(() => {
			if (isCompleteScreenshot(screenshot)) finish();
		}, 250);
		const timeout = setTimeout(() => {
			finish(new Error(stderr.trim() || 'Headless Chrome did not create the preview screenshot within 20 seconds.'));
		}, 20_000);

		child.on('error', finish);
		child.on('exit', code => {
			if (isCompleteScreenshot(screenshot)) finish();
			else finish(new Error(stderr.trim() || `Headless Chrome exited with code ${code}.`));
		});
	});
}

function renderPreviewDom(chrome, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(chrome, args, {
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');

		const isReady = () => stdout.includes('data-preview-ready="true"')
			&& stdout.includes('transcript-study-layout');
		const finish = error => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			stopProcessGroup(child);
			if (error) reject(error);
			else resolve();
		};
		const timeout = setTimeout(() => {
			finish(new Error(stderr.trim() || 'Headless Chrome did not execute the preview ready-state marker within 20 seconds.'));
		}, 20_000);

		child.stdout.on('data', chunk => {
			stdout += chunk;
			if (isReady()) finish();
		});
		child.stderr.on('data', chunk => {
			stderr += chunk;
		});
		child.on('error', finish);
		child.on('exit', code => {
			if (isReady()) finish();
			else finish(new Error(stderr.trim() || `Headless Chrome exited with code ${code} before the preview was ready.`));
		});
	});
}

const server = http.createServer((request, response) => {
	const pathname = new URL(request.url || '/', 'http://localhost').pathname;
	const relativePath = pathname === '/' ? 'transcript-layout-preview.html' : pathname.slice(1);
	const filePath = path.resolve(outputDir, relativePath);
	if (!filePath.startsWith(`${outputDir}${path.sep}`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
		response.writeHead(404).end('Not found');
		return;
	}
	response.setHeader('Content-Type', mimeTypes.get(path.extname(filePath)) || 'application/octet-stream');
	response.end(readFileSync(filePath));
});

server.listen(verify ? 0 : 4173, '127.0.0.1', async () => {
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Could not start preview server.');
	const url = `http://127.0.0.1:${address.port}/transcript-layout-preview.html`;
	if (!verify) {
		console.log(`Transcript preview: ${url}`);
		return;
	}

	const chrome = findChrome();
	if (!chrome) {
		server.close();
		throw new Error('Chrome or Chromium is required. Set CHROME_PATH to its executable.');
	}
	const profile = await mkdtemp(path.join(os.tmpdir(), 'clipper-preview-'));
	const screenshot = path.join(os.tmpdir(), 'obsidian-clipper-transcript-preview.png');
	const previewHtml = readFileSync(path.join(outputDir, 'transcript-layout-preview.html'), 'utf8');
	const previewScript = readFileSync(path.join(outputDir, 'transcript-layout-preview.js'), 'utf8');
	const commonArgs = [
		'--headless=new',
		'--disable-background-networking',
		'--disable-component-update',
		'--disable-default-apps',
		'--disable-extensions',
		'--disable-gpu',
		'--disable-sync',
		'--hide-scrollbars',
		'--no-first-run',
		'--run-all-compositor-stages-before-draw',
		'--virtual-time-budget=1500',
		'--window-size=1440,1000'
	];
	try {
		if (!previewHtml.includes('transcript-study-layout') || !previewScript.includes('previewReady')) {
			throw new Error('Transcript preview build is missing its ready-state marker.');
		}
		await renderPreviewDom(chrome, [
			...commonArgs,
			`--user-data-dir=${path.join(profile, 'dom')}`,
			'--dump-dom',
			url
		]);
		await rm(screenshot, { force: true });
		await captureScreenshot(chrome, [
			...commonArgs,
			`--user-data-dir=${path.join(profile, 'screenshot')}`,
			`--screenshot=${screenshot}`,
			url
		], screenshot);
		console.log(`Transcript preview passed: ${screenshot}`);
	} finally {
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});
