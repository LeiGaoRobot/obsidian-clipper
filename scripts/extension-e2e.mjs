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
	transcriptJobId,
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
		const closed = new Promise(resolveClosed => socket.addEventListener('close', () => resolveClosed()));
		socket.addEventListener('open', () => resolve({
			close: () => socket.close(),
			closed,
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

// A mock OpenAI-compatible provider that answers by task in SSE deltas: interpret with a fixed
// contract object in small delayed deltas, translate with `T:` + source text for every requested
// segment id. `providerHook(request)` may delay a reply or answer it with an error status.
const providerRequests = [];
let providerHook = () => ({});
const streamedEnvelope = '{"prompt_1":"Streamed summary"}';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function requestedSegments(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const system = messages.find(message => message.role === 'system')?.content || '';
	if (!system.includes('{"translations":')) return { task: 'interpret' };
	const user = messages.find(message => message.role === 'user')?.content || '{}';
	return { task: 'translate', segments: JSON.parse(user).segments || [] };
}

async function streamMockCompletion(request, response) {
	let body = '';
	for await (const chunk of request) body += chunk;
	const parsed = JSON.parse(body);
	const { task, segments } = requestedSegments(parsed);
	const record = {
		index: providerRequests.length,
		at: Date.now(),
		authorization: request.headers.authorization,
		body: parsed,
		task,
		ids: segments?.map(segment => segment.id) ?? [],
		aborted: false
	};
	providerRequests.push(record);
	response.on('close', () => {
		if (!response.writableFinished) record.aborted = true;
	});
	const hook = providerHook(record) || {};
	if (hook.delayMs) await sleep(hook.delayMs);
	if (response.destroyed) return;
	if (hook.status) {
		record.status = hook.status;
		response.writeHead(hook.status, {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
			...hook.headers
		});
		response.end(JSON.stringify({ error: { message: 'E2E mock: too many requests, slow down.' } }));
		return;
	}
	record.status = 200;
	response.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Access-Control-Allow-Origin': '*'
	});
	const envelope = task === 'translate'
		? JSON.stringify({ translations: segments.map(segment => ({ id: segment.id, text: `T:${segment.text}` })) })
		: streamedEnvelope;
	const chunkSize = task === 'translate' ? 2000 : 12;
	for (let index = 0; index < envelope.length; index += chunkSize) {
		if (response.destroyed) return;
		const content = envelope.slice(index, index + chunkSize);
		response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
		if (task !== 'translate') await sleep(40);
	}
	response.end('data: [DONE]\n\n');
}

const server = http.createServer((request, response) => {
	if (request.method === 'POST' && request.url === '/v1/chat/completions') {
		streamMockCompletion(request, response).catch(error => {
			response.destroy(error);
		});
		return;
	}
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
	await settings.send('Page.addScriptToEvaluateOnNewDocument', {
		source: `(() => {
			const originalFetch = globalThis.fetch.bind(globalThis);
			globalThis.fetch = (input, init) => {
				const url = typeof input === 'string' ? input : input?.url;
				if (url === 'https://raw.githubusercontent.com/obsidianmd/obsidian-clipper/refs/heads/main/providers.json') {
					return Promise.resolve(new Response(JSON.stringify({ version: 'e2e' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}));
				}
				return originalFetch(input, init);
			};
		})();`
	});
	const settingsErrors = [];
	settings.on('Runtime.exceptionThrown', event => settingsErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Settings exception'));
	settings.on('Runtime.consoleAPICalled', event => {
		if (event.type === 'error') settingsErrors.push(event.args?.map(item => item.value || item.description).join(' '));
	});
	const workerUrl = `chrome-extension://${extensionId}/background.js`;
	const runtimeErrors = [];
	// Lists the extension worker target and collects its runtime errors. A stopped worker's client
	// dies with it, so a restarted worker is attached again through a fresh listing.
	const attachWorker = async message => {
		const target = await waitForValue(async () => (
			(await listTargets(port)).find(entry => entry.type === 'service_worker' && entry.url === workerUrl)
		), message);
		const client = await connectCdp(target.webSocketDebuggerUrl);
		clients.push(client);
		client.on('Runtime.exceptionThrown', event => runtimeErrors.push(event.exceptionDetails?.text || 'Worker exception'));
		client.on('Runtime.consoleAPICalled', event => {
			if (event.type === 'error') runtimeErrors.push(event.args?.map(item => item.value || item.description).join(' '));
		});
		await client.send('Runtime.enable');
		return { target, client };
	};
	let worker = (await attachWorker(
		`The unpacked extension service worker did not start.${stderr.trim() ? ` Chrome: ${stderr.trim()}` : ''}`
	)).client;
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
	const interpreterSettingsUrl = `${settingsUrl}?section=interpreter`;
	await settings.send('Page.navigate', { url: interpreterSettingsUrl });
	const nativeCliInstallGuide = await waitForValue(async () => evaluate(settings, `(() => {
		const command = document.querySelector('#native-cli-install-command');
		const copyButton = document.querySelector('#native-cli-install-copy');
		const interpreter = document.querySelector('#interpreter-section');
		if (
			location.search !== '?section=interpreter'
			|| !interpreter?.classList.contains('active')
			|| !command?.textContent?.includes(${JSON.stringify(extensionId)})
			|| !command?.textContent?.startsWith('npm --prefix ')
			|| copyButton?.hidden
		) return null;
		return {
			command: command.textContent,
			copyLabel: copyButton.textContent?.trim()
		};
	})()`), 'The Interpreter settings did not initialize the Native CLI install guide.');
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
		|| Object.keys(storedSettings.session || {}).length !== Object.keys(checkpointState).length
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
	const providerUrl = `http://127.0.0.1:${address.port}/v1/chat/completions`;
	await evaluate(settings, `new Promise((resolve, reject) => chrome.storage.sync.set({ interpreter_settings: {
		interpreterEnabled: true,
		interpreterExecutionMode: 'api',
		interpreterModel: 'e2e-model',
		providers: [{ id: 'e2e-provider', name: 'E2E Mock', baseUrl: ${JSON.stringify(providerUrl)}, apiKey: 'sk-e2e', apiKeyRequired: true }],
		models: [{ id: 'e2e-model', providerId: 'e2e-provider', providerModelId: 'mock-model', name: 'Mock', enabled: true }]
	} }, () => {
		if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
		else resolve();
	}))`);
	const gatewayRun = await evaluate(settings, `new Promise((resolve, reject) => {
		const port = chrome.runtime.connect({ name: 'ai' });
		const messages = [];
		const timer = setTimeout(() => reject(new Error('AI gateway timed out: ' + JSON.stringify(messages))), 20000);
		port.onMessage.addListener(message => {
			messages.push(message.type === 'progress' ? message.phase : message.type);
			if (message.type === 'result' || message.type === 'error') {
				clearTimeout(timer);
				port.disconnect();
				resolve({ messages, outcome: message });
			}
		});
		port.postMessage({
			type: 'start',
			jobId: 'e2e-job',
			task: 'interpret',
			input: { context: 'E2E page', prompts: [{ key: 'prompt_1', prompt: 'Summarize' }] }
		});
	})`);
	if (
		gatewayRun.outcome?.type !== 'result'
		|| gatewayRun.outcome.output?.responses?.prompt_1 !== 'Streamed summary'
		|| gatewayRun.outcome.output?.missing?.length !== 0
		|| !gatewayRun.messages.includes('receiving')
		|| providerRequests.length !== 1
		|| providerRequests[0].body.stream !== true
		|| providerRequests[0].body.model !== 'mock-model'
		|| providerRequests[0].authorization !== 'Bearer sk-e2e'
		|| providerRequests[0].body.response_format?.type !== 'json_object'
		|| JSON.stringify(providerRequests[0].body.messages).includes('prompts_responses')
	) {
		throw new Error(`AI gateway did not stream the mock provider response: ${JSON.stringify({ gatewayRun, providerRequests })}`);
	}
	// Durable transcript jobs. The page drives the `ai` Port the way src/ai/job-client.ts does:
	// `start-job` once, keepalive pings, and reconnect + `attach` (never a new start) on disconnect.
	await evaluate(settings, `(() => {
		if (globalThis.__e2eStartJob) return true;
		const runs = globalThis.__e2eJobs = {};
		const reconnectDelays = [250, 500, 1000, 2000, 4000];
		globalThis.__e2eStartJob = message => {
			const run = runs[message.jobId] = { messages: [], connects: 0, disconnects: 0 };
			let port;
			let failures = 0;
			const post = value => {
				try {
					port.postMessage(value);
				} catch {
					// The port died; onDisconnect reconnects.
				}
			};
			const keepalive = setInterval(() => post({ type: 'ping' }), 20000);
			const finish = () => {
				clearInterval(keepalive);
				port.disconnect();
			};
			const open = first => {
				run.connects += 1;
				port = chrome.runtime.connect({ name: 'ai' });
				port.onMessage.addListener(event => {
					failures = 0;
					run.messages.push({ ...event, at: Date.now(), connection: run.connects });
					if (event.type === 'job-state' && event.status !== 'running') {
						run.final = event;
						finish();
					} else if (event.type === 'error') {
						run.error = event.error;
						finish();
					}
				});
				port.onDisconnect.addListener(() => {
					if (run.final || run.error) return;
					run.disconnects += 1;
					if (failures >= reconnectDelays.length) {
						clearInterval(keepalive);
						run.error = { code: 'network', detail: 'Reconnects exhausted.' };
						return;
					}
					setTimeout(() => open(false), reconnectDelays[failures++]);
				});
				post(first ? message : { type: 'attach', jobId: message.jobId });
			};
			open(true);
			return true;
		};
		return true;
	})()`);
	const jobRun = jobId => evaluate(settings, `globalThis.__e2eJobs[${JSON.stringify(jobId)}]`);
	const waitForJob = (jobId, done, message, timeoutMs = 30_000) => waitForValue(async () => {
		const run = await jobRun(jobId);
		if (run?.error) throw new Error(`Job failed: ${JSON.stringify(run.error)}`);
		return run && done(run) ? run : undefined;
	}, message, timeoutMs);
	const sessionRecord = jobId => evaluate(settings, `new Promise(resolve => chrome.storage.session.get(
		${JSON.stringify(`aiJob:${jobId}`)},
		items => resolve(items[${JSON.stringify(`aiJob:${jobId}`)}])
	))`);
	const translationInstruction = 'Translate each transcript segment into Simplified Chinese.';
	// The runner's grouping (src/ai/job-runner.ts buildTranscriptPromptGroups) at the API translate budget.
	const promptGroups = (segments, budget = 6000) => {
		const groups = [];
		let current = [];
		let length = translationInstruction.length;
		for (const segment of segments) {
			const size = JSON.stringify(segment).length + 1;
			if (current.length > 0 && length + size > budget) {
				groups.push(current);
				current = [];
				length = translationInstruction.length;
			}
			current.push(segment.id);
			length += size;
		}
		if (current.length > 0) groups.push(current);
		return groups;
	};
	const startJobMessage = (identity, segments) => ({
		type: 'start-job',
		jobId: transcriptJobId('translate', identity, segments.map(segment => segment.text)),
		task: 'translate',
		input: { instruction: translationInstruction, segments, identity }
	});
	const sortedResults = results => [...results].sort((left, right) => left.id - right.id);
	const echoes = segments => segments.map(segment => ({ id: segment.id, text: `T:${segment.text}` }));

	// A service worker stopped mid-job: the record checkpointed so far survives in storage.session,
	// the reconnecting client's `attach` resumes the job, and only the missing groups are requested.
	const stopSegments = Array.from({ length: 12 }, (_, id) => ({
		id,
		text: `Segment ${id} of the stop-worker job. ${'word '.repeat(276)}`.trim()
	}));
	const stopGroups = promptGroups(stopSegments);
	if (stopGroups.length < 3) throw new Error(`The stop-worker segments form too few groups: ${JSON.stringify(stopGroups)}`);
	const stopJob = startJobMessage({ namespace: 'translations', scope: 'e2e-stop-worker' }, stopSegments);
	const firstGroup = stopGroups[0];
	let workerStoppedAt;
	providerHook = record => (
		record.task === 'translate' && workerStoppedAt === undefined && !record.ids.includes(firstGroup[0])
			? { delayMs: 5000 }
			: {}
	);
	const stopRequestStart = providerRequests.length;
	await evaluate(settings, `globalThis.__e2eStartJob(${JSON.stringify(stopJob)})`);
	await waitForJob(
		stopJob.jobId,
		run => run.messages.some(message => message.type === 'job-progress'),
		'The stop-worker job reported no progress.'
	);
	// job-progress follows the checkpoint write but does not await it; stop once it has landed.
	await waitForValue(async () => {
		const record = await sessionRecord(stopJob.jobId);
		return record?.status === 'running' && firstGroup.every(id => String(id) in record.results);
	}, 'The first group was not checkpointed in storage.session.', 10_000);
	const inFlightBeforeStop = providerRequests.slice(stopRequestStart).filter(record => record.task === 'translate').length;

	// The old worker's DevTools client dies with the worker; close it first so it cannot keep the worker alive.
	worker.close();
	// The browser target has no ServiceWorker domain ("'ServiceWorker.enable' wasn't found"); an
	// extension page target of the same profile reports the extension worker's versions.
	const workerVersions = [];
	settings.on('ServiceWorker.workerVersionUpdated', event => workerVersions.push(...(event.versions || [])));
	await settings.send('ServiceWorker.enable');
	const runningVersion = await waitForValue(
		() => workerVersions.find(entry => entry.scriptURL === workerUrl && entry.runningStatus === 'running'),
		'ServiceWorker.workerVersionUpdated reported no running version of the extension worker.',
		5000
	);
	await settings.send('ServiceWorker.stopWorker', { versionId: runningVersion.versionId });
	workerStoppedAt = Date.now();
	await waitForValue(
		() => workerVersions.some(entry => entry.versionId === runningVersion.versionId && entry.runningStatus === 'stopped'),
		'The extension worker did not report a stopped state.',
		10_000
	);
	await settings.send('ServiceWorker.disable');
	const stopRun = await waitForJob(
		stopJob.jobId,
		run => Boolean(run.final),
		'The stop-worker job did not finish after the worker restarted.'
	).catch(async error => {
		throw new Error(`${error.message} ${JSON.stringify({
			run: await jobRun(stopJob.jobId),
			requests: providerRequests.slice(stopRequestStart).map(({ ids, at, status, aborted }) => ({ ids, at, status, aborted }))
		})}`);
	});
	// Re-list the restarted worker so its runtime errors are collected from here on.
	const restartedWorker = await attachWorker('The restarted extension service worker was not listed.');
	worker = restartedWorker.client;
	const stopRequests = providerRequests.slice(stopRequestStart).filter(record => record.task === 'translate');
	const firstGroupRequests = stopRequests.filter(record => record.ids.some(id => firstGroup.includes(id)));
	const afterStop = stopRequests.filter(record => record.at >= workerStoppedAt);
	const remainingIds = stopGroups.slice(1).flat();
	const resumedIds = afterStop.flatMap(record => record.ids).sort((left, right) => left - right);
	if (
		stopRun.final.status !== 'completed'
		|| stopRun.final.completedSegments !== stopSegments.length
		|| JSON.stringify(sortedResults(stopRun.final.results)) !== JSON.stringify(echoes(stopSegments))
		|| firstGroupRequests.length !== 1
		|| JSON.stringify(firstGroupRequests[0].ids) !== JSON.stringify(firstGroup)
		|| JSON.stringify(resumedIds) !== JSON.stringify(remainingIds)
		|| stopRun.disconnects < 1
		|| stopRun.connects < 2
		|| !stopRun.messages.some(message => message.type === 'job-state' && message.connection > 1)
	) {
		throw new Error(`The stopped worker did not resume the job exactly once per group: ${JSON.stringify({
			final: { ...stopRun.final, results: stopRun.final.results.length },
			connects: stopRun.connects,
			disconnects: stopRun.disconnects,
			messages: stopRun.messages.map(message => `${message.type}@${message.connection}`),
			firstGroup,
			requests: stopRequests.map(({ ids, at, status, aborted }) => ({ ids, at: at - workerStoppedAt, status, aborted }))
		})}`);
	}

	// A one-shot 429 with Retry-After: the group backs off, retries the same ids once, and completes.
	const retrySegments = [
		'The provider is busy at first.',
		'The second request succeeds.',
		'Every segment comes back translated.'
	].map((text, id) => ({ id, text }));
	const retryJob = startJobMessage({ namespace: 'translations', scope: 'e2e-retry-after' }, retrySegments);
	let rateLimited = false;
	providerHook = record => {
		if (record.task !== 'translate' || rateLimited) return {};
		rateLimited = true;
		return { status: 429, headers: { 'Retry-After': '1' } };
	};
	const retryRequestStart = providerRequests.length;
	await evaluate(settings, `globalThis.__e2eStartJob(${JSON.stringify(retryJob)})`);
	const retryRun = await waitForJob(retryJob.jobId, run => Boolean(run.final), 'The 429 job did not finish.');
	providerHook = () => ({});
	const retryRequests = providerRequests.slice(retryRequestStart);
	const retryMessages = retryRun.messages.filter(message => message.type === 'job-retry');
	const allIds = JSON.stringify(retrySegments.map(segment => segment.id));
	if (
		retryRun.final.status !== 'completed'
		|| JSON.stringify(sortedResults(retryRun.final.results)) !== JSON.stringify(echoes(retrySegments))
		|| retryRun.final.attempts?.retries !== 1
		|| retryRequests.length !== 2
		|| retryRequests[0].status !== 429
		|| retryRequests[1].status !== 200
		|| retryRequests.some(record => JSON.stringify(record.ids) !== allIds)
		|| retryRequests[1].at - retryRequests[0].at < 950
		|| retryMessages.length !== 1
		|| retryMessages[0].code !== 'rate-limited'
		|| retryMessages[0].status !== 429
		|| retryMessages[0].attempt !== 1
		|| !(retryMessages[0].delayMs >= 1000)
	) {
		throw new Error(`The 429 job did not honor Retry-After and complete: ${JSON.stringify({
			final: retryRun.final,
			retryMessages,
			requests: retryRequests.map(({ ids, at, status }) => ({ ids, at, status }))
		})}`);
	}

	// Both jobs left completed records next to the restored fixture records; nothing else was written.
	const sessionAfterJobs = await evaluate(settings, 'new Promise(resolve => chrome.storage.session.get(null, resolve))');
	const expectedJobIds = [
		...Object.keys(checkpointState).filter(key => key.startsWith('aiJob:')).map(key => key.slice('aiJob:'.length)),
		stopJob.jobId,
		retryJob.jobId
	].sort();
	const storedJobIds = prefix => Object.keys(sessionAfterJobs).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)).sort();
	if (
		JSON.stringify(storedJobIds('aiJob:')) !== JSON.stringify(expectedJobIds)
		|| JSON.stringify(storedJobIds('aiJobInput:')) !== JSON.stringify(expectedJobIds)
		|| Object.keys(sessionAfterJobs).length !== expectedJobIds.length * 2
		|| [[stopJob, stopSegments], [retryJob, retrySegments]].some(([job, segments]) => {
			const record = sessionAfterJobs[`aiJob:${job.jobId}`];
			return record?.status !== 'completed' || Object.keys(record.results).length !== segments.length;
		})
	) {
		throw new Error(`Unexpected storage.session after the transcript jobs: ${JSON.stringify(Object.keys(sessionAfterJobs))}`);
	}
	const errors = [...runtimeErrors, ...settingsErrors, ...fixtureErrors].filter(Boolean);
	if (errors.length > 0) throw new Error(`Extension runtime errors:\n${errors.join('\n')}`);

	console.log(`Chrome unpacked-extension E2E passed (${extensionId}).`);
	console.log(`Settings: ${JSON.stringify(settingsState)}`);
	console.log(`Native CLI install guide: ${JSON.stringify(nativeCliInstallGuide)}`);
	console.log('Reader restored bilingual subtitles and Japanese readings without starting a model request.');
	console.log(`Reader lazy chunks: ${loadedChunkUrls.join(', ')}`);
	console.log(`AI gateway streamed a mock provider response: ${gatewayRun.messages.join(' → ')}`);
	console.log(`Stopped the worker (version ${runningVersion.versionId}) after ${firstGroup.length} of ${stopSegments.length} segments; `
		+ `${stopRequests.filter(record => record.aborted).length} of ${inFlightBeforeStop - 1} in-flight group request(s) aborted, `
		+ `${afterStop.length} resumed after reconnect + attach, `
		+ `${stopRun.disconnects} disconnect(s); restarted worker re-listed (${restartedWorker.target.id}).`);
	console.log(`429 + Retry-After: 1 retried once after ${retryMessages[0].delayMs} ms and completed.`);
} finally {
	clients.forEach(client => client.close());
	stopProcessGroup(child);
	server.close();
	await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
