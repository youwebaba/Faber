# Sophia Harness

Bill's October 31, 2026 instruction for this application is a fresh harness,
Codex-style interface and modular backbone. This folder is independent of the
older native Sophia and pinned-Hermes developer build. Do not apply their glass
UI or Hermes milestone requirements to this new application. Preserve their
source, launchers and runtime data.

All parent project-memory requirements still apply. Delegate unified-memory
reads/writes to the required isolated GPT-6 Luna librarian. If that facility is
unavailable to an agent running inside this harness, report the limitation and
retain a pending change brief; never read/write the private log directly.

Read `CONTRACT.md`, `README.md` and the relevant modules before making changes.
The Electron host owns OS/credential access, the core owns run and approval
authority, and the renderer uses the narrow bridge. Models share one validated
tool registry. Approval resolution and authority grants remain user operations.

Local inference is the first target. Do not use a cloud fallback or paid model
requests without user authorization. Keep state, credentials, recordings,
screenshots and model files outside Git and OneDrive.

For self-upgrades requested inside the running app, stage, verify and explicitly
activate changes through the updater. Register an action when a new extension
needs a button. Preserve cancellation, backups, recovery and declared contracts.
Executable extensions and shell grants are trusted host code, not a sandbox.

Run `npm test` for changed behavior and `npm run smoke` for renderer/bridge work.
The optional `--smoke-live` and `test/core-live-smoke.mjs` checks use the actual
configured local model; keep their evidence separate from deterministic fixtures.
Native input testing uses the dedicated opt-in fixture, never an unrelated app.
Read `VERIFICATION.md` for current evidence and limits. Follow the parent Git
workflow, staging only changes for this task.
