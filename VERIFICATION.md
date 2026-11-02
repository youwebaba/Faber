# Faber verification

This records observed checks, not general autonomous reliability. The historical
developer-build entries below are retained; the b1 release evidence supersedes
their source-only packaging and hardware limitations where explicitly tested.

## Faber b1.0, November 2, 2026

Work is in the standalone private Faber repository on `codex/b1-local-desktop`,
based on `50cac21172e7f4b3662ef179e9e150095fca589a`. The original Sophia checkout,
normal harness profile, model configuration and user model files were preserved.

The combined deterministic suite passed 188 checks with one optional native-input
fixture skipped (189 total) after the real GPU logging correction. Additional
addon migration regression coverage and the final packaged results are recorded
in the release evidence alongside the installer. Coverage includes shared tools,
removed context/turn budgets, images and reported usage, hardware capabilities,
safe Recycle Bin deletion/reservations, bounded offline GGUF metadata, addon
approval/lifecycle/rollback/cancellation, and editable workbench recovery.

The actual Electron feature smoke exercised local addon import/disable/enable/
uninstall, hardware selections, card grids, offline tensor metadata and a
fixture-only recycle implementation preserving sibling variants. It did not
delete a real model. Reports and reviewed frames:
`C:\Users\youwe\AppData\Local\Temp\Faber-smoke-4qncpT\faber-smoke-report.json`
and the corrected visible hardware frame in `Faber-smoke-Ll6Uyn`.

The built Faber.exe exercised ASAR bootstrap into a writable copied workbench,
57 shared tools, real native-script paths, bundled CUDA detection, staged tests
using its embedded Node (no external Node), and immutable recovery after a
deliberately broken isolated workbench. Report:
`C:\Users\youwe\AppData\Local\Temp\Faber-smoke-mKrZjJ\packaged-report.json`.
The copied-workbench suite also passed under Electron's embedded Node runtime.

A real GPU proof used only a temporary hard link to the pre-existing
3,825,807,040-byte llama2-uncensored:7b GGUF. Offline metadata reported llama,
Q4_0 and 6,738,415,616 stored tensor parameters. The bundled CUDA 13 runner
loaded in 4,897 ms with 33/33 layers verified on CUDA0 (RTX 5070). Requested
logical CPUs 0–3, four threads and mapped model memory reached the owned process.
One loopback generation returned usage of 37 input and 12 output tokens. The
model did not follow the exact requested word; this proves inference, not task
quality or reliable tool use. Total device memory changed from 1,837 to 6,702 MiB
and returned to 1,837 MiB after Stop; those totals include other applications.
The process exited, temporary key/hard link were removed, and the original file's
size, inode and modification time were unchanged. Zero model downloads or paid
API calls. Report:
`C:\Users\youwe\AppData\Local\Temp\SophiaHarness-local-live-1yx5AD\report.json`.

That proof initially caught missing placement logs: this runner emits library
information at verbosity 4 while its server defaults to 3. Supported launches
now request level 4 and retain bounded diagnostics; custom mode still requires
actual observed GPU layers/devices. The fix does not force all layers or override
the runtime's fit algorithm.

Actual isolated NSIS tests passed fresh b1 install → beta.2 fixture upgrade →
b1 rollback → uninstall. Project/chat content, an encrypted fake key, an addon,
an external fixture model directory and the older workbench survived. Registration,
test-owned shortcuts and program files were removed on uninstall. The beta.2
fixture changes version metadata with the same data schema; future schema
migrations still require their own checks. Preflight rejected a pre-existing
Faber installation/process/shortcuts; normal profile paths were never launched.
Report:
`C:\Users\youwe\AppData\Local\Temp\Faber-installer-proof-11a0b88e72c949cf93d18c5fef1ae8f0\installer-proof.json`.
Final artifact hashes and the repeated final installer proof are stored in the
ignored `release/artifact-report.json`, outside the self-referential build inputs.

The Windows x64 beta is unsigned. CPU/CUDA/Vulkan binaries and their notices are
pinned and checked by the runtime manifest; actual inference was tested only on
the stated NVIDIA GPU/model. AMD/Intel/Vulkan, multi-GPU, large Qwen models,
physical microphone/clipboard/native input, clean alternate Windows machines and
paid cloud inference were not re-tested for b1. No online addon sharing or OTA
was built. Trusted addon/shell code is not sandboxed.

## Initial environment checks

- Windows host has Node.js 24.20.0, an NVIDIA RTX 5070 with 12 GB VRAM, and Ollama
  0.40.10. Cached model manifests include `qwen3.5:9b` and
  `llama2-uncensored:7b`; no model was downloaded.
- The usual local inference endpoints were initially offline. The coordinator
  started the existing Ollama executable on loopback for local verification.
- The older Sophia repository contained unrelated modified/untracked files.
  This work is restricted to the new `harness/` folder.

## Core milestone

The final core suite has 19 passing deterministic tests covering provider
protocols, schema validation, tool dispatch, approvals, run-tree cancellation,
queued messages, context bounds and restart recovery. Fixtures use fake model
responses where deterministic behavior is required. Windows sandboxed temporary
file renames initially failed with EPERM; the same atomic-write checks passed
outside that sandbox.

The opt-in `node test/core-live-smoke.mjs` passed on the first run against the
actual local `qwen3.5:9b`, at 20:55:11–20:55:19 EDT on October 31, 2026:

- The model called `project_list` and `files_read` against an isolated fixture.
- It called `agent_create` and `agent_wait`; the child called `files_read`.
- It called `shell_run` for `Write-Output HARNESS_SHELL_READY` under an explicit
  fixture-only shell grant.
- Four completed runs and their tool evidence were checked in persisted state.

That smoke exposed 18 tools at the time; later model/voice wrappers were checked
deterministically. It does not establish behavior with every installed extension
or arbitrary user tasks. No cloud requests, paid inference or model downloads
were used. Successful fixture data was removed; failures retain evidence.

## Integrated checks

| Check | Observed result and limit |
| --- | --- |
| Final combined Node suite | Coordinator ran 40 tests: 39 passed, zero failed, one opt-in native fixture skipped. Includes 19 core, 13 desktop and seven UI tests. |
| Actual renderer | Real Electron 45.2.1 loaded the sandboxed renderer and narrow bridge. DOM navigation selected a chat, model picker opened, all 37 built-in tools appeared, themes changed, and Node was unavailable to the page. |
| Real local UI/model loop | DOM composer submission reached local Qwen, executed `project_list` and `files_read`, and rendered the fixture's exact text. GUI Stop canceled a subsequent actual generation. The final report records completed tool events and the canceled run. |
| Extension UI | A bundled, inert extension registered a real tool and an action form; the form invoked the tool successfully. Unit fixtures separately covered trust approval, persisted source digests, incompatible/tampered versions, removal, failure preservation and concurrent installations. The UI smoke uses fixture approval, not a claim of manual native-dialog acceptance. |
| Upgrade/recovery | Real staged Node tests, failed-test rejection, baseline/stage integrity, cancellation after confirmation, partial-write recovery, concurrent operations and rollback using a fresh manager passed in temporary fixture trees. User data survived. These were controlled source fixtures, not an upgrade applied to the installed app. |
| Actual Windows input | The opt-in native fixture separately passed discovery, focus, literal Unicode/special-character typing, Backspace, targeted click, bounds rejection and screenshot capture in an owned window. Arbitrary/elevated apps and general shortcut compatibility were not established. |
| Speech | The actual Windows helper reported two installed recognizers and `listening: false`. Phrase routing and lifecycle logic were checked; physical microphone recognition and audible TTS were not tested. |
| Source and secrets | Work is confined to `harness/`; dependencies and private state are excluded from Git. Provider protocol tests use fake credentials; no real cloud key or paid inference was used. |

The coordinator inspected the real dark/light frames. Final live report and
frames are under the PC-local temporary directory
`C:\Users\youwe\AppData\Local\Temp\SophiaHarness-smoke-uUkh3t`:
`smoke-report.json`, `smoke-dark.png`, `smoke-light.png`.
The completed live run is `afb3ddf2-75aa-4c64-99ba-6ddf10bf99b8`; the GUI-canceled
run is `f2e4b9ab-def9-46ff-91c8-a5e47d2359e9`. Earlier passing live evidence is in
`SophiaHarness-smoke-U6n4eb`. These private test artifacts are not committed.

One intermediate live trial skipped the explicitly required `project_list` call
and correctly failed the smoke assertion. The final run used an ordered,
explicit two-tool instruction and passed. This is evidence of local-model
variability; do not interpret a completed run as proof that every requested
step was performed. Tool evidence remains visible for review.

Focused review also found and fixed a concurrent extension ledger/registry
mismatch, incomplete interrupted tool-call history, stale extension metadata,
late cancellation effects, and Electron's ESM readiness cycle. No failed check
was relabeled as a pass. The final integrated behavior was checked after the
relevant fixes.

## Hugging Face feature checks

Bill requested the model browser/download feature later on October 31, 2026.
It adds six shared agent tools, bringing the built-in registry to 43. The
final combined Node suite passed 62 tests, with zero failures and one optional
native-input fixture skipped (63 total). Focused Hub coverage includes 17
passing tests, including opening an empty configured download folder. The
coordinator reran the baseline Electron smoke after integration: tool registry,
extension action, themes and the renderer bridge passed with no Node exposure.
That report is in `C:\Users\youwe\AppData\Local\Temp\SophiaHarness-smoke-Xbc33c`.

The integration agent's controlled `npm run smoke:models` used the real
Electron UI, manager and disk writes with synthetic Hub responses. Its final
report and browser/progress/library/Settings frames are in
`C:\Users\youwe\AppData\Local\Temp\SophiaHarness-smoke-3ZcJP3`.
The coordinator and UI agent inspected rendered frames. Verified flows include:

- Search, file details, parameter/size/VRAM labels and pinned revisions.
- Explicit file selection, streamed progress/speed and on-disk SHA-256.
- GUI cancellation without publishing an incomplete file.
- Saved destination and preserved search, Settings and composer drafts.
- All six `hf_*` tools in the actual shared runtime, permission denial/allow,
  fixed-destination file approval and AI status/cancellation of the same jobs.

The sole live binary transfer used the actual manager with public Hugging Face
search/details and `hf-internal-testing/tiny-random-gpt2`, pinned to
`71034c5d8bde858ff824298bdedc65515b97d2b9`. Its `model.safetensors` completed at
453,864 bytes with matching SHA-256
`8111d5afb0715dbf5a31396d31432cb56370ba23f6650a035ea0fc8a20b4e500`.
Evidence: `C:\Users\youwe\AppData\Local\Temp\SophiaHarness-hf-live-A3nUw1\live-model-download-report.json`.
The initial live search failed on unsupported `expand[]=id`; the field was
removed, a regression assertion added, and the actual download then passed.

The coordinator used Settings' Restart app action on the idle normal instance.
The new process retained the four existing user chats and the current local
model, then displayed 30 actual public Hub results in the new Models screen.
This checked the normal desktop activation as well as the isolated test app.

No large model, real gated credential or newly downloaded model inference was
tested. The existing provider and paused Qwen 27B files were untouched. VRAM
estimates use a stated heuristic and do not guarantee a fit. Publication checks
hard-link support before transferring; exFAT/FAT destinations are unsupported.
There is no partial-transfer resume. Graceful cancellation cleans up temporary
bytes; an abrupt process/OS crash can leave a hidden `.partial` file, and the
restarted job reports it as interrupted.

## Quantization and cloud connection checks

Bill requested selectable quantization levels and per-chat cloud APIs on October
31, 2026. The final combined suite passed 79 tests with zero failures and one
optional native-input fixture skipped (80 total). Focused coverage includes 29
core, 21 Hub and 14 UI tests. The coordinator also reran the baseline Electron
smoke: all 43 tools, extension action, themes and renderer isolation passed.
Its report is in `C:\Users\youwe\AppData\Local\Temp\SophiaHarness-smoke-IOUTZX`.

The final `npm run smoke:features` used the actual Electron renderer, encrypted
host credential store, Responses HTTP/SSE adapter and downloader with isolated
loopback/API fixtures. Report and normal/compact frames are in
`C:\Users\youwe\AppData\Local\Temp\SophiaHarness-smoke-Ocygza`.
The coordinator and UI agent inspected rendered frames. Verified flows include:

- OpenAI Responses preset, Astra/Sol model suggestions, reasoning effort, model
  listing, and explicit per-chat selection. Saving alone did not switch chats.
- Four actual loopback Responses requests through `project_list`, GUI-approved
  `upgrade_stage`, and `upgrade_verify` with an actual staged Node test. The
  temporary source remained unchanged; no upgrade was applied to the checkout.
- Exact opaque reasoning/output replay, malformed/incomplete stream rejection,
  duplicate tool-call protection, credential-origin and concurrent-edit guards.
- Grouped nominal-bit quantizations, distinct identities for models with the
  same encoding, incomplete-shard rejection, and manual-file fallback.
- GUI selection of Q4_K_M downloaded exactly two 32,768-byte fixture shards,
  with progress/speed and matching disk hashes. Other variants and auxiliaries
  were not transferred.

A read-only live Hub inspection of
`ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF`, pinned to
`ed59f92082b1e93c0e96d60a8b11aab089b52f09`, returned 21 files and four complete
catalogued variants. The two-shard IQ2_XS variant totaled 68,026,093,024 bytes;
one auxiliary file was excluded. No weights were downloaded. Report:
`C:\Users\youwe\AppData\Local\Temp\SophiaHarness-quant-metadata-UY5mVi\quantization-metadata-report.json`.

The coordinator restarted the idle normal app through Settings. All four chats
and the current local Qwen connection remained present; the new composer label
and cloud connection picker were visible. No real cloud credential or provider
switch was made. Paid cloud inference and large model transfers remain untested.
Quantization names are inferred from published filenames, not verified against
binary tensor headers; bit-depth groups and VRAM estimates are approximate.

## Removal of harness context and turn limits

Bill requested removal after a cloud run hit the application's context-budget
error. This supersedes the earlier character-budget behavior described above.
The former 36,000-character budget, message-history trimming, content clipping
and 24-turn default cutoff were removed. Saved `contextChars`, `contextMessages`
and `maxTurns` are deleted during startup, and settings updates reject them.
Ollama requests no longer impose the harness's former `num_ctx: 16384` override.

The focused core suite passed 33 tests. The coordinator's complete suite passed
83 tests, with zero failures and one optional native-input fixture skipped
(84 total). Synthetic wire-body checks cover all three adapters with over 100
historical messages and over 500 KB of retained context, large tool schemas,
arguments, results and opaque reasoning. A run completed 105 tool calls plus
its final response; Stop canceled a subsequent continuing loop. Legacy settings
were removed from disk after reopening. Existing timeout, approval, image and
credential checks also passed. Independent integration review found no hidden
desktop/renderer context or turn enforcement.

The coordinator restarted the idle normal app through Settings and verified
that all four chats and the selected OpenAI / `gpt-6.1-sol` connection remained.
The previous failed run remains in history; it was not automatically resumed.
No live model request or paid API inference was used for this verification.
Provider-native limits, the existing wall-clock timeout, image/transport/tool
resource checks and agent depth/concurrency limits remain in effect.

## Inspection history, per-call usage and pasted images

Bill requested these changes on October 31, 2026, explicitly preserving the
removal of context and turn cutoffs. The final Node suite passed 101 tests with
zero failures and one optional native-input fixture skipped (102 total).
The baseline Electron smoke passed all 43 tools, extension actions, themes and
renderer isolation in
`C:\Users\youwe\AppData\Local\Temp\SophiaHarness-smoke-NFHjA0`.

Deterministic regressions cover saved recursive `chat_read`, `agent_read` and
`agent_wait` results. Each legacy inspection snapshot becomes a small reference
in model input, while disk contents, ordinary text/tool results and actual opaque
Responses continuation remain exact. New inspection indexes expose explicit
message/result selectors and cannot recursively expand inspection outputs.
Selected screenshots do not become base64 transcript text. A requested agent
run's final reply cannot be substituted with a later run's reply. Existing
large-history and 105-tool-turn checks still pass without harness context caps.

All three provider adapters were checked for native user-image encoding,
image-only messages, retained historical images and durable per-call usage.
Fixtures cover missing usage, reported zero, duplicate usage frames, canceled
and HTTP-failed calls, restart interruption, failed/incomplete Responses and
the final Chat Completions usage chunk after an output-length error. Failed
responses do not dispatch pending tools. Invalid attachment encoding/signatures
and aggregate/count limits are rejected before chat/run mutation.

The combined `npm run smoke:features` passed against isolated loopback fixtures
using the actual Electron renderer, IPC and Responses adapter. Report and frames:
`C:\Users\youwe\AppData\Local\Temp\SophiaHarness-smoke-2Agro4\features-smoke-report.json`.
Four successive tool-loop requests displayed distinct input/output/cache/reasoning
counts. Synthetic clipboard events exercised image previews/removal, image-only
sending, persisted image rendering, text/image draft preservation after a
rejected send, and chat/project switching. The image request arrived on the
fixture's real HTTP wire and displayed its reported 1,005 input / 25 output
tokens. The coordinator inspected the draft and reply/usage frames. Existing
quantization download and staged-upgrade checks also passed.

The coordinator restarted the idle normal application through Settings after
observing an empty composer. All five existing chats and the selected Local
Ollama / `qwen3.5:9b` connection remained visible. The new image-paste prompt and
Token usage section were present, including honest Not reported counts for an
existing failed call. No conversation was sent or resumed during activation.

Smoke-test token counts are controlled fixture values, not paid API measurements. No live
model inference, actual OS clipboard contents, microphone, large-image decoding
or broad accessibility campaign was used. Image validation checks canonical
encoding and file signatures, not complete image decoding. Providers/models
must support vision. Historical usage cannot be reconstructed; previously saved
recursive tool outputs remain in the durable transcript for inspection.

## Local model dropdown and lifecycle controls

Bill requested Start/Stop controls and a dropdown populated from the configured
download folder on November 1, 2026. The final combined Node suite passed 132
tests with zero failures and one optional native-input test skipped (133 total).
Coverage includes recursive GGUF discovery, original shard grouping, incomplete
downloads, filesystem links, installed Ollama load/unload, process readiness,
cancellation, secret redaction, active-run guards, close/start races and upgrade
inventory. Duplicate connections to the same Ollama endpoint/model share lifecycle
guards. A running model remains available to Stop after its folder or file changes.

The baseline Electron smoke passed with all 46 tools, existing attachment flows,
extension action, themes and renderer isolation. Report:
`C:\Users\youwe\AppData\Local\Temp\SophiaHarness-smoke-UjcdOE\smoke-report.json`.
Its pre-existing cleanup assertion was corrected to compare the effective model
label when a chat inherits its provider's default, while preserving stored-value
assertions and the original error if cleanup also fails.

The isolated `--smoke-local-models` desktop check passed the actual dropdown,
Start/readiness, explicit Use, reopening, Stop, cancellation during loading,
failure display and removal of temporary credential files. Three controlled
child processes exited. Report and inspected 1100 by 760 frames are in
`C:\Users\youwe\AppData\Local\Temp\SophiaHarness-smoke-9TpQb5`.
This uses a synthetic local server, not model inference. Initial fixture-layout
and asynchronous UI-timing failures were fixed before the passing run. The
picker footer remains visible while the form scrolls.

Separately, `node test/desktop-local-models-live.mjs --allow-existing-local-load`
loaded the existing 3,825,807,040-byte `llama2-uncensored:7b` GGUF through the
installed standalone llama.cpp server in 4,033 ms. The check authenticated the
model listing, then verified Stop exited the process and removed the key file.
It used a temporary hard link, preserved the original file's metadata, and made
zero inference requests and zero downloads. Report:
`C:\Users\youwe\AppData\Local\Temp\SophiaHarness-local-live-8BFxrS\report.json`.

The coordinator restarted the idle normal app through Settings after observing
an empty composer. Six existing chats and Local Ollama / `qwen3.5:9b` remained.
The new controls read the actual configured downloads folder, currently empty,
and display the offline Ollama model as not checked with Start available. No
normal-app conversation was sent, resumed or switched for verification.

Direct file loading currently supports GGUF, including complete original shard
sets. Safetensors and separate vision projectors are not loaded. Header discovery
does not prove full-file integrity, architecture support or memory fit. Actual
generation with newly loaded weights, real Ollama lifecycle operations and a
hard-crash cleanup guarantee were not established by these checks. Ordinary Stop
and app close manage the owned process; an abrupt host/OS crash may leave it alive.

## Interface updates without a desktop restart

Bill requested applying updates without restarting on November 2, 2026.
Renderer-only upgrades and rollbacks now request an interface refresh. Backend
source changes still require a restart; the updater compares those files with
its startup baseline before permitting a refresh. Approved extension tools and
actions retain their existing live activation path.

The combined Node suite passed 151 tests with zero failures and one optional
native-input fixture skipped (152 total). New coverage checks update
classification, mixed/backend drift, busy mutations, callback failures, rollback,
strict handoff validation, unchanged chat transport limits, draft restoration,
pending attachment reads, deferred refresh and stream/state ordering. Transient
stream text and revisions are absent from persisted state and model input.

The baseline `npm run smoke` passed all 46 tools, attachment flows, extension
action, themes and renderer isolation. Report:
`C:\Users\youwe\AppData\Local\Temp\SophiaHarness-smoke-6OfXlB\smoke-report.json`.

The controlled `--smoke-ui-reload` exercised real Electron navigation and actual
stage/verify/apply/rollback against a copied source fixture. The host PID, active
chat run, local child process and download job remained the same. Download bytes
continued increasing. Two chats retained their text, PNG and UTF-8 file drafts;
the drafts were absent from persisted runtime state. A response chunk emitted
during navigation appeared exactly once between the pre-refresh and later chunks.
Both changed HTML and a changed JavaScript module loaded after apply and reverted
after rollback. A backend source change rejected manual interface refresh and
preserved the existing drafts. Report and inspected frame:
`C:\Users\youwe\AppData\Local\Temp\SophiaHarness-smoke-yRZlht\ui-reload-smoke-report.json`
and `ui-reloaded-drafts.png` in the same directory.

The normal app was closed at activation time. The coordinator launched the
updated host, then used Settings' Refresh interface action through native UI
automation. The same host PID (33628) and window remained, the interface reported
successful restoration, and the exact temporary unsent composer text returned.
The test draft was then removed without sending it. The selected chat and Local
Ollama / `qwen3.5:9b` connection remained selected. No user conversation was resumed
and no production source upgrade was staged or applied during this check.

Those are controlled loopback responses, synthetic transfers and a local fixture
process, not paid API calls or real model inference. Physical voice and native
clipboard/file-chooser interactions were not exercised. Draft handoff is held
only in desktop memory until the refreshed page acknowledges restoration; a full
host exit or crash loses that temporary backup. A broken or incompatible new
renderer may leave a handoff pending for recovery. Backend hot replacement and
automatic source-file watching are not implemented.

## Remaining limits

- Physical microphone/wake phrase/audio quality and live cloud provider calls
  remain unverified. No broad accessibility, multi-monitor or long-running soak
  campaign was performed.
- Full history is sent without a harness context/turn budget. Provider context
  capacity still applies; long histories can increase API usage. The existing
  wall-clock timeout remains. Models can omit requested steps; test outcomes.
- Shell and executable extensions have the user's Windows authority. Modularity
  and the renderer sandbox do not isolate trusted host extensions or shell code.
- Unapplied upgrade stages last for the current session. Rollback persists, but
  the standalone recovery command requires the app to be closed. Dependencies,
  launchers and the recovery entry use the normal development workflow.
- The b1 installer is unsigned; the older native Sophia/Hermes data and deployment
  were not migrated. Its historical harness profile remains at `SophiaHarness`.
