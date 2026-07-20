export interface BilibiliPlayerPageResponse {
	ok: boolean;
	text: string;
}

interface BilibiliPlayerState {
	aid?: unknown;
	bvid?: unknown;
	cid?: unknown;
}

/**
 * Runs in the Bilibili document's execution world through scripting.executeScript.
 * Keep this function self-contained: extension APIs and module bindings are not
 * available after the browser serializes it into the page.
 */
export async function fetchCurrentBilibiliPlayerJson(
	bvid: string,
	deadline: number
): Promise<BilibiliPlayerPageResponse> {
	const expectedBvid = bvid.toLowerCase();
	const attemptedUrls = new Set<string>();
	const waitForNextAttempt = async () => {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, remainingMs)));
		return true;
	};
	while (Date.now() <= deadline) {
		const state = (window as Window & { __INITIAL_STATE__?: BilibiliPlayerState }).__INITIAL_STATE__;
		const stateBvid = typeof state?.bvid === 'string' ? state.bvid.toLowerCase() : '';
		if (!stateBvid) {
			if (!await waitForNextAttempt()) break;
			continue;
		}
		if (stateBvid !== expectedBvid) return { ok: false, text: '' };
		const aid = typeof state?.aid === 'string' || typeof state?.aid === 'number' ? String(state.aid) : '';
		const cid = typeof state?.cid === 'string' || typeof state?.cid === 'number' ? String(state.cid) : '';
		if (aid && cid) {
			const entries = performance.getEntriesByType('resource');
			for (let index = entries.length - 1; index >= 0; index--) {
				try {
					const url = new URL(entries[index].name);
					if (url.protocol !== 'https:'
						|| url.hostname !== 'api.bilibili.com'
						|| url.pathname !== '/x/player/wbi/v2'
						|| url.searchParams.get('aid') !== aid
						|| url.searchParams.get('cid') !== cid
						|| attemptedUrls.has(url.href)) continue;
					attemptedUrls.add(url.href);
					const remainingMs = deadline - Date.now();
					if (remainingMs <= 0) break;
					const controller = new AbortController();
					const timeout = setTimeout(() => controller.abort(), remainingMs);
					try {
						const response = await fetch(url, { credentials: 'include', signal: controller.signal });
						const text = await response.text();
						const payload = JSON.parse(text) as { code?: unknown; data?: { subtitle?: unknown } };
						if (response.ok && payload.code === 0 && payload.data?.subtitle) {
							return { ok: true, text };
						}
					} finally {
						clearTimeout(timeout);
					}
				} catch {
					// Ignore malformed, expired, and unavailable requests until a current one arrives.
				}
			}
		}
		if (!await waitForNextAttempt()) break;
	}
	return { ok: false, text: '' };
}
