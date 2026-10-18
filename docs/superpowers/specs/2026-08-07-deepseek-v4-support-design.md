# DeepSeek V4 API Support Design

## Goal

Make the current DeepSeek V4 models directly selectable in Interpreter while preserving existing user configurations and the extension's OpenAI-compatible provider request path.

## Scope

- Replace the obsolete DeepSeek preset suggestions with `deepseek-v4-flash` and `deepseek-v4-pro`.
- Mark DeepSeek V4 Flash as the recommended model for new configurations.
- Make the V4 suggestions visible in the current extension build even while the remotely loaded Obsidian provider catalog still contains the legacy model IDs.
- Preserve saved providers, API keys, models, and Interpreter selections without migration.
- Keep every non-DeepSeek provider unchanged.

Adding a DeepSeek CLI mode, exposing thinking or reasoning controls, switching to the Responses or Anthropic APIs, dynamically querying `/models`, and changing provider-catalog ownership are outside this change.

## Provider Catalog and Runtime Behavior

The settings page currently loads provider presets from the Obsidian repository and falls back to its local extension-storage cache. The repository's root `providers.json` is not bundled into the extension, so editing that file alone would not change the current PagePick build.

Add a narrow normalization step at the point where remote or cached provider data is converted into the settings-page preset map. When a `deepseek` preset is present, retain its ID, name, API-key metadata, model-list URL, and base URL, but replace its `popularModels` with:

- `deepseek-v4-flash`, displayed as **DeepSeek V4 Flash** and marked recommended;
- `deepseek-v4-pro`, displayed as **DeepSeek V4 Pro**.

Apply the same normalization to both freshly fetched and cached preset data. Do not synthesize a DeepSeek provider when neither source contains one, and do not alter any other provider entry.

Update the root `providers.json` to the same V4 model list and set its version token to `2026.08.07` so a future publication of that catalog invalidates older cached data. A contract test must keep the root catalog and runtime normalization values aligned.

## Compatibility and Migration

Do not rewrite stored `ModelConfig` records. Existing `deepseek-chat`, `deepseek-reasoner`, or custom DeepSeek model IDs remain present and editable exactly as saved. Because those IDs are no longer in `popularModels`, the existing model editor treats them as custom entries.

Do not automatically fall back from a legacy model ID to a V4 model. Provider errors remain visible through the current error path so the extension never silently changes model behavior, cost, or thinking mode.

## API Request and Response Flow

DeepSeek V4 continues to support the OpenAI Chat Completions interface at the existing `https://api.deepseek.com/v1/chat/completions` preset URL. Keep the generic request implementation in `src/utils/llm-client.ts` unchanged:

1. Resolve the saved DeepSeek provider and API key from extension storage.
2. Send the selected V4 model ID, the existing system/user messages, and the current optional token limit.
3. Authenticate with the existing Bearer header.
4. Parse the final answer from `choices[0].message.content` through the existing JSON-response parser.

Do not add DeepSeek-specific request parameters such as `thinking`, `reasoning_effort`, or `response_format` in this change. A focused request-contract test will demonstrate that both V4 model IDs work through the shared path without introducing a provider-specific branch.

## Error Handling

Keep the existing API-key, cooldown, timeout, cancellation, HTTP-error, and malformed-response behavior. The preset normalization is deterministic and does not perform an additional network request.

If the provider catalog request fails, a valid cached catalog is normalized before display. If no remote or cached catalog exists, the existing empty-preset behavior remains unchanged; users can still add a custom OpenAI-compatible provider and model.

## Documentation and Localization

Update `docs/Interpret web pages.md` to name the two current DeepSeek V4 model IDs and explain that saved legacy model IDs are not migrated automatically. Retain the existing API-key and model-documentation links.

No new user-facing control or message is introduced, so localization files do not change. The Introduction and language-learning documentation do not need behavioral updates because all language-learning callers already use the configured Interpreter provider and shared LLM client.

## Testing

Add focused coverage for:

- remote provider data normalizing DeepSeek recommendations to V4;
- cached provider data receiving the same normalization;
- unrelated provider data remaining deeply equal at the field level;
- a saved legacy DeepSeek model remaining untouched and appearing as a custom model in the existing editor behavior;
- the root `providers.json` matching the runtime V4 recommendation contract;
- DeepSeek V4 Chat Completions request URL, Bearer authentication, model ID, message body, and response parsing through `sendToLLM`.

Implementation follows test-driven development: the new catalog-normalization and root-catalog expectations must first fail for the missing V4 support, then pass with the smallest production change. The API request and legacy-model cases characterize behavior that already exists and must remain green before and after the change.

Completion requires the focused tests, `TZ=America/Los_Angeles npm test`, `npx tsc --noEmit --module es2020`, Chrome/Firefox/Safari production builds, and `git diff --check`. No live DeepSeek request will be made because that would require a user credential and create external usage; real API validation remains separate.
