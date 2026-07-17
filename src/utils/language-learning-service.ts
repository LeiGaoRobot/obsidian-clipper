import { LanguageLearningRequest, LanguageLearningResponse } from './language-learning';
import { loadSettings } from './storage-utils';
import { sendToLLM } from './llm-client';
import { executeNativeCliForPrompts } from './native-cli-service';

const LANGUAGE_LEARNING_COOLDOWN_MS = 0;

export async function runLanguageLearningRequest(
	request: LanguageLearningRequest
): Promise<LanguageLearningResponse[]> {
	const settings = await loadSettings();
	if (!settings.interpreterEnabled) {
		throw new Error('Interpreter is not enabled.');
	}

	const executionMode = settings.interpreterExecutionMode ?? 'api';
	if (executionMode !== 'api') {
		const responses = await executeNativeCliForPrompts(executionMode, request.context, request.prompts);
		return request.prompts.map(prompt => ({
			key: prompt.key,
			prompt: prompt.prompt,
			user_response: responses[prompt.key]
		}));
	}

	const enabledModels = settings.models.filter(model => model.enabled);
	const model = enabledModels.find(item => item.id === settings.interpreterModel) || enabledModels[0];
	if (!model) {
		throw new Error('No Interpreter model is enabled.');
	}

	const result = await sendToLLM(
		request.context,
		'',
		request.prompts,
		model,
		{
			maxTokens: request.maxTokens,
			cooldownMs: LANGUAGE_LEARNING_COOLDOWN_MS
		}
	);
	return result.promptResponses;
}
