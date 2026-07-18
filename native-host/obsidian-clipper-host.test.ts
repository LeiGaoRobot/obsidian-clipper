import { describe, expect, test } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCliInvocation } from '../src/utils/cli-execution';
// @ts-expect-error The Native Messaging host intentionally remains a standalone ESM script.
import { createCliInvocation, runCli, validateRequest } from './obsidian-clipper-host.mjs';
import { NATIVE_CLI_PROTOCOL_VERSION } from '../src/utils/native-cli-contract';

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

	test('accepts execute, cancel, and health messages on the current protocol', () => {
		expect(validateRequest({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-1',
			mode: 'codex',
			prompt: 'prompt'
		})).toBeNull();
		expect(validateRequest({
			type: 'cancelCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-1'
		})).toBeNull();
		expect(validateRequest({
			type: 'healthCheck',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'health-1',
			mode: 'grok'
		})).toBeNull();
	});

	test('rejects an incompatible Native Host protocol version', () => {
		expect(validateRequest({
			type: 'healthCheck',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION + 1,
			requestId: 'health-1',
			mode: 'grok'
		})).toBe('Native host protocol version mismatch.');
	});

	test('terminates the CLI child when the connected request is cancelled', async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'obsidian-clipper-host-'));
		const executable = path.join(directory, 'blocking-cli');
		writeFileSync(executable, '#!/bin/sh\ntrap "exit 0" TERM\nwhile true; do sleep 1; done\n');
		chmodSync(executable, 0o755);
		let cancel: (() => void) | undefined;
		try {
			const request = runCli({
				type: 'executeCli',
				protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
				requestId: 'request-cancel',
				mode: 'codex',
				prompt: 'prompt'
			}, {
				grokPath: executable,
				codexPath: executable
			}, (terminate: () => void) => { cancel = terminate; });
			cancel?.();

			await expect(request).rejects.toMatchObject({ code: 'cancelled' });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('force kills a CLI that ignores termination after oversized output', async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'obsidian-clipper-host-'));
		const executable = path.join(directory, 'oversized-cli');
		const pidFile = path.join(directory, 'pid');
		writeFileSync(executable, [
			'#!/bin/sh',
			'echo $$ > "$OBSIDIAN_CLIPPER_TEST_PID_FILE"',
			'trap "" TERM',
			'head -c 1000000 /dev/zero',
			'while true; do sleep 1; done',
			''
		].join('\n'));
		chmodSync(executable, 0o755);
		const previousPidFile = process.env.OBSIDIAN_CLIPPER_TEST_PID_FILE;
		process.env.OBSIDIAN_CLIPPER_TEST_PID_FILE = pidFile;
		let childPid: number | undefined;
		try {
			const request = runCli({
				type: 'executeCli',
				protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
				requestId: 'request-oversized',
				mode: 'codex',
				prompt: 'prompt'
			}, {
				grokPath: executable,
				codexPath: executable
			}, () => {});

			await expect(request).rejects.toMatchObject({ code: 'response-too-large' });
			childPid = Number(readFileSync(pidFile, 'utf8').trim());
			expect(() => process.kill(childPid, 0)).toThrow();
		} finally {
			if (childPid) {
				try {
					process.kill(childPid, 'SIGKILL');
				} catch {
					// The expected path has already reaped the child.
				}
			}
			if (previousPidFile === undefined) delete process.env.OBSIDIAN_CLIPPER_TEST_PID_FILE;
			else process.env.OBSIDIAN_CLIPPER_TEST_PID_FILE = previousPidFile;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
