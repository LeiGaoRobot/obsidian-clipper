import { describe, expect, test } from 'vitest';
import { buildCliInvocation } from '../src/utils/cli-execution';
// @ts-expect-error The Native Messaging host intentionally remains a standalone ESM script.
import { createCliInvocation } from './obsidian-clipper-host.mjs';

describe('Obsidian Web Clipper native host', () => {
	test('runs Grok as a single-turn interpreter without built-in tools or memory', () => {
		expect(createCliInvocation(
			{ mode: 'grok', prompt: 'prompt' },
			{ grokPath: '/usr/local/bin/grok', codexPath: '/usr/local/bin/codex' }
		)).toEqual({
			command: '/usr/local/bin/grok',
			args: [
				'--single',
				'prompt',
				'--output-format',
				'plain',
				'--no-plan',
				'--no-subagents',
				'--no-memory',
				'--disable-web-search',
				'--tools',
				'',
				'--max-turns',
				'1',
				'--verbatim'
			],
			input: ''
		});
	});

	test('keeps Grok hardening flags aligned with shared CLI execution', () => {
		const nativeInvocation = createCliInvocation(
			{ mode: 'grok', prompt: 'prompt' },
			{ grokPath: '/usr/local/bin/grok', codexPath: '/usr/local/bin/codex' }
		);
		const sharedInvocation = buildCliInvocation('grok', 'prompt');

		expect(nativeInvocation.args).toEqual(sharedInvocation.args);
	});
});
