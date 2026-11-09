# Background work and manual routines

Open **Routines** in the sidebar. Background operation and starting at Windows
sign-in are separate options, both off by default. Save **Keep working after
closing the window** to retain the worker when its last window closes. The tray
offers **Open Faber**, **Pause work**, **Resume routine queue** and **Quit Faber**.
Launching Faber normally also reconnects a visible window to the same worker.

**Close window** leaves opted-in work running. **Pause work** pauses routine
admission and stops active work; stopped jobs require an explicit resume.
**Quit Faber** stops owned work and transports, waits for final receipts and
saves, then exits. A pending approval can be answered after reopening the UI.

**Start this profile at Windows sign-in** registers the selected profile using
Electron's Windows login-item API. It starts a hidden worker in the signed-in
user's session. A later normal launch opens its UI visibly. This is a sign-in
worker; a2.6 does not install a Windows service or run work before sign-in.

## Create and review a routine

1. Choose **Create routine**. Review its project, saved connection and exact
   model, instructions, input specification, expected outputs and completion
   criteria. Choose approved tools and project-relative paths.
2. Save the revision. **Preview** runs the selected model and permitted read
   tools; privileged actions become visible proposals rather than executions.
   The chosen connection's normal API billing still applies when applicable.
3. Inspect the preview and definition, then explicitly **Enable** the routine.
4. Choose **Run manually** and provide that job's input snapshot. The queue
   retains this snapshot and definition even if the routine is edited later.
5. Inspect the job's stable ID, activity chat, observed input hashes, action
   proposals and output receipts. Use **Stop job** to cancel it.

Editing saves a new revision for future admissions and requires enabling that
revision. Already-admitted jobs retain their reviewed revision and scope.
**Disable** stops current/queued work. **Revoke permissions** also invalidates
the routine's authorization; review and save it before authorizing new work.

The queue admits one routine job at a time. Ordinary interactive chats retain
their existing concurrency controls. An idle routine makes no model calls.
There are no schedules, file triggers or automatic paid-provider fallbacks in
this milestone. The later daily folder-report routine builds on this queue.

## Scope, approvals and recovery

Each job starts a dedicated chat with its saved provider/model, tools and path
scope. It does not inherit the profile's default chat grants. A dot in approved
paths means the selected project; another project cannot be approved implicitly.
Structured file tools continue to reject path escapes, protected profile data
and writes to running application source.

The optional routine file grant permits file operations inside that scope.
Otherwise the normal run-scoped file approval applies. Allowed network, desktop,
shell and upgrade actions require operation approval; they cannot be remembered
as broader chat grants. Administrative tools are excluded. Approved shell/native
tools and executable addons still carry their normal Windows-account authority;
routine path checks are not an operating-system sandbox.

Desktop-dependent tools wait before dispatch while the UI is absent, minimized
or the Windows session is locked. Closing the UI does not invent an approval or
an interactive session. Missing models, changed connections/credentials and
revoked scope stop admission with an actionable job reason. The overall chat
run deadline and Stop remain in force.

The worker saves an action intent before dispatch and a receipt afterward.
Identical verified action requests within a job reuse their recorded result.
After a worker crash, a planned `files_write` can be reconciled against the
destination's exact byte digest. A matching file becomes a verified output;
continuation still requires review. Unconfirmed writes, sends or appends remain
**Needs attention** and are never automatically replayed.

Review the actual destination before choosing **Verified at destination** or
**Abandon job**. Verification here records the operator's decision and note;
it does not fabricate an external acknowledgement. Only then can eligible
verified work be resumed. Safe read-only interrupted attempts can be retried,
with at most three attempts. Safe Mode pauses automatic queue admission.

## Ownership and implementation contract

The Electron main process is the background worker and sole profile-state owner.
The window's sandboxed renderer is a separate UI process; closing or crashing it
does not create a second runtime. The trusted bootstrap acquires a kernel
named-pipe lock for the canonical profile before loading editable application
code. Windows releases that lock if the worker dies. The existing cross-version
Electron lock remains, so only one selected profile is active at a time.
Switching profiles restarts its worker after existing activity guards pass;
the previous profile's queued jobs remain stored there.

Routine definitions, immutable revisions and jobs are separate records in the
profile's atomic runtime state, independent of conversation compaction. Jobs
retain IDs, revision/definition, input snapshot and observed input hashes,
approved scope, step, attempts, activity run IDs, proposals, outputs and review
decisions. Credentials stay in the existing host store. Connection identity and
authorization revision are rechecked rather than silently widening access.

Host/UI bridge methods are `worker.state`, `worker.configure`,
`worker.closeWindow`, `worker.pause`, `worker.quit` and
`routines.state/save/enable/run/stop/revoke/review/resume/pause`.
These are user operations, not agent tools. `runtime.startRoutines()` admits
recovered jobs only after the desktop has registered its actual tools.

Implementation: [routine journal](core/routines.mjs),
[background host](desktop/background.mjs),
[trusted profile owner](desktop/profile-owner.cjs) and
[routine UI](renderer/routines.mjs). See
[a2.6 worker verification](docs/a2.6-worker-verification.md) for observed tests.

a2.7 adds timezone-aware schedules, stable-file triggers, shared job budgets,
the Work Inbox and a local Qwen daily folder report. These retain the same
profile owner, routine scope and action-receipt rules. See
[scheduled work](SCHEDULER.md) and [a2.7 verification](docs/a2.7-scheduler-verification.md).
