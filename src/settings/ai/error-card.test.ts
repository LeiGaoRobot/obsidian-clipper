// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { AiSettingsStorageError } from '../../ai/settings';
import { AiSettingsBootstrapFailedError, AiSettingsItemMissingError } from './controller';
import { describeSettingsError } from './error-card';

describe('describeSettingsError', () => {
	test('a bootstrap stopped by a full sync storage says to free space and reload', () => {
		const description = describeSettingsError(new AiSettingsBootstrapFailedError(new AiSettingsStorageError('total-quota')));
		expect(description.title).toBe("Couldn't set up AI settings on this device");
		expect(description.body).toContain('sync storage is full');
		expect(description.body).toContain('reload Settings');
		expect(description.body).toContain('templates');
	});

	test('a bootstrap stopped by an item too large names the item instead of advising a shorter prompt context', () => {
		const description = describeSettingsError(new AiSettingsBootstrapFailedError(
			new AiSettingsStorageError('item-too-large', { key: 'ai_prompt_context', bytes: 9000 })
		));
		expect(description.title).toBe("Couldn't set up AI settings on this device");
		expect(description.body).toContain('“Default interpreter context”');
		expect(description.body).toContain('unchanged');
		expect(description.body).toContain('technical details');
		expect(description.body).not.toContain('Shorten');
		expect(description.detail).toBe('ai_prompt_context: 9000 B');
		expect(describeSettingsError(new AiSettingsBootstrapFailedError(
			new AiSettingsStorageError('item-too-large', { key: 'ai_profiles' })
		)).body).toContain('“Providers and models”');
		expect(describeSettingsError(new AiSettingsBootstrapFailedError(
			new AiSettingsStorageError('item-too-large', { key: 'ai_routing' })
		)).body).toContain('“Tasks”');
		// A normal save still says how to make the item smaller.
		expect(describeSettingsError(new AiSettingsStorageError('item-too-large', { key: 'ai_prompt_context' })).body).toContain('Shorten');
	});

	test('a full sync storage during a normal save keeps the try-again copy', () => {
		const description = describeSettingsError(new AiSettingsStorageError('total-quota'));
		expect(description.body).toBe("Browser sync storage is full. Remove settings or templates you don't use, then try again.");
	});

	test('a connection or profile deleted while its dialog was open is named', () => {
		expect(describeSettingsError(new AiSettingsItemMissingError('connection'))).toMatchObject({
			title: 'This connection was deleted',
			body: expect.stringContaining("Your changes weren't saved"),
			action: 'none'
		});
		expect(describeSettingsError(new AiSettingsItemMissingError('profile')).title).toBe('This model was deleted');
	});
});
