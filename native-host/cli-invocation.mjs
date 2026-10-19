// Shared argv builder for the Grok and Codex CLIs. The Native Messaging Host and the
// Node CLI (`src/cli.ts`) both use it, so hardening flags cannot drift apart.
// Keep this file dependency-free: the Host installer copies it next to the Host.

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
	'--skip-git-repo-check',
	'-'
];

/**
 * @param {{ mode: 'grok' | 'codex', prompt: string, model?: string, effort?: string }} request
 * @returns {{ args: string[], input: string }}
 */
export function buildCliArguments({ mode, prompt, model, effort }) {
	if (mode === 'grok') {
		return { args: ['--single', prompt, ...GROK_ARGUMENTS], input: '' };
	}
	return {
		args: [
			'exec',
			...(model ? ['--model', model] : []),
			...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
			...CODEX_ARGUMENTS
		],
		input: prompt
	};
}
