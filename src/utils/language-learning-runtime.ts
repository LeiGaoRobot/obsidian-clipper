import browser from './browser-polyfill';
import {
	LanguageLearningResponse,
	LearningSelection,
	createLanguageLearningAssistant
} from './language-learning';
import { getMessage } from './i18n';
import { loadSettings } from './storage-utils';

async function loadConfiguredAssistant() {
	const settings = await loadSettings();
	if (!settings.interpreterEnabled) {
		throw new Error(getMessage('aiLanguageToolsRequireInterpreter'));
	}

	const executionMode = settings.interpreterExecutionMode ?? 'api';
	if (executionMode === 'api') {
		const enabledModels = settings.models.filter(model => model.enabled);
		const model = enabledModels.find(item => item.id === settings.interpreterModel) || enabledModels[0];
		if (!model) {
			throw new Error(getMessage('aiLanguageToolsRequireModel'));
		}
	}

	const responseLanguage = settings.readerSettings.learningResponseLanguage.trim()
		|| navigator.language
		|| 'English';
	const assistant = createLanguageLearningAssistant(async request => {
		const response = await browser.runtime.sendMessage({
			action: 'languageLearningRequest',
			request
		}) as {
			success: boolean;
			promptResponses?: LanguageLearningResponse[];
			error?: string;
		};
		if (!response?.success || !Array.isArray(response.promptResponses)) {
			throw new Error(response?.error || getMessage('error'));
		}
		return response.promptResponses;
	});

	return { assistant, responseLanguage };
}

export const configuredLanguageLearning = {
	async transformContent(content: string, instruction: string): Promise<string> {
		const { assistant, responseLanguage } = await loadConfiguredAssistant();
		const resolvedInstruction = instruction.replace(/{{responseLanguage}}/g, responseLanguage);
		return assistant.transformContent(content, resolvedInstruction);
	},

	async explainSelection(selection: LearningSelection): Promise<string> {
		const { assistant, responseLanguage } = await loadConfiguredAssistant();
		return assistant.explainSelection(selection, responseLanguage);
	},

	async translateTranscript(segments: string[]): Promise<string[]> {
		const { assistant, responseLanguage } = await loadConfiguredAssistant();
		return assistant.translateTranscript(segments, responseLanguage);
	}
};
