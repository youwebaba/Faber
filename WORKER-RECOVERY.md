# Boot work, backups and installer recovery

Open **Work Inbox → Before Windows sign-in**. Boot work is a separate opt-in
from keeping the signed-in worker running and starting it at sign-in. First
review an eligible routine's boot access, including a bounded CPU thread count.
Then register the reviewed boot work from the packaged Windows application.
Disabling the policy prevents boot execution even if Windows refuses task
removal. No Windows task is registered by ordinary startup or by smoke tests.

The Windows adapter uses an S4U task under the selected ordinary user's SID
with LeastPrivilege, a boot trigger and no stored password. Windows documents
S4U as noninteractive and without network or encrypted-file access; this does
not provide an interactive desktop or usable account credentials.
[Microsoft logon types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type),
[boot triggers](https://learn.microsoft.com/en-us/windows/win32/taskschd/boottrigger).
Windows registration permissions and batch logon rights must already allow
the task. Faber does not substitute SYSTEM, save a password or change those
rights when registration fails. Battery power defers this boot task.

## Eligible work and process ownership

Boot work requires an explicit grant bound to the routine definition,
authorization revision, canonical local project and local model-cache identity.
The runtime budget must be finite. Only the owned local inference runtime and
the reviewed `system_time`, `files_list`, `files_read`, `files_write` and
`folder_report` tools are eligible. Writes need their existing scoped file
grant. Network and sign-in-dependent sync paths are excluded from project and
weight selection. Changed grants, model metadata, project identity or routine
definition require another review.

The headless host loads no browser, addons, account connector, credential store
or external gateway. Its local inference credential is generated separately;
the signed-in profile's saved credentials are not decrypted or copied into it.
Boot-specific CPU configuration is stored separately from the interactive
model's hardware defaults. Eligible calls retain their existing job budgets,
input identities, output receipts, Stop and recovery checks. Optional idle
unload rechecks active work before stopping the owned model.

Desktop, browser, shell, account, delegated and other unreviewed jobs appear as
deferred for the interactive worker. They cannot acquire additional grants from
their input text. The Task Scheduler status and last boot-worker phase are
visible in the Inbox. An inaccessible input or model remains an explicit
failure or review state rather than silently switching providers.

The boot entry acquires the same kernel profile lock as the signed-in worker.
A normal visible launch uses a narrow, profile-authenticated local handoff:
the boot owner pauses admission, stops transports, checkpoints current steps,
closes its model and releases ownership. Only then does the UI worker acquire
the profile. Reopening starts paused for inspection and Resume. Interrupted
read-only work can continue from saved evidence; unknown effects need review.
An unclean boot-worker exit causes Safe Mode on the next visible launch.

## Routine backups

Choose **Save routine backup** to use the Windows Save As dialog. The archive
contains definitions, requested tools/paths/grants, immutable revisions, input
and result data, action journal and receipts. Credential stores, project
locations, live authorization, browser cookies, request headers and recognized
credential fields/patterns are excluded. Job text and result data can still be
private; this is a profile backup, not a public report. Weights, media binaries
and installer caches are not copied into it. Archives are bounded to 32 MiB.

Choose a backup, inspect its requested scope, then **Restore paused evidence**.
Restore merges into the same profile and keeps newer receipts, occurrence
identities, cursors and routine revisions. It never restores the independent
effect ledger, credentials, active grants or boot access. It refuses a different
profile identity or a backup ahead of the available independent history.

For each restored routine, review and save its current project, connection,
tools, paths and grants. Open its job and bind that reviewed revision. An old
connected-account intent must retain the original account; use a new reviewed
job when intentionally changing accounts. Reconcile destination evidence before
resuming an uncertain job. An operator decision is recorded as
`operator_verified`; it does not fabricate a provider delivery receipt.
New irreversible steps in a restored or reconciled job require operation
approval even when the reviewed routine has a file grant. A model cannot evade
old-effect review merely by proposing different arguments. The job displays
newer independent destination evidence; identical verified effects reuse their
receipt. Steps needing this approval wait for the signed-in worker.

## Independent effect history

The installer-owned effect ledger lives outside portable profile backups and
is shared by the interactive and boot owners. It appends a hash-linked,
sequence-numbered reservation before dispatch and an outcome afterward, with
an independent high watermark. Stable job/action identity and project/account
scope prevent an older restored job from repeating a later effect. Connectors
can also supply a stable message/draft identity across job IDs. Completed
receipts cannot be overwritten through the API. Unknown outcomes block replay
until destination reconciliation or an explicit operator decision.

The ledger retains safe destination IDs and digests, not credential values or
message bodies. Torn, corrupted or rolled-back ledger files fail closed.
Faber's restore does not rewind this history. A whole-machine rollback that
rewinds both the profile and independent history is outside that guarantee.
Treat missing history as a supervised recovery rather than assuming an effect
did not happen.

## Installer handoff and rollback

Before replacing files, the installer helper checkpoints live workers through
the authenticated local control channel. It preserves completed and pending
receipts, pauses admission, stops current transports and waits for ownership to
be released. An older running release without the protocol must be quit
normally. The installer hook does not force-kill the worker.

The trusted bootstrap migrates a versioned checkpoint before loading editable
application code. Migration must retain every stable job, pending intent and
committed output receipt. It refuses intervening authority/effect changes;
extension display descriptors are the one allowed normal-shutdown difference.
Interrupted migration recovers from its known checkpoint without replaying a
tool. The queue reopens paused; Resume is an explicit user operation.

A supported downgrade handoff disables routine and boot autorun and retains
the newer independent ledger. Previous full installers and model/profile data
remain available for rollback. Pre-a2.9 binaries and installers do not enforce
this new protocol; launching an arbitrary old executable is not equivalent to
a supported checkpointed downgrade. Actual prior-installer/VM acceptance is
recorded separately from source and helper tests.

Implementation: [boot eligibility](core/boot-eligibility.mjs),
[headless host](desktop/boot-runtime.mjs), [boot entry](desktop/boot-worker.cjs),
[Windows adapter](desktop/boot-task.mjs), [control channel](desktop/worker-control.cjs),
[independent ledger](desktop/action-ledger.cjs), [backup format](core/routine-backup.mjs),
[installer transaction](desktop/worker-update.cjs) and
[installer helper](desktop/worker-update-cli.cjs).
See [a2.9 worker verification](docs/a2.9-worker-verification.md) for observed evidence
and the still-open physical pre-login gate.
