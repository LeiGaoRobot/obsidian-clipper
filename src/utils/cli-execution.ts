import { spawn } from 'child_process';
import type { PromptVariable } from '../types/types';
import { buildExecutionPrompt, parsePromptResponses } from './cli-execution-contract';
import type { CliExecutionMode } from './cli-execution-contract';
import type { CodexReasoningEffort } from '../types/types';
import { buildCliArguments } from '../../native-host/cli-invocation.mjs';

export * from './cli-execution-contract';

export interface CliProcessInvocation {
	command: string;
	args: string[];
	input?: string;
	cwd: string;
	timeoutMs: number;
}

export interface CliProcessResult {
	stdout: string;
	stderr: string;
}

export type CliProcessRunner = (invocation: CliProcessInvocation) => Promise<CliProcessResult>;

export interface CliExecutionOptions {
	cwd?: string;
	/** Codex only. */
	model?: string;
	/** Codex only. */
	effort?: CodexReasoningEffort;
	timeoutMs?: number;
	runner?: CliProcessRunner;
}

const DEFAULT_TIMEOUT_MS = 120000;
export function buildCliInvocation(
	mode: CliExecutionMode,
	prompt: string,
	options: CliExecutionOptions = {}
): CliProcessInvocation {
	const { args, input } = buildCliArguments({
		mode,
		prompt,
		...(mode === 'codex' && options.model ? { model: options.model } : {}),
		...(mode === 'codex' && options.effort ? { effort: options.effort } : {})
	});
	return {
		cwd: options.cwd ?? process.cwd(),
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		command: mode,
		args,
		...(input ? { input } : {})
	};
}

const runCliProcess: CliProcessRunner = (invocation) => new Promise((resolve, reject) => {
	const child = spawn(invocation.command, invocation.args, {
		cwd: invocation.cwd,
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
		reject(new Error(`${invocation.command} CLI timed out after ${Math.ceil(invocation.timeoutMs / 1000)} seconds.`));
	}, invocation.timeoutMs);

	const settle = (callback: () => void) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		callback();
	};

	child.stdout.on('data', chunk => {
		stdout += chunk.toString();
	});
	child.stderr.on('data', chunk => {
		stderr += chunk.toString();
	});
	child.on('error', error => {
		const code = (error as NodeJS.ErrnoException).code;
		settle(() => {
			if (code === 'ENOENT') {
				reject(new Error(`Could not find ${invocation.command} CLI. Install it and ensure it is available on PATH.`));
				return;
			}
			reject(new Error(`Failed to start ${invocation.command} CLI: ${error.message}`));
		});
	});
	child.on('close', (code, signal) => {
		settle(() => {
			if (code !== 0) {
				const detail = stderr.trim() || `process exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
				reject(new Error(`${invocation.command} CLI failed: ${detail}`));
				return;
			}
			resolve({ stdout, stderr });
		});
	});

	child.stdin.end(invocation.input ?? '');
});

export async function executePromptVariables(
	mode: CliExecutionMode,
	context: string,
	promptVariables: PromptVariable[],
	options: CliExecutionOptions = {}
): Promise<Record<string, unknown>> {
	if (promptVariables.length === 0) {
		return {};
	}

	const runner = options.runner ?? runCliProcess;
	const invocation = buildCliInvocation(mode, buildExecutionPrompt(context, promptVariables), options);
	const result = await runner(invocation);
	return parsePromptResponses(result.stdout, promptVariables);
}
