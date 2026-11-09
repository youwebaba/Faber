# Faber

This standalone repository is `https://github.com/youwebaba/Faber`. Work from
its root; do not push the containing repository into this remote. Preserve
unrelated edits, commit only this task's verified source, fetch before pushing,
and do not force-push. Runtime data and binaries are not source files.

Keep distributable source, docs, screenshots, build metadata and reports free of
maintainer names, personal credentials and developer-machine paths. Use project-
relative paths or explicit user inputs. Preserve required third-party credits,
canonical project links and functional user data. Check release artifacts for
these categories before publication.
Write public posts in the maintainer's voice; describe the product directly in docs.
Publish each version as a separate full GitHub release with a new tag, the full
Windows installer, its SHA-256 checksum and patch notes. Keep previous tags and
assets available for rollback and for backporting individual fixes.

Faber is in closed development. Keep source, releases, installers and tester
access in the private repository. A public launch can be reconsidered at 10.0
or later with a separate release decision. Prioritize functioning core workflows,
project and credential boundaries, data recovery and an installer smoke check.
Track extended device, WAN and endurance coverage separately during closed use.

Read `ADDONS.md` before authoring a removable feature. b1 includes only local
addon management; no online addon sharing, publishing, catalog or OTA updates.

Faber is a fresh harness with a Codex-style interface and modular backbone.
This folder is independent of the
older native and pinned-Hermes developer builds. Do not apply their glass
UI or Hermes milestone requirements to this new application. Preserve their
source, launchers and runtime data.

Follow any project-memory policy supplied by the development workspace. Delegate
unified-memory reads/writes to the designated isolated GPT-6 Luna librarian. If
that facility is unavailable, report the limitation and retain a pending change
brief; never read/write the private log directly.

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
