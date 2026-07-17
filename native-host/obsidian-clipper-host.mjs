#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

export const MAX_PROMPT_CHARS = 750_000;
export const MAX_REQUEST_BYTES = 4_000_000;
export const MAX_RESPONSE_BYTES = 900_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function configPath() {
	return process.env.OBSIDIAN_CLIPPER_NATIVE_HOST_CONFIG
		|| path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json');
}

function loadConfig() {
	try {
		const config = JSON.parse(readFileSync(configPath(), 'utf8'));
		return {
			grokPath: typeof config.grokPath === 'string' ? config.grokPath : null,
			codexPath: typeof config.codexPath === 'string' ? config.codexPath : null
		};
	} catch (error) {
		throw new Error(`Native host configuration could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function validateRequest(request) {
	if (!request || typeof request !== 'object') return 'Request must be an object.';
	if (request.type !== 'executeCli') return 'Unsupported native host request.';
	if (request.mode !== 'grok' && request.mode !== 'codex') return 'Unsupported CLI execution mode.';
	if (typeof request.prompt !== 'string' || request.prompt.length === 0) return 'Prompt must be a non-empty string.';
	if (request.prompt.length > MAX_PROMPT_CHARS) return 'Prompt is too large for Native Messaging.';
	return null;
}

export function createCliInvocation(request, config) {
	const command = request.mode === 'grok' ? config.grokPath : config.codexPath;
	if (!command) {
		throw new Error(`The ${request.mode} CLI is not configured. Install it or reinstall the Native Messaging Host.`);
	}

	if (request.mode === 'grok') {
		return {
			command,
			args: [
				'--single',
				request.prompt,
				'--output-format',
				'plain',
				'--no-plan',
				'--no-subagents'
			],
			input: ''
		};
	}

	return {
		command,
		args: [
			'exec',
			'--ephemeral',
			'--color',
			'never',
			'--sandbox',
			'read-only',
			'--skip-git-repo-check',
			'-'
		],
		input: request.prompt
	};
}

function runCli(request, config) {
	const invocation = createCliInvocation(request, config);
	return new Promise((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd: os.homedir(),
			env: { ...process.env, NO_COLOR: '1' },
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			child.kill('SIGTERM');
			settled = true;
			reject(new Error(`${request.mode} CLI timed out after ${DEFAULT_TIMEOUT_MS / 1000} seconds.`));
		}, DEFAULT_TIMEOUT_MS);

		const settle = callback => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			callback();
		};

		child.stdout.on('data', chunk => {
			stdout += chunk.toString();
			if (Buffer.byteLength(stdout, 'utf8') > MAX_RESPONSE_BYTES) {
				child.kill('SIGTERM');
				settle(() => reject(new Error('CLI response is too large for Native Messaging.')));
			}
		});
		child.stderr.on('data', chunk => {
			stderr += chunk.toString();
			if (stderr.length > 20_000) stderr = stderr.slice(0, 20_000);
		});
		child.on('error', error => {
			settle(() => reject(new Error(`Failed to start ${request.mode} CLI: ${error.message}`)));
		});
		child.on('close', (code, signal) => {
			settle(() => {
				if (code !== 0) {
					const detail = stderr.trim() || `process exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
					reject(new Error(`${request.mode} CLI failed: ${detail}`));
					return;
				}
				resolve({ ok: true, stdout });
			});
		});

		child.stdin.end(invocation.input);
	});
}

export function encodeNativeMessage(message) {
	const payload = Buffer.from(JSON.stringify(message), 'utf8');
	const header = Buffer.alloc(4);
	header.writeUInt32LE(payload.length, 0);
	return Buffer.concat([header, payload]);
}

export function decodeNativeMessages(buffer) {
	const messages = [];
	let offset = 0;
	while (buffer.length - offset >= 4) {
		const length = buffer.readUInt32LE(offset);
		if (length > MAX_REQUEST_BYTES) throw new Error('Native Messaging request is too large.');
		if (buffer.length - offset - 4 < length) break;
		const payload = buffer.subarray(offset + 4, offset + 4 + length).toString('utf8');
		messages.push(JSON.parse(payload));
		offset += 4 + length;
	}
	return { messages, remaining: buffer.subarray(offset) };
}

async function handleRequest(request, config) {
	const validationError = validateRequest(request);
	if (validationError) return { ok: false, error: validationError };
	try {
		return await runCli(request, config);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function startHost() {
	let config;
	try {
		config = loadConfig();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return;
	}

	let buffer = Buffer.alloc(0);
	let pending = Promise.resolve();
	const writeResponse = response => new Promise((resolve, reject) => {
		process.stdout.write(encodeNativeMessage(response), error => error ? reject(error) : resolve());
	});
	process.stdin.resume();
	process.stdin.on('data', chunk => {
		buffer = Buffer.concat([buffer, chunk]);
		let decoded;
		try {
			decoded = decodeNativeMessages(buffer);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
			process.stdin.pause();
			return;
		}
		buffer = decoded.remaining;
		for (const request of decoded.messages) {
			pending = pending
				.then(() => handleRequest(request, config))
				.then(writeResponse);
		}
	});
	process.stdin.on('end', () => {
		pending.then(
			() => process.exit(0),
			error => {
				console.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		);
	});
}

const isMainModule = process.argv[1]
	&& realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isMainModule) startHost();
