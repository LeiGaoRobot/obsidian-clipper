export interface BilibiliTranscriptSegment {
	start: number;
	end: number;
	text: string;
}

export interface BilibiliTranscript {
	bvid: string;
	language: string;
	languageLabel: string;
	segments: BilibiliTranscriptSegment[];
}

interface BilibiliFetchResponse {
	ok: boolean;
	json: () => Promise<unknown>;
}

export interface BilibiliTranscriptOptions {
	fetcher: (url: string) => Promise<BilibiliFetchResponse>;
}

interface BilibiliSubtitleTrack {
	lan?: unknown;
	lan_doc?: unknown;
	is_lock?: unknown;
	subtitle_url?: unknown;
}

function isBilibiliSubtitleUrl(value: URL): boolean {
	return value.protocol === 'https:'
		&& (value.hostname.endsWith('.bilibili.com') || value.hostname.endsWith('.hdslb.com'));
}

function getRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

async function fetchJson(
	fetcher: (url: string) => Promise<BilibiliFetchResponse>,
	url: string
): Promise<Record<string, unknown> | null> {
	try {
		const response = await fetcher(url);
		return response.ok ? getRecord(await response.json()) : null;
	} catch {
		return null;
	}
}

function selectSubtitleTrack(subtitles: unknown): BilibiliSubtitleTrack | null {
	if (!Array.isArray(subtitles)) return null;
	const tracks = subtitles.filter((track): track is BilibiliSubtitleTrack => {
		const item = getRecord(track);
		return item !== null
			&& item.is_lock !== true
			&& item.is_lock !== 1
			&& typeof item.subtitle_url === 'string';
	});
	return tracks.find(track => track.lan === 'ai-zh')
		|| tracks.find(track => track.lan === 'zh-CN' || track.lan === 'zh')
		|| tracks[0]
		|| null;
}

function parseSegments(value: unknown): BilibiliTranscriptSegment[] {
	const payload = getRecord(value);
	if (!Array.isArray(payload?.body)) return [];
	return payload.body.flatMap(item => {
		const record = getRecord(item);
		const start = Number(record?.from);
		const end = Number(record?.to);
		const text = typeof record?.content === 'string' ? record.content.trim() : '';
		return Number.isFinite(start) && Number.isFinite(end) && end > start && text
			? [{ start, end, text }]
			: [];
	});
}

export async function fetchBilibiliTranscript(
	bvid: string,
	playerResponse: unknown,
	{ fetcher }: BilibiliTranscriptOptions
): Promise<BilibiliTranscript | null> {
	if (!/^BV[0-9A-Za-z]+$/i.test(bvid)) return null;
	const player = getRecord(playerResponse);
	const subtitle = getRecord(getRecord(player?.data)?.subtitle);
	const track = selectSubtitleTrack(subtitle?.subtitles);
	if (!track || typeof track.subtitle_url !== 'string') return null;
	if (!track.subtitle_url.startsWith('https://') && !track.subtitle_url.startsWith('//')) return null;

	let subtitleUrl: URL;
	try {
		subtitleUrl = new URL(track.subtitle_url, 'https://www.bilibili.com');
	} catch {
		return null;
	}
	if (!isBilibiliSubtitleUrl(subtitleUrl)) return null;
	const document = await fetchJson(fetcher, subtitleUrl.toString());
	const segments = parseSegments(document);
	if (!segments.length) return null;

	return {
		bvid,
		language: typeof track.lan === 'string' ? track.lan : '',
		languageLabel: typeof track.lan_doc === 'string' ? track.lan_doc : '',
		segments
	};
}
