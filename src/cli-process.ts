// Node-only: runs the Grok or Codex CLI for `src/cli.ts --execution-mode` and writes the answers
// into the clip. The extension reaches the same CLIs through the Native Messaging Host instead.
import { spawn } from 'child_process';
import { buildCliArguments, DEFAULT_TIMEOUT_MS } from '../native-host/cli-invocation.mjs';
import type { CodexReasoningEffort, PromptVariable, Property, Template } from './types/types';
import {
	buildExecutionPrompt,
	parsePromptResponses,
	replacePromptVariables,
	type CliExecutionMode
} from './utils/cli-execution-contract';
import { formatPropertyValue, generateFrontmatter } from './utils/shared';
import { sanitizeFileName } from './utils/string-utils';

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

export const runCliProcess: CliProcessRunner = (invocation) => new Promise((resolve, reject) => {
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

	const { args, input } = buildCliArguments({
		mode,
		prompt: buildExecutionPrompt(context, promptVariables),
		...(mode === 'codex' && options.model ? { model: options.model } : {}),
		...(mode === 'codex' && options.effort ? { effort: options.effort } : {})
	});
	const runner = options.runner ?? runCliProcess;
	const result = await runner({
		command: mode,
		args,
		...(input ? { input } : {}),
		cwd: options.cwd ?? process.cwd(),
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	});
	return parsePromptResponses(result.stdout, promptVariables);
}

/** The page text the prompts are answered from: the Markdown content, else the raw HTML. */
export function promptContextOf(variables: Record<string, string>): string {
	return variables['{{content}}'] || variables['{{fullHtml}}'] || '';
}

export interface PromptFillTarget {
	template: Template;
	propertyTypes?: Record<string, string>;
	/** The clip's compiled properties, in template order. */
	properties: Property[];
	frontmatter: string;
	content: string;
	noteName: string;
	/**
	 * The note name compiled with its placeholders kept and not yet sanitized (the sanitizer strips
	 * `"` and `|`). Without it the clip's `noteName` is kept as is.
	 */
	compiledNoteName?: string;
}

/**
 * Writes the CLI's answers into a clip made with `keepPromptVariables`. Properties are filled before
 * the frontmatter is generated again, because the frontmatter has escaped the placeholders' quotes.
 */
export function fillPromptResponses(
	target: PromptFillTarget,
	promptVariables: PromptVariable[],
	responses: Record<string, unknown>,
	currentUrl: string
): { fullContent: string; noteName: string } {
	const fill = (value: string) => replacePromptVariables(value, promptVariables, responses, currentUrl);

	let propertiesChanged = false;
	const properties = target.properties.map((property, index) => {
		const value = fill(property.value);
		if (value === property.value) return property;
		propertiesChanged = true;
		const templateValue = target.template.properties[index]?.value ?? '';
		return { ...property, value: formatPropertyValue(value, property.type || 'text', templateValue) };
	});

	let frontmatter = target.frontmatter;
	if (propertiesChanged) {
		// The same type map `clip` uses.
		const typeMap: Record<string, string> = {};
		for (const property of target.template.properties) {
			if (property.type) typeMap[property.name] = property.type;
		}
		Object.assign(typeMap, target.propertyTypes);
		frontmatter = generateFrontmatter(properties, typeMap);
	}

	const content = fill(target.content);
	const noteName = target.compiledNoteName === undefined
		? target.noteName
		: sanitizeFileName(fill(target.compiledNoteName)) || 'Untitled';
	return { fullContent: frontmatter ? frontmatter + content : content, noteName };
}
