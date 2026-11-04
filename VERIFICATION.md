# Faber verification

These records describe observed checks, not general autonomous reliability.
Machine-local reports and screenshots are retained in the ignored
`release/verification/` folder. Original development evidence remains in source
history and the local release archive.

## Alpha 2.0 — release validation

Release name: **Alpha 2.0**. Internal package/app version: `2.0.2-alpha.1`;
Windows build version: `2.0.2.0`. Release tag: `alpha-2.0`, marked prerelease.

- Post-version-change `npm test`: **502 passed, zero failed, one optional
  native-input skip (503 total)**. Receipt:
  `release/verification/alpha-2.0/source-suite.log`.
- Source `npm run smoke` passed on `2.0.2-alpha.1` with the visible **Alpha 2.0**
  label in the isolated `Faber-smoke-Zlbtw5` profile. The bridge, attachment/
  reasoning/theme/addon controls and 76-tool registry passed fixture checks;
  `live:false`. Receipt: `release/verification/alpha-2.0/source-smoke.log`.
- A `build:dir` preflight and actual unpacked `Faber.exe --smoke-package` passed
  on `2.0.2-alpha.1` in a fresh isolated profile/versioned workbench, exit 0.
  It verified bundled runner availability, the compiled Rust metadata worker
  parsing a controlled fixture, packaged Node verification and independent
  recovery; no inference was performed. Receipts:
  `release/verification/alpha-2.0/preflight-packaged-receipt.json`,
  `preflight-packaged-report.json` and `build-dir.log` under the same directory.
- Preflight archive/source checks verified code/config/vendors and runtime pins,
  excluding private profiles, credentials and generated evidence. Four release
  documents changed during finalization and are recorded as expected preflight
  drift; this is not a final installer byte-equivalence claim. Receipt:
  `release/verification/alpha-2.0/preflight-artifact-source.json`.

Installer size/hash, commit/tag and publication receipts belong to the external
release notes/evidence rather than this application-source validation record.
These checks do not establish an installed upgrade on the user's profile.
A fresh internal-version workbench retains profile/model locations and older
source bases without merging prior custom core patches. No new live-model,
LAN/editor, physical native-input/microphone or installer acceptance is claimed.

## Unreleased source roadmap — November 4, 2026

These receipts cover source work only: no version bump, installation/publication,
commit/push, or change to the running user's profile/downloads.

- Final full `npm test`: **502 passed, zero failed, one optional native-input skip
  (503 total)**. Receipt:
  `release/verification/remaining-roadmap-20261104/final-npm-test-cdp.log`.
  Coverage includes steering, target-project consent/revocation, protected profile
  paths, timeout changes/Off, version-2 checkpoint rebuilding, core-backup reuse
  integrity, gateway lifecycles and browser capture/navigation races.
- Actual Electron bootstrap/main/preload acceptance passed six isolated phases:
  legacy singleton compatibility, selected-profile/readiness/automatic Safe Mode
  and switch barriers, Off surviving restart, explicit Safe Mode, independent
  addon recovery, and corrupt-registry fail-closed startup. Inactive profile bytes
  stayed unchanged; no inference was performed. Receipt:
  `release/verification/remaining-roadmap-20261104/host-acceptance-report.json`.
- Real renderer/preload/runtime/gateway smoke passed the new controls with zero
  renderer errors or inference calls. Native profile switching/recovery actions
  in the UI test use scoped fixtures; the actual host is covered separately.
  The report and six screenshots are in
  `release/verification/remaining-roadmap-20261104/ui/roadmap-ui-report.json`
  and its folder. The coordinator visually reviewed Off, profiles and external
  access.
- Required `npm run smoke` passed on final source in the fresh isolated
  `Faber-smoke-JLAMRm` fixture. Receipt:
  `release/verification/remaining-roadmap-20261104/final-base-smoke-cdp.log`;
  retained report/images: `smoke/base-final/` under the same directory.
  The existing b2.0.1 smoke also passed: `smoke/b201/b201-smoke-report.json`.
  These synthetic/loopback checks cover the 76-tool registry, attachments,
  reasoning/theme/addon controls, settings/prompts/account picker, rich content
  and project-image/provider-vision wiring.
- Final browser proof is `browser-cdp-reviewed-final/` under that verification
  directory: `focused-browser-tests.log` (**37 passed, zero skipped/failed**),
  `browser-view-output.txt`, `view-report.json` and `browser-smoke-report.json`.
  Production retains CDP screenshot capture with a pending-navigation guard and
  same-tab detach/reconfiguration after site-driven navigation. Strict real
  Electron checks validate first-submit and first-resize PNG pixels, static idle,
  automatic page navigation, responsive layout and zoom-scaled native bounds.
  Focused regressions prevent recovery/recreation after Close, Stop or ownership
  revocation and keep queued monitors blocked until setup is ready.
  The independently reviewed browser source `desktop/browser.mjs` matches SHA256
  `1e5a04db0fc995336269c3279e29b3a7c47e09ccfc2f1a64bbd5bce71458c502`.

Earlier suite/browser prototype receipts, including `browser-fixed/` and
`browser-compositor-final/`, are diagnostic checkpoints superseded by these final
CDP receipts. Native compositor/paint-gate alternatives are not the final source.

No new live local/paid model, real LAN/editor, physical microphone/native-input
or installer acceptance is established. Context summaries remain lossy, scoped
permissions are not an OS sandbox, and external HTTP needs network protection.

## Tabbed Chromium browser — November 4, 2026 (installed local update)

The browser now uses a Codex-style right dock: compact tabs align with the
measured chat-header height, navigation/address controls sit beneath them, and
the page fills the remaining height. A draggable divider remembers its width;
the same bounded separator supports keyboard resizing while keeping the chat and
composer available. Agent screenshots follow the watched pane's actual viewport
rather than a fixed letterboxed preview. Human control mounts the same Chromium
page as a native interactive surface.

Tabs and website storage now persist separately for each chat. Explicit user
navigation/tab actions or Take over acquire human control. Browser tool reads
and actions wait until Resume browsing, then reject their old observations rather
than replay pre-takeover clicks or typing. Non-browser work and Stop chat keep
their existing behavior. Native pages hide for dialogs, library drawers, divider
dragging, other views and foreground/window guards. Ordinary page interaction
and browser-scoped shortcuts, find and page zoom use the browser's own controls.

The final preview-fix source and staged Node suites each passed **429 tests with
one optional native-input fixture skipped (430 total)**, with no failures. The
initial 16-file expansion stage passed 427 tests with one skipped (428 total). Focused
host fixtures and 21 focused UI tests cover
ownership/cancellation, session and cookie handling, stale observations, dynamic
viewports, operation-owned manual Open, address drafts during background tab
changes, stable focused library controls, same-geometry takeover attachment,
modal/viewport clipping, resize persistence, shortcut focus guards and Activity
switching. The wider UI suite passed. The installed expansion and preview
follow-up both completed the verified upgrade/backup workflow.

Real Electron fixtures passed with isolated profiles and controlled HTTP pages.
The core integration covered multiple parked tabs with fresh images, navigation,
a held lookup invalidated by concurrent resize, queued/in-flight browser calls
held during takeover, Stop releasing waits, and Resume rejecting old actions
without replay or a provider retry loop. An autonomous page change updated the
monitored image while another owned window retained foreground/document focus.
Actual PNGs reached the loopback provider image pipeline. The production-view
probe attached the same page natively, then
obtained fresh pane-sized screenshots after detaching. Modal hiding, divider
resizing, UI zoom/bounds and composer preservation passed. The baseline smoke
also passed its existing attachment, model-picker, reasoning-slider and bridge
checks with 75 registered tools.

Three fresh Electron processes verified synthetic session and expiring HttpOnly
cookies across restart, HTTP cookie delivery, logout not being revived, closed
tabs staying closed, lazy metadata restore and cross-chat isolation. The fixture
used an encrypted synthetic secret store; it did not sign into a real account.
File checks verified actual HTML FileList uploads and controlled download bytes,
identity/tab ownership, and rejection after ownership changed while a chooser
was pending. Those picker callbacks used controlled fixture paths; they do not
establish physical upload selection. Human HTTP Save As was checked separately
as described below.

A separate actual-CDP form probe selected a native HTML option with browser-local
click/keys, opened an owned target-blank tab with an explicit opener handshake,
confirmed the same chat's cookies, and denied an unsolicited popup without
creating another OS window. The final pane-filled agent screenshot was reviewed
with aligned headers and without the earlier stale-observation error banner.
These automated reports do not establish physical Windows typing or strict
pointer stability for this architecture.

Separate coordinator-operated Windows fixture checks passed human popup creation,
opener communication and child window.close, Ctrl+L/T/W with Ctrl+W closing only
the browser tab, and native HTTP Save As completing a controlled 25-byte file.
A corrected inline blob fixture also saved controlled content. Its earlier
failure was a fixture handler's URL shadowing, not a production request-filter
restriction. The physical corrected blob button opened Save As with the right
default filename, but that dialog was canceled after the automation retargeted
the parent window; physical blob save completion is **not** claimed. Strict
pointer measurement, broad website behavior and live account sign-in remain
outside these checks.

The initial installed expansion applied 16 source/test files with a backup.
An installed Resume check then exposed a Chromium race: a 1280-pixel screenshot
capture could restore old layout metrics after the pane changed to 492 pixels,
leaving a cropped preview despite matching metadata. The four-file follow-up
serializes capture and viewport changes, adds regression coverage and was applied
with its own backup after the final 430-test stage passed.

After the final Desktop shortcut restart, the coordinator observed both IANA and
Example Domain tabs restored in human-paused mode and the remembered 492-CSS-pixel
pane width. Explicit Resume produced a settled IANA preview with its logo and
vertically stacked responsive cards, without the earlier 1280-pixel crop. The
original unsent composer draft was restored exactly and never submitted; its text
was kept out of the evidence files. The browser finished in agent mode.

The read-only post-restart checker verified the merged 16 installed source hashes,
three protected file hashes, protected conversation hash, unchanged model-hub
bytes and unchanged version. Existing records remained one chat and six runs
(five completed, one canceled, none active), with four historical model-download
records. No model or inference run was started by browser verification; existing
inference services were left untouched. RMb2.0.1 remains `2.0.1-rm.beta.1`; no
installer rebuild, version bump or commit was made for this update.

Evidence is retained in `release/verification/browser-tabs-20261104/`: the source
suite and `qa/core-integration.json`, `persistence.json`, `file-transfers.json`,
`production-view-proof.json`, `agent-forms-and-popup.json`, `baseline-smoke.json`,
and the before/corrected inline-blob reports. Original and follow-up activation
records remain separate. The final source/stage logs are
`preview-source-suite.log` and `preview-installed-stage-tests.log`;
`preview-installed-post-restart.json` records the filesystem checks, and
`installed-ui-observations.json` separately records the coordinator's UI/draft
observations without draft text. Full Chrome/Edge parity, broad website
compatibility, real account sign-in, long-running browsing, strict new quiet-pointer
stability and live model vision quality are not established. No paid inference was
used by these browser checks. The earlier temporary-browser record
below is historical and does not describe the new persistence or takeover model.

## Historical: initial visible Chromium browser — November 4, 2026

This records the first temporary, screenshot-only browser. Its storage and
interaction limits were replaced by the tabbed update above; its checks remain
evidence for that earlier implementation.

The initial browser used actual sandboxed Electron Chromium pages with separate
in-memory chat sessions. The renderer showed a live screenshot preview; structured
element commands and screenshot-coordinate input used Chromium's page-local
transport. The remote page had no Node access, preload or Faber bridge.

The source baseline Electron smoke passed, including existing composer,
attachments, thinking-slider and bridge checks, and passed again after the viewer
fix. The final installed-stage Node suite passed **402 tests with one optional
native-input fixture skipped (403 total)**. The first approved browser stage passed
400 tests with one skipped (401 total). Browser fixtures cover validated URLs and
input, stale observation handles, isolated sessions and cleanup, automatic tool authority
without grant leakage, cancellation, Stop/Close during navigation, draft/focus
preservation, screenshot scaling, image decoding and post-input frame recovery.

The first stage was correctly refused after the existing synthetic transfer
progress/cancellation fixture timed out: **399 passed, one failed, one skipped**.
QA reproduced a producer timing race: it advertised 800 bytes but continued
producing during delayed partial-file setup, causing the transfer to reject
oversized input before the fixture's progress predicate. No transfer production
code or staged files were changed. The isolated staged case and unchanged full
stage then passed; a fresh stage also passed the upgrader's own full verification
before application. The unrelated fixture timing race remains and can recur.

The full browser Electron integration smoke passed against controlled local HTTP
pages. It exercised structured element and screenshot-coordinate click/type/key/
wheel operations, the actual live viewer controls and bridge, per-chat isolation,
stale-handle rejection, blocked popups/downloads, permission and native-picker
restrictions, and cancellation/close. A real PNG reached the agent registry and
loopback provider image input. This used a deterministic provider fixture, not
live model vision. The decoded viewer screenshot was visually reviewed.

A separate user-authorized quiet-input phase observed an unchanged Windows cursor
and retained focus in an independent window throughout host browser click, type,
key and wheel operations. That run later exposed the live viewer's stale-frame
race, which was fixed and covered by regression tests. The final complete viewer
run retained independent-window focus but used `strictInputMeasurement:false`
while the user moved the mouse; it does **not** establish an unchanged cursor for
the entire viewer run. The installed manual UI check did not repeat foreground
or cursor measurements. No paid inference or live model vision was tested.

The installed manual Open check found a renderer bug: the submitted URL was
mistaken for an unsent draft, preventing selection of its newly created session.
The fix tracks the explicit open's chat through creation/loading and unrelated
agent events, then releases that intent on completion or failure. Two added
regressions fail against the old code and pass with the fix. The two-file
renderer/test follow-up passed the final 403-test stage and was applied with a
separate backup. Ordinary Ctrl+R retained a cached module during this check;
the existing **Settings → Refresh interface** action bypassed the cache and
activated the verified renderer.

Eleven source/test paths were applied through the verified upgrade/backup
workflow. Profile and model-download-state bytes stayed unchanged during both
staging/application steps. After the initial restart through the Desktop shortcut,
the previously loaded Qwen model was restored to Loaded and ready with its
131072-token context setting. After the cache-bypassing interface refresh, a fresh
Close page → type `https://example.com` → Open sequence selected the calling chat
while loading, enabled Stop/Close, then showed **Example Domain**, Ready/Page loaded,
an actual rendered frame and enabled typing controls.

Finalization verified all 11 installed source hashes, the original protected
projects/chats/runs/presets/settings hash, unchanged download state and a fresh
updater reporting no restart required. Provider connection details changed during
model restoration, so whole profile bytes are not claimed unchanged across the
restart. RMb2.0.1 version numbers remain unchanged; no installer was rebuilt.

Evidence is retained in `release/verification/chromium-20261104/`: the baseline
smoke, installed stage/application records, and `qa/` browser/quiet-input reports,
viewer screenshots, first-failure diagnosis and unchanged-stage rerun. The
`installed-viewer-fix-*` records cover the follow-up, and
`installed-finalization.json` records installed hashes and explicit root-observed
UI/model proof flags. These checks do not establish general autonomous browsing
or live model vision quality.

## Download throughput and library discovery — November 4, 2026 (local update)

Transfers now batch small network chunks into bounded 1 MiB disk writes. Hashes,
length checks, cancellation and no-overwrite publication remain enforced. The
scanner uses tracked repository-relative paths to classify auxiliary files;
the DavidAU repository's MTP name no longer hides its main Q4_K_M GGUF.

The complete staged Node suite passed **384 tests with one optional native-input
fixture skipped (385 total)**. New real-disk fixtures cover chunk boundaries,
buffered cancellation/overflow, short writes, disk failures and competing targets.
Electron model-download and local-model smokes passed with isolated profiles.
The download fixture was corrected to select its current Settings category.

Six alternating 128 MiB Hugging Face range downloads from the same pinned GGUF
measured median total throughput of **148.5 → 174.6 MiB/s**; excluding request
setup, **173.1 → 215.7 MiB/s**. All ranges matched in size and SHA-256. Earlier
transport samples varied, so these short measurements do not establish sustained
full-model speed or parity with browser downloads. No transport dependency was added.

The installed workbench received the five verified source/test files through the
backup/upgrade workflow. After restarting the idle app through its Desktop shortcut,
all three model cards appeared. The recovered model's details opened and it was
selectable with Start enabled. Profile and download-state bytes stayed unchanged.
No model was re-downloaded or loaded for inference. RMb2.0.1 versions remain
unchanged; no installer was rebuilt. Local evidence is in
`release/verification/download-speed-20261104/` and
`release/verification/library-mtp-20261104/`.

## Thinking slider — November 4, 2026 (local update)

The composer brain button now opens a discrete slider with the selected level,
model name and default reset. ChatGPT account levels come from the existing
capability catalog; boolean local controls retain Default/Off/On. Selecting an
effort clears an older boolean override. Active runs, pending saves, failed saves,
and switching chats/models preserve the existing per-chat authority.

The full staged Node suite passed **373 tests with one optional native-input
fixture skipped (374 total)**. Electron baseline and b1.1 flows passed slider
preview/save/reset, native keyboard and outside dismissal, focus retention,
capability gating, and the actual bridge to a loopback Ollama fixture receiving
`think: true`. Multi-level account checks use declared fixture capabilities, not
live accounts. No live model inference or paid API calls were used.

The installed workbench received the verified renderer/test files through the
backup/upgrade workflow and its normal Refresh interface action. The same Faber
process remained open, and saved profile bytes were unchanged. RMb2.0.1 version
numbers were retained; the installer was not rebuilt. Evidence is in the ignored
`release/verification/thinking-slider-20261104/` folder.

## RMb2.0.1 — November 3, 2026

Version `2.0.1-rm.beta.1` / Windows build `2.0.1.2` moves bounded GGUF metadata
parsing to Rust, preserves the host's file guards and existing public result, and
extends the reviewed source-upgrade workflow to compile and recover Rust changes.
The UI, provider connections, orchestration, inference engine and data schema
retain their existing behavior. The following cleanup removed obsolete renderer
helpers/image drafts and redundant lookup/filename work without adding features.

The complete post-cleanup Node suite passed **371 tests with one optional native
input fixture skipped (372 total)**. Rust's three parser tests passed. Sixty-four
differential parser cases matched the previous reader's fields, warnings and byte
budgets exactly. Existing shard aggregation, malformed metadata, cancellation and
file identity checks passed. An actual Windows inherited file descriptor was
read by Rust, including repeat reads on the same descriptor. The final Windows
build links its C runtime statically; dependency inspection found only Windows
OS DLL imports, not a separately installed VC runtime requirement.

Nineteen updater tests cover source/artifact tampering, locked dependencies,
compiler/test failures, cancellation, retained executables, pointer publication,
restart pinning, older records and rollback. An isolated real Cargo build ran Rust
tests and a Node parser test, applied a compiled upgrade, then rolled it back with
a fresh manager. Source, manifest and the prior binary were restored; fixture
chat bytes stayed unchanged. A deliberately broken Rust stage failed compilation
and could not be applied. No active user profile was used by these checks.

Cleanup retained dynamic registrations and legacy history handling. All 69 UI
tests and 48 focused backend tests passed. Metadata cleanup produced exactly the
same outputs in 987 comparisons across 329 synthetic fixture sets. The retained
legacy GGUF reader is used only as a differential test oracle.

The source checkout contains OneDrive cloud reparse attributes on some older
files. A fresh source smoke therefore rejected the bundled Lightpanda files and
reported 59 tools. A byte-verified materialized build copy retained link defenses
and restored all 70 tools. Its actual Electron b2.0.1, model/addon and Thinking
smokes passed: account picker, prompts, scale, formatting, attachments, model
grid/offline Rust GGUF details, addon lifecycle, streaming and context recovery.
These are isolated deterministic fixtures, not live cloud inference, native
Recycle Bin or WSL browser tests. Screenshots were inspected.

Synthetic metadata-only benchmarks compare the frozen JS reader with the Rust
path, including process startup and host validation. Exact per-sample timings and
worker hashes are in `release/verification/RMb2.0.1/gguf-parser-benchmark.json`.
They do not establish faster inference or whole-application performance. The known
Qwen summary-retention limitation below remains outside this migration/cleanup.

The local `release/verification/RMb2.0.1/` folder records compiled-upgrade proof,
test logs, clean build inventory, packaging and artifact checks. Existing user
chats, credentials and models were not changed. The installer remains unsigned;
another PC and physical devices were not tested. Rust authoring requires the
pinned compiler and C++ build tools; normal installed use and rollback do not.

## b2.0.1 — November 3, 2026

Version `2.0.1-beta.1` / installer build `2.0.1.1` implements the quicker b2
features plus the official ChatGPT account connection and OpenAI account model
picker. Existing context/turn behavior, profiles and downloaded models are
preserved. The harder b2 features listed in README remain deferred.

The final deterministic suite passed **299 tests with one optional native-input
fixture skipped (300 total)**. Coverage includes prompt-library migration and
per-chat snapshots, active-run prompt stability, categorized settings/scale,
chat-family ordering, redacted reviewable issue drafts, safe formatting and
bounded raster images, encrypted account persistence, PKCE/state/nonce/JWT
validation, issued-client retry, refresh/logout races, model capability gating,
and namespaced tool/reasoning replay through the runtime. Independent review
found and fixed cancellation during credential persistence and incomplete
terminal-refresh-error handling. Canceling reauthorization retains the previous
session; temporary network failures do not erase usable credentials.

The actual Electron renderer/preload/host passed baseline and b2.0.1 fixture
checks: Edit → Settings, seven categories, persisted whole-UI zoom, prompt editor
and snapshot behavior, quick start and disabled Claude, Start/Stop icons,
account-picker context/effort selection, editable bug report, safe rich text
under the production CSP, and images_show from a project file through the tool
loop into both chat output and provider vision input. Screenshots were visually
reviewed. Account-picker populated-state tests use explicit fixture metadata;
no model access or context limits are inferred from those test values.

The existing b1.2 activity/model smoke also passed: live chronological tool
batches, inline approval, retained disclosures, reader scroll position, managed
model names, Stop, child/continuation placement and interface refresh. No paid
inference requests were made. Image-file/path tests include traversal and
junction rejection; unsupported remote images and executable HTML remain inert.

During final work, the user disabled OneDrive Desktop backup and moved the
workspace to the local Desktop. Source and Git history were verified after
arrival. A disposable local build copy passed the full suite and the pinned
local-model and Lightpanda runtime integrity checks. This avoids interpreting
transient OneDrive placeholder directory entries as runtime links. No integrity
check was weakened and no installed profile was used for these checks.

Real ChatGPT browser consent, account entitlements, catalog and live subscription
inference remain unverified. Voice, native input, live GPU inference and a fresh
live Lightpanda run were not repeated for this release. The installer remains
unsigned. The dependency audit reports 15 moderate findings in existing build
dependencies, with no high/critical findings and no finding for the new pinned
Markdown lexer; no forced dependency upgrades were applied. The editable report
redactor is best-effort and requires the user to review the public issue draft.
Package-level verification reports are kept beside the installer under the
ignored release/verification/b2.0.1 directory.

## b1.2rc — November 2, 2026

Version `1.2.0-rc.2` / installer build `1.2.0.2` adds chronological live tool
activity, detected local model names, automatic shipped-Lightpanda lifecycle
and the `system_time` read tool. Context and turn limits remain removed.

The complete deterministic suite passed **251 checks with one optional
native-input fixture skipped (252 total)**. New coverage includes tool-batch
correlation and legacy histories, stable continuation/child placement, exact
provider-to-model naming across Stop/restart, actual PC-clock values, narrow
automatic tool authority with no grant leakage, cancellation before WSL import,
exclusive browser ownership/idle cleanup, and preservation of disabled, removed
or customized addons during a verified factory upgrade. Empty or whitespace-only
final answers now fail with an actionable retry message and retain reported
token usage; tool-only turns still execute and continue normally.

The baseline Electron smoke passed with 69 registered tools. The b1.2rc smoke
used the real renderer/preload/host bridge and deterministic loopback providers.
It checked scanner-derived Qwen labels with unchanged API aliases, two live tool
batches between replies, inline approval, retained disclosure nodes, top/middle
reader scroll positions, absence of duplicate tool cards, child/continuation
placement and chronology after interface refresh. Captured frames were visually
reviewed. This is UI/protocol evidence, not a live model-quality benchmark.

An isolated real Lightpanda 1.0.2 runtime passed automatic first-use setup and
navigation, typing, clicking, reading and evaluation with **zero approval
prompts**. A second chat received a busy result without changing the first
chat's page. After the owner run ended, automatic cleanup stopped its WSL distro
after about 32 seconds; another chat then restarted and acquired it automatically.
Disable stopped the owned runtime, uninstall removed it, and restart preserved
the removal. Existing distros were untouched; the temporary owned distro was
removed after verification. No inference requests were made.

The first b1.2rc installer was also applied to the user's actual installation.
All 24 selected profile files were byte-identical before first launch, all 77
original chat messages remained unchanged after live checks, and both downloaded
model files retained their sizes and timestamps. The real Qwen3.5 9B Q8 model
loaded on the RTX 5070 with a 16K context. Current time, automatic Lightpanda
navigation/idle shutdown/restart, model labels, usage/TPS, thinking controls and
sidebar Force stop were exercised in a new test chat. Default model thinking
produced two empty final replies after successful tools; thinking off produced
visible answers. The blank-reply handling fix prompted the internal rc.2 rebuild
while the displayed release remains b1.2rc. The new internal version seeds a new
workbench without overwriting any edited rc.1 source. Final rebuilt-artifact and
installer checks are recorded beside the artifact in `release/verification/b1.2rc/`.

Lightpanda 1.0.2 allows only one browsing chat at a time. WSL2 must already work;
this release does not enable Windows features or reboot the PC. Cloud inference,
voice/native input and broad website compatibility were not tested in this
release. The installer remains unsigned.

## b1.1 — November 2, 2026

### Transparent-logo rebuild

The user-approved SVG originals now supply the UI, transparent PNG compatibility
assets and seven-size Windows icon. Only the black background rectangles were
removed; the orange paths retain their original geometry and use a subtle shadow.
Application and installer versions remain `1.1.0-beta.1` / `1.1.0.1`.

The rebuilt source suite passed **228 checks with one optional native-input
fixture skipped (229 total)**, and the baseline Electron smoke passed. SVG
rasterization verified transparent corners. Same-version refresh checks covered
original-file backups, customized-file preservation, repeated startup, concurrent
edits and linked directories. An isolated copy of the previous b1.1 workbench
refreshed all eight branding files while retaining its core source. Installer
build and packaged verification results are recorded separately in the local
`release/` artifact reports. The installed user session is not modified by these
checks.

### Initial b1.1 delivery

Branch `codex/b1.1-chat-controls` starts from b1 source
`e28b28961ec824fd08010cd8de56a0a179648aaf`. Implementation includes composer
context controls/TPS/thinking, sidebar lifecycle menus, inline activity,
Lightpanda, supplied logos and current-source Faber branding. A single internal
legacy-profile lookup remains with the user's explicit approval. Existing data
is reused in place; the active installed application was left running.

The complete deterministic suite passed **223 checks with one optional native-input
fixture skipped (224 total)**. Coverage includes full-history and over-100-turn
retention, image-byte exclusion from estimates, whole-tree archive/cancellation,
deleted/moved targets during approval, requested-versus-loaded capacity, edited
endpoint ownership, template-declared thinking, addon lifecycle and profile
compatibility.

Both the baseline Electron smoke and the final b1.1 desktop smoke passed through
the actual `faber://` renderer/preload/host bridge with isolated profiles. The
baseline exposed 68 tools and checked attachments, extension actions and themes.
The b1.1 check exercised context/thinking request parameters, live/reported TPS,
command approval and results, scoped parent/child Force stop, moves to existing
and new projects, archive, exact delete target/Cancel confirmation, retained
workspace files and drafts across refresh. Keyboard disclosure, Shift+F10,
Escape/focus restoration and outside dismissal passed. Supplied-logo frames were
inspected in both themes. Reports:
`release/verification/b1.1/ui-report.json` and `baseline-ui-report.json`.

### Actual local model capacity

The bundled llama.cpp runner loaded a temporary hard link to the existing
3,825,807,040-byte 7B/Q4_0 GGUF into one requested 1,024-token slot, confirmed by
authenticated `/props`. All 33 layers were observed on CUDA0 (RTX 5070), with a
5,270 ms load. A mismatched chat context was rejected before adding a message or
generating. One direct loopback request reported 37 input and 12 output tokens.
The model did not follow the exact requested word; this proves inference and
capacity handling, not reasoning or reliable tool use.

Total GPU memory changed from 1,563 to 5,901 MiB and returned to 1,561 MiB; these
readings include other apps. Stop exited the process and removed the temporary
key/hard link. The original model's size, inode and modification time were
unchanged. No weights were downloaded or paid model calls made. Evidence:
`release/verification/b1.1/local-context-report.json`.

A prior 4,096-token request correctly failed because this runner reported an
actual 2,048-token slot for that model. The check did not override its training
capacity. Thinking behavior of a real reasoning-capable GGUF was not tested;
template detection and request encoding use deterministic fixtures.

### Actual Lightpanda browser

Lightpanda 1.0.2 ran through its dedicated WSL2 distribution using the bundled
Ubuntu Base and pinned browser payload. The actual addon manager performed setup,
verified the Lightpanda-specific CDP domain, navigated/read a controlled page,
typed into a field, clicked, and evaluated page JavaScript. Disable stopped the
owned runtime; Uninstall removed the ownership-verified distribution. Restart
did not reinstall the removed addon. Normal browser profiles/cookies and unrelated
WSL distributions were untouched. Evidence:
`release/verification/b1.1/lightpanda-report.json`.

### Packaging limits

The user's installed Faber session was active, so this release's NSIS install/
upgrade was not run against that live installation. Build, exact artifact hashes,
packaged checks and isolated profile/workbench retention results are recorded
separately in `release/artifact-report-b1.1.json`. This avoids changing packaged
source to insert its own build result. The isolated checks remain distinct from
the actual b1 installer sequence recorded below.

## b1.0 baseline

Source `e28b28961ec824fd08010cd8de56a0a179648aaf` was delivered on
`codex/b1-local-desktop`. Its final suite passed 189 checks with one optional
native-input fixture skipped (190 total). Desktop checks covered local addons,
hardware selections, grid/details UI and fixture model recycling.

The packaged application bootstrapped into an editable workbench, exposed the
shared tools, ran staged checks with embedded Node and recovered after an
intentionally broken isolated workbench. Actual GPU inference loaded the existing
7B model with 33/33 CUDA layers; Stop released its owned process and temporary
files. Those results do not establish other GPUs or model quality.

Actual isolated NSIS checks passed b1 install → beta.2 fixture upgrade → b1
rollback → uninstall. Project/chat records, an encrypted fake key, an addon,
external fixture model folder and the older workbench survived. Test-owned
registration and shortcuts were removed. The beta.2 fixture changed version
metadata with the same data schema; later schema changes need separate checks.
Baseline reports are retained directly under `release/verification/`.

The b1 installer is retained as `release/Faber-Setup-b1.0-x64.exe`,
712,849,381 bytes, SHA256
`909201adda6c72b964afb3542f0be4e38a9d36fee6076c7ead3b6e38facf8348`.

## Remaining limits

- Windows installers are unsigned. No clean alternate-PC, multi-GPU, AMD/Intel
  or Vulkan inference campaign was performed.
- Paid API inference, a real thinking-capable GGUF, physical microphone,
  clipboard/native-input devices and broad accessibility/soak testing were not
  established by this release's fixture checks.
- Full history remains uncapped by Faber's former context/turn budgets. Provider
  limits and the existing run timeout still apply. Usage estimates are labeled;
  they are not billing or fit guarantees.
- Trusted addon/shell code has the user's host authority. Lightpanda's separate
  profile/runtime does not make arbitrary addons safe. Online addon sharing and
  OTA updates are not implemented.
- Canceling work cannot undo effects already started. A blocked synchronous host
  extension may require closing the app; a remote API may continue computing.

## November 3, 2026 — b2.0.1 response/context fixes

359 deterministic tests: 358 passed, one optional native-input test skipped, zero
failures. Added indexed/revised Responses fixtures, context checkpoint chunking,
whole-tool-group preservation, restart durability, bounded overflow recovery,
summary cancellation and no repeated tool execution.

Isolated Electron --smoke-thinking passed pulsing Thinking, reduced motion,
public progress, canonical live replacement, first-visible-token timing tooltip,
average TPS labeling, failed automatic-summary recovery through Compact &
continue, full visible history retention, and no extra Continue user message.
Base npm run smoke passed the bridge, attachments, model picker and 70-tool
registry. Screenshots were visually reviewed. All inference was deterministic
loopback/fixture traffic; no paid or live account/local-model inference was run.
Summaries remain lossy and token estimates approximate; native provider limits
still apply. Version remains 2.0.1-beta.1.

Installed-copy activation also passed the updater's complete staged test suite
(358 passed, one optional skip). The idle app was restarted through the existing
Desktop shortcut. The updated renderer, current conversations and ChatGPT
selection were visible; the entire saved state was unchanged against its backup.
The installed workbench retains a source rollback backup. No installer rebuild,
version bump, commit, push or real provider inference was part of this patch.

## Live local Qwen context recovery — November 3, 2026

Actual installed b2.0.1, Qwen3.5-9B-OBLITERATED Q8_0, bundled llama.cpp,
70 tools, thinking off. The smallest 4096 preset failed preflight because the
system/tool envelope alone did not fit; no provider call was attempted at 4k.
At 16384, a normal reply succeeded (7784 input tokens). A synthetic token-dense
archive produced native HTTP 400 context rejection. With a short follow-up,
Faber recovered from a 23,310-token request: a real Qwen summary used 15,720 input
tokens and the retry completed with 7,908 input tokens.

Mechanical recovery passed, but required fact retention FAILED: the expected
reply was RECOVERED HARBOR-7261; the actual reply was RECOVERED. Qwen returned
ARCHIVE_RECEIVED as its summary, obeying an archival reply instruction. The
harness accepted that nonempty, in-budget text and lost the code from its working
context. All original test messages and existing chats were preserved exactly.
The test model was stopped afterward; the test chat remains available. No cloud
calls or tool effects occurred, and implementation/version were not changed.
Evidence: release/verification/qwen-context-live-20261103/report.json and
4k-baseline.json (local release evidence, not source). This test does not
establish other models, repeated compaction, or completed-tool replay safety.
