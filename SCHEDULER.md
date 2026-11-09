# Scheduled work and the Work Inbox

Open **Work Inbox** in the sidebar. Create a routine, choose its project and
connection, describe the inputs, output and completion criteria, and approve
its tools and project-relative paths. Each saved revision starts disabled.
Preview proposes privileged actions; **Enable** authorizes the reviewed revision.
You can still queue a manual run at any time while the routine is enabled.

Choose Manual, Once, Daily, Weekly, Every interval, or Stable file arrival.
Calendar triggers retain their IANA timezone and wall time. Preview the next
occurrences before enabling. Spring gaps can skip or move to the next valid
minute. Autumn folds can use the first, second, or both occurrences. Interval
triggers use an explicit first UTC occurrence and a duration in minutes.

Missed occurrences can skip, catch up once, or queue the newest bounded count.
Overlap can skip, queue, or coalesce into one pending job. Coalescing retains
every admitted source identity. The durable cursor and occurrence receipt
prevent a repeated poll or restart from admitting the same occurrence twice.
A backwards clock never rewinds the saved cursor and produces an Inbox notice.
Pause retains the cursor so the selected catch-up policy applies after Resume.

File triggers require two matching content hashes across the selected quiet
period. Partial copies, changed file identity, oversize files and linked files
remain pending or produce an explicit notice. Relative path plus content hash
identify an input revision; repeated notifications and watcher restarts retain
that identity. Excluded folders and the routine's recorded output paths do not
trigger new jobs. A quiet period is a heuristic: select an application-specific
ready folder when a producer can pause longer than that period while copying.
The scanner caps each watched tree at 10,000 entries and each file at 64 MiB.

## Budgets and local resources

Each admitted job keeps its routine revision, paths, grants and limits. Parent
and child agents share its runtime, attempts, token and spend ledger and child
concurrency cap. Completion waits for that child tree. Child agents cannot
inspect unrelated jobs, expand project access, change credentials, or obtain
new grants from conversation text. There is no automatic provider fallback.

Runtime is independent of the global chat timeout. Model-call reservations are
saved before transport dispatch; actual input plus output usage settles them
without counting cached or reasoning subsets twice. A strict total-token limit
requires an enforceable input bound; an owned managed local context supplies a
conservative bound. Output tokens are capped on the actual request. Unsupported
API bounds stop the call before dispatch. A strict spend ceiling also stops a
paid request when no enforceable cost ceiling is available. Owned local calls
have zero provider spend. Missing usage remains unknown and retains the reserved
worst case; the reviewed policy either pauses bounded work or charges that
reservation. A provider exceeding its bound blocks later calls for review.

Select an available downloaded model to load it on demand. Foreground-first
priority waits for active interactive local work before loading or requesting
inference. It never evicts an active chat or switches to a cloud provider.
Optional idle unload rechecks recent activity and active work before stopping
the owned model. Zero keeps it loaded. Default limits are ten minutes, three
attempts, two concurrent parent/child runs and 1,024 output tokens per call;
total tokens and spend are unlimited until explicitly bounded.

## Daily folder report

Select an owned local Qwen model and enable **Daily folder report with local
Qwen**. Choose an approved input folder and a separate output folder. A Daily
calendar trigger follows the chosen timezone; a 1,440-minute UTC interval is
also supported. The worker discovers and sorts the input snapshot, records
each readable input's hash, and asks the selected local model for one summary
per bounded UTF-8 file. Unreadable, binary, changing, linked or context-unfit
inputs are explicit exceptions. The report does not silently truncate inputs.
The input tree is limited to 1,000 entries and each input to at most 1 MiB,
further reduced to fit the verified model context and output allowance.

One `folder-report-YYYY-MM-DD.md` is created without replacing an existing
destination. Its journal retains the input manifest, individual summaries,
exceptions and output digest. A duplicate same-date request verifies and reuses
that committed output. Changed same-date inputs or an unexpected existing file
need review. Model summaries are labelled as model-generated; coverage and
file hashes do not independently establish their factual correctness.

Closing every window leaves opted-in work running. Reopen to inspect the
Inbox's active, queued, completed and attention groups, source snapshots,
coverage, usage, approvals and output receipts. **Stop** cancels the active
transport and job tree; **Pause work** stops activity and pauses admission.
An active agent correction follows the normal steering rules. A report is one
structured action, so a queued correction cannot rewrite a file already being
summarized; Stop and review a new revision when changing its specification.
Interrupted read-only report work can resume from saved summaries. Publication
is reconciled against its intended digest; unknown effects require review.
Safe Mode starts paused and requires an explicit Resume.

Implementation: [time policy](core/scheduling.mjs), [file identities](core/file-triggers.mjs),
[admission receipts](core/routine-scheduler.mjs), [budgets](core/work-budget.mjs),
[report](core/folder-report.mjs), [job authority](core/routines.mjs), and
[Inbox UI](renderer/routines.mjs). Evidence and remaining gates are in
[a2.7 verification](docs/a2.7-scheduler-verification.md).
