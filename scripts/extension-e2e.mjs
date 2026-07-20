import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	createTranscriptCheckpointState,
	createYouTubeTranscriptFixtureHtml,
	transcriptReadings,
	transcriptTranslations
} from './transcript-e2e-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'dist');

function findChrome() {
	const testingRoot = path.join(os.homedir(), '.cache', 'obsidian-clipper', 'chrome');
	const testingChrome = existsSync(testingRoot)
		? readdirSync(testingRoot)
			.filter(name => name.startsWith('mac_arm-'))
			.sort()
			.reverse()
			.map(name => path.join(
				testingRoot,
				name,
				'chrome-mac-arm64',
				'Google Chrome for Testing.app',
				'Contents',
				'MacOS',
				'Google Chrome for Testing'
			))
			.find(existsSync)
		: undefined;
	return [
		process.env.CHROME_PATH,
		testingChrome,
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium'
	].filter(Boolean).find(existsSync);
}

function stopProcessGroup(child) {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, 'SIGTERM');
	} catch {
		// Chrome may already have exited.
	}
}

async function waitForValue(probe, message, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const result = await probe();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, 75));
	}
	throw new Error(lastError?.message ? `${message} ${lastError.message}` : message);
}

function connectCdp(webSocketUrl) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(webSocketUrl);
		const pending = new Map();
		const listeners = new Map();
		let sequence = 1;
		socket.addEventListener('open', () => resolve({
			close: () => socket.close(),
			on: (method, listener) => {
				const entries = listeners.get(method) || [];
				entries.push(listener);
				listeners.set(method, entries);
			},
			send: (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
				const id = sequence++;
				pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest });
				socket.send(JSON.stringify({ id, method, params }));
			})
		}));
		socket.addEventListener('message', event => {
			if (typeof event.data !== 'string') return;
			const message = JSON.parse(event.data);
			if (message.id && pending.has(message.id)) {
				const request = pending.get(message.id);
				pending.delete(message.id);
				if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
				else request.resolve(message.result);
				return;
			}
			for (const listener of listeners.get(message.method) || []) listener(message.params);
		});
		socket.addEventListener('error', () => reject(new Error(`Could not connect to CDP target ${webSocketUrl}.`)));
	});
}

async function evaluate(cdp, expression) {
	const result = await cdp.send('Runtime.evaluate', {
		expression,
		awaitPromise: true,
		returnByValue: true,
		userGesture: true
	});
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	}
	return result.result?.value;
}

async function listTargets(port) {
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	if (!response.ok) return [];
	return response.json();
}

async function browserTarget(port) {
	const response = await fetch(`http://127.0.0.1:${port}/json/version`);
	if (!response.ok) throw new Error('Chrome did not expose its browser DevTools target.');
	return response.json();
}

const fixtureHtml = createYouTubeTranscriptFixtureHtml(
	'Reader integration fixture',
	'const verified = true;'
);

if (!existsSync(path.join(extensionPath, 'manifest.json'))) {
	throw new Error('Built Chrome extension is missing. Run npm run build:chrome first.');
}
const chrome = findChrome();
if (!chrome) throw new Error('Chrome or Chromium is required. Set CHROME_PATH to its executable.');

const server = http.createServer((_request, response) => {
	response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
	response.end(fixtureHtml);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Could not start the Reader E2E fixture server.');
const fixtureUrl = `http://youtube.com.localhost:${address.port}/watch?v=test`;

const profile = await mkdtemp(path.join(os.tmpdir(), 'clipper-extension-e2e-'));
const child = spawn(chrome, [
	'--disable-background-networking',
	'--disable-component-update',
	'--disable-default-apps',
	'--disable-gpu',
	'--disable-sync',
	'--enable-unsafe-extension-debugging',
	'--no-default-browser-check',
	'--no-first-run',
	'--remote-debugging-port=0',
	'--remote-allow-origins=*',
	`--user-data-dir=${profile}`,
	'--window-size=1200,900',
	'about:blank'
], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });
const clients = [];

try {
	const checkpointState = createTranscriptCheckpointState();
	const port = await waitForValue(() => {
		const file = path.join(profile, 'DevToolsActivePort');
		return existsSync(file) ? Number(readFileSync(file, 'utf8').split('\n')[0]) : undefined;
	}, stderr || 'Chrome did not expose a DevTools port.');
	const browserInfo = await browserTarget(port);
	const browser = await connectCdp(browserInfo.webSocketDebuggerUrl);
	clients.push(browser);
	const { id: extensionId } = await browser.send('Extensions.loadUnpacked', {
		path: extensionPath,
		enableInIncognito: false
	});
	if (!extensionId) throw new Error('Chrome did not return an ID for the unpacked extension.');
	const blankTarget = await waitForValue(async () => (
		(await listTargets(port)).find(target => target.type === 'page')
	), 'Chrome did not expose a page target.');
	const settings = await connectCdp(blankTarget.webSocketDebuggerUrl);
	clients.push(settings);
	await settings.send('Page.enable');
	await settings.send('Runtime.enable');
	const settingsErrors = [];
	settings.on('Runtime.exceptionThrown', event => settingsErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Settings exception'));
	settings.on('Runtime.consoleAPICalled', event => {
		if (event.type === 'error') settingsErrors.push(event.args?.map(item => item.value || item.description).join(' '));
	});
	const workerTarget = await waitForValue(async () => (
		(await listTargets(port)).find(target => (
			target.type === 'service_worker'
			&& target.url === `chrome-extension://${extensionId}/background.js`
		))
	), `The unpacked extension service worker did not start.${stderr.trim() ? ` Chrome: ${stderr.trim()}` : ''}`);
	const worker = await connectCdp(workerTarget.webSocketDebuggerUrl);
	clients.push(worker);
	const runtimeErrors = [];
	worker.on('Runtime.exceptionThrown', event => runtimeErrors.push(event.exceptionDetails?.text || 'Worker exception'));
	worker.on('Runtime.consoleAPICalled', event => {
		if (event.type === 'error') runtimeErrors.push(event.args?.map(item => item.value || item.description).join(' '));
	});
	await worker.send('Runtime.enable');
	const settingsUrl = `chrome-extension://${extensionId}/settings.html`;
	await settings.send('Page.navigate', { url: settingsUrl });
	await waitForValue(async () => evaluate(settings, `
		location.href.startsWith(${JSON.stringify(settingsUrl)})
		&& document.readyState === 'complete'
		&& Boolean(document.querySelector('#reader-transcript-layout'))
		&& document.querySelectorAll('#language-select option').length > 10
	`), 'The settings page did not load.').catch(async error => {
		const diagnostics = await evaluate(settings, `({
			href: location.href,
			readyState: document.readyState,
			languageOptions: document.querySelectorAll('#language-select option').length,
			layout: document.querySelector('#reader-transcript-layout')?.value,
			body: document.body?.innerText?.slice(0, 500)
		})`);
		throw new Error(`${error.message} ${JSON.stringify({ diagnostics, settingsErrors })}`);
	});
	const settingsEnvironment = await evaluate(settings, `({
		href: location.href,
		title: document.title,
		body: document.body?.innerText?.slice(0, 200),
		chromeRuntime: typeof chrome !== 'undefined' ? typeof chrome.runtime : 'missing',
		chromeStorage: typeof chrome !== 'undefined' ? typeof chrome.storage : 'missing'
	})`);
	if (settingsEnvironment.chromeStorage !== 'object') {
		throw new Error(`The unpacked extension settings page did not expose Chrome storage APIs: ${JSON.stringify(settingsEnvironment)}`);
	}
	const pagePickManifest = await evaluate(settings, `(async () => {
		const manifest = chrome.runtime.getManifest();
		const iconPath = manifest.icons?.['48'];
		const iconResponse = iconPath ? await fetch(chrome.runtime.getURL(iconPath)) : null;
		return {
			name: manifest.name,
			description: manifest.description,
			homepage: manifest.homepage_url,
			iconPath,
			iconStatus: iconResponse?.status
		};
	})()`);
	if (
		pagePickManifest.name !== 'PagePick for Obsidian'
		|| !pagePickManifest.description?.includes('independent')
		|| pagePickManifest.homepage !== 'https://github.com/LeiGaoRobot/obsidian-clipper'
		|| pagePickManifest.iconPath !== 'icons/pagepick48.png'
		|| pagePickManifest.iconStatus !== 200
	) {
		throw new Error(`The unpacked extension did not expose the PagePick Chrome identity: ${JSON.stringify(pagePickManifest)}`);
	}
	const settingsBranding = await waitForValue(async () => {
		const branding = await evaluate(settings, `(() => {
			const logo = document.querySelector('#settings-sidebar-title img.logo');
			return {
				title: document.title,
				navbarTitle: document.querySelector('#navbar-title > span')?.textContent?.trim(),
				logoSource: logo?.getAttribute('src'),
				logoWidth: logo instanceof HTMLImageElement ? logo.naturalWidth : 0,
				logoHeight: logo instanceof HTMLImageElement ? logo.naturalHeight : 0,
				logoDisplayWidth: logo?.getBoundingClientRect().width ?? 0,
				logoDisplayHeight: logo?.getBoundingClientRect().height ?? 0,
				remainingSvgLogos: document.querySelectorAll('svg.logo').length,
				changelog: document.querySelector('#changelog-link')?.getAttribute('href')
			};
		})()`);
		return (
			branding.title === 'PagePick for Obsidian'
			&& branding.navbarTitle === 'PagePick for Obsidian'
			&& branding.logoSource?.endsWith('/icons/pagepick48.png')
			&& branding.logoWidth === 48
			&& branding.logoHeight === 48
			&& branding.logoDisplayWidth === 20
			&& branding.logoDisplayHeight === 20
			&& branding.remainingSvgLogos === 0
			&& branding.changelog === 'https://github.com/LeiGaoRobot/obsidian-clipper/releases'
		) ? branding : undefined;
	}, 'The settings page did not apply the PagePick Chrome branding.');
	if (!settingsBranding) {
		throw new Error('The settings page did not expose PagePick Chrome branding.');
	}
	await evaluate(settings, `Promise.all([
		new Promise((resolve, reject) => chrome.storage.local.set({ language: 'zh_CN' }, () => {
			if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
			else resolve();
		})),
		new Promise((resolve, reject) => chrome.storage.sync.set({ reader_settings: {
			transcriptLayout: 'focus',
			compactPlayer: true,
			bilingualSubtitles: true,
			japaneseReadings: true,
			learningResponseLanguage: 'Simplified Chinese'
		} }, () => {
			if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
			else resolve();
		})),
		new Promise((resolve, reject) => chrome.storage.session.set(${JSON.stringify(checkpointState)}, () => {
			if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
			else resolve();
		}))
	])`);
	const storedSettings = await evaluate(settings, `Promise.all([
		new Promise(resolve => chrome.storage.local.get(null, resolve)),
		new Promise(resolve => chrome.storage.sync.get(null, resolve)),
		new Promise(resolve => chrome.storage.session.get(null, resolve))
	]).then(([local, sync, session]) => ({ local, sync, session }))`);
	if (
		storedSettings.local?.language !== 'zh_CN'
		|| storedSettings.sync?.reader_settings?.transcriptLayout !== 'focus'
		|| Object.keys(storedSettings.session || {}).length !== 2
	) {
		throw new Error(`Chrome did not persist the E2E settings fixture: ${JSON.stringify(storedSettings)}`);
	}
	const reloadedSettingsUrl = `${settingsUrl}?section=reader`;
	await settings.send('Page.navigate', { url: reloadedSettingsUrl });
	await waitForValue(async () => evaluate(settings, `
		location.search === '?section=reader'
		&& document.readyState === 'complete'
		&& document.querySelectorAll('#language-select option').length > 10
		&& /[\\u4e00-\\u9fff]/.test(document.querySelector('[data-i18n="readerTranscripts"]')?.textContent || '')
	`), 'The unpacked extension settings page did not initialize.');
	const settingsState = await evaluate(settings, `(() => {
		const layout = document.querySelector('#reader-transcript-layout');
		return {
			lang: document.documentElement.lang,
			transcripts: document.querySelector('[data-i18n="readerTranscripts"]')?.textContent?.trim(),
			layout: layout.value,
			compact: document.querySelector('#reader-compact-player')?.checked,
			bilingual: document.querySelector('#reader-bilingual-subtitles')?.checked,
			readings: document.querySelector('#reader-japanese-readings')?.checked
		};
	})()`);
	if (
		settingsState.lang !== 'zh_CN'
		|| settingsState.layout !== 'focus'
		|| !settingsState.compact
		|| !settingsState.bilingual
		|| !settingsState.readings
		|| !/[\u4e00-\u9fff]/.test(settingsState.transcripts || '')
	) {
		throw new Error(`Unexpected settings E2E state: ${JSON.stringify({ settingsState, storedSettings })}`);
	}

	const tab = await evaluate(settings, `chrome.tabs.create({ url: ${JSON.stringify(fixtureUrl)}, active: true })`);
	const fixtureTarget = await waitForValue(async () => (
		(await listTargets(port)).find(target => target.type === 'page' && target.url.startsWith(fixtureUrl))
	), 'Chrome did not open the Reader fixture tab.');
	const fixture = await connectCdp(fixtureTarget.webSocketDebuggerUrl);
	clients.push(fixture);
	const fixtureErrors = [];
	const chunkNetwork = [];
	fixture.on('Runtime.exceptionThrown', event => fixtureErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
	fixture.on('Runtime.consoleAPICalled', event => {
		if (event.type === 'error') fixtureErrors.push(event.args?.map(item => item.value || item.description).join(' '));
	});
	fixture.on('Network.responseReceived', event => {
		if (event.response?.url?.includes('/chunks/')) {
			chunkNetwork.push({ url: event.response.url, status: event.response.status });
		}
	});
	fixture.on('Network.loadingFailed', event => {
		chunkNetwork.push({ requestId: event.requestId, error: event.errorText, blockedReason: event.blockedReason });
	});
	await fixture.send('Runtime.enable');
	await fixture.send('Network.enable');
	await waitForValue(async () => evaluate(fixture, 'document.readyState === "complete"'), 'Reader fixture did not load.');

	const toggleResponse = await evaluate(settings, `chrome.runtime.sendMessage({
		action: 'toggleReaderMode',
		tabId: ${Number(tab.id)}
	})`);
	if (!toggleResponse?.success) {
		throw new Error(`Reader activation failed: ${JSON.stringify(toggleResponse)}`);
	}
	const readerState = await waitForValue(async () => evaluate(fixture, `(() => {
		const article = document.querySelector('.obsidian-reader-content article');
		const code = article?.querySelector('pre > code');
		const transcript = article?.querySelector('.transcript-study-layout');
		const translations = Array.from(article?.querySelectorAll('.transcript-segment-translation') || [])
			.map(element => element.textContent?.trim());
		const readings = Array.from(article?.querySelectorAll('ruby rt') || [])
			.map(element => element.textContent?.trim());
		if (
			!document.documentElement.classList.contains('obsidian-reader-active')
			|| !article
			|| !code?.classList.contains('hljs')
			|| translations.length !== ${transcriptTranslations.length}
			|| readings.length !== ${transcriptReadings.flat().filter(token => token.reading).length}
		) return null;
		return {
			text: article.textContent,
			transcript: Boolean(transcript),
			layout: transcript?.dataset.transcriptLayout,
			compact: transcript?.querySelector('.player-container')?.classList.contains('is-compact'),
			bilingualVisible: transcript?.querySelector('.youtube.transcript')?.classList.contains('show-bilingual-transcript'),
			readingsVisible: transcript?.querySelector('.youtube.transcript')?.classList.contains('show-japanese-readings'),
			translations,
			readings,
			remoteTaskStarted: transcript?.querySelector('.player-learning-task')?.getAttribute('aria-busy') === 'true',
			errorVisible: document.querySelector('.language-learning-card')?.style.display === 'block',
			chunks: performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('/chunks/'))
		};
	})()`), 'Reader mode or its lazy syntax-highlighting chunk did not initialize.').catch(error => {
		throw new Error(`${error.message} ${JSON.stringify({ toggleResponse, fixtureErrors, chunkNetwork, stderr })}`);
	});
	if (!readerState.text?.includes('Reader integration fixture')) {
		throw new Error(`Reader extraction lost fixture content: ${JSON.stringify(readerState)}`);
	}
	if (
		readerState.remoteTaskStarted
		|| readerState.errorVisible
		|| !readerState.bilingualVisible
		|| !readerState.readingsVisible
		|| JSON.stringify(readerState.translations) !== JSON.stringify(transcriptTranslations)
		|| JSON.stringify(readerState.readings) !== JSON.stringify(
			transcriptReadings.flat().filter(token => token.reading).map(token => token.reading)
		)
	) {
		throw new Error(`Reader did not restore language-learning checkpoints safely: ${JSON.stringify(readerState)}`);
	}
	const loadedChunkUrls = [
		...readerState.chunks,
		...chunkNetwork
			.filter(entry => entry.status === 200 && typeof entry.url === 'string')
			.map(entry => entry.url)
	];
	for (const chunk of ['reader-content-extraction', 'reader-syntax-highlighting', 'reader-language-learning']) {
		if (!loadedChunkUrls.some(url => url.includes(chunk))) {
			throw new Error(`Reader did not load expected lazy chunk ${chunk}: ${JSON.stringify(loadedChunkUrls)}`);
		}
	}
	if (readerState.transcript && (readerState.layout !== 'focus' || !readerState.compact)) {
		throw new Error(`Reader transcript preferences were not applied: ${JSON.stringify(readerState)}`);
	}
	const errors = [...runtimeErrors, ...settingsErrors, ...fixtureErrors].filter(Boolean);
	if (errors.length > 0) throw new Error(`Extension runtime errors:\n${errors.join('\n')}`);

	console.log(`Chrome unpacked-extension E2E passed (${extensionId}).`);
	console.log(`Settings: ${JSON.stringify(settingsState)}`);
	console.log('Reader restored bilingual subtitles and Japanese readings without starting a model request.');
	console.log(`Reader lazy chunks: ${loadedChunkUrls.join(', ')}`);
} finally {
	clients.forEach(client => client.close());
	stopProcessGroup(child);
	server.close();
	await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
