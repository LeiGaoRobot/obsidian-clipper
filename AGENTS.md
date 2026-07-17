# AGENTS.md

## Scope

These instructions apply to the entire repository. A more specific `AGENTS.md` in a subdirectory overrides this file for that subtree.

## Project overview

Obsidian Web Clipper is a TypeScript browser extension built with Webpack for Chromium, Firefox, and Safari. Source files live in `src/`; local production outputs are generated in `dist/`, `dist_firefox/`, `dist_safari/`, and `builds/` and must not be committed.

Keep changes surgical. Match the existing TypeScript, SCSS, localization, and Obsidian Help Markdown conventions. Do not refactor unrelated code while implementing a feature or fix.

## Important module seams

| Module | Responsibility | Constraint |
| --- | --- | --- |
| `src/utils/language-learning.ts` | Pure prompt construction, text replacement, transcript batching, and response alignment | No DOM, storage, or browser runtime dependencies |
| `src/utils/language-learning-runtime.ts` | Configured language-learning interface used by Popup and Reader callers | Loads settings and sends model work to the background |
| `src/utils/language-learning-popup.ts` | Popup and side-panel AI-edit UI | Preview against a source snapshot before applying |
| `src/utils/transcript-language-learning.ts` | YouTube Reader bilingual and explanation UI | Remote calls must follow trusted user actions |
| `src/utils/language-learning-service.ts` | Background configuration checks and model selection | Use only stored, enabled Interpreter models |
| `src/utils/llm-client.ts` | Provider request construction and response parsing | Must remain DOM-free and safe in an MV3 service worker |

The network client is also re-exported from `src/utils/interpreter.ts` for the existing Interpreter interface. Keep the implementation in `llm-client.ts`; do not duplicate provider logic in UI modules.

## Language-learning invariants

- Never run a paid or remote language-learning request automatically on page load, transcript load, or selection change. A user must explicitly request an edit, translation, or explanation.
- Page-DOM controls that can create model costs must reject synthetic events with `event.isTrusted`. Programmatic controller methods may exist for isolated tests, but must not be exposed to host-page scripts.
- Execute provider requests in the extension background. Do not fetch model providers directly from Reader or page content scripts.
- Keep the background network path synchronous in the bundle. Do not dynamically import `interpreter.ts` or create a runtime chunk for Chrome MV3 service workers.
- Never pass provider credentials through page DOM or language-learning messages. Resolve the provider, API key, and enabled model from stored Interpreter settings in the background.
- Preserve transcript alignment. Every source segment has a stable numeric ID, long transcripts use sequential requests that target bounded prompt groups, and the UI must reject incomplete translations instead of displaying a partial result as complete. Keep each source segment atomic; one oversized segment may exceed the group target.
- Resolve the response language from `readerSettings.learningResponseLanguage`, then fall back to the browser language.
- AI edits operate on the selected portion of the clipping, or the full clipping when there is no selection. Applying a preview must fail if the source content changed after the preview was generated.
- Clean up Reader controls and listeners during SPA navigation. Explanation caching is session-local and keyed by selection kind, selected text, and context.

## Development workflow

Install dependencies with:

```sh
npm install
```

During implementation, run the closest test file repeatedly:

```sh
npx vitest run src/utils/<name>.test.ts
```

Before committing, run:

```sh
TZ=America/Los_Angeles npm test
npx tsc --noEmit --module es2020
npm run build
git diff --check
```

The explicit timezone avoids the repository's timezone-sensitive test behavior. If shared CLI or API code changes, also run:

```sh
npm run build:cli
npm run build:api
```

When changing background imports, provider requests, or Webpack entry behavior, build Chromium separately and verify `dist/background.js` does not depend on DOM APIs or a runtime-loaded network chunk. A real unpacked-extension smoke test is preferred for MV3 changes.

## Tests

- Put pure behavior tests next to the module using `*.test.ts`.
- Use `// @vitest-environment jsdom` only for DOM behavior.
- Test through the same interface used by callers. Inject provider calls or transformation functions instead of making real model requests.
- Cover user-visible state transitions such as preview, apply, cancel, undo, retry, show/hide, and SPA cleanup.
- For transcript changes, include alignment, incomplete-response, long-batch, word-selection, sentence-selection, and cross-segment-selection cases.

## Documentation and localization

- User documentation uses YAML frontmatter, Obsidian callouts, and `[[wikilinks]]` under `docs/`.
- Add new user-facing features to `docs/Introduction to Obsidian Web Clipper.md` so they are discoverable.
- Update `docs/Language learning.md` and `docs/development/Language learning MVP.md` whenever language-learning behavior, limitations, settings, or architecture changes.
- Do not hardcode user-facing UI text. Add message keys to `src/_locales/en/messages.json` and update `src/_locales/zh_CN/messages.json` for this feature. Other locales may use the English fallback until translated.
- Document when an action may send content to a third-party provider or create multiple billable requests.

## Completion criteria

A change is complete only when its focused tests pass, the full suite and type check pass, affected browser builds succeed, documentation and localization are synchronized, `git diff --check` is clean, and only files required by the task are changed.
