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

const checkpointPrefix = 'languageLearningTranscriptCheckpointV1:';

function hashText(value) {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function checkpointEntry(namespace, scope, value) {
	const id = `${namespace}:${hashText(JSON.stringify([scope, transcriptSegments]))}`;
	return {
		[`${checkpointPrefix}${id}`]: {
			id,
			namespace,
			scope,
			segments: [...transcriptSegments],
			value,
			updatedAt: Date.now()
		}
	};
}

export function createTranscriptCheckpointState() {
	return {
		...checkpointEntry(
			'translations',
			'shared:Simplified Chinese',
			[...transcriptTranslations]
		),
		...checkpointEntry(
			'japanese-readings',
			'shared',
			transcriptReadings.map(tokens => tokens.map(token => ({ ...token })))
		)
	};
}
