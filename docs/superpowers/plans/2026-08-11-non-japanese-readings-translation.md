# Non-Japanese Transcript Readings Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve non-Japanese source subtitles while adding a separate Japanese translation line with validated hiragana ruby readings after an explicit Japanese-readings action.

**Architecture:** Keep translation and reading annotation as two sequential, independently checkpointed operations. Add a fixed-target Japanese translation adapter to the configured runtime, classify the transcript once, and render non-Japanese results in a dedicated DOM line that does not share state with ordinary bilingual subtitles.

**Tech Stack:** TypeScript, Vitest, jsdom, WebExtension storage/runtime messaging, SCSS, Webpack.

## Global Constraints

- Remote translation and annotation start only after a trusted **Japanese readings** action; restoration, layout changes, transcript loading, and synthetic page events never start requests.
- Provider work remains in the extension background and uses only stored Interpreter or Native CLI configuration.
- Translation and reading responses remain aligned to stable subtitle IDs and incomplete output is never accepted as complete.
- Ordinary bilingual translations, fixed Japanese translations, and Japanese readings use independent state and checkpoint identities.
- Preserve the original subtitle and any existing `.transcript-segment-translation`; non-Japanese learning output uses `.transcript-segment-japanese`.
- Keep existing API, Grok CLI, Codex CLI, cancellation, dictionary override, batching, and checkpoint behavior.
- Add no Japanese tokenizer or language-detection dependency and make no paid language-detection request.
- Update English and Simplified Chinese strings; other locales use English fallback.
- `src/_locales/en/messages.json`, `src/_locales/zh_CN/messages.json`, and all three target documentation files already contain unrelated user edits. Capture their baseline diffs before editing and preserve every unrelated hunk.
- Do not stage or commit. Git staging and commits require separate user authorization, so commit steps are intentionally replaced with scoped diff checkpoints.

## Responsibility map

- `src/utils/transcript-language-learning.ts`: transcript classification, two-stage Reader orchestration, independent UI state, ruby DOM rendering, restore/retry/edit/regenerate behavior.
- `src/utils/language-learning-runtime.ts`: fixed-target Japanese translation and its session checkpoint scope.
- `src/utils/reader-transcript.ts`: prevent clicks inside the Japanese learning line from seeking video playback.
- `src/styles/reader/transcripts.scss`: Japanese learning-line visibility and typography.
- `src/_locales/{en,zh_CN}/messages.json`: stage-specific progress copy.
- User/developer docs: cost, privacy, state, limitations, and architecture.

---

### Task 1: Classify transcript language and expose the action correctly

**Files:**
- Modify: `src/utils/transcript-language-learning.ts`
- Test: `src/utils/transcript-language-learning.test.ts`

**Interfaces:**
- Produces: `isJapaneseTranscript(texts: string[], language?: string): boolean`
- Produces: `shouldOfferJapaneseReadings(texts: string[], language?: string): boolean`
- Consumed by: Task 3 Reader orchestration.

- [ ] **Step 1: Write failing classification tests**

Add the imports and table-driven cases below:

```ts
import {
	cleanupTranscriptLanguageLearning,
	clearTranscriptLanguageLearningCache,
	getTranscriptLearningSelection,
	isJapaneseTranscript,
	shouldOfferJapaneseReadings,
	wireTranscriptLanguageLearning
} from './transcript-language-learning';

test.each([
	{ language: 'ja', texts: ['東京です。'], expected: true },
	{ language: 'ja-JP', texts: ['東京です。'], expected: true },
	{ language: 'ai-ja', texts: ['東京です。'], expected: true },
	{ language: 'ai-zh', texts: ['これは日本語です。'], expected: false },
	{ language: undefined, texts: ['これは日本語です。'], expected: true },
	{ language: undefined, texts: ['Hello world.'], expected: false },
	{ language: undefined, texts: ['東京'], expected: false }
])('classifies transcript language from metadata before text fallback', ({ language, texts, expected }) => {
	expect(isJapaneseTranscript(texts, language)).toBe(expected);
});

test('offers Japanese readings for non-Japanese text and Japanese text with kanji', () => {
	expect(shouldOfferJapaneseReadings(['Hello world.'])).toBe(true);
	expect(shouldOfferJapaneseReadings(['日本語です。'])).toBe(true);
	expect(shouldOfferJapaneseReadings(['こんにちは。'])).toBe(false);
	expect(shouldOfferJapaneseReadings(['   '])).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
npx vitest run src/utils/transcript-language-learning.test.ts
```

Expected: FAIL because `isJapaneseTranscript` and `shouldOfferJapaneseReadings` are not exported.

- [ ] **Step 3: Implement the minimal pure classification functions**

Place these beside the existing Japanese Unicode expressions and make `containsJapaneseKanji` reuse the same constants:

```ts
const JAPANESE_KANJI = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々]/;
const JAPANESE_KANA = /[\u3040-\u30FF]/;
const JAPANESE_LANGUAGE_TOKEN = /(^|[-_])(?:ja|jpn)(?=$|[-_])/i;

export function isJapaneseTranscript(texts: string[], language?: string): boolean {
	const normalizedLanguage = language?.trim();
	if (normalizedLanguage) return JAPANESE_LANGUAGE_TOKEN.test(normalizedLanguage);
	return texts.some(text => JAPANESE_KANA.test(text));
}

export function shouldOfferJapaneseReadings(texts: string[], language?: string): boolean {
	if (!texts.some(text => text.trim())) return false;
	return !isJapaneseTranscript(texts, language)
		|| texts.some(text => JAPANESE_KANJI.test(text));
}
```

Change the button condition to:

```ts
const transcriptLanguage = transcript.dataset.transcriptLanguage;
const sourceIsJapanese = isJapaneseTranscript(originalTexts, transcriptLanguage);
readingsButton.hidden = !shouldOfferJapaneseReadings(originalTexts, transcriptLanguage);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```sh
npx vitest run src/utils/transcript-language-learning.test.ts
```

Expected: PASS, including the existing Japanese-source tests.

- [ ] **Step 5: Audit the scoped diff**

Run:

```sh
git diff -- src/utils/transcript-language-learning.ts src/utils/transcript-language-learning.test.ts
```

Expected: only classification, button visibility, imports, and focused tests changed.

---

### Task 2: Add fixed-target Japanese translation to the configured runtime

**Files:**
- Modify: `src/utils/language-learning-runtime.ts`
- Test: `src/utils/language-learning-runtime.test.ts`

**Interfaces:**
- Produces: `translateTranscriptToJapanese(segments, onProgress?, signal?): Promise<string[]>`
- Produces: `loadJapaneseTranscriptTranslations(segments): Promise<string[] | undefined>`
- Reuses: `LanguageLearningAssistant.translateTranscript(segments, targetLanguage, onProgress?, signal?)`
- Consumed by: Task 3 `TranscriptLanguageLearning`.

- [ ] **Step 1: Write a failing fixed-target and isolation test**

Add this test inside `Configured language learning runtime`:

```ts
test('translates transcript to fixed Japanese without colliding with the configured response language', async () => {
	mocks.sendMessage.mockResolvedValue({
		success: true,
		promptResponses: [{
			key: 'prompt_1',
			prompt: 'translate',
			user_response: '0|||こんにちは、世界。'
		}]
	});

	await expect(configuredLanguageLearning.translateTranscriptToJapanese(['Hello world.']))
		.resolves.toEqual(['こんにちは、世界。']);

	expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
		action: 'languageLearningRequest',
		request: expect.objectContaining({
			prompts: [expect.objectContaining({
				prompt: expect.stringContaining('Translate each transcript segment into Japanese.')
			})]
		})
	}));
	expect(await configuredLanguageLearning.loadJapaneseTranscriptTranslations(['Hello world.']))
		.toEqual(['こんにちは、世界。']);
	expect(await configuredLanguageLearning.loadTranscriptTranslations(['Hello world.']))
		.toBeUndefined();
});
```

- [ ] **Step 2: Run the runtime test and verify RED**

Run:

```sh
npx vitest run src/utils/language-learning-runtime.test.ts
```

Expected: FAIL because the two fixed-Japanese runtime methods do not exist.

- [ ] **Step 3: Make assistant loading target-aware without changing existing callers' behavior**

Introduce the options type immediately above `loadConfiguredAssistant`:

```ts
interface ConfiguredAssistantOptions {
	japaneseReadingSegments?: string[];
	transcriptTargetLanguage?: string;
	transcriptCheckpointScope?: string;
}
```

Replace the current positional signature:

```ts
async function loadConfiguredAssistant(japaneseReadingSegments?: string[]) {
```

with:

```ts
async function loadConfiguredAssistant({
	japaneseReadingSegments,
	transcriptTargetLanguage,
	transcriptCheckpointScope
}: ConfiguredAssistantOptions = {}) {
```

Immediately after the existing `responseLanguage` declaration, insert:

```ts
const resolvedTranscriptTargetLanguage = transcriptTargetLanguage?.trim() || responseLanguage;
const resolvedTranscriptCheckpointScope = transcriptCheckpointScope?.trim()
	|| `shared:${resolvedTranscriptTargetLanguage}`;
```

Replace:

```ts
const transcriptTranslationCheckpoints = createTranslationCheckpointStore(
	`shared:${responseLanguage}`
);
```

with:

```ts
const transcriptTranslationCheckpoints = createTranslationCheckpointStore(
	resolvedTranscriptCheckpointScope
);
```

Do not change the Interpreter/model checks, request adapter, reading-limit calculation, or returned fields.

Update existing reading-specific calls from `loadConfiguredAssistant(segments)` to:

```ts
loadConfiguredAssistant({ japaneseReadingSegments: segments })
```

Keep other existing calls as `loadConfiguredAssistant()`.

- [ ] **Step 4: Add the two configured-runtime methods**

Add methods beside the existing transcript loaders and translator:

```ts
async loadJapaneseTranscriptTranslations(segments: string[]): Promise<string[] | undefined> {
	const translations = await createTranslationCheckpointStore('japanese-readings:Japanese').load(segments);
	return translations?.length === segments.length
		&& translations.every(translation => translation.trim())
		? [...translations]
		: undefined;
},

async translateTranscriptToJapanese(
	segments: string[],
	onProgress?: TranscriptTranslationProgressHandler,
	signal?: AbortSignal
): Promise<string[]> {
	const { assistant } = await loadConfiguredAssistant({
		transcriptTargetLanguage: 'Japanese',
		transcriptCheckpointScope: 'japanese-readings:Japanese'
	});
	return assistant.translateTranscript(segments, 'Japanese', onProgress, signal);
},
```

- [ ] **Step 5: Verify complete Japanese translations load without Interpreter**

Add this test after the fixed-target test:

```ts
test('loads saved Japanese transcript translation without an enabled Interpreter', async () => {
	mocks.sendMessage.mockResolvedValue({
		success: true,
		promptResponses: [{ key: 'prompt_1', prompt: 'translate', user_response: '0|||日本語です。' }]
	});
	await configuredLanguageLearning.translateTranscriptToJapanese(['This is Japanese.']);
	mocks.loadSettings.mockResolvedValue({ ...settings, interpreterEnabled: false });
	mocks.sendMessage.mockClear();

	await expect(configuredLanguageLearning.loadJapaneseTranscriptTranslations(['This is Japanese.']))
		.resolves.toEqual(['日本語です。']);
	expect(mocks.sendMessage).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run runtime and pure batching tests and verify GREEN**

Run:

```sh
npx vitest run src/utils/language-learning-runtime.test.ts src/utils/language-learning.test.ts
```

Expected: PASS. Existing response-language translation, execution-mode switching, partial checkpoint, and reading tests remain green.

- [ ] **Step 7: Audit the scoped diff**

Run:

```sh
git diff -- src/utils/language-learning-runtime.ts src/utils/language-learning-runtime.test.ts
```

Expected: only target-aware checkpoint selection, two public methods, and their tests changed.

---

### Task 3: Render the non-Japanese two-stage result without replacing existing layers

**Files:**
- Modify: `src/utils/transcript-language-learning.ts`
- Test: `src/utils/transcript-language-learning.test.ts`

**Interfaces:**
- Consumes: `translateTranscriptToJapanese` and `loadJapaneseTranscriptTranslations` from Task 2.
- Produces DOM: `.transcript-segment-japanese` containing accessible ruby tokens.
- Preserves DOM: source text and `.transcript-segment-translation`.

- [ ] **Step 1: Write a failing explicit-action and three-layer test**

Add a test that first enables an ordinary Chinese translation, then Japanese readings:

```ts
test('keeps source and bilingual translation while adding annotated Japanese for non-Japanese text', async () => {
	const { controls, transcript, segments } = createTranscript(['Hello world.']);
	const translateTranscript = vi.fn().mockResolvedValue(['你好，世界。']);
	const translateTranscriptToJapanese = vi.fn().mockResolvedValue(['こんにちは、世界。']);
	const annotateJapaneseTranscript = vi.fn().mockResolvedValue([[
		{ text: 'こんにちは、', reading: '' },
		{ text: '世界', reading: 'せかい' },
		{ text: '。', reading: '' }
	]]);
	const controller = wireTranscriptLanguageLearning({
		doc: document,
		transcript,
		segments,
		controls,
		tools: {
			translateTranscript,
			translateTranscriptToJapanese,
			explainSelection: vi.fn(),
			annotateJapaneseTranscript
		},
		cancelPendingSeek: vi.fn()
	});

	expect(translateTranscriptToJapanese).not.toHaveBeenCalled();
	expect(annotateJapaneseTranscript).not.toHaveBeenCalled();
	await controller.toggleBilingual();
	await controller.toggleJapaneseReadings();

	expect(translateTranscriptToJapanese).toHaveBeenCalledWith(
		['Hello world.'], expect.any(Function), expect.any(AbortSignal)
	);
	expect(annotateJapaneseTranscript).toHaveBeenCalledWith(
		['こんにちは、世界。'], expect.any(Function), expect.any(AbortSignal)
	);
	expect(translateTranscriptToJapanese.mock.invocationCallOrder[0])
		.toBeLessThan(annotateJapaneseTranscript.mock.invocationCallOrder[0]);
	const textElement = segments[0].querySelector('.transcript-segment-text') as HTMLElement;
	expect(textElement.firstChild?.textContent).toContain('Hello world.');
	expect(textElement.querySelector('.transcript-segment-translation')?.textContent).toBe('你好，世界。');
	const japanese = textElement.querySelector('.transcript-segment-japanese') as HTMLElement;
	expect(japanese.textContent).toBe('こんにちは、世界せかい。');
	expect(japanese.querySelector('ruby rt')?.textContent).toBe('せかい');
	expect(Array.from(textElement.children).map(element => element.className)).toEqual([
		'transcript-segment-translation',
		'transcript-segment-japanese'
	]);
});
```

- [ ] **Step 2: Write a failing Japanese-source bypass test**

Extend the existing explicit Japanese-reading test with:

```ts
const translateTranscriptToJapanese = vi.fn();
const controller = wireTranscriptLanguageLearning({
	doc: document,
	transcript,
	segments,
	controls,
	tools: {
		translateTranscript: vi.fn(),
		translateTranscriptToJapanese,
		explainSelection: vi.fn(),
		annotateJapaneseTranscript
	},
	cancelPendingSeek: vi.fn()
});
await controller.toggleJapaneseReadings();
expect(translateTranscriptToJapanese).not.toHaveBeenCalled();
```

- [ ] **Step 3: Run the Reader DOM test and verify RED**

Run:

```sh
npx vitest run src/utils/transcript-language-learning.test.ts
```

Expected: FAIL because the Japanese translation tool and dedicated DOM line are not wired.

- [ ] **Step 4: Extend the Reader tool interface without forcing unrelated tests to supply the method**

Add optional methods:

```ts
translateTranscriptToJapanese?: (
	segments: string[],
	onProgress?: (progress: TranscriptTranslationProgress) => void,
	signal?: AbortSignal
) => Promise<string[]>;
loadJapaneseTranscriptTranslations?: (segments: string[]) => Promise<string[] | undefined>;
```

When a non-Japanese action runs without `translateTranscriptToJapanese`, throw the localized translation-incomplete error rather than dereferencing `undefined`.

- [ ] **Step 5: Extract reusable ruby-token population**

Move the token loop currently inside `renderTranscriptReadings` into a helper that accepts a target element:

```ts
function populateTranscriptReadings(
	doc: Document,
	target: HTMLElement,
	tokens: TranscriptReadingToken[],
	editable: boolean,
	onReadingInput?: (tokenIndex: number, reading: string) => void
): void {
	target.replaceChildren();
	tokens.forEach((token, tokenIndex) => {
		if (!token.reading && !JAPANESE_KANJI.test(token.text)) {
			target.appendChild(doc.createTextNode(token.text));
			return;
		}
		const ruby = doc.createElement('ruby');
		const base = doc.createElement('span');
		const reading = doc.createElement('rt');
		base.textContent = token.text;
		reading.textContent = token.reading;
		reading.setAttribute('contenteditable', editable ? 'true' : 'false');
		if (editable) {
			reading.setAttribute('role', 'textbox');
			reading.setAttribute('aria-label', getMessage('readerReadingEditLabel', token.text));
			reading.setAttribute('aria-multiline', 'false');
			reading.setAttribute('tabindex', '0');
			reading.setAttribute('spellcheck', 'false');
			reading.addEventListener('input', () => {
				onReadingInput?.(tokenIndex, reading.textContent?.trim() || '');
			});
		}
		ruby.append(base, reading);
		if (!editable) {
			ruby.className = 'transcript-reading-token';
			ruby.setAttribute('role', 'button');
			ruby.setAttribute('tabindex', '0');
			ruby.setAttribute('aria-pressed', 'false');
			ruby.setAttribute('aria-label', getMessage('readerToggleReading', token.text));
			const toggleReading = () => {
				const hidden = ruby.classList.toggle('is-reading-hidden');
				ruby.setAttribute('aria-pressed', String(hidden));
			};
			ruby.addEventListener('click', event => {
				event.preventDefault();
				event.stopPropagation();
				toggleReading();
			});
			ruby.addEventListener('keydown', event => {
				if (event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				event.stopPropagation();
				toggleReading();
			});
		}
		target.appendChild(ruby);
	});
}
```

Keep `renderTranscriptReadings` responsible for the original source wrapper and call the helper only when readings are visible. Add a dedicated renderer:

```ts
function renderJapaneseTranslationReadings(
	doc: Document,
	textElement: Element,
	tokens: TranscriptReadingToken[],
	show: boolean,
	editable: boolean,
	onReadingInput?: (tokenIndex: number, reading: string) => void
): void {
	let japanese = textElement.querySelector<HTMLElement>('.transcript-segment-japanese');
	if (!japanese) {
		japanese = doc.createElement('div');
		japanese.className = 'transcript-segment-japanese';
		textElement.appendChild(japanese);
	}
	if (show) populateTranscriptReadings(doc, japanese, tokens, editable, onReadingInput);
	japanese.hidden = !show;
}
```

- [ ] **Step 6: Keep ordinary translation before the Japanese line**

When `renderTranslations` creates `.transcript-segment-translation`, insert it before an existing Japanese line:

```ts
const japaneseElement = textElement.querySelector('.transcript-segment-japanese');
if (japaneseElement) {
	textElement.insertBefore(translationElement, japaneseElement);
} else {
	textElement.appendChild(translationElement);
}
```

- [ ] **Step 7: Add the minimal two-stage orchestration**

Keep separate aligned state:

```ts
let japaneseTranslationValues = new Array<string>(originalTexts.length).fill('');

const getReadingSourceText = (index: number): string => sourceIsJapanese
	? originalTexts[index]
	: japaneseTranslationValues[index];
```

Before annotation, obtain aligned Japanese task text:

```ts
const ensureJapaneseTaskTexts = async (
	taskIndexes: number[],
	requestController: AbortController
): Promise<string[]> => {
	if (sourceIsJapanese) return taskIndexes.map(index => originalTexts[index]);
	const existing = taskIndexes.map(index => japaneseTranslationValues[index]);
	if (existing.every(text => text.trim())) return existing;
	if (!tools.translateTranscriptToJapanese) throw new Error(getMessage('readerTranslationIncomplete'));
	const sourceTexts = taskIndexes.map(index => originalTexts[index]);
	const translated = await tools.translateTranscriptToJapanese(
		sourceTexts,
		setJapaneseTranslationProgress,
		requestController.signal
	);
	if (translated.length !== taskIndexes.length || translated.some(text => !text.trim())) {
		throw new Error(getMessage('readerTranslationIncomplete'));
	}
	taskIndexes.forEach((sourceIndex, scopedIndex) => {
		japaneseTranslationValues[sourceIndex] = translated[scopedIndex];
	});
	return [...translated];
};
```

Use the returned Japanese task text for `annotateJapaneseTranscript`, completeness checks, cache keys, reading saves, and reading clears. Use `renderTranscriptReadings` for Japanese sources and `renderJapaneseTranslationReadings` for non-Japanese sources.

- [ ] **Step 8: Run the focused DOM test and verify GREEN**

Run:

```sh
npx vitest run src/utils/transcript-language-learning.test.ts
```

Expected: PASS. Source text, ordinary translation, Japanese line, ruby access, and Japanese-source bypass all hold.

- [ ] **Step 9: Audit the scoped diff**

Run:

```sh
git diff -- src/utils/transcript-language-learning.ts src/utils/transcript-language-learning.test.ts
```

Expected: no unrelated selection, vocabulary, modal, or playback behavior changed.

---

### Task 4: Preserve progress across retry, restore, range changes, cancellation, and regeneration

**Files:**
- Modify: `src/utils/transcript-language-learning.ts`
- Test: `src/utils/transcript-language-learning.test.ts`

**Interfaces:**
- Consumes: complete Japanese-translation loader from Task 2.
- Preserves: existing `TranscriptLanguageLearningController` API.
- Produces: stage-specific progress and restore behavior with no automatic request.

- [ ] **Step 1: Write failing retry and regeneration tests**

Add focused tests:

```ts
test('reuses completed Japanese translation when reading annotation is retried', async () => {
	const { controls, transcript, segments } = createTranscript(['Hello world.']);
	const translateTranscriptToJapanese = vi.fn().mockResolvedValue(['日本語です。']);
	const annotateJapaneseTranscript = vi.fn()
		.mockRejectedValueOnce(new Error('reading failed'))
		.mockResolvedValueOnce([[
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'です。', reading: '' }
		]]);
	const controller = wireTranscriptLanguageLearning({
		doc: document, transcript, segments, controls,
		tools: {
			translateTranscript: vi.fn(),
			translateTranscriptToJapanese,
			explainSelection: vi.fn(),
			annotateJapaneseTranscript
		},
		cancelPendingSeek: vi.fn()
	});

	await controller.toggleJapaneseReadings();
	await controller.toggleJapaneseReadings();
	expect(translateTranscriptToJapanese).toHaveBeenCalledOnce();
	expect(annotateJapaneseTranscript).toHaveBeenCalledTimes(2);
});

test('regenerates only readings for a non-Japanese source', async () => {
	const fixture = createTranscript(['Hello world.']);
	const translateTranscriptToJapanese = vi.fn().mockResolvedValue(['日本語です。']);
	const annotateJapaneseTranscript = vi.fn().mockResolvedValue([[
		{ text: '日本語', reading: 'にほんご' }, { text: 'です。', reading: '' }
	]]);
	const clearJapaneseReadings = vi.fn().mockResolvedValue(undefined);
	const controller = wireTranscriptLanguageLearning({
		doc: document,
		transcript: fixture.transcript,
		segments: fixture.segments,
		controls: fixture.controls,
		tools: {
			translateTranscript: vi.fn(),
			translateTranscriptToJapanese,
			explainSelection: vi.fn(),
			annotateJapaneseTranscript,
			clearJapaneseReadings
		},
		cancelPendingSeek: vi.fn()
	});

	await controller.toggleJapaneseReadings();
	await controller.regenerateJapaneseReadings();
	expect(translateTranscriptToJapanese).toHaveBeenCalledOnce();
	expect(clearJapaneseReadings).toHaveBeenCalledWith(['日本語です。']);
	expect(annotateJapaneseTranscript).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Write a failing no-request restore test**

```ts
test('restores complete translated Japanese readings without model work', async () => {
	const { controls, transcript, segments } = createTranscript(['Hello world.']);
	const translateTranscriptToJapanese = vi.fn();
	const annotateJapaneseTranscript = vi.fn();
	const controller = wireTranscriptLanguageLearning({
		doc: document,
		transcript,
		segments,
		controls,
		tools: {
			translateTranscript: vi.fn(),
			translateTranscriptToJapanese,
			loadJapaneseTranscriptTranslations: vi.fn().mockResolvedValue(['日本語です。']),
			loadJapaneseReadings: vi.fn().mockResolvedValue([[
				{ text: '日本語', reading: 'にほんご' }, { text: 'です。', reading: '' }
			]]),
			explainSelection: vi.fn(),
			annotateJapaneseTranscript
		},
		restoreJapaneseReadings: true,
		cancelPendingSeek: vi.fn()
	});

	await controller.ready;
	expect(transcript.querySelector('.transcript-segment-japanese ruby rt')?.textContent)
		.toBe('にほんご');
	expect(translateTranscriptToJapanese).not.toHaveBeenCalled();
	expect(annotateJapaneseTranscript).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Write failing range and cancellation tests**

Add this range test:

```ts
test('applies the selected transcript range to Japanese translation and readings', async () => {
	const { controls, transcript, segments } = createTranscript(['First line.', 'Second line.']);
	segments[1].classList.add('is-active');
	const translateTranscriptToJapanese = vi.fn().mockResolvedValue(['二行目です。']);
	const annotateJapaneseTranscript = vi.fn().mockResolvedValue([[
		{ text: '二行目', reading: 'にぎょうめ' }, { text: 'です。', reading: '' }
	]]);
	const controller = wireTranscriptLanguageLearning({
		doc: document,
		transcript,
		segments,
		controls,
		tools: {
			translateTranscript: vi.fn(),
			translateTranscriptToJapanese,
			explainSelection: vi.fn(),
			annotateJapaneseTranscript
		},
		cancelPendingSeek: vi.fn()
	});
	controller.setTaskRange('current');

	await controller.toggleJapaneseReadings();
	expect(translateTranscriptToJapanese).toHaveBeenCalledWith(
		['Second line.'], expect.any(Function), expect.any(AbortSignal)
	);
	expect(annotateJapaneseTranscript).toHaveBeenCalledWith(
		['二行目です。'], expect.any(Function), expect.any(AbortSignal)
	);
});
```

Add this cancellation test:

```ts
test('cancels during Japanese translation without starting reading annotation', async () => {
	const { controls, transcript, segments } = createTranscript(['Hello world.']);
	const annotateJapaneseTranscript = vi.fn();
	const translateTranscriptToJapanese = vi.fn((
		_segments: string[],
		_onProgress?: unknown,
		signal?: AbortSignal
	) => new Promise<string[]>((_, reject) => {
		signal?.addEventListener('abort', () => reject(new RequestCancelledError()), { once: true });
	}));
	const controller = wireTranscriptLanguageLearning({
		doc: document,
		transcript,
		segments,
		controls,
		tools: {
			translateTranscript: vi.fn(),
			translateTranscriptToJapanese,
			explainSelection: vi.fn(),
			annotateJapaneseTranscript
		},
		cancelPendingSeek: vi.fn()
	});

	const request = controller.toggleJapaneseReadings();
	controller.cancelActiveRequest();
	await request;
	expect(annotateJapaneseTranscript).not.toHaveBeenCalled();
	expect(controls.querySelector('.player-learning-progress')?.textContent)
		.toBe('readerAiCancelled');
});
```

- [ ] **Step 4: Run the DOM test and verify RED**

Run:

```sh
npx vitest run src/utils/transcript-language-learning.test.ts
```

Expected: FAIL on restore, retry reuse, translated reading checkpoint keys, or stage cancellation.

- [ ] **Step 5: Add a bounded Japanese-translation in-page cache**

Mirror the existing bounded cache without sharing its map:

```ts
const japaneseTranslationCache = new Map<string, string[]>();

function getJapaneseTranslationCacheKey(segments: string[]): string {
	return JSON.stringify(segments);
}

function getCachedJapaneseTranslations(segments: string[]): string[] | null {
	const cached = japaneseTranslationCache.get(getJapaneseTranslationCacheKey(segments));
	return cached ? [...cached] : null;
}

function cacheJapaneseTranslations(segments: string[], translations: string[]): void {
	const key = getJapaneseTranslationCacheKey(segments);
	if (japaneseTranslationCache.has(key)) japaneseTranslationCache.delete(key);
	japaneseTranslationCache.set(key, [...translations]);
	while (japaneseTranslationCache.size > MAX_SESSION_CACHE_ENTRIES) {
		const oldestKey = japaneseTranslationCache.keys().next().value;
		if (oldestKey === undefined) break;
		japaneseTranslationCache.delete(oldestKey);
	}
}
```

Clear this map in `clearTranscriptLanguageLearningCache()`.

- [ ] **Step 6: Make the translation stage reuse state, cache, and saved complete output**

Before calling the model adapter, check in this order:

```ts
const existing = taskIndexes.map(index => japaneseTranslationValues[index]);
if (existing.every(text => text.trim())) return existing;

if (getTaskRange() === 'all') {
	const local = getCachedJapaneseTranslations(originalTexts)
		?? await tools.loadJapaneseTranscriptTranslations?.(originalTexts);
	if (local?.length === originalTexts.length && local.every(text => text.trim())) {
		japaneseTranslationValues = [...local];
		cacheJapaneseTranslations(originalTexts, local);
		return taskIndexes.map(index => local[index]);
	}
}
```

After a complete all-transcript translation, cache it. Partial runtime checkpoints continue to live in session storage and are resumed by `translateTranscriptToJapanese` on the next explicit action.

- [ ] **Step 7: Make every reading identity use Japanese text for non-Japanese sources**

Replace original-text assumptions in these operations with `getReadingSourceText(index)`:

- `hasCompleteReadings`
- `isCompleteTranscriptReadings`
- `getCachedJapaneseReadings` and `cacheJapaneseReadings`
- `saveJapaneseReadings` after an edit
- `clearJapaneseReadings` before regeneration
- saved-readings restore

Only use an array when every required translated text is present; never construct a complete-reading cache key containing empty translation slots.

- [ ] **Step 8: Restore in dependency order without requesting**

In `restorePromise`, branch on `sourceIsJapanese`:

```ts
if (restoreJapaneseReadings && shouldOfferJapaneseReadings(originalTexts, transcriptLanguage)) {
	const readingTexts = sourceIsJapanese
		? originalTexts
		: getCachedJapaneseTranslations(originalTexts)
			?? await tools.loadJapaneseTranscriptTranslations?.(originalTexts);
	if (!signal.aborted && readingTexts?.length === originalTexts.length) {
		if (!sourceIsJapanese) japaneseTranslationValues = [...readingTexts];
		const savedReadings = getCachedJapaneseReadings(readingTexts)
			?? await tools.loadJapaneseReadings?.(readingTexts);
		if (savedReadings && isCompleteTranscriptReadings(savedReadings, readingTexts)) {
			japaneseReadings = cloneTranscriptReadings(savedReadings);
			readingsComplete = true;
			renderReadings(true);
		}
	}
}
```

Retain the existing best-effort boundary exactly:

```ts
})()
	.catch(() => {
		// Restoring local checkpoints is best-effort and never starts a paid request.
	})
	.finally(() => { restoreComplete = true; });
```

- [ ] **Step 9: Give both stages one request controller and distinct progress labels**

Start one controller and one task UI before translation. Use:

```ts
const setJapaneseTranslationProgress = (progress: TranscriptTranslationProgress) => {
	lastTaskProgress = { completed: progress.completed, total: progress.total };
	taskProgress.max = Math.max(1, progress.total);
	taskProgress.value = progress.completed;
	setProgressStatus(getMessage('readerJapaneseTranslationProgress', [
		String(progress.completed), String(progress.total)
	]));
};
```

Then reuse the existing reading-progress handler. Cancellation of the shared controller stops the current stage and prevents the next one from starting.

- [ ] **Step 10: Run focused tests and verify GREEN**

Run:

```sh
npx vitest run src/utils/transcript-language-learning.test.ts src/utils/language-learning-runtime.test.ts
```

Expected: PASS for retry, restore, range, cancellation, edit, regenerate, existing Japanese sources, and ordinary bilingual subtitles.

- [ ] **Step 11: Audit the scoped diff**

Run:

```sh
git diff -- src/utils/transcript-language-learning.ts src/utils/transcript-language-learning.test.ts
```

Expected: state changes trace only to the fixed Japanese translation/readings flow.

---

### Task 5: Integrate click safety, styles, localization, and documentation

**Files:**
- Modify: `src/utils/reader-transcript.ts`
- Test: `src/utils/reader-transcript.test.ts`
- Modify: `src/styles/reader/transcripts.scss`
- Modify carefully: `src/_locales/en/messages.json`
- Modify carefully: `src/_locales/zh_CN/messages.json`
- Modify carefully: `docs/Introduction to Obsidian Web Clipper.md`
- Modify carefully: `docs/Language learning.md`
- Modify carefully: `docs/development/Language learning MVP.md`

**Interfaces:**
- Consumes DOM: `.transcript-segment-japanese` from Task 3.
- Produces i18n key: `readerJapaneseTranslationProgress` with `$1/$2` batch placeholders.

- [ ] **Step 1: Capture overlapping-file baselines**

Run and retain the output for comparison:

```sh
git diff -- src/_locales/en/messages.json src/_locales/zh_CN/messages.json docs/Introduction\ to\ Obsidian\ Web\ Clipper.md docs/Language\ learning.md docs/development/Language\ learning\ MVP.md
```

Expected: existing unrelated changes are visible and remain untouched by later patches.

- [ ] **Step 2: Write a failing click-safety integration test**

Add this `wireTranscript` test:

```ts
test('does not seek when the Japanese learning line is clicked', () => {
	vi.useFakeTimers();
	vi.stubGlobal('CSS', {});
	document.body.innerHTML = `
		<article>
			<div class="reader-video-wrapper"><video class="reader-video-player"></video></div>
			<div class="youtube transcript">
				<div class="transcript-segment">
					<strong><span class="timestamp" data-timestamp="10">0:10</span></strong>
					Hello world.
					<div class="transcript-segment-japanese"><ruby>世界<rt>せかい</rt></ruby></div>
				</div>
			</div>
		</article>
	`;
	const article = document.querySelector('article') as HTMLElement;
	const video = article.querySelector('video') as HTMLVideoElement;
	wireTranscript(document, article, {
		pinPlayer: true,
		autoScroll: true,
		highlightActiveLine: true,
		transcriptLayout: 'reading'
	}, {
		getStickyOffset: () => 0,
		scrollTo: vi.fn(),
		programmaticScroll: () => false
	});
	const segment = article.querySelector('.transcript-segment') as HTMLElement;
	segment.getBoundingClientRect = () => ({ top: 0, height: 100 } as DOMRect);
	const japanese = article.querySelector('.transcript-segment-japanese') as HTMLElement;
	japanese.dispatchEvent(new MouseEvent('click', {
		bubbles: true,
		clientX: 10,
		clientY: 50,
		detail: 1
	}));
	vi.advanceTimersByTime(350);
	expect(video.currentTime).toBe(0);
});
```

- [ ] **Step 3: Run the Reader transcript test and verify RED**

Run:

```sh
npx vitest run src/utils/reader-transcript.test.ts
```

Expected: FAIL because the transcript click filter does not recognize `.transcript-segment-japanese`.

- [ ] **Step 4: Extend the click filter and styles**

Add the Japanese line to the existing closest-selector guard:

```ts
if (target.closest(
	'.transcript-segment-translation, .transcript-segment-japanese, .transcript-reading-token, .player-learning-action, .language-learning-selection-action'
)) return;
```

Add styling adjacent to `.transcript-segment-translation`:

```scss
.transcript-segment-japanese {
	display: none;
	color: var(--text-normal);
	font-size: 0.92em;
	line-height: 1.72;
	margin-top: 0.55em;
}
.show-japanese-readings .transcript-segment-japanese:not([hidden]) {
	display: block;
}
```

- [ ] **Step 5: Add stage-specific English and Chinese progress messages**

Insert beside `readerJapaneseReadingsProgress`, preserving all existing locale edits:

```json
"readerJapaneseTranslationProgress": {
	"message": "Translating to Japanese ($1/$2)…"
}
```

```json
"readerJapaneseTranslationProgress": {
	"message": "正在翻译为日语（$1/$2）…"
}
```

- [ ] **Step 6: Update discoverability and user behavior documentation**

Apply these exact edits to the three approved docs:

- Introduction: extend the existing language-learning bullet with: `For non-Japanese transcripts, Japanese readings preserves the source, translates the selected range to Japanese, and annotates that separate Japanese line.`
- User guide: add the exact paragraphs below after the current Japanese-readings introduction.
- Developer MVP: add the exact architecture paragraph below after the transcript alignment and checkpoint description.

Use this exact user-facing cost statement in `docs/Language learning.md`:

```md
For a non-Japanese transcript, **Japanese readings** first translates the selected range into Japanese and then generates readings for the Japanese text. Each stage can create multiple sequential provider or local CLI requests for a long range. Both stages start only from the explicit action; reload and retry restoration never start a paid request automatically.

The original subtitle remains visible. If **Bilingual subtitles** is also enabled, its ordinary translation remains a separate line, followed by the Japanese translation with readings. Turning off **Japanese readings** hides the entire Japanese learning line. **Regenerate readings** regenerates only hiragana readings; it does not retranslate the Japanese text or clear personal reading overrides.
```

Add this developer paragraph:

```md
For a transcript classified as non-Japanese, Reader runs fixed-target `Japanese` translation before reading annotation. Explicit `ja`/`jpn` language tokens take precedence over the kana fallback. Ordinary translations, Japanese translations, and readings have independent checkpoint identities. Restore loads the Japanese translation before readings keyed by that exact Japanese text; missing state never triggers a request. Translation must be complete and aligned before annotation begins.
```

- [ ] **Step 7: Run focused integration tests and JSON parsing**

Run:

```sh
npx vitest run src/utils/reader-transcript.test.ts src/utils/transcript-language-learning.test.ts
node -e "JSON.parse(require('fs').readFileSync('src/_locales/en/messages.json','utf8')); JSON.parse(require('fs').readFileSync('src/_locales/zh_CN/messages.json','utf8'))"
```

Expected: PASS with valid locale JSON.

- [ ] **Step 8: Compare overlapping files with their captured baselines**

Run:

```sh
git diff -- src/_locales/en/messages.json src/_locales/zh_CN/messages.json docs/Introduction\ to\ Obsidian\ Web\ Clipper.md docs/Language\ learning.md docs/development/Language\ learning\ MVP.md
```

Expected: every new hunk maps to Japanese translation/readings documentation or localization; all pre-existing unrelated hunks remain present.

---

### Task 6: Complete repository verification and produce an evidence boundary

**Files:**
- Verify only; fix failures only in files already owned by Tasks 1-5 unless a new failure proves another task-scoped dependency.

**Interfaces:**
- Consumes all deliverables from Tasks 1-5.
- Produces focused, full-suite, typecheck, build, whitespace, and Git-state evidence.

- [ ] **Step 1: Run all focused regression tests together**

Run:

```sh
npx vitest run src/utils/language-learning.test.ts src/utils/language-learning-runtime.test.ts src/utils/transcript-language-learning.test.ts src/utils/reader-transcript.test.ts
```

Expected: all selected files pass with no unhandled rejection or warning.

- [ ] **Step 2: Run the timezone-stable full test suite**

Run:

```sh
TZ=America/Los_Angeles npm test
```

Expected: PASS. If an unrelated baseline test fails, record its exact test and prove whether it reproduces without task changes before altering any extra file.

- [ ] **Step 3: Run TypeScript validation**

Run:

```sh
npx tsc --noEmit --module es2020
```

Expected: exit code 0.

- [ ] **Step 4: Build all browser targets**

Run:

```sh
npm run build
```

Expected: Chromium, Firefox, and Safari production builds succeed. Generated `dist*` and `builds` outputs remain uncommitted.

- [ ] **Step 5: Check whitespace and inspect task-only diffs**

Run:

```sh
git diff --check
git status --short
git diff -- src/utils/language-learning-runtime.ts src/utils/language-learning-runtime.test.ts src/utils/transcript-language-learning.ts src/utils/transcript-language-learning.test.ts src/utils/reader-transcript.ts src/utils/reader-transcript.test.ts src/styles/reader/transcripts.scss src/_locales/en/messages.json src/_locales/zh_CN/messages.json docs/Introduction\ to\ Obsidian\ Web\ Clipper.md docs/Language\ learning.md docs/development/Language\ learning\ MVP.md
```

Expected: `git diff --check` is clean. Report task files separately from the user's pre-existing dirty files and do not claim unrelated changes.

- [ ] **Step 6: Perform optional unpacked-Chromium smoke acceptance when available**

Use one Japanese transcript and one non-Japanese transcript with timed segments. Verify:

1. Japanese source produces readings without translation.
2. Non-Japanese source preserves the original and adds the Japanese line with ruby.
3. Ordinary bilingual output can coexist as a third layer.
4. Toggle, cancel, retry, edit readings, and regenerate readings match the design.
5. Reload restores only complete results and starts no request.

If browser acceptance cannot run, report it as `NOT_RUN`; automated tests and a successful build do not substitute for visible browser proof.

- [ ] **Step 7: Hand off without staging or committing**

Report:

- Files changed for this feature.
- Focused/full test counts and commands.
- Typecheck/build/diff-check results.
- Browser smoke status.
- Any unrelated dirty-worktree files preserved.

Do not emit Git stage, commit, push, or PR directives because none of those actions are authorized by this plan.
