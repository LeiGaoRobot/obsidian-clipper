import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const packageMetadata = JSON.parse(readFileSync('package.json', 'utf8'));
const chromeManifest = JSON.parse(readFileSync('src/manifest.chrome.json', 'utf8'));
const firefoxManifest = JSON.parse(readFileSync('src/manifest.firefox.json', 'utf8'));
const safariManifest = JSON.parse(readFileSync('src/manifest.safari.json', 'utf8'));
const pagePickIcons = {
	16: 'src/brands/pagepick/icons/pagepick16.png',
	48: 'src/brands/pagepick/icons/pagepick48.png',
	128: 'src/brands/pagepick/icons/pagepick128.png'
};

describe('PagePick Chrome release metadata', () => {
	test('uses the independent PagePick identity and original icon assets', () => {
		expect(chromeManifest.name).toBe('PagePick for Obsidian');
		expect(chromeManifest.homepage_url).toBe('https://github.com/LeiGaoRobot/obsidian-clipper');
		expect(chromeManifest.description).toContain('independent');
		expect(chromeManifest.description).not.toMatch(/official/i);
		expect(chromeManifest.description.length).toBeLessThanOrEqual(132);
		expect(chromeManifest.version).toBe(packageMetadata.version);
		expect(chromeManifest.icons).toEqual({
			16: 'icons/pagepick16.png',
			48: 'icons/pagepick48.png',
			128: 'icons/pagepick128.png'
		});
		expect(chromeManifest.commands._execute_action.description).toBe('Open PagePick');
		for (const icon of Object.values(pagePickIcons)) {
			expect(existsSync(icon)).toBe(true);
		}
	});

	test('keeps Firefox and Safari metadata on their existing release identity', () => {
		for (const manifest of [firefoxManifest, safariManifest]) {
			expect(manifest.name).toBe('Obsidian Web Clipper');
			expect(manifest.homepage_url).toBe('https://obsidian.md/');
			expect(manifest.version).toBe(packageMetadata.version);
		}
		expect(firefoxManifest.description).toContain('official extension');
		expect(safariManifest.description).toContain('Save content from the web to Obsidian');
	});
});
