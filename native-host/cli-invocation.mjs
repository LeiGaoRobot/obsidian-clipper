// Shared argv builder and limits for the Grok and Codex CLIs. The Native Messaging Host, the
// extension (`src/utils/native-cli-contract.ts`, `codex-*.ts`) and the Node CLI (`src/cli.ts`)
// all import from here, so hardening flags and limits cannot drift apart.
// Keep this file dependency-free: the Host installer copies it next to the Host.

/** Bumped when the Host and the extension stop understanding each other's messages. */
export const NATIVE_CLI_PROTOCOL_VERSION = 5;
/** How long one CLI run may take before it is killed. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_CODEX_MODEL_CHARS = 200;
export const MAX_OUTPUT_SCHEMA_CHARS = 20_000;
export const CODEX_REASONING_EFFORTS = Object.freeze([
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra'
]);

const GROK_ARGUMENTS = [
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
];

const CODEX_ARGUMENTS = [
	'--ephemeral',
	'--color',
	'never',
	'--sandbox',
	'read-only',
	'--skip-git-repo-check'
];

/**
 * @param {{ mode: 'grok' | 'codex', prompt: string, model?: string, effort?: string, outputSchemaPath?: string }} request
 * @returns {{ args: string[], input: string }}
 */
export function buildCliArguments({ mode, prompt, model, effort, outputSchemaPath }) {
	if (mode === 'grok') {
		return { args: ['--single', prompt, ...GROK_ARGUMENTS], input: '' };
	}
	return {
		args: [
			'exec',
			...(model ? ['--model', model] : []),
			...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
			...CODEX_ARGUMENTS,
			...(outputSchemaPath ? ['--output-schema', outputSchemaPath] : []),
			// The prompt arrives on stdin; `-` must stay last.
			'-'
		],
		input: prompt
	};
}
