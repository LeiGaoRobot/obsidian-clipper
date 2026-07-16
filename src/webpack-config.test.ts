import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const createWebpackConfig = require('../webpack.config.js') as (
	env: { BROWSER: string },
	argv: { mode: string }
) => Array<{ entry: Record<string, unknown> }>;

describe('Webpack extension entries', () => {
	test('keeps the background as a synchronous entry for MV3 service workers', () => {
		const [config] = createWebpackConfig(
			{ BROWSER: 'chrome' },
			{ mode: 'production' }
		);

		expect(config.entry.background).toBe('./src/background.ts');
	});
});
