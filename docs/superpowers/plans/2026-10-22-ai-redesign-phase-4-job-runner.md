# AI Redesign Phase 4: JobRunner

Spec: [[2026-10-19-ai-subsystem-redesign-design]]. Previous: [[2026-10-21-ai-redesign-phase-3-output-contracts]]. Branch: `ai-redesign`.

**Goal:** Run a whole transcript (`translate`, `reading`) as one durable background job: groups run in a bounded pool, every completed group is checkpointed in `storage.session` through serialized writes, D4 retries are automatic, and a Port disconnect or a dead service worker is survived by reconnect + `attach`. The `transcriptCheckpointStorage` bridge is deleted.

## Constraints

- **User actions only.** A job starts only from a `start-job` message sent by a user action. `checkpoint-get` (Reader restore) never resumes or starts anything. Auto-resume applies only to a job the user started that is still `running` (decision 6).
- **Background-only network, static imports.** `job-runner.ts`, `job-store.ts`, and `job-identity.ts` are DOM-free, statically imported into `background.ts`, and safe in an MV3 service worker. `npm run test:bundle-boundaries` stays green.
- **No credentials in messages.** Job messages carry instruction, segments, and identity only. The runner resolves the profile per group through the gateway's execute path.
- **Alignment.** Segment ids are stable source indexes, segments are atomic, a result is accepted only for a requested id that validates, and a job is `completed` only when every segment has a result. Groups now run concurrently; the AGENTS.md invariant text changes accordingly (D2).
- **Same UI behavior.** `transcript-language-learning.ts` keeps progress, cancel, Continue remaining, manual save, regenerate, and request-free restore. Its `tools` interface (`:17-50`) does not change shape; only one optional progress field is added.
- **Settings stay v1.** `Connection.maxConcurrency` (`src/ai/types.ts:28`) is honored when present, but `settings-view.ts` never sets it until Phase 5, so defaults apply in practice.

## Decisions made here

1. **Unit of work.** One job = one transcript task on one set of segments. New client message `start-job` (below). The gateway's existing single-call `execute` (`gateway.ts:139-216`) is extracted as `executeTask(task, input, {profileId, signal, onProgress})` and becomes the runner's per-group executor. Single-call `start` for `interpret`/`edit`/`explain` is unchanged. `translate`/`reading` via plain `start` stay valid for tests and `src/cli.ts`, but no UI caller uses them any more.
2. **Job identity.** `src/ai/job-identity.ts` (pure, shared by client and gateway) exports `hashSegments(scope, texts)` (cyrb53, 53-bit, sync, no `crypto.subtle` so it works on insecure Reader origins) and `transcriptJobId(task, identity, segments) = \`job:${task}:${namespace}:${hash}\``. The client sends this id; the gateway recomputes it and answers `Invalid AI request.` on a mismatch. Profile is not part of the id. Segment ids in a job input must equal their index (`id === i`), so results map to arrays without a lookup. A `start-job` whose id is already running attaches the port and replays the snapshot; it never duplicates work.
3. **Port messages** (`src/ai/protocol.ts`). Client → gateway:

   | Message | Shape |
   | --- | --- |
   | `start-job` | `{ type, jobId, task: 'translate' \| 'reading', profileId?, input: { instruction, segments: {id,text}[], identity: { namespace, scope } } }`; same bounds as `sanitizeTaskInput` (`MAX_SEGMENTS`, `MAX_INPUT_CHARS`), namespace and scope non-empty ≤ 100 chars |
   | `attach` / `cancel` | unchanged; now also valid for durable jobs |
   | `checkpoint-get` | `{ type, requestId, jobId }` |
   | `checkpoint-put` | `{ type, requestId, jobId, task, identity, segmentCount, results: JobResultItem[] }`, items validated by the task contract; writes a record with status `completed` when every id is present, else `incomplete`; refused while that job is `running` |
   | `checkpoint-clear` | `{ type, requestId, jobId }`; removes the record and cancels an in-memory job of that id |

   Gateway → client:

   | Message | Shape |
   | --- | --- |
   | `job-state` | `{ type, jobId, status, completedGroups, totalGroups, completedSegments, totalSegments, results: JobResultItem[], attempts: { requests, retries, splits }, error?: SerializedAiError }`; full snapshot, sent on `start-job`, on `attach`, and as the final message when `status !== 'running'` |
   | `job-progress` | `{ type, jobId, completedGroups, totalGroups, completedSegments, totalSegments, results: JobResultItem[] }`; delta holding only the items accepted from the group that just finished |
   | `job-retry` | `{ type, jobId, code, status?, delayMs, attempt }`; sent when a group enters backoff |
   | `checkpoint` | `{ type, requestId, jobId, ok, record?: { status, results, completedSegments, totalSegments } }` |

   `JobResultItem` is an item of `AiTaskOutput<'translate'>` or `AiTaskOutput<'reading'>`. `SerializedAiError` gains `retryAfterMs?`.
4. **Store** (`src/ai/job-store.ts`). Key prefix `aiJob:` + jobId in `storage.session`; `createAiJobStore(area?)` falls back to an in-memory `Map` when `browser.storage.session` is absent (Safari < 16.4, tests), which keeps restore working for the worker's lifetime only. Record:

   ```ts
   interface AiJobRecord {
     v: 1; id: string; task: 'translate' | 'reading';
     identity: { namespace: string; scope: string };
     segmentCount: number; segmentHash: string; profileId?: string;
     status: 'running' | 'completed' | 'incomplete' | 'failed' | 'cancelled';
     results: Record<string, string | ReadingToken[]>;   // accepted items by segment id
     attempts: { requests: number; retries: number; splits: number };
     cliPromptChars?: number;                           // current CLI group budget after splits
     error?: SerializedAiError; createdAt: number; updatedAt: number;
   }
   ```

   Group membership is not stored: groups are rebuilt from the ids without results on every (re)start, which a CLI split needs anyway, so "group status" from the spec is implicit in `results`. Writes are serialized per job through a promise chain; `put` prunes to `MAX_RECORDS = 20` by `updatedAt`, skipping `running` records unless more than 20 are running, and treats a quota error as an eviction trigger (drop the oldest non-running record, retry once). `removeLegacyCheckpoints()` deletes `languageLearningTranscriptCheckpointV1:*` once on gateway init; no migration, because `storage.session` does not survive a browser restart.
5. **Runner** (`src/ai/job-runner.ts`, pure, deps injected: `store`, `execute`, `now`, `random`, `setTimeout`, `heartbeatMs`). Policy constants live here:
   - Group budget by kind × task: API 6000 / 2500, `cli-codex` 6000 / 2500, `cli-grok` 6000 / 1600 (from `language-learning-runtime.ts:29-33`); floors 1200 / 600; `MAX_SPLITS = 3`.
   - `maxConcurrency`: `connection.maxConcurrency ?? (ollama 1, CLI 1, other API 3)`.
   - `maxTokens` per group: the formulas at `language-learning.ts:238` and `:284`, verbatim.
   - `buildTranscriptPromptGroups` (`language-learning.ts:84-127`) moves here unchanged.
   - Pool: groups in source order; dispatch while `inFlight < maxConcurrency`; after each group, merge accepted items into the in-memory record, enqueue a serialized `put`, post `job-progress`. While running, `updatedAt` is refreshed every `heartbeatMs` (20 s) so "recently updated" means "was actively running", not "last group finished" (a CLI group can take 120 s).
   - A fatal group error stops dispatch, lets in-flight groups finish (they are already billed and still checkpoint), then finishes the job.
   - Profile per group: `execute` re-reads settings each call, so a model or key change applies at the next dispatch. `maxConcurrency` is re-read before each dispatch from the connection resolved for that dispatch. The group budget is fixed per plan; a kind change mid-run only takes effect on the next re-plan (a CLI split or a later Continue). Oversized groups after an API→CLI switch are handled by the CLI timeout split.
6. **Resume.** Only `running` records resume. (a) `attach` or `start-job` for a `running` record with no in-memory job resumes it immediately: the attaching UI belongs to the user who started it. (b) On gateway init the runner resumes `running` records with `updatedAt` within `RESUME_WINDOW_MS = 10 min` and marks older ones `incomplete` (no error). Justification for (b) against "no automatic paid request": `running` exists only between an explicit start and a terminal state, cancel is terminal and never resumes, and the window plus the heartbeat refresh bound the resume to a job that was actively running moments before the worker died. `completed`, `incomplete`, `failed`, and `cancelled` never auto-resume; a later `start-job` from the user ("Continue remaining") re-plans from the missing ids and reuses the results. Init and `attach` race: `resume(id)` is idempotent through an in-memory `Map<jobId, Promise<Job>>`, and `attach` awaits it.
7. **Retry (D4).** Per group, in the runner: codes `rate-limited` (never `quota`) and `provider-error` with status in {500, 502, 503, 504, 529}; `MAX_GROUP_RETRIES = 2`; per-job budget `JOB_RETRY_BUDGET = min(8, 2 + floor(groups / 2))` persisted in `attempts.retries`; delay `max(retryAfterMs ?? 0, min(30 s, 1 s × 2^attempt)) × (0.5 + random())`; a `Retry-After` above 60 s is not retried. The sleep listens to the job signal, so cancel aborts it. `timeout`, `network`, and everything else are never retried for API kinds. `http.ts:354-357` parses `Retry-After` (seconds or HTTP-date) into `AiError.retryAfterMs`; `classifyHttpStatus` gains an optional `retryAfterMs` option.
   **CLI timeout split** replaces the runtime's adaptive maps (`language-learning-runtime.ts:37-38, 88-114, 248-315, 405-470`): on a `timeout` from a CLI connection, if `cliPromptChars > floor` and `attempts.splits < MAX_SPLITS`, halve `cliPromptChars` (not below the floor), persist, re-plan the remaining ids, continue; otherwise the job fails with that timeout error. This is now automatic for readings too; today readings only shrink the limit for the next explicit try, so `readerJapaneseReadingsTimeoutRetry` (en, zh_CN) is deleted. The runtime maps a CLI `timeout` with `attempts.splits > 0` to `readerTranscriptTranslationBatchFailed` with `automaticBatchRetry: true`, as today.
8. **Terminal states.** `completed`: every segment has a result. `incomplete`: every group finished without error but some ids were omitted or rejected by the contract; the final `job-state` carries `error: AiError('incomplete')`. The runner never re-requests omitted ids on its own; Continue remaining does. `failed`: a group error stopped the job; `error` is that error. `cancelled`: user cancel. The client resolves `completed` and `incomplete` with the aligned snapshot (missing → `''` or `[]`) so the UI's existing incomplete check and Continue button keep working; it rejects `failed` and `cancelled`.
9. **Contracts tighten.** `parseOutput('reading')` accepts an item only if its tokens reproduce the source text and every kanji token has a reading; `isCompleteTranscriptReadingSegment` and the kanji regex move from `language-learning.ts` to `contracts.ts`, and `language-learning.ts` re-exports `isCompleteTranscriptReadings` for restore validation. `parseOutput('translate')` drops blank text. Both are the rules the UI applied after the fact; moving them into the contract lets the runner accept whatever `execute` returns.
10. **Client** (`src/ai/job-client.ts`). `runTranscriptJob(task, input, {profileId?, signal?, onProgress?, connect?, keepaliveMs?, reconnect?})` → `Promise<{ status, results: AiTaskOutput<T>, attempts, connectionKind? }>`: computes the id, sends `start-job`, accumulates `job-progress` deltas, replaces its state on `job-state`, and treats `onDisconnect` as reconnect + `attach` with delays 250, 500, 1000, 2000, 4000 ms (`MAX_RECONNECTS = 5`); after that it rejects `network` (the job itself keeps running in the background). `loadTranscriptCheckpoint`, `saveTranscriptCheckpoint`, `clearTranscriptCheckpoint` open a short-lived Port and exchange one `checkpoint-*` round trip. `runAiTask` is unchanged. Disconnect policy stays as `CANCEL_ON_DETACH` (`gateway.ts:59`): interactive tasks cancel, durable jobs continue.
11. **Runtime and UI.** `language-learning-runtime.ts` translate/annotate call `runTranscriptJob`; the Japanese personal-dictionary merge stays in the runtime and the job runs on the unresolved subset (identity `japanese-readings` / `shared`, as today's in-flight checkpoint did), while the UI's `saveJapaneseReadings` of the full set becomes a `checkpoint-put` on the full-set id, also as today. `createLanguageLearningAssistant(sendRequest, { runJob })` loses the checkpoint-store options; `TranscriptReadingCheckpointStore` / `TranscriptTranslationCheckpointStore` are deleted. `TranscriptBatchProgress` gains optional `retry?: { delayMs, attempt }`; the UI shows `readerTranscriptRetrying` ("Provider busy, retrying in $1 s…", en + zh_CN) in the progress status while a group backs off.
12. **Safari.** `nativeMessaging === 'message'` keeps one group per `sendNativeMessage`, no heartbeat, no cancel of the in-flight group: cancel marks the job `cancelled` and stops dispatch, and the in-flight group's result is still checkpointed so a later Continue skips it. API kinds behave as on Chrome. Without `storage.session` the store is in-memory (decision 4). No Safari e2e change.

## Files

| File | Change |
| --- | --- |
| `src/ai/job-identity.ts` | `hashSegments`, `transcriptJobId`, `parseJobId` |
| `src/ai/job-store.ts` | Record schema, `createAiJobStore`, serialized writes, pruning, legacy key removal |
| `src/ai/job-runner.ts` | Policy constants, `buildTranscriptPromptGroups`, pool, retry, CLI split, resume, events |
| `src/ai/errors.ts`, `src/ai/adapters/http.ts` | `retryAfterMs` on `AiError`; `Retry-After` parsing |
| `src/ai/contracts.ts` | Reading completeness and blank-translation rules in `parseOutput`; `isCompleteTranscriptReadingSegment` |
| `src/ai/protocol.ts` | `start-job`, `checkpoint-*`, `job-state`, `job-progress`, `job-retry`, `checkpoint`; `sanitizeJobInput`; `retryAfterMs` serialization |
| `src/ai/gateway.ts` | `executeTask` extraction; runner wiring; new message handlers; `resumeJobs()`; durable `attach` |
| `src/ai/job-client.ts` | `runTranscriptJob`, `loadTranscriptCheckpoint`, `saveTranscriptCheckpoint`, `clearTranscriptCheckpoint` |
| `src/background.ts` | Store wiring, `resumeJobs()` at init; delete the bridge (`:20`, `:29-43`, `:500-539`) |
| `src/utils/language-learning.ts` | `runJob` option; groups, checkpoints, and per-group loops removed; re-export completeness check |
| `src/utils/language-learning-runtime.ts` | Job client calls; adaptive maps and session keys deleted; `getExecutionInfo` reads the policy constants |
| `src/utils/transcript-language-learning.ts` | Retry status text; otherwise unchanged behavior |
| Deleted | `src/utils/transcript-checkpoint-storage.ts` and its test |
| `src/_locales/en`, `zh_CN` | Add `readerTranscriptRetrying`; remove `readerJapaneseReadingsTimeoutRetry` |
| `scripts/extension-e2e.mjs` | Task-aware mock provider; stopWorker and 429 tests |
| `scripts/transcript-e2e-fixture.mjs`, `scripts/firefox-e2e.mjs` | New store records and key format |
| Docs | AGENTS.md seam table and invariant, `docs/Language learning.md`, `docs/development/Language learning MVP.md` |

## Tasks (each commit green)

Tasks 1 and 2 are independent of each other; 5 depends only on 2 and can run in parallel with 3 and 4. Tasks 1–5 add code while the old paths keep running; 6 switches callers and deletes the old code.

1. **Identity, store, Retry-After** (pure, test-first).
   - `job-identity.test.ts`: stable id for equal input, different id for different scope / text / order / task, `id === index` check, `parseJobId` round trip, id length ≤ 200 for a 100-char namespace and scope.
   - `job-store.test.ts` with a fake `StorageAreaLike` (records calls, optional quota failure): `put` then `get`, concurrent `put`s on one id are applied in order, prune to 20 by `updatedAt` skipping `running`, quota error evicts the oldest non-running record then succeeds, in-memory fallback when no area, `removeLegacyCheckpoints` removes only the old prefix.
   - `errors.test.ts` / `http.test.ts`: `Retry-After: 7` → `retryAfterMs: 7000`; an HTTP-date → the positive delta; missing or garbage → undefined; `serializeAiError` carries it.
2. **Protocol and contracts.**
   - `protocol.test.ts`: `start-job` accepted with id match, refused on mismatch, non-index ids, oversized input, bad identity; `checkpoint-put` items validated per task; `checkpoint-get` / `clear` shape; `isAiClientMessage` still rejects unknown types.
   - `contracts.test.ts`: reading item dropped when tokens do not reproduce the source or a kanji token lacks a reading; blank translation dropped; both counted as missing, not `bad-response`, while at least one item is valid.
3. **Runner** (pure, fake timers, fake store, fake `execute`).
   - Planning: budgets per kind × task, `maxTokens` formulas, groups rebuilt from missing ids only.
   - Pool: with concurrency 3 and 5 groups, never more than 3 in flight; results and `job-progress` in source order even when group 3 finishes before group 2; checkpoint `put` calls are sequential and the final record holds every item.
   - Retry: 429 with `Retry-After` honored; 503 retried twice then fails; `quota` 429 not retried; API `timeout` not retried; per-job budget stops further retries across groups; cancel during backoff ends the job `cancelled` without another request; `job-retry` emitted with the delay.
   - CLI split: `timeout` halves the budget, re-plans, succeeds; at the floor or after 3 splits the job fails with the timeout error; `attempts.splits` persisted.
   - Terminal states: all accepted → `completed`; omitted ids → `incomplete` with the `incomplete` error; auth error with one group in flight → that group's result is still checkpointed, status `failed`.
   - Resume: a `running` record with 2 of 4 groups done resumes exactly the missing ids; `incomplete` / `failed` / `cancelled` records do not resume on init; a `running` record older than 10 min is marked `incomplete` on init; `resume(id)` called twice yields one job; heartbeat refreshes `updatedAt`.
4. **Gateway.** Extract `executeTask`; register runner jobs in `jobs` so keepalive covers them; handle the new messages; `attach` on a durable job replays `job-state` and resumes when needed; `start-job` for a running id attaches; `checkpoint-get` never triggers `execute`; `checkpoint-put` refused while running; `checkpoint-clear` cancels and removes; `resumeJobs()` on init removes legacy keys. Tests in `gateway.test.ts` with `FakePort`: each of those, plus the existing single-call suite unchanged.
5. **Job client.** `job-client.test.ts` with fake ports: start → progress deltas → final state resolves aligned arrays; disconnect after one delta → reconnect → `attach` → snapshot replaces local state → completes; 5 failed reconnects reject `network`; abort posts `cancel` and rejects `cancelled`; `failed` rejects with the deserialized error including `retryAfterMs`; `incomplete` resolves with gaps; checkpoint helpers do one round trip and disconnect.
6. **Runtime, language-learning, UI, bridge deletion.**
   - `language-learning.test.ts`: `translateTranscript` / `annotateJapaneseTranscript` build the instruction, call `runJob` once with `id === index` segments and the right identity, map results back, and surface `retry` in progress; no per-group tests remain here (they moved to task 3).
   - `language-learning-runtime.test.ts`: dictionary-resolved segments excluded from the job and merged back; `loadJapaneseReadings` / `loadTranscriptTranslations` return a value only for a `completed` record and never call `runTranscriptJob`; `saveJapaneseReadings` is a `checkpoint-put` on the full set; CLI timeout with `splits > 0` maps to `readerTranscriptTranslationBatchFailed`; adaptive-limit tests deleted.
   - `transcript-language-learning.test.ts`: existing progress, cancel, Continue remaining, restore-without-request, regenerate, and SPA cleanup cases pass against a fake `tools`; add the retry status text.
   - Delete `transcript-checkpoint-storage.ts` + test and the `background.ts` bridge in this commit; `grep -rn transcriptCheckpointStorage src` is empty.
7. **E2E.** `scripts/extension-e2e.mjs`:
   - Mock provider answers by task: `translate` echoes `{translations:[{id, text: 'T:' + text}]}` for the requested ids, `interpret` as today; per-request hooks for delay and a one-shot 429 with `Retry-After: 1`.
   - stopWorker test: from the settings page, `start-job` with 12 synthetic segments sized to form 3 groups; the mock answers the first request at once and delays the rest 5 s; after the first `job-progress`, call `ServiceWorker.enable` + `ServiceWorker.stopWorker({versionId})` (version from `ServiceWorker.workerVersionUpdated` for `background.js`); the page's client reconnects and attaches; assert the final `job-state` is `completed` with 12 results, that the ids of the first group appear in exactly one provider request, and that the worker target was re-listed for error collection.
   - 429 test: one `start-job` whose first request gets 429 then 200; assert two provider requests for the same ids, a `job-retry` message, and `completed`.
   - `transcript-e2e-fixture.mjs` writes `aiJob:` records (status `completed`) with a copy of cyrb53; the `=== 2` session-key assertions (`extension-e2e.mjs:375`, `firefox-e2e.mjs:226`) stay valid because the store writes nothing before a job runs. Firefox restore assertion unchanged.
8. **Docs, verify, review.**
   - AGENTS.md: seam table rows for `language-learning.ts` (prompt construction and result alignment; batching moves out), `src/ai/` (add `job-runner.ts`, `job-store.ts`, `job-client.ts`), and the invariant: "long transcripts run as one background job in bounded concurrent groups with stable ids and serialized checkpoint writes".
   - `docs/Language learning.md` `:56, :66, :70, :74-75, :109-110, :135`; `docs/development/Language learning MVP.md` `:41, :57, :80-81, :125, :132, :134, :183, :191, :250`: concurrent groups, automatic retries for 429/5xx (replacing "API requests are never retried automatically"), Reader restore through the `ai` Port, the job store, resume behavior, and a cost note that a transcript job may run concurrent and automatically retried billable requests.
   - Verify: `TZ=America/Los_Angeles npm test`, `npx tsc --noEmit --module es2020`, `npm run build`, `npm run build:cli`, `npm run build:api`, `npm run test:bundle-boundaries`, `npm run test:e2e:chrome`, `npm run test:e2e:firefox`, `git diff --check`; confirm `dist/background.js` has no DOM API and no runtime chunk; then a Fable review of the diff.

## Verification

Per task: the test file next to the module. Before each commit: the full suite with the explicit timezone, the type check, and `npm run build`. Tasks 4, 6, and 7 also run `npm run test:bundle-boundaries` and the Chrome e2e; task 6 runs the Firefox e2e. Manual smoke on an unpacked Chromium build: start a long translation, close the Reader tab, reopen it within a minute, confirm Continue resumes without re-requesting finished segments; cancel during a visible retry countdown and confirm no further provider request.

## Risks

- `ServiceWorker.stopWorker` needs a version id; if the page-level `ServiceWorker` domain does not list the extension worker, use the browser target's session. Budget half a day; if neither works, keep the test but gate it behind `E2E_STOP_WORKER=1` and note it in the plan review.
- Init-resume versus `attach` ordering in a freshly woken worker; covered by the idempotent `resume(id)` map and a gateway test.
- Serialized `put` of a whole record per group for large readings transcripts (up to ~1 MB) against the 10 MB `storage.session` quota; the eviction-on-quota rule bounds it, and a 2000-segment readings run should be measured in the e2e log.
- Behavior change: readings on CLI now split-and-retry automatically (decision 7); documented in both docs files.
- Groups overlapping after an API→CLI switch mid-run may exceed the CLI budget until the next re-plan; the CLI split absorbs it.

## Out of scope

Diagnostics ring buffer, Test probe, persisted `maxConcurrency` and `structuredOutput` on connections (Phase 5); `chrome.alarms` to wake a listener-less worker; shared action controller and the split of `transcript-language-learning.ts` (Phase 6); deletion of v1 code paths and `cli-execution.ts` (Phase 7); automatic re-request of model-omitted segments.
