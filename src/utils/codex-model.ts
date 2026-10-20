import { MAX_CODEX_MODEL_CHARS } from '../../native-host/cli-invocation.mjs';

export { MAX_CODEX_MODEL_CHARS };

export function normalizeCodexModel(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const model = value.trim();
	return model.length > 0 && model.length <= MAX_CODEX_MODEL_CHARS
		? model
		: undefined;
}
