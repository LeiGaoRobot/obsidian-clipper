// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import { createBilibiliTranscriptElement } from './bilibili-reader';

describe('Bilibili Reader transcript', () => {
	test('creates safe timed transcript segments for the Reader', () => {
		const transcript = createBilibiliTranscriptElement(document, {
			bvid: 'BV1GBMG65ECA',
			language: 'ai-zh',
			languageLabel: '中文',
			segments: [
				{ start: 0, end: 1.5, text: '第一句' },
				{ start: 61.25, end: 62.5, text: '<em>第二句</em>' }
			]
		});

		expect(transcript.className).toBe('bilibili transcript');
		expect(transcript.dataset.transcriptPlatform).toBe('bilibili');
		expect(transcript.dataset.transcriptLanguage).toBe('ai-zh');
		expect(transcript.querySelectorAll('.transcript-segment')).toHaveLength(2);
		expect(Array.from(transcript.querySelectorAll('.timestamp'), item => item.textContent)).toEqual(['0:00', '1:01']);
		expect(transcript.querySelectorAll('.timestamp')[1].getAttribute('data-timestamp')).toBe('61.25');
		expect(transcript.querySelectorAll('.transcript-segment')[1].textContent).toContain('<em>第二句</em>');
		expect(transcript.querySelector('em')).toBeNull();
	});
});
