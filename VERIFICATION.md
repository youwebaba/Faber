# Faber verification

These records describe observed checks, not general autonomous reliability.
Machine-local reports and screenshots are retained in the ignored
`release/verification/` folder. Original development evidence remains in source
history and the local release archive.

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
