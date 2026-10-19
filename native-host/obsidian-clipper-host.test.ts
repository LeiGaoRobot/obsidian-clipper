import { afterEach, describe, expect, test, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCliInvocation } from '../src/utils/cli-execution';
// @ts-expect-error The Native Messaging host intentionally remains a standalone ESM script.
import {
	HEARTBEAT_INTERVAL_MS,
	MAX_OUTPUT_SCHEMA_CHARS,
	createCliInvocation,
	runCli,
	validateRequest
} from './obsidian-clipper-host.mjs';
// @ts-expect-error The argv module intentionally remains a standalone ESM script.
import { buildCliArguments } from './cli-invocation.mjs';
// @ts-expect-error The installer intentionally remains a standalone ESM script.
import { installNativeHost } from '../scripts/install-native-host.mjs';
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

	test('passes the selected model to Codex as one argument', () => {
		const invocation = createCliInvocation(
			{ mode: 'codex', prompt: 'prompt', model: 'gpt-5.6-sol' },
			{ grokPath: '/usr/local/bin/grok', codexPath: '/usr/local/bin/codex' }
		);

		expect(invocation.args).toEqual([
			'exec',
			'--model',
			'gpt-5.6-sol',
			'--ephemeral',
			'--color',
			'never',
			'--sandbox',
			'read-only',
			'--skip-git-repo-check',
			'-'
		]);
		expect(invocation.input).toBe('prompt');
	});

	test('passes model and reasoning effort to Codex as separate arguments', () => {
		const invocation = createCliInvocation(
			{ mode: 'codex', prompt: 'prompt', model: 'gpt-5.6-sol', effort: 'max' },
			{ grokPath: '/usr/local/bin/grok', codexPath: '/usr/local/bin/codex' }
		);

		expect(invocation.args).toEqual([
			'exec',
			'--model',
			'gpt-5.6-sol',
			'-c',
			'model_reasoning_effort="max"',
			'--ephemeral',
			'--color',
			'never',
			'--sandbox',
			'read-only',
			'--skip-git-repo-check',
			'-'
		]);
	});

	test('supports an effort override without a model override', () => {
		const invocation = createCliInvocation(
			{ mode: 'codex', prompt: 'prompt', effort: 'high' },
			{ grokPath: '/usr/local/bin/grok', codexPath: '/usr/local/bin/codex' }
		);

		expect(invocation.args).toEqual([
			'exec',
			'-c',
			'model_reasoning_effort="high"',
			'--ephemeral',
			'--color',
			'never',
			'--sandbox',
			'read-only',
			'--skip-git-repo-check',
			'-'
		]);
	});

	test('keeps the previous Codex arguments when no model is selected', () => {
		expect(createCliInvocation(
			{ mode: 'codex', prompt: 'prompt' },
			{ grokPath: '/usr/local/bin/grok', codexPath: '/usr/local/bin/codex' }
		).args).toEqual([
			'exec',
			'--ephemeral',
			'--color',
			'never',
			'--sandbox',
			'read-only',
			'--skip-git-repo-check',
			'-'
		]);
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

	test.each([
		{
			name: 'canonical Codex model',
			request: { mode: 'codex', model: 'gpt-5.6-sol' },
			expected: null
		},
		{
			name: 'Grok model override',
			request: { mode: 'grok', model: 'gpt-5.6-sol' },
			expected: 'Codex model overrides require Codex execution mode.'
		},
		{
			name: 'blank Codex model',
			request: { mode: 'codex', model: '' },
			expected: 'Codex model must be a non-empty string of at most 200 characters.'
		},
		{
			name: 'padded Codex model',
			request: { mode: 'codex', model: ' gpt-5.6-sol ' },
			expected: 'Codex model must not include leading or trailing whitespace.'
		},
		{
			name: 'oversized Codex model',
			request: { mode: 'codex', model: 'x'.repeat(201) },
			expected: 'Codex model must be a non-empty string of at most 200 characters.'
		}
	])('validates $name at the Native Host boundary', ({ request, expected }) => {
		expect(validateRequest({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-model',
			prompt: 'prompt',
			...request
		})).toBe(expected);
	});

	test.each(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
		('accepts %s effort at the Native Host boundary', effort => {
			expect(validateRequest({
				type: 'executeCli',
				protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
				requestId: `request-${effort}`,
				mode: 'codex',
				prompt: 'prompt',
				effort
			})).toBeNull();
		});

	test.each([
		{
			name: 'unknown Codex effort',
			request: { mode: 'codex', effort: 'extreme' },
			expected: 'Codex reasoning effort must be a supported value.'
		},
		{
			name: 'Grok effort override',
			request: { mode: 'grok', effort: 'high' },
			expected: 'Codex reasoning effort overrides require Codex execution mode.'
		}
	])('rejects $name at the Native Host boundary', ({ request, expected }) => {
		expect(validateRequest({
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-effort',
			prompt: 'prompt',
			...request
		})).toBe(expected);
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

	test('runs a Node-based CLI when the browser PATH does not contain Node', async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'obsidian-clipper-host-'));
		const executable = path.join(directory, 'node-cli');
		writeFileSync(executable, [
			'#!/usr/bin/env node',
			'process.stdin.resume();',
			'process.stdin.on("end", () => process.stdout.write("ok\\n"));',
			''
		].join('\n'));
		chmodSync(executable, 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = '';
		try {
			await expect(runCli({
				type: 'executeCli',
				protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
				requestId: 'request-node-path',
				mode: 'codex',
				prompt: 'prompt'
			}, {
				grokPath: executable,
				codexPath: executable
			}, () => {})).resolves.toMatchObject({ stdout: 'ok\n' });
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
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

	test('rejects a protocol v4 request so outdated clients reinstall', () => {
		expect(validateRequest({
			type: 'executeCli',
			protocolVersion: 4,
			requestId: 'request-v4',
			mode: 'codex',
			prompt: 'prompt'
		})).toBe('Native host protocol version mismatch.');
	});

	test('validates the heartbeat opt-in flag', () => {
		const request = {
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-heartbeat',
			mode: 'codex',
			prompt: 'prompt'
		};
		expect(validateRequest({ ...request, heartbeat: true })).toBeNull();
		expect(validateRequest({ ...request, heartbeat: 'yes' })).toBe('Heartbeat must be a boolean.');
	});

	describe('heartbeats', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		async function runBlockingCli(heartbeat: boolean) {
			const directory = mkdtempSync(path.join(os.tmpdir(), 'obsidian-clipper-host-'));
			const executable = path.join(directory, 'blocking-cli');
			writeFileSync(executable, '#!/bin/sh\ntrap "exit 0" TERM\nwhile true; do sleep 1; done\n');
			chmodSync(executable, 0o755);
			vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
			const heartbeats: unknown[] = [];
			let cancel: (() => void) | undefined;
			try {
				const request = runCli({
					type: 'executeCli',
					protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
					requestId: 'request-heartbeat',
					mode: 'codex',
					prompt: 'prompt',
					...(heartbeat ? { heartbeat: true } : {})
				}, {
					grokPath: executable,
					codexPath: executable
				}, (terminate: () => void) => { cancel = terminate; }, (message: unknown) => heartbeats.push(message));
				vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2 + 1);
				cancel?.();
				await expect(request).rejects.toMatchObject({ code: 'cancelled' });
				vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
				return heartbeats;
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}

		test('emits heartbeats while an opted-in CLI request runs', async () => {
			const heartbeats = await runBlockingCli(true);
			expect(heartbeats).toHaveLength(2);
			expect(heartbeats[0]).toMatchObject({ type: 'heartbeat', requestId: 'request-heartbeat' });
			expect((heartbeats[0] as { ok?: unknown }).ok).toBeUndefined();
		});

		test('stays silent without the opt-in flag', async () => {
			expect(await runBlockingCli(false)).toEqual([]);
		});
	});

	test('installs the Host with its argv module so it can be imported', async () => {
		const home = mkdtempSync(path.join(os.tmpdir(), 'obsidian-clipper-install-'));
		try {
			installNativeHost({
				extensionId: 'a'.repeat(32),
				grokPath: '/usr/local/bin/grok',
				codexPath: '/usr/local/bin/codex',
				home,
				platform: 'linux',
				env: {},
				nodePath: process.execPath,
				workspaceRoot: path.resolve(__dirname, '..')
			});
			const installDirectory = path.join(home, '.config', 'obsidian-web-clipper', 'native-host');
			const installed = await import(path.join(installDirectory, 'obsidian-clipper-host.mjs'));
			expect(installed.NATIVE_CLI_PROTOCOL_VERSION).toBe(NATIVE_CLI_PROTOCOL_VERSION);
			expect(installed.createCliInvocation(
				{ mode: 'codex', prompt: 'p', effort: 'high' },
				{ grokPath: null, codexPath: '/bin/codex' }
			).args).toContain('model_reasoning_effort="high"');
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	describe('Codex output schema', () => {
		const schema = {
			type: 'object',
			properties: { answer: { type: 'string' } },
			required: ['answer'],
			additionalProperties: false
		};
		const baseRequest = {
			type: 'executeCli',
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			requestId: 'request-schema',
			mode: 'codex',
			prompt: 'prompt'
		};
		const schemaDirectories = () => new Set(readdirSync(os.tmpdir())
			.filter(name => name.startsWith('obsidian-clipper-schema-')));
		const newSchemaDirectories = (before: Set<string>) => Array.from(schemaDirectories())
			.filter(name => !before.has(name));

		/** Writes a fake CLI that records argv, the schema file content and its permissions. */
		function createRecordingCli(directory: string, tail: string) {
			const executable = path.join(directory, 'recording-cli');
			const files = {
				args: path.join(directory, 'args'),
				schema: path.join(directory, 'schema-copy'),
				mode: path.join(directory, 'schema-mode'),
				ready: path.join(directory, 'ready')
			};
			writeFileSync(executable, [
				'#!/bin/sh',
				`printf '%s\\n' "$@" > '${files.args}'`,
				'previous=""',
				'for argument in "$@"; do',
				'  if [ "$previous" = "--output-schema" ]; then',
				`    cat "$argument" > '${files.schema}'`,
				`    ls -l "$argument" | cut -c1-10 > '${files.mode}'`,
				'  fi',
				'  previous="$argument"',
				'done',
				`touch '${files.ready}'`,
				tail,
				''
			].join('\n'));
			chmodSync(executable, 0o755);
			return { executable, files };
		}

		function recordedArgs(file: string): string[] {
			return readFileSync(file, 'utf8').split('\n').slice(0, -1);
		}

		async function waitForFile(file: string) {
			for (let attempt = 0; attempt < 250 && !existsSync(file); attempt++) {
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			expect(existsSync(file)).toBe(true);
		}

		test.each([
			{ name: 'a Codex object schema', request: { mode: 'codex', outputSchema: schema }, expected: null },
			{
				name: 'a Grok schema',
				request: { mode: 'grok', outputSchema: schema },
				expected: 'Output schemas require Codex execution mode.'
			},
			{
				name: 'an array schema',
				request: { mode: 'codex', outputSchema: [schema] },
				expected: 'Output schema must be a JSON object.'
			},
			{
				name: 'a null schema',
				request: { mode: 'codex', outputSchema: null },
				expected: 'Output schema must be a JSON object.'
			},
			{
				name: 'a string schema',
				request: { mode: 'codex', outputSchema: '{"type":"object"}' },
				expected: 'Output schema must be a JSON object.'
			},
			{
				name: 'an oversized schema',
				request: { mode: 'codex', outputSchema: { description: 'x'.repeat(MAX_OUTPUT_SCHEMA_CHARS) } },
				expected: 'Output schema must serialize to at most 20000 characters.'
			}
		])('validates $name at the Native Host boundary', ({ request, expected }) => {
			expect(validateRequest({ ...baseRequest, ...request })).toBe(expected);
		});

		test('accepts a schema that serializes to exactly the limit', () => {
			const padding = MAX_OUTPUT_SCHEMA_CHARS - JSON.stringify({ description: '' }).length;
			const outputSchema = { description: 'x'.repeat(padding) };
			expect(JSON.stringify(outputSchema)).toHaveLength(MAX_OUTPUT_SCHEMA_CHARS);
			expect(validateRequest({ ...baseRequest, outputSchema })).toBeNull();
		});

		test('places --output-schema before the trailing stdin marker for Codex only', () => {
			expect(buildCliArguments({
				mode: 'codex',
				prompt: 'prompt',
				model: 'gpt-5.6-sol',
				outputSchemaPath: '/tmp/schema-dir/schema.json'
			}).args).toEqual([
				'exec',
				'--model',
				'gpt-5.6-sol',
				'--ephemeral',
				'--color',
				'never',
				'--sandbox',
				'read-only',
				'--skip-git-repo-check',
				'--output-schema',
				'/tmp/schema-dir/schema.json',
				'-'
			]);
			expect(buildCliArguments({ mode: 'grok', prompt: 'prompt', outputSchemaPath: '/tmp/schema.json' }).args)
				.not.toContain('--output-schema');
		});

		test('ignores a schema path smuggled into the request itself', () => {
			const config = { grokPath: '/usr/local/bin/grok', codexPath: '/usr/local/bin/codex' };
			expect(createCliInvocation({ mode: 'codex', prompt: 'p', outputSchemaPath: '/etc/passwd' }, config).args)
				.not.toContain('--output-schema');
			expect(createCliInvocation({ mode: 'codex', prompt: 'p' }, config, '/tmp/d/schema.json').args.slice(-3))
				.toEqual(['--output-schema', '/tmp/d/schema.json', '-']);
		});

		test('writes the schema to a private temp file and removes it after success', async () => {
			const directory = mkdtempSync(path.join(os.tmpdir(), 'obsidian-clipper-host-'));
			const { executable, files } = createRecordingCli(directory, 'cat > /dev/null\necho \'{"answer":"ok"}\'');
			try {
				await expect(runCli({ ...baseRequest, outputSchema: schema }, {
					grokPath: executable,
					codexPath: executable
				}, () => {})).resolves.toMatchObject({ stdout: '{"answer":"ok"}\n' });

				const args = recordedArgs(files.args);
				const schemaPath = args[args.indexOf('--output-schema') + 1];
				expect(args.at(-1)).toBe('-');
				expect(path.basename(schemaPath)).toBe('schema.json');
				expect(path.basename(path.dirname(schemaPath))).toMatch(/^obsidian-clipper-schema-/);
				expect(readFileSync(files.schema, 'utf8')).toBe(JSON.stringify(schema));
				expect(readFileSync(files.mode, 'utf8').trim()).toBe('-rw-------');
				expect(existsSync(path.dirname(schemaPath))).toBe(false);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});

		test('removes the schema file after a failing CLI', async () => {
			const directory = mkdtempSync(path.join(os.tmpdir(), 'obsidian-clipper-host-'));
			const { executable, files } = createRecordingCli(directory, 'cat > /dev/null\necho boom >&2\nexit 3');
			try {
				await expect(runCli({ ...baseRequest, outputSchema: schema }, {
					grokPath: executable,
					codexPath: executable
				}, () => {})).rejects.toMatchObject({ code: 'cli-failed' });

				const args = recordedArgs(files.args);
				const schemaPath = args[args.indexOf('--output-schema') + 1];
				expect(existsSync(path.dirname(schemaPath))).toBe(false);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});

		test('removes the schema file after a cancelled CLI', async () => {
			const directory = mkdtempSync(path.join(os.tmpdir(), 'obsidian-clipper-host-'));
			const { executable, files } = createRecordingCli(
				directory,
				'trap "exit 0" TERM\nwhile true; do sleep 1; done'
			);
			let cancel: (() => void) | undefined;
			try {
				const request = runCli({ ...baseRequest, outputSchema: schema }, {
					grokPath: executable,
					codexPath: executable
				}, (terminate: () => void) => { cancel = terminate; });
				await waitForFile(files.ready);
				const args = recordedArgs(files.args);
				const schemaPath = args[args.indexOf('--output-schema') + 1];
				expect(existsSync(schemaPath)).toBe(true);
				cancel?.();

				await expect(request).rejects.toMatchObject({ code: 'cancelled' });
				expect(existsSync(path.dirname(schemaPath))).toBe(false);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});

		test('cancels before spawning when cancellation arrives during schema setup', async () => {
			const directory = mkdtempSync(path.join(os.tmpdir(), 'obsidian-clipper-host-'));
			const { executable, files } = createRecordingCli(directory, 'cat > /dev/null');
			const before = schemaDirectories();
			let cancel: (() => void) | undefined;
			try {
				const request = runCli({ ...baseRequest, outputSchema: schema }, {
					grokPath: executable,
					codexPath: executable
				}, (terminate: () => void) => { cancel = terminate; });
				cancel?.();

				await expect(request).rejects.toMatchObject({ code: 'cancelled' });
				expect(existsSync(files.args)).toBe(false);
				expect(newSchemaDirectories(before)).toEqual([]);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});

		test('removes the schema file when the CLI cannot be launched', async () => {
			const directory = mkdtempSync(path.join(os.tmpdir(), 'obsidian-clipper-host-'));
			const before = schemaDirectories();
			try {
				await expect(runCli({ ...baseRequest, outputSchema: schema }, {
					grokPath: null,
					codexPath: path.join(directory, 'missing-cli')
				}, () => {})).rejects.toMatchObject({ code: 'launch-failed' });
				expect(newSchemaDirectories(before)).toEqual([]);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	});
});