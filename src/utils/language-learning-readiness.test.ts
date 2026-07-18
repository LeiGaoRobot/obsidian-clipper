// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest';
import {
	assessLanguageLearningReadiness,
	wireLanguageLearningReadiness
} from './language-learning-readiness';
import type { Settings } from '../types/types';

function settings(overrides: Partial<Settings> = {}): Settings {
	return {
		vaults: [],
		showMoreActionsButton: false,
		betaFeatures: false,
		legacyMode: false,
		silentOpen: false,
		openBehavior: 'popup',
		highlighterEnabled: true,
		alwaysShowHighlights: true,
		highlightBehavior: 'highlight-inline',
		models: [],
		providers: [],
		interpreterEnabled: false,
		interpreterAutoRun: false,
		defaultPromptContext: '',
		propertyTypes: [],
		readerSettings: {
			fontSize: 16,
			lineHeight: 1.6,
			maxWidth: 38,
			lightTheme: 'default',
			darkTheme: 'same',
			appearance: 'auto',
			fonts: [],
			defaultFont: '',
			blendImages: true,
			colorLinks: false,
			followLinks: true,
			pinPlayer: true,
			autoScroll: true,
			highlightActiveLine: true,
			transcriptLayout: 'reading',
			learningResponseLanguage: '',
			customCss: ''
		},
		stats: { addToObsidian: 0, saveFile: 0, copyToClipboard: 0, share: 0 },
		history: [],
		ratings: [],
		saveBehavior: 'addToObsidian',
		...overrides
	};
}

describe('Language learning readiness', () => {
	test('requires an enabled API model for API mode', () => {
		const result = assessLanguageLearningReadiness(settings({ interpreterEnabled: true }));
		expect(result.ready).toBe(false);
		expect(result.steps.find(step => step.id === 'engine')?.state).toBe('error');

		const ready = assessLanguageLearningReadiness(settings({
			interpreterEnabled: true,
			interpreterModel: 'model-1',
			models: [{ id: 'model-1', providerId: 'provider', providerModelId: 'model', name: 'Model', enabled: true }],
			providers: [{ id: 'provider', name: 'Provider', baseUrl: 'https://example.com', apiKey: '', apiKeyRequired: false }]
		}));
		expect(ready.ready).toBe(true);
	});

	test('requires the selected API model provider and mandatory API key', () => {
		const model = { id: 'model-1', providerId: 'provider', providerModelId: 'model', name: 'Model', enabled: true };
		const missingProvider = assessLanguageLearningReadiness(settings({
			interpreterEnabled: true,
			interpreterModel: model.id,
			models: [model]
		}));
		expect(missingProvider.ready).toBe(false);

		const missingKey = assessLanguageLearningReadiness(settings({
			interpreterEnabled: true,
			interpreterModel: model.id,
			models: [model],
			providers: [{ id: 'provider', name: 'Provider', baseUrl: 'https://example.com', apiKey: '', apiKeyRequired: true }]
		}));
		expect(missingKey.ready).toBe(false);
		expect(missingKey.steps.find(step => step.id === 'engine')?.label)
			.toBe('Complete the selected model provider and API key');
	});

	test('checks the selected CLI and updates the setup assistant', async () => {
		document.body.innerHTML = `
			<details id="language-learning-readiness"><summary></summary>
				<ol id="language-learning-readiness-steps"></ol>
				<button id="language-learning-readiness-check"></button>
				<div id="language-learning-readiness-status"></div>
			</details>`;
		const current = settings({ interpreterEnabled: true, interpreterExecutionMode: 'codex' });
		const checkCli = vi.fn().mockResolvedValue(undefined);
		const controller = wireLanguageLearningReadiness({
			doc: document,
			getSettings: () => current,
			checkCli
		});

		expect(document.querySelector('[data-readiness-step="engine"]')?.className).toContain('is-pending');
		(document.getElementById('language-learning-readiness-check') as HTMLButtonElement).click();
		await controller.pendingCheck();

		expect(checkCli).toHaveBeenCalledWith('codex');
		expect(document.querySelector('[data-readiness-step="engine"]')?.className).toContain('is-ready');
		expect((document.getElementById('language-learning-readiness') as HTMLDetailsElement).open).toBe(false);
	});
});
