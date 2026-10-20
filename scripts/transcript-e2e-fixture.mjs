export const transcriptSegments = [
	'日本語を勉強します。',
	'漢字の読み方を確認します。'
];

export const transcriptTranslations = [
	'学习日语。',
	'确认汉字读音。'
];

export const transcriptReadings = [
	[
		{ text: '日本語', reading: 'にほんご' },
		{ text: 'を', reading: '' },
		{ text: '勉強', reading: 'べんきょう' },
		{ text: 'します。', reading: '' }
	],
	[
		{ text: '漢字', reading: 'かんじ' },
		{ text: 'の', reading: '' },
		{ text: '読み方', reading: 'よみかた' },
		{ text: 'を', reading: '' },
		{ text: '確認', reading: 'かくにん' },
		{ text: 'します。', reading: '' }
	]
];

function escapeHtml(value) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

export function createYouTubeTranscriptFixtureHtml(title, code) {
	const metadata = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'VideoObject',
		'@id': 'https://www.youtube.com/watch?v=test',
		url: 'https://www.youtube.com/watch?v=test',
		embedUrl: 'https://www.youtube.com/embed/test',
		name: title,
		author: { '@type': 'Person', name: 'Reader E2E' },
		description: `${title}</p><pre><code class="language-javascript">${escapeHtml(code)}</code></pre><p>Reader transcript integration fixture.`,
		thumbnailUrl: ['https://img.youtube.com/vi/test/hqdefault.jpg'],
		uploadDate: '2026-01-01'
	}).replaceAll('<', '\\u003c');
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>.obsidian-reader-active .pin-player { height: 200vh !important; }</style>
<script type="application/ld+json">${metadata}</script></head>
<body>
<video></video>
<ytd-video-owner-renderer><div id="channel-name"><a href="/@reader-e2e">Reader E2E</a></div></ytd-video-owner-renderer>
<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript">
	<div id="segments-container">
		${transcriptSegments.map((segment, index) => `
		<ytd-transcript-segment-renderer>
			<span class="segment-timestamp">0:0${index * 8}</span>
			<span class="segment-text">${escapeHtml(segment)}</span>
		</ytd-transcript-segment-renderer>`).join('')}
	</div>
</ytd-engagement-panel-section-list-renderer>
</body></html>`;
}

// Reader restore reads completed transcript job records from storage.session through the `ai`
// Port. Keep the key prefixes, record shape, and hash in sync with src/ai/job-store.ts and
// src/ai/job-identity.ts.
const jobKeyPrefix = 'aiJob:';
const jobInputKeyPrefix = 'aiJobInput:';

// cyrb53 (public domain, bryc), copied from src/ai/job-identity.ts.
function cyrb53(text, seed = 0) {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let index = 0; index < text.length; index += 1) {
		const char = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ char, 2654435761);
		h2 = Math.imul(h2 ^ char, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function hashSegments(scope, texts) {
	return cyrb53(JSON.stringify([scope, texts])).toString(36);
}

/** The job id the client and gateway compute, as in src/ai/job-identity.ts `transcriptJobId`. */
export function transcriptJobId(task, { namespace, scope }, texts) {
	return `job:${task}:${namespace}:${hashSegments(scope, texts)}`;
}

function completedJobEntry(task, namespace, scope, values) {
	const segmentHash = hashSegments(scope, transcriptSegments);
	const id = transcriptJobId(task, { namespace, scope }, transcriptSegments);
	const now = Date.now();
	return {
		[`${jobKeyPrefix}${id}`]: {
			v: 1,
			id,
			task,
			identity: { namespace, scope },
			segmentCount: transcriptSegments.length,
			segmentHash,
			status: 'completed',
			results: Object.fromEntries(values.map((value, index) => [String(index), value])),
			attempts: { requests: 1, retries: 0, splits: 0 },
			createdAt: now,
			updatedAt: now
		},
		[`${jobInputKeyPrefix}${id}`]: {
			instruction: '',
			segments: [...transcriptSegments]
		}
	};
}

/** Completed translation and reading jobs for the fixture transcript, keyed as the job store writes them. */
export function createTranscriptCheckpointState() {
	return {
		...completedJobEntry(
			'translate',
			'translations',
			'shared:Simplified Chinese',
			[...transcriptTranslations]
		),
		...completedJobEntry(
			'reading',
			'japanese-readings',
			'shared',
			transcriptReadings.map(tokens => tokens.map(token => ({ ...token })))
		)
	};
}
