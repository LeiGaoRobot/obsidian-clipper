// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchBilibiliPageJson } from './bilibili-page-fetch';

describe('Bilibili page fetch bridge', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('aborts a stalled subtitle document request at the supplied deadline', async () => {
		vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			(init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
				reject(new DOMException('Timed out', 'AbortError'));
			}, { once: true });
		}));

		await expect(fetchBilibiliPageJson('https://subtitle.hdslb.com/zh.json', Date.now() + 25))
			.resolves.toEqual({ ok: false, text: '' });
	});

	test('does not fetch when an injected call starts after its deadline', async () => {
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);

		await expect(fetchBilibiliPageJson('https://subtitle.hdslb.com/zh.json', Date.now() - 1))
			.resolves.toEqual({ ok: false, text: '' });
		expect(fetcher).not.toHaveBeenCalled();
	});
});
