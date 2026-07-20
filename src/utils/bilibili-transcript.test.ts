import { describe, expect, test, vi } from 'vitest';
import { fetchBilibiliTranscript } from './bilibili-transcript';

describe('Bilibili transcript adapter', () => {
	test('loads the preferred timed AI subtitle track from the current player response', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url === 'https://subtitle.hdslb.com/zh.json') {
				return new Response(JSON.stringify({
					body: [
						{ from: 0, to: 1.5, content: '第一句' },
						{ from: 1.5, to: 3, content: '第二句' }
					]
				}));
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		const playerResponse = {
			code: 0,
			data: {
				subtitle: {
					subtitles: [
						{ lan: 'ai-en', lan_doc: 'English', subtitle_url: '//subtitle.hdslb.com/en.json' },
						{ lan: 'ai-zh', lan_doc: '中文', subtitle_url: '//subtitle.hdslb.com/zh.json' }
					]
				}
			}
		};

		await expect(fetchBilibiliTranscript('BV1GBMG65ECA', playerResponse, { fetcher })).resolves.toEqual({
			bvid: 'BV1GBMG65ECA',
			language: 'ai-zh',
			languageLabel: '中文',
			segments: [
				{ start: 0, end: 1.5, text: '第一句' },
				{ start: 1.5, end: 3, text: '第二句' }
			]
		});

		expect(fetcher).toHaveBeenCalledOnce();
	});

	test('does not request a subtitle document when the player has no subtitle tracks', async () => {
		const fetcher = vi.fn(async () => new Response(JSON.stringify({
			code: 0,
			data: { subtitle: { subtitles: [] } }
		})));

		await expect(fetchBilibiliTranscript('BV1GBMG65ECA', {
			code: 0,
			data: { subtitle: { subtitles: [] } }
		}, { fetcher })).resolves.toBeNull();

		expect(fetcher).not.toHaveBeenCalled();
	});

	test('does not follow a subtitle URL outside Bilibili-owned domains', async () => {
		const fetcher = vi.fn(async () => new Response(JSON.stringify({
			code: 0,
			data: {
				subtitle: {
					subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://example.com/subtitle.json' }]
				}
			}
		})));

		await expect(fetchBilibiliTranscript('BV1GBMG65ECA', {
			code: 0,
			data: {
				subtitle: {
					subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://example.com/subtitle.json' }]
				}
			}
		}, { fetcher })).resolves.toBeNull();

		expect(fetcher).not.toHaveBeenCalled();
	});

	test('ignores a malformed subtitle URL', async () => {
		const fetcher = vi.fn(async () => new Response('{}'));

		await expect(fetchBilibiliTranscript('BV1GBMG65ECA', {
			data: {
				subtitle: {
					subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://[invalid' }]
				}
			}
		}, { fetcher })).resolves.toBeNull();

		expect(fetcher).not.toHaveBeenCalled();
	});

	test('does not resolve a relative subtitle URL against the Bilibili page', async () => {
		const fetcher = vi.fn(async () => new Response('{}'));

		await expect(fetchBilibiliTranscript('BV1GBMG65ECA', {
			data: {
				subtitle: {
					subtitles: [{ lan: 'ai-zh', subtitle_url: '/account' }]
				}
			}
		}, { fetcher })).resolves.toBeNull();

		expect(fetcher).not.toHaveBeenCalled();
	});
});
