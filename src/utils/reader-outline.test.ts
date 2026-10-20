import { describe, expect, test } from 'vitest';
import { buildOutlineRootMargin } from './reader-outline';

describe('Reader outline observer margin', () => {
	test('uses the default heading zone without a sticky player', () => {
		expect(buildOutlineRootMargin(0, 800)).toBe('-5% 0px -80% 0px');
	});

	test('accounts for a sticky player within the viewport', () => {
		expect(buildOutlineRootMargin(180, 600)).toBe('-32% 0px -53% 0px');
	});

	test('clamps an oversized sticky player to a valid observer margin', () => {
		expect(buildOutlineRootMargin(900, 600)).toBe('-85% 0px 0% 0px');
	});

	test('falls back safely for unusable viewport measurements', () => {
		expect(buildOutlineRootMargin(180, 0)).toBe('-5% 0px -80% 0px');
		expect(buildOutlineRootMargin(Number.POSITIVE_INFINITY, 600))
			.toBe('-5% 0px -80% 0px');
	});
});
