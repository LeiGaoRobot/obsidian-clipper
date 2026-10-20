#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {
	CODEX_REASONING_EFFORTS,
	DEFAULT_TIMEOUT_MS,
	MAX_CODEX_MODEL_CHARS,
	MAX_OUTPUT_SCHEMA_CHARS,
	NATIVE_CLI_PROTOCOL_VERSION,
	buildCliArguments
} from './cli-invocation.mjs';

// Re-exported so an installed Host can be checked against the extension's protocol.
export { NATIVE_CLI_PROTOCOL_VERSION };
/** Matches `MAX_INPUT_CHARS` in `src/ai/protocol.ts`; a parity test keeps them equal. */
export const MAX_PROMPT_CHARS = 750_000;
export const MAX_REQUEST_BYTES = 4_000_000;
export const MAX_RESPONSE_BYTES = 900_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;

class NativeHostError extends Error {
	constructor(code, message, details) {
		super(message);
		this.name = 'NativeHostError';
		this.code = code;
		this.details = details;
	}
}

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
		throw new NativeHostError(
			'config',
			`Native host configuration could not be loaded: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

function isMode(value) {
	return value === 'grok' || value === 'codex';
}

function isPlainObject(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function validateRequest(request) {
	if (!request || typeof request !== 'object') return 'Request must be an object.';
	if (request.protocolVersion !== NATIVE_CLI_PROTOCOL_VERSION) {
		return 'Native host protocol version mismatch.';
	}
	if (typeof request.requestId !== 'string' || request.requestId.length === 0) {
		return 'Request ID must be a non-empty string.';
	}
	if (request.type === 'cancelCli') return null;
	if (request.type === 'healthCheck') {
		return isMode(request.mode) ? null : 'Unsupported CLI execution mode.';
	}
	if (request.type !== 'executeCli') return 'Unsupported native host request.';
	if (!isMode(request.mode)) return 'Unsupported CLI execution mode.';
	if (typeof request.prompt !== 'string' || request.prompt.length === 0) return 'Prompt must be a non-empty string.';
	if (request.prompt.length > MAX_PROMPT_CHARS) return 'Prompt is too large for Native Messaging.';
	if (request.heartbeat !== undefined && typeof request.heartbeat !== 'boolean') {
		return 'Heartbeat must be a boolean.';
	}
	if (request.model !== undefined) {
		if (request.mode !== 'codex') return 'Codex model overrides require Codex execution mode.';
		if (typeof request.model !== 'string'
			|| request.model.length === 0
			|| request.model.length > MAX_CODEX_MODEL_CHARS) {
			return 'Codex model must be a non-empty string of at most 200 characters.';
		}
		if (request.model !== request.model.trim()) {
			return 'Codex model must not include leading or trailing whitespace.';
		}
	}
	if (request.effort !== undefined) {
		if (request.mode !== 'codex') {
			return 'Codex reasoning effort overrides require Codex execution mode.';
		}
		if (typeof request.effort !== 'string' || !CODEX_REASONING_EFFORTS.includes(request.effort)) {
			return 'Codex reasoning effort must be a supported value.';
		}
	}
	if (request.outputSchema !== undefined) {
		if (request.mode !== 'codex') return 'Output schemas require Codex execution mode.';
		if (!isPlainObject(request.outputSchema)) return 'Output schema must be a JSON object.';
		if (JSON.stringify(request.outputSchema).length > MAX_OUTPUT_SCHEMA_CHARS) {
			return `Output schema must serialize to at most ${MAX_OUTPUT_SCHEMA_CHARS} characters.`;
		}
	}
	return null;
}

export function createCliInvocation(request, config, outputSchemaPath) {
	const command = request.mode === 'grok' ? config.grokPath : config.codexPath;
	if (!command) {
		throw new NativeHostError(
			'config',
			`The ${request.mode} CLI is not configured. Install it or reinstall the Native Messaging Host.`,
			{ mode: request.mode }
		);
	}

	// Pass known fields only so a request cannot smuggle in `outputSchemaPath`.
	return {
		command,
		...buildCliArguments({
			mode: request.mode,
			prompt: request.prompt,
			model: request.model,
			effort: request.effort,
			outputSchemaPath
		})
	};
}

function cancelledError(request) {
	return new NativeHostError('cancelled', 'The CLI request was cancelled.', { mode: request.mode });
}

/**
 * Writes the schema to a fresh private temp directory for the duration of `run`, and removes
 * the directory however `run` settles. Without a schema, `run` starts synchronously.
 */
async function withOutputSchemaFile(outputSchema, run) {
	if (outputSchema === undefined) return run(undefined);
	const directory = await mkdtemp(path.join(os.tmpdir(), 'obsidian-clipper-schema-'));
	try {
		const schemaPath = path.join(directory, 'schema.json');
		await writeFile(schemaPath, JSON.stringify(outputSchema), { mode: 0o600, flag: 'wx' });
		return await run(schemaPath);
	} finally {
		// A cleanup failure must not replace the CLI result; `force` already ignores a missing path.
		await rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}

export function runCli(request, config, onStart, onHeartbeat) {
	// Cancellation can arrive while the schema file is still being written, before the child exists.
	let cancelled = false;
	let terminate = () => { cancelled = true; };
	onStart(() => terminate());
	return withOutputSchemaFile(request.outputSchema, outputSchemaPath => {
		if (cancelled) throw cancelledError(request);
		const invocation = createCliInvocation(request, config, outputSchemaPath);
		return spawnCli(request, invocation, childTerminate => { terminate = childTerminate; }, onHeartbeat);
	});
}

function spawnCli(request, invocation, onStart, onHeartbeat) {
	const executablePath = [
		path.dirname(process.execPath),
		path.dirname(invocation.command),
		process.env.PATH
	].filter(Boolean).join(path.delimiter);
	return new Promise((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd: os.homedir(),
			env: { ...process.env, PATH: executablePath, NO_COLOR: '1' },
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		let terminationError;
		let timeout;
		let forceKillTimer;
		const startedAt = Date.now();
		// Only connected ports opt in: a one-shot sendNativeMessage takes the first reply as the response.
		const heartbeatTimer = request.heartbeat && onHeartbeat
			? setInterval(() => onHeartbeat({
				type: 'heartbeat',
				requestId: request.requestId,
				elapsedMs: Date.now() - startedAt
			}), HEARTBEAT_INTERVAL_MS)
			: undefined;
		const terminateWithError = error => {
			if (settled || terminationError) return;
			terminationError = error;
			child.kill('SIGTERM');
			forceKillTimer = setTimeout(() => {
				if (!settled) child.kill('SIGKILL');
			}, 2000);
		};
		onStart(() => terminateWithError(cancelledError(request)));
		timeout = setTimeout(() => {
			terminateWithError(new NativeHostError(
				'timeout',
				`${request.mode} CLI timed out after ${DEFAULT_TIMEOUT_MS / 1000} seconds.`,
				{ mode: request.mode, timeoutSeconds: DEFAULT_TIMEOUT_MS / 1000 }
			));
		}, DEFAULT_TIMEOUT_MS);

		const settle = callback => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			callback();
		};

		child.stdout.on('data', chunk => {
			stdout += chunk.toString();
			if (Buffer.byteLength(stdout, 'utf8') > MAX_RESPONSE_BYTES) {
				terminateWithError(new NativeHostError(
					'response-too-large',
					'CLI response is too large for Native Messaging.'
				));
			}
		});
		child.stderr.on('data', chunk => {
			stderr += chunk.toString();
			if (stderr.length > 20_000) stderr = stderr.slice(0, 20_000);
		});
		child.on('error', error => {
			settle(() => reject(terminationError || new NativeHostError(
				'launch-failed',
				`Failed to start ${request.mode} CLI: ${error.message}`,
				{ mode: request.mode }
			)));
		});
		child.on('close', (code, signal) => {
			settle(() => {
				if (terminationError) {
					reject(terminationError);
					return;
				}
				if (code !== 0) {
					const detail = stderr.trim() || `process exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
					reject(new NativeHostError(
						'cli-failed',
						`${request.mode} CLI failed: ${detail}`,
						{ mode: request.mode }
					));
					return;
				}
				resolve({ ok: true, requestId: request.requestId, stdout });
			});
		});

		child.stdin.end(invocation.input);
	});
}

function errorResponse(requestId, error) {
	return {
		ok: false,
		requestId,
		errorCode: error instanceof NativeHostError ? error.code : 'cli-failed',
		error: error instanceof Error ? error.message : String(error),
		details: error instanceof NativeHostError ? error.details : undefined
	};
}

function healthResponse(request, config) {
	const command = request.mode === 'grok' ? config.grokPath : config.codexPath;
	if (!command || !existsSync(command)) {
		throw new NativeHostError(
			'config',
			`The ${request.mode} CLI is not configured or cannot be found.`,
			{ mode: request.mode }
		);
	}
	return {
		ok: true,
		requestId: request.requestId,
		health: {
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			mode: request.mode,
			command
		}
	};
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

function startHost() {
	let config;
	let configError;
	try {
		config = loadConfig();
	} catch (error) {
		configError = error;
		config = { grokPath: null, codexPath: null };
	}

	let buffer = Buffer.alloc(0);
	let writes = Promise.resolve();
	const activeRequests = new Map();
	const activeTasks = new Set();
	const writeResponse = response => {
		writes = writes.then(() => new Promise((resolve, reject) => {
			process.stdout.write(encodeNativeMessage(response), error => error ? reject(error) : resolve());
		}));
		return writes;
	};
	const handleMessage = request => {
		const validationError = validateRequest(request);
		if (validationError) {
			const errorCode = validationError === 'Native host protocol version mismatch.'
				? 'protocol-mismatch'
				: 'invalid';
			void writeResponse({
				ok: false,
				requestId: typeof request?.requestId === 'string' ? request.requestId : undefined,
				errorCode,
				error: validationError,
				details: { protocolVersion: NATIVE_CLI_PROTOCOL_VERSION }
			});
			return;
		}
		if (request.type === 'cancelCli') {
			activeRequests.get(request.requestId)?.();
			return;
		}
		if (configError) {
			void writeResponse(errorResponse(request.requestId, configError));
			return;
		}
		if (request.type === 'healthCheck') {
			try {
				void writeResponse(healthResponse(request, config));
			} catch (error) {
				void writeResponse(errorResponse(request.requestId, error));
			}
			return;
		}
		if (activeRequests.has(request.requestId)) {
			void writeResponse(errorResponse(
				request.requestId,
				new NativeHostError('invalid', 'A CLI request with this ID is already running.')
			));
			return;
		}
		const task = runCli(
			request,
			config,
			cancel => activeRequests.set(request.requestId, cancel),
			heartbeat => void writeResponse(heartbeat)
		)
			.then(writeResponse)
			.catch(error => writeResponse(errorResponse(request.requestId, error)))
			.finally(() => {
				activeRequests.delete(request.requestId);
				activeTasks.delete(task);
			});
		activeTasks.add(task);
	};

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
		decoded.messages.forEach(handleMessage);
	});
	process.stdin.on('end', () => {
		Promise.allSettled(Array.from(activeTasks))
			.then(() => writes)
			.then(
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
