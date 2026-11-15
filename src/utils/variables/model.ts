import { applyFilters } from '../filters';

export const MODEL_VARIABLE_NAMES = ['model', 'modelId', 'modelProvider'];

/** What `{{model}}`, `{{modelId}}`, and `{{modelProvider}}` become once the prompts have run. */
export interface ModelVariableValues {
	model: string;
	modelId: string;
	modelProvider: string;
}

const MODEL_VARIABLE_PATTERN = /{{(modelProvider|modelId|model)(\|[\s\S]*?)?}}/g;

// Returns true if the variable string (e.g. `model` or `modelId|lower`)
// is an interpreter model variable
export function isModelVariable(variableString: string): boolean {
	const baseName = variableString.split('|')[0].trim();
	return MODEL_VARIABLE_NAMES.includes(baseName);
}

/** True when text holds a kept model variable. */
export function hasModelVariables(text: string): boolean {
	return new RegExp(MODEL_VARIABLE_PATTERN.source).test(text);
}

/**
 * Model variables are only known once the interpreter runs. Like prompt variables, with `keep` the
 * whole variable is returned for whoever runs the prompts to fill; otherwise it compiles to nothing.
 */
export function processModelVariable(match: string, keep: boolean): string {
	return keep ? match : '';
}

/** Replaces kept model variables in text, applying their filters. */
export function fillModelVariables(text: string, values: ModelVariableValues): string {
	return text.replace(new RegExp(MODEL_VARIABLE_PATTERN.source, 'g'), (_match, name: keyof ModelVariableValues, filters?: string) => {
		const value = values[name];
		return filters ? applyFilters(value, filters.slice(1)) : value;
	});
}
