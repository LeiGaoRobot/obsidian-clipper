import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AI_ERROR_CODES, AiError } from './errors';
import { aiErrorMessageKeys, describeAiError } from './error-messages';

function locale(name: string): Record<string, { message: string }> {
	return JSON.parse(readFileSync(resolve(process.cwd(), `src/_locales/${name}/messages.json`), 'utf8'));
}

describe('describeAiError', () => {
	test.each(['en', 'zh_CN'])('has a title and body in %s for every code', name => {
		const messages = locale(name);
		for (const code of AI_ERROR_CODES) {
			const keys = aiErrorMessageKeys(code);
			expect(keys.title).toMatch(/^[A-Za-z0-9_]+$/);
			expect(messages[keys.title]?.message?.trim(), `${name} ${keys.title}`).toBeTruthy();
			expect(messages[keys.body]?.message?.trim(), `${name} ${keys.body}`).toBeTruthy();
		}
	});

	test('returns localized text, an action, and the raw detail', () => {
		const description = describeAiError(new AiError('auth', { detail: '{"error":"invalid x-api-key"}' }));
		expect(description).toEqual({
			title: locale('en').aiErrorAuthTitle.message,
			body: locale('en').aiErrorAuthBody.message,
			action: 'openSettings',
			detail: '{"error":"invalid x-api-key"}'
		});
	});

	test('picks the next step for the error', () => {
		expect(describeAiError(new AiError('host-outdated')).action).toBe('copyInstallCommand');
		expect(describeAiError(new AiError('incomplete')).action).toBe('continueRemaining');
		expect(describeAiError(new AiError('cancelled')).action).toBe('none');
		expect(describeAiError(new AiError('cli-not-authenticated')).action).toBe('none');
		expect(describeAiError(new AiError('provider-error', { retryable: true })).action).toBe('retry');
		expect(describeAiError(new AiError('provider-error')).action).toBe('none');
	});

	test('a continue-remaining recovery selects the batch-failed body and keeps the code\'s title', () => {
		const en = locale('en');
		const description = describeAiError(new AiError('timeout', { nativeCode: 'timeout', recovery: 'continue-remaining', detail: 'codex CLI timed out' }));
		expect(description).toEqual({
			title: en.aiErrorTimeoutTitle.message,
			body: en.readerTranscriptTranslationBatchFailed.message,
			action: 'retry',
			detail: 'codex CLI timed out'
		});
		expect(locale('zh_CN').readerTranscriptTranslationBatchFailed?.message?.trim()).toBeTruthy();
		expect(describeAiError(new AiError('timeout')).body).toBe(en.aiErrorTimeoutBody.message);
	});

	test('omits a detail that only repeats the code', () => {
		expect(describeAiError(new AiError('timeout')).detail).toBeUndefined();
	});
});
