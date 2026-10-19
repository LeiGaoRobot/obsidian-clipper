import browser from './browser-polyfill';
import type { NativeMessagingSupport } from '../ai/types';

/**
 * How this context can reach the Native Messaging Host: a long-lived port (Chromium, Firefox
 * with the permission), one-shot messages only (Safari), or not at all. Shared by the background
 * and extension pages; content scripts have neither API and always answer `none`.
 */
export function detectNativeMessaging(): NativeMessagingSupport {
	const runtime = browser.runtime as unknown as { connectNative?: unknown; sendNativeMessage?: unknown };
	if (typeof runtime.connectNative === 'function') return 'port';
	return typeof runtime.sendNativeMessage === 'function' ? 'message' : 'none';
}
