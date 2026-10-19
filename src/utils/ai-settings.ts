import browser from './browser-polyfill';
import type { StorageAreaLike } from '../ai/job-store';
import {
	AI_V2_BOOTSTRAP,
	createAiSettingsStore,
	type AiSettingsBootstrapper,
	type AiSettingsSnapshot,
	type AiSettingsStore,
	type StorageChangedEventLike,
	type StorageChangedListener
} from '../ai/settings';
import type { AiSettingsView } from '../ai/types';
import { detectNativeMessaging } from './native-messaging-support';

// The v2 AI settings store wired to the browser's storage areas. Each extension context (Popup,
// Settings, Reader, background) builds its own instance; they share state only through storage.
// Only the background and the Settings page pass the migration bootstrapper, which keeps the
// catalog and migration code out of the Popup and Reader bundles; those read the derived view
// until the background has bootstrapped.

interface BrowserStorageLike {
	sync: StorageAreaLike;
	local: StorageAreaLike;
	session?: StorageAreaLike;
	onChanged: StorageChangedEventLike;
}

function browserStorage(): BrowserStorageLike {
	return browser.storage as unknown as BrowserStorageLike;
}

// Areas are resolved on each call, so building the store never touches `browser.storage`.
function lazyArea(area: () => StorageAreaLike | undefined, name: string): StorageAreaLike {
	const resolve = () => {
		const resolved = area();
		if (!resolved) throw new Error(`storage.${name} is unavailable`);
		return resolved;
	};
	return {
		get: keys => resolve().get(keys),
		set: values => resolve().set(values),
		remove: keys => resolve().remove(keys)
	};
}

const lazyOnChanged: StorageChangedEventLike = {
	addListener: (listener: StorageChangedListener) => browserStorage().onChanged.addListener(listener),
	removeListener: (listener: StorageChangedListener) => browserStorage().onChanged.removeListener(listener)
};

function manifestVersion(): string {
	try {
		return browser.runtime.getManifest().version ?? '';
	} catch {
		return '';
	}
}

function sessionArea(): StorageAreaLike | undefined {
	try {
		// Absent on Safari < 16.4 and Firefox < 115.
		return browserStorage().session ? lazyArea(() => browserStorage().session, 'session') : undefined;
	} catch {
		return undefined;
	}
}

/** `storage.session` for the Settings page's Diagnostics panel; undefined where the browser lacks it. */
export function browserSessionArea(): StorageAreaLike | undefined {
	return sessionArea();
}

/** A store over `browser.storage`; it bootstraps per `AI_V2_BOOTSTRAP` only when given a bootstrapper. */
export function createBrowserAiSettingsStore(bootstrapper?: AiSettingsBootstrapper): AiSettingsStore {
	const session = sessionArea();
	return createAiSettingsStore({
		sync: lazyArea(() => browserStorage().sync, 'sync'),
		local: lazyArea(() => browserStorage().local, 'local'),
		...(session ? { session } : {}),
		onChanged: lazyOnChanged,
		nativeMessaging: detectNativeMessaging,
		bootstrap: AI_V2_BOOTSTRAP && Boolean(bootstrapper),
		...(bootstrapper ? { bootstrapper } : {}),
		build: manifestVersion()
	});
}

/** The read-mostly store for Popup and Reader contexts; it never runs the migration. */
export const aiSettingsStore: AiSettingsStore = createBrowserAiSettingsStore();

/** The current AI settings view. In derived mode (no v2 items yet) it is computed from v1. */
export function loadAiSettings(): Promise<AiSettingsView> {
	return aiSettingsStore.load();
}

export function loadAiSettingsSnapshot(): Promise<AiSettingsSnapshot> {
	return aiSettingsStore.loadSnapshot();
}
