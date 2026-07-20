import type { BilibiliTranscript } from './bilibili-transcript';

function formatTimestamp(seconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const remainingSeconds = totalSeconds % 60;
	const secondsText = String(remainingSeconds).padStart(2, '0');
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`
		: `${minutes}:${secondsText}`;
}

export function createBilibiliTranscriptElement(
	doc: Document,
	transcript: BilibiliTranscript
): HTMLElement {
	const element = doc.createElement('div');
	element.className = 'bilibili transcript';
	element.dataset.transcriptPlatform = 'bilibili';
	element.dataset.transcriptLanguage = transcript.language;

	for (const segment of transcript.segments) {
		const row = doc.createElement('div');
		row.className = 'transcript-segment';
		const timestampContainer = doc.createElement('strong');
		const timestamp = doc.createElement('span');
		timestamp.className = 'timestamp';
		timestamp.dataset.timestamp = String(segment.start);
		timestamp.textContent = formatTimestamp(segment.start);
		timestampContainer.appendChild(timestamp);
		row.append(timestampContainer, doc.createTextNode(` · ${segment.text}`));
		element.appendChild(row);
	}

	return element;
}
