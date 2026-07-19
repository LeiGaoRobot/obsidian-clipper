import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

describe('Browser manifests', () => {
	test('discloses website-content transmission in the Firefox manifest', () => {
		const manifest = JSON.parse(readFileSync('src/manifest.firefox.json', 'utf8'));

		expect(manifest.browser_specific_settings.gecko.data_collection_permissions.required)
			.toEqual(['websiteContent']);
		expect(manifest.browser_specific_settings.gecko_android.data_collection_permissions.required)
			.toEqual(['websiteContent']);
		expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe('140.0');
		expect(manifest.browser_specific_settings.gecko_android.strict_min_version).toBe('142.0');
	});
});
