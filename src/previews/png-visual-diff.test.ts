import { describe, expect, test } from 'vitest';
// @ts-ignore The visual utility is an executable ESM script shared with Node CI.
import { comparePng, encodePng } from '../../scripts/png-visual-diff.mjs';

describe('PNG visual diff', () => {
	test('counts changed pixels and emits a visible diff image', () => {
		const baseline = encodePng(2, 1, new Uint8Array([
			255, 255, 255, 255,
			0, 0, 0, 255
		]));
		const current = encodePng(2, 1, new Uint8Array([
			255, 255, 255, 255,
			255, 0, 0, 255
		]));

		const result = comparePng(baseline, current, { channelThreshold: 8 });

		expect(result.changedPixels).toBe(1);
		expect(result.totalPixels).toBe(2);
		expect(result.ratio).toBe(0.5);
		expect(result.diff.subarray(1, 4).toString()).toBe('PNG');
	});
});
