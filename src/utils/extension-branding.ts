import browser from './browser-polyfill';

export const PAGEPICK_NAME = 'PagePick for Obsidian';

export interface ExtensionBranding {
	name: string;
	homepageUrl: string;
	exportFilePrefix: string;
}

export function getExtensionBranding(): ExtensionBranding {
	const manifest = browser.runtime.getManifest();
	if (manifest.name === PAGEPICK_NAME) {
		return {
			name: manifest.name,
			homepageUrl: manifest.homepage_url || 'https://github.com/LeiGaoRobot/obsidian-clipper',
			exportFilePrefix: 'pagepick-for-obsidian'
		};
	}

	return {
		name: manifest.name || 'Obsidian Web Clipper',
		homepageUrl: manifest.homepage_url || 'https://obsidian.md/',
		exportFilePrefix: 'obsidian-web-clipper'
	};
}
