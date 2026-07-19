import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

function isCompleteScreenshot(screenshot, width, height) {
	if (!existsSync(screenshot) || statSync(screenshot).size < 10_000) return false;
	const image = readFileSync(screenshot);
	return image.subarray(1, 4).toString() === 'PNG'
		&& image.readUInt32BE(16) === width
		&& image.readUInt32BE(20) === height
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

function connectCdp(webSocketUrl) {
	if (typeof WebSocket === 'undefined') {
		throw new Error('Transcript preview screenshots require a Node.js runtime with WebSocket support.');
	}
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(webSocketUrl);
		const pending = new Map();
		let nextId = 1;
		const rejectPending = error => {
			for (const request of pending.values()) request.reject(error);
			pending.clear();
		};
		socket.addEventListener('open', () => {
			resolve({
				close: () => socket.close(),
				send: (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
					const id = nextId++;
					pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
					socket.send(JSON.stringify({ id, method, params }));
				})
			});
		});
		socket.addEventListener('message', event => {
			if (typeof event.data !== 'string') return;
			const message = JSON.parse(event.data);
			if (!message.id || !pending.has(message.id)) return;
			const request = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) request.reject(new Error(message.error.message));
			else request.resolve(message.result);
		});
		socket.addEventListener('error', () => {
			const error = new Error('Could not connect to the Chrome DevTools screenshot target.');
			rejectPending(error);
			reject(error);
		});
		socket.addEventListener('close', () => {
			rejectPending(new Error('Chrome DevTools closed before the screenshot completed.'));
		});
	});
}

async function waitForValue(probe, failureMessage, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error(lastError?.message ? `${failureMessage} ${lastError.message}` : failureMessage);
}

async function captureScreenshot({ chrome, args, profileDir, url, preview, screenshot }) {
	const { layout, controls, width, height, interaction } = preview;
	const child = spawn(chrome, [
		...args.filter(arg => !arg.startsWith('--virtual-time-budget=')),
		'--remote-debugging-port=0',
		'--remote-allow-origins=*',
		'about:blank'
	], {
		detached: true,
		stdio: ['ignore', 'ignore', 'pipe']
	});
	let stderr = '';
	let launchError;
	let cdp;
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', chunk => {
		stderr += chunk;
	});
	child.on('error', error => {
		launchError = error;
	});

	try {
		const port = await waitForValue(() => {
			if (launchError) throw launchError;
			const portFile = path.join(profileDir, 'DevToolsActivePort');
			if (!existsSync(portFile)) return undefined;
			return Number.parseInt(readFileSync(portFile, 'utf8').split('\n')[0], 10) || undefined;
		}, stderr.trim() || 'Chrome did not expose a DevTools port for the preview screenshot.');
		const target = await waitForValue(async () => {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`);
			if (!response.ok) return undefined;
			const targets = await response.json();
			return targets.find(candidate => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
		}, 'Chrome did not expose a page target for the preview screenshot.');
		cdp = await connectCdp(target.webSocketDebuggerUrl);
		await cdp.send('Page.enable');
		await cdp.send('Runtime.enable');
		await cdp.send('Emulation.setDeviceMetricsOverride', {
			width,
			height,
			deviceScaleFactor: 1,
			mobile: false
		});
		await cdp.send('Page.navigate', { url });
		const waitForPreviewState = expectedControls => waitForValue(async () => {
			const ready = await cdp.send('Runtime.evaluate', {
				expression: `(() => {
					const html = document.documentElement;
					if (html.dataset.previewReady !== 'true'
						|| html.dataset.previewLayout !== '${layout}'
						|| html.dataset.previewControls !== '${expectedControls}') return false;
					const root = document.querySelector('.transcript-study-layout');
					const details = document.querySelector('.player-controls-more');
					const panel = document.querySelector('.player-controls-panel');
					if (!root || !details || !panel) return false;
					if ('${expectedControls}' === 'closed') return panel.parentElement === details;
					const stickyControls = document.querySelector('.player-toggles');
					const active = document.querySelector('.transcript-segment.is-active');
					if (!stickyControls || !active || panel.parentElement !== root) return false;
					const controlsRect = stickyControls.getBoundingClientRect();
					const activeRect = active.getBoundingClientRect();
					const panelRect = panel.getBoundingClientRect();
					return panelRect.top >= 0
						&& panelRect.bottom <= innerHeight
						&& activeRect.top >= controlsRect.bottom
						&& activeRect.bottom <= panelRect.top;
				})()`
			});
			return ready.result?.value === true;
		}, `Chrome did not reach the expected ${layout}/${expectedControls} transcript preview state.`);
		await waitForPreviewState(preview.initialControls || controls);
		if (interaction === 'cycle-controls') {
			const click = async selector => {
				const result = await cdp.send('Runtime.evaluate', {
					expression: `(() => {
						const target = document.querySelector('${selector}');
						if (!target) return false;
						target.click();
						return true;
					})()`
				});
				if (result.result?.value !== true) {
					throw new Error(`Could not click ${selector} in the transcript preview.`);
				}
			};
			await click('.player-controls-more > summary');
			await waitForPreviewState('open');
			await click('[data-preview-close-controls]');
			await waitForPreviewState('closed');
			await click('.player-controls-more > summary');
		}
		await waitForPreviewState(controls);
		await cdp.send('Runtime.evaluate', {
			expression: 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
			awaitPromise: true
		});
		const capture = await cdp.send('Page.captureScreenshot', {
			format: 'png',
			fromSurface: true,
			captureBeyondViewport: false
		});
		await writeFile(screenshot, Buffer.from(capture.data, 'base64'));
		if (!isCompleteScreenshot(screenshot, width, height)) {
			throw new Error(`Chrome created an incomplete ${width}x${height} transcript preview screenshot.`);
		}
	} finally {
		cdp?.close();
		stopProcessGroup(child);
	}
}

function renderPreviewDom(chrome, args, expectedLayout, expectedControls) {
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
			&& stdout.includes(`data-preview-layout="${expectedLayout}"`)
			&& stdout.includes(`data-preview-controls="${expectedControls}"`)
			&& stdout.includes(`data-preview-panel-host="${expectedControls === 'open' ? 'root' : 'details'}"`)
			&& stdout.includes(`transcript-layout-${expectedLayout}`)
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
		'--force-device-scale-factor=1'
	];
	const previews = [
		{ name: 'reading-desktop', layout: 'reading', controls: 'closed', width: 1440, height: 1000 },
		{ name: 'study-tools-desktop', layout: 'notebook', controls: 'closed', width: 1440, height: 1000 },
		{ name: 'split-desktop', layout: 'focus', controls: 'closed', width: 1440, height: 1000 },
		{ name: 'split-768', layout: 'focus', controls: 'closed', width: 768, height: 900 },
		{
			name: 'split-768-controls-open',
			layout: 'focus',
			controls: 'open',
			initialControls: 'closed',
			interaction: 'cycle-controls',
			width: 768,
			height: 900
		}
	];
	try {
		if (!previewHtml.includes('transcript-study-layout') || !previewScript.includes('previewReady')) {
			throw new Error('Transcript preview build is missing its ready-state marker.');
		}
		for (const preview of previews) {
			const previewUrl = `${url}?layout=${preview.layout}&controls=${preview.controls}`;
			const screenshotUrl = `${url}?layout=${preview.layout}&controls=${preview.initialControls || preview.controls}`;
			const screenshot = path.join(os.tmpdir(), `obsidian-clipper-transcript-preview-${preview.name}.png`);
			const windowSize = `--window-size=${preview.width},${preview.height}`;
			await renderPreviewDom(chrome, [
				...commonArgs,
				windowSize,
				`--user-data-dir=${path.join(profile, `dom-${preview.name}`)}`,
				'--dump-dom',
				previewUrl
			], preview.layout, preview.controls);
			await rm(screenshot, { force: true });
			const screenshotProfile = path.join(profile, `screenshot-${preview.name}`);
			await captureScreenshot({
				chrome,
				args: [
					...commonArgs,
					windowSize,
					`--user-data-dir=${screenshotProfile}`
				],
				profileDir: screenshotProfile,
				url: screenshotUrl,
				preview,
				screenshot
			});
			console.log(`Transcript preview passed (${preview.name}): ${screenshot}`);
		}
	} finally {
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});
