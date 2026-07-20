import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getManifest: vi.fn()
}));

vi.mock('./browser-polyfill', () => ({
	default: {
		runtime: {
			getManifest: mocks.getManifest
		}
	}
}));

import { getExtensionBranding } from './extension-branding';

describe('extension branding', () => {
	beforeEach(() => {
		mocks.getManifest.mockReset();
	});

	test('uses the PagePick branding only for the PagePick Chrome manifest', () => {
		mocks.getManifest.mockReturnValue({
			name: 'PagePick for Obsidian',
			homepage_url: 'https://github.com/LeiGaoRobot/obsidian-clipper'
		});

		expect(getExtensionBranding()).toEqual({
			name: 'PagePick for Obsidian',
			homepageUrl: 'https://github.com/LeiGaoRobot/obsidian-clipper',
			exportFilePrefix: 'pagepick-for-obsidian'
		});
	});

	test('preserves the official branding for Firefox and Safari manifests', () => {
		mocks.getManifest.mockReturnValue({
			name: 'Obsidian Web Clipper',
			homepage_url: 'https://obsidian.md/'
		});

		expect(getExtensionBranding()).toEqual({
			name: 'Obsidian Web Clipper',
			homepageUrl: 'https://obsidian.md/',
			exportFilePrefix: 'obsidian-web-clipper'
		});
	});
});
