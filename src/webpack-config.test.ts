import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const createWebpackConfig = require('../webpack.config.js') as (
	env: { BROWSER: string },
	argv: { mode: string }
) => Array<{
	entry: Record<string, unknown>;
	output: { chunkFilename?: string };
	plugins: unknown[];
}>;

describe('Webpack extension entries', () => {
	test('keeps the background as a synchronous entry for MV3 service workers', () => {
		const [config] = createWebpackConfig(
			{ BROWSER: 'chrome' },
			{ mode: 'production' }
		);

		expect(config.entry.background).toBe('./src/background.ts');
	});

	test('builds the transcript preview only for development', () => {
		const [development] = createWebpackConfig(
			{ BROWSER: 'chrome' },
			{ mode: 'development' }
		);
		const [production] = createWebpackConfig(
			{ BROWSER: 'chrome' },
			{ mode: 'production' }
		);

		expect(development.entry['transcript-layout-preview'])
			.toBe('./src/previews/transcript-layout-preview.ts');
		expect(production.entry['transcript-layout-preview']).toBeUndefined();
	});

	test('emits lazy UI modules under the generated chunks directory', () => {
		const [config] = createWebpackConfig(
			{ BROWSER: 'chrome' },
			{ mode: 'production' }
		);

		expect(config.output.chunkFilename).toBe('chunks/[name].js');
	});

	test('allows generated chunks in each browser manifest', () => {
		for (const manifestPath of [
			'src/manifest.chrome.json',
			'src/manifest.firefox.json',
			'src/manifest.safari.json'
		]) {
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
			const resources = manifest.web_accessible_resources
				.flatMap((entry: { resources?: string[] }) => entry.resources ?? []);
			expect(resources).toContain('chunks/*.js');
		}
	});
});
