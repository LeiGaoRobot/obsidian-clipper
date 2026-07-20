export interface BilibiliPageFetchResponse {
	ok: boolean;
	text: string;
}

/**
 * Runs in the Bilibili document's execution world through scripting.executeScript.
 * Keep this function self-contained: extension APIs and module bindings are not
 * available after the browser serializes it into the page.
 */
export async function fetchBilibiliPageJson(
	url: string,
	deadline: number
): Promise<BilibiliPageFetchResponse> {
	const timeoutMs = deadline - Date.now();
	if (timeoutMs <= 0) return { ok: false, text: '' };
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { credentials: 'include', signal: controller.signal });
		return { ok: response.ok, text: await response.text() };
	} catch {
		return { ok: false, text: '' };
	} finally {
		clearTimeout(timeout);
	}
}
