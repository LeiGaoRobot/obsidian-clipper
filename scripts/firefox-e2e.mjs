import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const extensionPath = path.join(root, 'dist_firefox');
const firefoxPath = process.env.FIREFOX_PATH
	|| '/Applications/Firefox.app/Contents/MacOS/firefox';
const extensionUuid = '52e2a47b-6792-4de4-aa11-7693b0ed9d5d';

function stopProcess(child) {
	if (!child.pid) return;
	try {
		child.kill('SIGTERM');
	} catch {
		// Firefox may already have exited.
	}
}

async function waitForValue(probe, message, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(lastError?.message ? `${message} ${lastError.message}` : message);
}

function connectBidi(url) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
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
			if (typeof message.id === 'number' && pending.has(message.id)) {
				const request = pending.get(message.id);
				pending.delete(message.id);
				if (message.type === 'error') {
					request.reject(new Error(`${request.method}: ${message.error}: ${message.message}`));
				} else {
					request.resolve(message.result);
				}
				return;
			}
			for (const listener of listeners.get(message.method) || []) listener(message.params);
		});
		socket.addEventListener('error', () => reject(new Error(`Could not connect to Firefox BiDi at ${url}.`)));
	});
}

function deserialize(remoteValue) {
	if (!remoteValue) return undefined;
	if (['undefined', 'null'].includes(remoteValue.type)) return remoteValue.type === 'null' ? null : undefined;
	if (['string', 'boolean', 'number', 'bigint'].includes(remoteValue.type)) return remoteValue.value;
	if (remoteValue.type === 'array') return (remoteValue.value || []).map(deserialize);
	if (remoteValue.type === 'object') {
		return Object.fromEntries((remoteValue.value || []).map(([key, value]) => [key, deserialize(value)]));
	}
	return remoteValue.value;
}

async function evaluate(bidi, context, expression) {
	const response = await bidi.send('script.evaluate', {
		expression,
		target: { context },
		awaitPromise: true,
		resultOwnership: 'none'
	});
	if (response.type === 'exception') {
		throw new Error(response.exceptionDetails?.text || 'Firefox script evaluation failed.');
	}
	return deserialize(response.result);
}

const fixtureHtml = createYouTubeTranscriptFixtureHtml(
	'Reader Firefox integration fixture',
	'const firefoxVerified = true;'
);

if (!existsSync(path.join(extensionPath, 'manifest.json'))) {
	throw new Error('Built Firefox extension is missing. Run npm run build:firefox first.');
}
for (const chunk of ['reader-content-extraction.js', 'reader-syntax-highlighting.js']) {
	if (!existsSync(path.join(extensionPath, 'chunks', chunk))) {
		throw new Error(`Built Firefox extension is missing chunks/${chunk}.`);
	}
}
if (!existsSync(firefoxPath)) {
	throw new Error('Firefox is required. Set FIREFOX_PATH to its executable.');
}

const server = http.createServer((_request, response) => {
	response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
	response.end(fixtureHtml);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Could not start the Firefox fixture server.');
const fixtureUrl = `http://youtube.com.localhost:${address.port}/watch?v=test`;

const profile = await mkdtemp(path.join(os.tmpdir(), 'clipper-firefox-e2e-'));
await writeFile(path.join(profile, 'user.js'), [
	`user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'clipper@obsidian.md': extensionUuid }))});`,
	'user_pref("extensions.installDistroAddons", false);',
	'user_pref("extensions.systemAddon.update.enabled", false);',
	'user_pref("extensions.systemAddon.update.url", "");',
	''
].join('\n'));
const child = spawn(firefoxPath, [
	'--headless',
	'--no-remote',
	'--profile', profile,
	'--remote-debugging-port', '0',
	'about:blank'
], {
	env: { ...process.env, MOZ_HEADLESS: '1' },
	stdio: ['ignore', 'pipe', 'pipe']
});
let firefoxOutput = '';
for (const stream of [child.stdout, child.stderr]) {
	stream.setEncoding('utf8');
	stream.on('data', chunk => { firefoxOutput += chunk; });
}

let bidi;
try {
	const checkpointState = createTranscriptCheckpointState();
	const websocketListener = await waitForValue(() => (
		firefoxOutput.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/)?.[1]
	), 'Firefox did not expose a WebDriver BiDi endpoint.', 45_000);
	const websocketUrl = websocketListener.endsWith('/session')
		? websocketListener
		: `${websocketListener}/session`;
	bidi = await connectBidi(websocketUrl);
	await bidi.send('session.new', { capabilities: {} });
	const errors = [];
	const chunks = [];
	bidi.on('log.entryAdded', entry => {
		if (entry.level === 'error') errors.push(entry.text || entry.type);
	});
	bidi.on('network.responseCompleted', event => {
		if (event.response?.url?.includes('/chunks/')) chunks.push(event.response.url);
	});
	await bidi.send('session.subscribe', {
		events: ['log.entryAdded', 'network.responseCompleted']
	});
	const { extension } = await bidi.send('webExtension.install', {
		extensionData: { type: 'path', path: extensionPath }
	});
	if (!extension) throw new Error('Firefox did not return the temporary extension ID.');

	const tree = await bidi.send('browsingContext.getTree', {});
	const context = tree.contexts?.find(item => item.url === 'about:blank')?.context
		|| tree.contexts?.[0]?.context;
	if (!context) throw new Error('Firefox did not expose a browsing context.');
	await bidi.send('browsingContext.navigate', {
		context,
		url: fixtureUrl,
		wait: 'complete'
	});
	const { context: extensionContext } = await bidi.send('browsingContext.create', { type: 'tab' });
	const settingsUrl = `moz-extension://${extensionUuid}/settings.html`;
	await bidi.send('browsingContext.navigate', {
		context: extensionContext,
		url: settingsUrl,
		wait: 'complete'
	});
	await waitForValue(async () => evaluate(bidi, extensionContext, `(
		document.readyState === 'complete'
		&& Boolean(document.querySelector('#reader-transcript-layout'))
		&& document.querySelectorAll('#language-select option').length > 10
	)`), 'Firefox settings did not finish its initial storage migration.');
	const storedSettings = await waitForValue(async () => evaluate(bidi, extensionContext, `(async () => {
		if (typeof browser === 'undefined' || !browser.storage?.session) return null;
		await browser.storage.local.set({ language: 'zh_CN' });
		await browser.storage.sync.set({ reader_settings: {
			transcriptLayout: 'focus',
			compactPlayer: true,
			bilingualSubtitles: true,
			japaneseReadings: true,
			learningResponseLanguage: 'Simplified Chinese'
		} });
		await browser.storage.session.set(${JSON.stringify(checkpointState)});
		const [local, sync, session] = await Promise.all([
			browser.storage.local.get(null),
			browser.storage.sync.get(null),
			browser.storage.session.get(null)
		]);
		return { local, sync, sessionCount: Object.keys(session).length };
	})()`), 'Firefox extension storage APIs did not persist Reader settings and checkpoints.');
	if (
		storedSettings.local?.language !== 'zh_CN'
		|| storedSettings.sync?.reader_settings?.transcriptLayout !== 'focus'
		|| storedSettings.sessionCount !== 2
	) {
		throw new Error(`Firefox did not persist the Reader fixture: ${JSON.stringify(storedSettings)}`);
	}
	await bidi.send('browsingContext.navigate', {
		context: extensionContext,
		url: `${settingsUrl}?section=reader`,
		wait: 'complete'
	});
	const settingsState = await waitForValue(async () => evaluate(bidi, extensionContext, `(() => {
		const layout = document.querySelector('#reader-transcript-layout');
		const transcripts = document.querySelector('[data-i18n="readerTranscripts"]')?.textContent?.trim();
		const state = {
			lang: document.documentElement.lang,
			transcripts,
			layout: layout?.value,
			compact: document.querySelector('#reader-compact-player')?.checked,
			bilingual: document.querySelector('#reader-bilingual-subtitles')?.checked,
			readings: document.querySelector('#reader-japanese-readings')?.checked
		};
		return layout
			&& /[\\u4e00-\\u9fff]/.test(transcripts || '')
			&& state.lang === 'zh_CN'
			&& state.layout === 'focus'
			&& state.compact
			&& state.bilingual
			&& state.readings
			? state
			: null;
	})()`), 'Firefox settings did not initialize in Chinese.');
	if (
		settingsState.lang !== 'zh_CN'
		|| settingsState.layout !== 'focus'
		|| !settingsState.compact
		|| !settingsState.bilingual
		|| !settingsState.readings
	) {
		throw new Error(`Unexpected Firefox settings state: ${JSON.stringify(settingsState)}`);
	}
	const toggleResponse = await waitForValue(async () => evaluate(bidi, extensionContext, `(async () => {
		if (typeof browser === 'undefined' || !browser.runtime?.id) return null;
		const tabs = await browser.tabs.query({});
		const tab = tabs.find(candidate => candidate.url === ${JSON.stringify(fixtureUrl)});
		if (!tab?.id) return null;
		return browser.runtime.sendMessage({ action: 'toggleReaderMode', tabId: tab.id });
	})()`), 'Firefox extension APIs did not activate Reader mode.');
	if (!toggleResponse?.success || !toggleResponse.isActive) {
		throw new Error(`Firefox Reader toggle failed: ${JSON.stringify(toggleResponse)}`);
	}
	const readerState = await waitForValue(async () => evaluate(bidi, context, `(() => {
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
			extractor: document.documentElement.dataset.readerExtractor,
			layout: transcript?.dataset.transcriptLayout,
			compact: transcript?.querySelector('.player-container')?.classList.contains('is-compact'),
			bilingualVisible: transcript?.querySelector('.youtube.transcript')?.classList.contains('show-bilingual-transcript'),
			readingsVisible: transcript?.querySelector('.youtube.transcript')?.classList.contains('show-japanese-readings'),
			translations,
			readings,
			remoteTaskStarted: transcript?.querySelector('.player-learning-task')?.getAttribute('aria-busy') === 'true',
			errorVisible: document.querySelector('.language-learning-card')?.style.display === 'block',
			resources: performance.getEntriesByType('resource').map(entry => entry.name).filter(url => url.includes('/chunks/'))
		};
	})()`), 'Firefox Reader mode or its module chunks did not initialize.', 45_000).catch(async error => {
		const diagnostics = await evaluate(bidi, context, `({
			url: location.href,
			active: document.documentElement.classList.contains('obsidian-reader-active'),
			readerInitialized: Object.prototype.hasOwnProperty.call(window, 'obsidianReaderInitialized'),
			body: document.body?.innerText?.slice(0, 300)
		})`);
		const realms = await bidi.send('script.getRealms', {});
		throw new Error(`${error.message} ${JSON.stringify({ diagnostics, errors, chunks, realms, firefoxOutput: firefoxOutput.slice(-2000) })}`);
	});
	if (!readerState.text?.includes('Reader Firefox integration fixture')) {
		throw new Error(`Firefox Reader extraction lost fixture content: ${JSON.stringify(readerState)}`);
	}
	if (
		readerState.layout !== 'focus'
		|| !readerState.compact
		|| readerState.remoteTaskStarted
		|| readerState.errorVisible
		|| !readerState.bilingualVisible
		|| !readerState.readingsVisible
		|| JSON.stringify(readerState.translations) !== JSON.stringify(transcriptTranslations)
		|| JSON.stringify(readerState.readings) !== JSON.stringify(
			transcriptReadings.flat().filter(token => token.reading).map(token => token.reading)
		)
	) {
		throw new Error(`Firefox Reader did not restore language-learning checkpoints safely: ${JSON.stringify(readerState)}`);
	}
	const loadedChunkUrls = [...new Set([...readerState.resources, ...chunks])];
	if (errors.length > 0) throw new Error(`Firefox extension runtime errors:\n${errors.join('\n')}`);

	console.log(`Firefox temporary-extension E2E passed (${extension}).`);
	console.log(`Settings: ${JSON.stringify(settingsState)}`);
	console.log('Reader extraction, module loading, and local language-learning checkpoint restore passed.');
	if (loadedChunkUrls.length > 0) console.log(`Reader module chunks: ${loadedChunkUrls.join(', ')}`);
	await bidi.send('webExtension.uninstall', { extension });
	await bidi.send('session.end', {});
} finally {
	bidi?.close();
	stopProcess(child);
	server.close();
	await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
