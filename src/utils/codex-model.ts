export const MAX_CODEX_MODEL_CHARS = 200;

export function normalizeCodexModel(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const model = value.trim();
	return model.length > 0 && model.length <= MAX_CODEX_MODEL_CHARS
		? model
		: undefined;
}
