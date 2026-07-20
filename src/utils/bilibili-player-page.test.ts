// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchCurrentBilibiliPlayerJson } from './bilibili-player-page';

const bvid = 'BV1GBMG65ECA';
const playerUrl = (rid: string) => `https://api.bilibili.com/x/player/wbi/v2?aid=101&cid=202&w_rid=${rid}`;
const playerPayload = '{"code":0,"data":{"subtitle":{"subtitles":[]}}}';
const deadlineAfter = (milliseconds: number) => Date.now() + milliseconds;

describe('Bilibili player page bridge', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		delete (window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__;
	});

	test('keeps waiting after an expired matching player request', async () => {
		(window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__ = {
			aid: 101,
			bvid,
			cid: 202
		};
		let resourcesRead = 0;
		vi.stubGlobal('performance', {
			getEntriesByType: () => {
				resourcesRead++;
				return resourcesRead === 1
					? [{ name: playerUrl('expired') }]
					: [{ name: playerUrl('expired') }, { name: playerUrl('fresh') }];
			}
		});
		const fetcher = vi.fn(async (url: URL) => {
			return url.searchParams.get('w_rid') === 'fresh'
				? new Response(playerPayload)
				: new Response('', { status: 403 });
		});
		vi.stubGlobal('fetch', fetcher);

		await expect(fetchCurrentBilibiliPlayerJson(bvid, deadlineAfter(250))).resolves.toEqual({
			ok: true,
			text: playerPayload
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(fetcher.mock.calls.map(([url]) => url.searchParams.get('w_rid'))).toEqual(['expired', 'fresh']);
	});

	test('keeps waiting after a successful HTTP response with an API error', async () => {
		(window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__ = {
			aid: 101,
			bvid,
			cid: 202
		};
		let resourcesRead = 0;
		vi.stubGlobal('performance', {
			getEntriesByType: () => {
				resourcesRead++;
				return resourcesRead === 1
					? [{ name: playerUrl('api-error') }]
					: [{ name: playerUrl('api-error') }, { name: playerUrl('fresh') }];
			}
		});
		const fetcher = vi.fn(async (url: URL) => {
			return url.searchParams.get('w_rid') === 'fresh'
				? new Response(playerPayload)
				: new Response('{"code":-403,"message":"invalid sign"}');
		});
		vi.stubGlobal('fetch', fetcher);

		await expect(fetchCurrentBilibiliPlayerJson(bvid, deadlineAfter(250))).resolves.toEqual({
			ok: true,
			text: playerPayload
		});
		expect(fetcher.mock.calls.map(([url]) => url.searchParams.get('w_rid'))).toEqual(['api-error', 'fresh']);
	});

	test('does not use a matching AID and CID until the page BVID is present', async () => {
		(window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__ = {
			aid: 101,
			cid: 202
		};
		vi.stubGlobal('performance', {
			getEntriesByType: () => [{ name: playerUrl('other-video') }]
		});
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);

		await expect(fetchCurrentBilibiliPlayerJson(bvid, deadlineAfter(1))).resolves.toEqual({ ok: false, text: '' });
		expect(fetcher).not.toHaveBeenCalled();
	});

	test('aborts a stalled current-player request at the deadline', async () => {
		(window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__ = {
			aid: 101,
			bvid,
			cid: 202
		};
		vi.stubGlobal('performance', {
			getEntriesByType: () => [{ name: playerUrl('stalled') }]
		});
		vi.stubGlobal('fetch', (_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			(init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
				reject(new DOMException('Timed out', 'AbortError'));
			}, { once: true });
		}));

		await expect(fetchCurrentBilibiliPlayerJson(bvid, deadlineAfter(25))).resolves.toEqual({ ok: false, text: '' });
	});

	test('does not fetch when an injected call starts after its deadline', async () => {
		(window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__ = {
			aid: 101,
			bvid,
			cid: 202
		};
		vi.stubGlobal('performance', {
			getEntriesByType: () => [{ name: playerUrl('late') }]
		});
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);

		await expect(fetchCurrentBilibiliPlayerJson(bvid, deadlineAfter(-1)))
			.resolves.toEqual({ ok: false, text: '' });
		expect(fetcher).not.toHaveBeenCalled();
	});
});
