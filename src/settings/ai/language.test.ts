// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { initializeAiSettings } from './index';
import { RESPONSE_LANGUAGE_SUGGESTIONS } from './language';
import { createFakeStore, installGuideEnvironment, loadSettingsDocument, settle, type FakeSettings } from './test-support';

async function section(settings: FakeSettings) {
	const fake = createFakeStore(settings);
	const handle = await initializeAiSettings({ store: fake.store, installGuide: installGuideEnvironment() });
	return { ...fake, handle };
}

function languageInput(): HTMLInputElement {
	return document.getElementById('ai-response-language') as HTMLInputElement;
}

function effective(): string | null | undefined {
	return document.getElementById('ai-response-language-effective')?.textContent;
}

beforeEach(() => {
	loadSettingsDocument();
});

describe('Language panel', () => {
	test('shows the stored response language with suggestions like the Reader control', async () => {
		await section({ routing: { taskProfiles: {}, responseLanguage: 'Japanese' } });
		expect(languageInput().value).toBe('Japanese');
		expect(languageInput().getAttribute('list')).toBe('ai-response-language-options');
		expect(Array.from(document.querySelectorAll<HTMLOptionElement>('#ai-response-language-options option')).map(option => option.value))
			.toEqual([...RESPONSE_LANGUAGE_SUGGESTIONS]);
		expect(effective()).toBe('Responses will use Japanese.');
	});

	test('writes ai_routing.responseLanguage through the controller on change', async () => {
		const { sync, handle } = await section({ routing: { defaultProfileId: 'gpt', taskProfiles: { edit: 'gpt' } } });
		const setResponseLanguage = vi.spyOn(handle.controller, 'setResponseLanguage');
		expect(effective()).toContain('browser language');

		languageInput().value = ' Korean ';
		languageInput().dispatchEvent(new Event('input'));
		expect(effective()).toBe('Responses will use Korean.');
		expect(setResponseLanguage).not.toHaveBeenCalled();

		languageInput().dispatchEvent(new Event('change'));
		await settle();
		expect(setResponseLanguage).toHaveBeenCalledWith(' Korean ');
		expect(sync.data.ai_routing).toEqual({ v: 1, defaultProfileId: 'gpt', taskProfiles: { edit: 'gpt' }, responseLanguage: 'Korean' });
		expect(languageInput().value).toBe('Korean');

		languageInput().value = '';
		languageInput().dispatchEvent(new Event('change'));
		await settle();
		expect(sync.data.ai_routing).toEqual({ v: 1, defaultProfileId: 'gpt', taskProfiles: { edit: 'gpt' } });
		expect(effective()).toContain('browser language');
	});

	test('follows changes from another context unless the field is being edited', async () => {
		const { sync } = await section({ routing: { taskProfiles: {} } });

		await sync.set({ ai_routing: { v: 1, taskProfiles: {}, responseLanguage: 'French' } });
		await settle();
		expect(languageInput().value).toBe('French');

		languageInput().focus();
		languageInput().value = 'Germ';
		await sync.set({ ai_routing: { v: 1, taskProfiles: {}, responseLanguage: 'Spanish' } });
		await settle();
		expect(languageInput().value).toBe('Germ');
	});
});
