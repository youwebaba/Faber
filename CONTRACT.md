# Faber implementation contract

Faber provides a Codex-style UI, modular tools, local/cloud models, agent
delegation, chats/projects, PC access,
voice activation and upgrades authored by agents. Local inference is the first
live target. Faber is a separate application. It does not migrate other
applications' data or change their launchers.

This contract describes Faber a3.0.3 (application version 3.0.3), including
steering, project authority, profiles, recovery, core snapshots, external access
and compaction hardening. Source/application validation is recorded in
[VERIFICATION.md](VERIFICATION.md); artifact/publication records accompany release
assets, and earlier chronological evidence remains separate.

a3.0.2 pairs a downloaded GGUF with a complete matching vision projector.
Companion downloads retain the main model's repository revision and destination.
Local discovery rejects incomplete, linked or ambiguous companions; text-only
models keep the explicit no-projector runtime path. Model startup uses only local
files and performs no companion download. See [a3.0.2 notes](docs/a3.0.2-release-notes.md).

## Remote desktop sessions

The desktop owns pairing, encrypted device credentials, revocation and the outbound relay. The core exposes a scoped workspace dispatcher for a paired user. Agent tools and external API clients have no pairing or grant-management methods. See [Remote sessions](REMOTE.md).

a2.3 advertises `imageReferences` in workspace capabilities. A controller may
request `chat.read` with `imageMode:'references'` and fetch each displayed image
through `chat.image {chatId,imageId}`. References identify validated, persisted
chat/tool/inbox image data. They do not accept a file path, fetch a URL or execute
a command. Image IDs bind their owning chat, source and current content.
Legacy controllers may continue to use bounded inline image responses, and
a2.3 controllers omit the new option for hosts without the capability.

a2.4 adds `mediaReferences` and `chat.read {mediaMode:'references'}`. Audio/video
descriptors are chat-owned opaque IDs; `chat.media {chatId,mediaId,offset,length}`
reads at most 256 KiB per request. Media bytes stay outside transcripts and
provider history. The desktop streams validated references through its local
protocol and owns clipboard and native Save As operations. Agent tools cannot
write the clipboard or choose a save destination. See [Chat media](MEDIA.md).

## Implementation ownership

- `core/`, `test/core*.test.mjs`: runtime agent. Node ES modules, no Electron
  imports. Durable projects/chats/runs, streaming provider, registry, approvals,
  bounded agent tree, cancellation, cross-chat tools.
- `desktop/`, `tools/`, `extensions/`, `test/desktop*.test.mjs`, package files,
  launch scripts: desktop/tools agent. Electron host, Windows adapters,
  extension loader, staged upgrade/rollback, file/shell tools and voice bridge.
- `renderer/`, `test/ui*.test.mjs`: interface agent. Local HTML/CSS/ES modules,
  sandboxed renderer, no dependency on Electron internals.
- Documentation and integrated review: coordinator. Agents report changes to
  the designated GPT-6 Luna librarian; only Luna accesses unified memory.
- `model-hub/`, `test/hub*.test.mjs`: Hugging Face metadata, download jobs and
  shared agent tools; see [HUGGINGFACE.md](HUGGINGFACE.md). The renderer and
  agents use the same manager, with host-owned networking and encrypted tokens.
- `local-models/`: downloaded-file discovery, managed local server lifecycle and
  existing Ollama load/unload operations; see [LOCAL_MODELS.md](LOCAL_MODELS.md).
- `native/src/`: bounded GGUF binary parsing in a Rust subprocess. The JS host
  retains path authorization, open-file identity checks and result aggregation.
  The worker receives an inherited read-only descriptor, never a model path.

Use Node's test runner. Electron is the only initial runtime dependency; prefer
standard-library code over adding a framework for this small first version.

## Runtime and tool boundary

a2.6 adds opt-in background operation and reviewed manual routines. The Electron
main process remains the sole profile-state owner while sandboxed UI windows can
close, crash and reconnect. The trusted bootstrap's kernel profile lock precedes
editable code and is released by Windows after a worker crash. Routine revisions,
input snapshots, action intents/receipts, review decisions and queue state are
durable records, separate from conversation compaction. User-only worker/routine
bridge methods and authority/recovery rules are specified in [WORKER.md](WORKER.md).
The host calls `runtime.startRoutines()` after tool registration; Safe Mode pauses
automatic admission, unknown effects require review, and no scheduling or boot
service is implied.

`core/runtime.mjs` exports `createRuntime({dataDir, sourceDir, host, provider?})`
as an async factory. Runtime exposes `request(method, params = {})`,
`subscribe(listener)` (returns unsubscribe), `registerTools(tools)`, and
`close()`. Host-only `createExternalSession(...)` and
`withExternalProvider(...)` are described below. The host also uses
`emit(event)`, `setExtensions(metadata)` and
`replaceExtensionTools(tools, metadata)`; replacement validates before changing
the active registry. An event is `{type, ...payload}`. A state change emits `state` with
`state`; streaming emits `delta` with `chatId, runId, text`; other supported
types are `approval`, `voice`, `models`, `error`, `browser`, `browserFrame`,
`browserShortcut`, `browserFind`, `browserViewHidden`, `localModels`, `addons`
and `gateway`. The `models` event carries a
separate model-hub state snapshot. Runtime state contains `projects, chats, runs,
providers, tools, extensions, approvals, settings, promptPresets`. It never includes secrets.
Live response snapshots are transient UI state, not saved messages or provider
input. Their sequence numbers let a refreshed renderer join an active response
without dropping or repeating chunks received during startup.

Host hooks: `getSecret(id)`, `setSecret(id, value)`, `chooseDirectory()`,
`openPath(path)`, `desktop(action,args,signal)`, `voice(action,args,signal)`,
`reloadExtensions()`, `restart()`, and `openExternal(url)` for validated Hugging
Face model pages. Hooks are optional; missing hooks produce
an honest unavailable result. Host connects native voice events to the UI.
`privatePaths` supplies protected profile/registry roots; scoped path checks also
protect the current `dataDir`. The desktop supplies `backupCore(signal)` before
shell execution; failure prevents the command. It snapshots source, not user data.
The optional synchronous `assertProviderAvailable(providerId, model, options)` hook
rejects a new run before message mutation when local lifecycle state prevents
use of that connection/model or its selected context size differs from the loaded
capacity. `providerControls(providerId, model)` declares host-owned managed
runtime capacity and thinking support; a connection name or URL is not proof of
ownership. See [CHAT_CONTROLS.md](CHAT_CONTROLS.md) for native parameter semantics.
`modelDisplayName(providerId, model)` returns a verified managed model label;
the runtime captures it on each new run without changing the provider model ID.
`isAutomaticTool(tool, permission)` is an optional synchronous host authority
check for the verified shipped Lightpanda addon. It must match the active
registered execution function, fixed tool name, allowed browser permission and
installer-pinned package digest. It returns false for other tools and revokes
authority on addon disable, removal or replacement. It never grants a run/chat
permission, including through `ctx.approve`. The built-in visible Chromium
browser also uses this hook: automatic authority matches its exact registered
execution function, fixed tool name and that tool's declared permission only.
Closing the manager revokes it; unrelated tools receive no authority.
`browser_download` requires ordinary files permission and receives no automatic
authority. Persistent browser sessions and tabs belong to the calling chat;
human takeover pauses all its agent browser tools until explicit Resume. See [BROWSER.md](BROWSER.md).

The read-only web crawler uses the ordinary `network` approval and a dedicated
stdio MCP worker for each calling chat run. Stop, run completion or revocation
closes the worker. Crawled data is untrusted, kept in bounded memory, and read
in pages by the owning run. Website credentials stay in the browser. Safe Mode
omits the crawler tools. [Built-in web research](MCP.md#built-in-web-research)

Each tool is `{name, description, parameters, permission, execute(args, ctx)}`.
Names use underscores for provider compatibility. Permission is one of `read`,
`files`, `shell`, `computer`, `network`, `upgrade`. Read tools may inspect the
current workspace and authorized harness metadata. Target-project authority is
separate: inspection, coordination and structured file access in another project
require that exact project's approval, even with a files/shell grant. Lists default
to authorized projects. Revoking `projectGrants` removes authority from the chat
tree and cancels dependent live work/pending approvals; it cannot undo completed
effects. Privileged tools require a run-scoped
approval or an explicit persistent chat grant. A grant is real host authority,
not an OS sandbox; shell/plugins may access anything the user account can.
The verified bundled Lightpanda browser tools and built-in Chromium browser
tools have the narrow automatic host authority described above; configuration
changes and unrelated tools do not.
The built-in read tool `system_time` returns the PC clock as UTC, local time,
IANA timezone, UTC offset in minutes and Unix milliseconds without shell access.
Tool args require JSON-schema validation before execution; reject unknown tools.
`ctx` contains `runtime, chat, project, runId, signal, dataDir, sourceDir, host`,
and `approve(permission, summary)`, `authorizeProject(projectId, summary?)`,
`authorizePath(absolutePath, summary?)`. File/image callers check paths before
access and revalidate after awaits. The check resolves the most specific registered
project, rejects protected profile paths and rechecks scope changes. Same-project
children inherit bounded grants; cross-project children start without file/shell
grants. Agents cannot grant themselves authority. Stop cancels the
run and descendants, pending approvals and managed subprocesses. Restart never
automatically replays interrupted side effects. Tools return JSON-serializable
values; a screenshot may return `{image: 'data:image/png;base64,...', ...}`.
The provider adapter forwards image tool results for vision-capable models.

## Renderer bridge

Preload exposes only `window.faber.request(method, params)` and
`window.faber.subscribe(listener)`. The host validates frame/sender and
allowlists request methods. No Node access, eval, arbitrary navigation or remote
script in the renderer. Model text/tool output renders as text or sanitized DOM.

Requests and return values:

- `state.get` → state snapshot.
- `project.create` `{name,path?}` → project; omitted path uses a native picker.
- `project.update` `{id,name?}` → project.
- `project.archive` / `project.delete` `{projectId}` → result; records only,
  never workspace files. Delete requires stopped chats.
- `chat.create` `{projectId,title?}` → chat. User-created root chats copy the
  profile's current `settings.defaultGrants`. Existing chats/runs are unchanged
  when defaults change. Child chats use bounded parent inheritance and external
  sessions retain their separate authority policy.
- `chat.update` `{id,title?,providerId?,model?,grants?,projectGrants?,voice?,contextTokens?,thinking?,reasoningEffort?,systemPrompt?,systemPromptPresetId?}`
  → chat. Context is a positive integer or null (default); thinking is boolean or
  null (provider default). Unsupported explicit values are rejected. Prompt text
  is a per-chat snapshot, up to 65,536 characters, and may intentionally be empty.
  Selecting a preset ID alone copies the library text; custom text without an ID
  clears the reference. Runs freeze the prompt/options at start. `projectGrants`
  is the user's explicit set of additional project IDs; removing an ID revokes
  dependent authority. Moving a stopped chat tree clears permission/project grants.
  External session project/provider/authority fields cannot be changed.
- `chat.controls` `{chatId}` → provider capabilities, selected options, context
  estimate and measured managed capacity when available.
- `chat.send` `{chatId,text,images?}` → `{runId}` when starting, or
  `{runId,queued:true,messageId}` for a busy-run followup. Text/images enter
  the durable inbox (maximum 32 queued items), delivered before the next model
  turn after the current assistant/tool-result group. Steering does not interrupt
  an in-flight provider/tool call. Events carry progress.
  `images` is an optional array of PNG/JPEG/WebP base64 data URLs, with up to
  eight images and 8 MiB of encoded strings in total. Runtime validation precedes
  any message/run mutation; empty text is accepted when an image is present.
  The IPC envelope allows 12 MiB for this method; other requests retain 4 MiB.
- `chat.stop` `{chatId}` → result, including descendant cancellation.
- `chat.archive` `{chatId}` → result.
- `chat.forceStop` `{chatId}` → settled cancellation for its chat/run tree.
- `chat.move` `{chatId,projectId}` → result; moves its stopped child-chat tree.
- `chat.delete` `{chatId}` → result; removes its stopped child-chat tree and
  run/approval records. The renderer captures the target and requires the shared
  large red Delete confirmation. Delete/move/force-stop and project lifecycle
  methods are user bridge operations, not model tools.
- `provider.save` `{id?,name,kind,baseUrl,model,apiKey?,reasoningEffort?}` → redacted
  provider. `kind` is `openai-responses` (Responses), `openai` (OpenAI-compatible
  Chat Completions), or `ollama` (native local API). Responses reasoning effort
  is optional: `low`, `medium`, `high`, `xhigh`, `max`; empty clears the setting.
- `provider.test` `{id}` → `{ok,models?,error?}`; no paid inference by default.
- `approval.resolve` `{id,allow,remember?}` → result. Project approval grants only
  its target; remembering adds that project ID to the chat. `rememberable:false`
  rejects remembered approval, including external tool calls.
- `tool.run` `{chatId,name,args}` → result, same policy as model invocation.
- `settings.update` `{theme?,maxDepth?,maxAgents?,runTimeoutMs?,uiScale?,onboardingComplete?,defaultGrants?}` → settings.
  Theme is `dark`, `light` or `system`; legacy context/turn settings are retired.
  UI scale is 0.75–1.5 and changes Electron's whole-page zoom; onboarding is boolean.
  `runTimeoutMs` is `0` (Off) or an integer from 1000 through 2147483647;
  default 600000. Updates immediately reschedule active runs from their original
  monotonic start, including approval/compaction time. An elapsed shortened
  deadline stops work; Off removes the overall timer. Stop/forceStop and separate
  tool/network/gateway deadlines remain effective.
  `defaultGrants` is a duplicate-free subset of `files,shell,computer,network,upgrade`,
  defaulting to an empty array for existing and new profiles. Only user settings
  requests can change it. The model's `settings_update` tool excludes this field.
  It is stored separately as `defaultChatGrants` in the profile state and
  projected into public settings so a2.2's strict settings schema remains usable
  when reopening the same profile after a downgrade.
- `promptPresets.save` `{id?,name,text}` → preset; `promptPresets.delete/reset`
  `{id}` → result. Save edits the library only. General cannot be deleted; deleting
  another preset retains existing chat text. Reset restores a built-in default.
- `app.bugReportDraft` `{description?,steps?,errors?}` → `{title,body}` with bounded,
  commonly sensitive values redacted; `app.reportIssue` `{title,body}` opens only
  the Faber GitHub new-issue URL for user review. Neither method submits an issue.
- `app.openLink` `{url}` opens a user-clicked HTTP(S) link without embedded credentials.
- `chatgpt.status/signIn/cancel/signOut/select/models/usage` are host-owned account
  operations. `runtime.setAccountProviders(records)` is host-only and accepts no
  tokens. Account providers use reserved `chatgpt:<id>` IDs and the fixed public
  OpenAI Responses endpoint; `provider.save` cannot create/edit them. See [CHATGPT.md](CHATGPT.md).
- `extensions.reload` → extension metadata.
- `voice.start` `{chatId,mode}` (`dictation` or `assistant`) → result.
- `voice.stop` `{chatId?}` → result.
- `voice.speak` `{text}` → result.
- `voice.status` → actual Windows recognizer/listening status, without starting
  microphone capture.
- `app.openPath` `{path}` → result.
- `app.restart` → result.
- `profiles.list {}` → `{currentId,profiles:[{id,name,current}],switchRequiresRestart:true}`.
  `profiles.create {name}` / `profiles.rename {id,name}` return profile metadata.
  `profiles.switch {id,draftsCleared:true}` selects/relaunches with
  `{restarting:true,currentId}`; the current profile does not restart.
  The renderer resolves/discards drafts/forms first. The host rejects active
  runs/downloads/voice, UI handoffs, source mutations and external requests,
  stops the idle gateway and rechecks before selection. No profile deletion API.
- `app.recoveryStatus {}` → `{safeMode,reason}`; `app.restartNormal {}` asks for
  confirmation before restarting without the forced Safe Mode flag.
- `app.uiReady {}` → `{ready:true,safeMode,reason}` after renderer initialization.
  Navigation alone does not mark startup ready. This is not a claim that every
  addon/model/device is available.
- `gateway.status/configure/start/stop/rotateToken` → [GATEWAY.md](GATEWAY.md).
  Status is `{running,activeRequests,activeSessions,hasToken,config,baseUrl,mcpUrl}`;
  `gateway` events carry it as `state`. Rotation alone returns `token` once after
  stopping/canceling requests and sessions. There is no automatic start.
- `app.reloadUI` `{state}` → `{id,reloading:true}` after accepting a versioned
  composer/view snapshot into host memory. Only the renderer reloads; runtime,
  model processes and download jobs continue. Backend source drift, voice work,
  invalid snapshots or an existing handoff reject before unloading the page.
- `app.uiState` → pending `{id,state}` or `null`; reads do not consume it.
- `app.uiStateAck` `{id}` → acknowledgement, clearing only the matching handoff
  after successful renderer restoration. Handoffs are never written to disk or
  exposed as model tools. Their separate 64 MiB transport limit does not change
  chat context or turn limits. A rejected handoff leaves the old page intact.
- `uiUpdate` events request refresh after a compatible source upgrade or rollback;
  `uiReloadFailed` reports a failed scheduled refresh. A refresh request is not
  proof that the new renderer has loaded.
- `models.*` → the separate [Hub request and state contract](HUGGINGFACE.md).
  These requests are explicitly allowlisted in the host and preload.
- `localModels.list/details/hardware/configure/start/stop/delete` → the
  [local model contract](LOCAL_MODELS.md).
  These host-owned methods are allowlisted in the bridge; agents share the same
  manager through registered tools. `localModels` events signal lifecycle changes.
- `browser.state/frame/open/navigate/input/stop/close`, tab new/select/close,
  back/forward/reload, takeover/resume/view, bookmarks/history/downloads/upload,
  find/stopFind/zoom and toolbar-focus notifications → the persistent browser
  manager in [BROWSER.md](BROWSER.md). User operations may select a chat explicitly;
  agent tools own only their calling chat's tabs. Explicit toolbar navigation
  acquires human control. All agent browser calls pause during human ownership;
  Resume releases old calls as stale, never replaying input. Stop preserves tabs.
  `browser` events carry session/tab ownership and library metadata;
  `browserFrame` carries bounded PNGs with chat/tab IDs, URL, actual viewport,
  sequence and observation handle. A native WebContentsView attaches only to the
  validated selected page slot during human control; screenshots monitor agents.
  Remote pages are sandboxed without preload, Node or the Faber bridge. Agent
  input never moves the Windows pointer, injects OS keys or activates a window.
  Tabs/ownership persist in profile metadata, cookies in Chromium partitions and
  an encrypted host session-cookie store. Cookie values never enter UI/tool state.
  Agent downloads require files approval, use a constrained directory and never
  execute. Human uploads/downloads require explicit selection or a real gesture.
- `addons.list/import/enable/disable/uninstall/reset/rollback/openDirectory` →
  the local package lifecycle in [ADDONS.md](ADDONS.md). `addons` events carry
  changed state; unchanged reads do not emit another event. Mutations serialize
  and code approval covers the complete package. Online sharing is excluded.

Project: `{id,name,path,createdAt}`. Chat:
`{id,projectId,title,providerId,model,grants:[],projectGrants:[],inbox:[],voice:{enabled:false,phrase:'Hey Faber',speakReplies:true},messages:[],createdAt,updatedAt,archived:false,parentChatId?}`.
Message: `{id,role,content,createdAt,toolCalls?,toolName?,toolCallId?,status?,images?,runId?,modelCallId?,sourceMessageId?}`.
User `images` are durable attachments, distinct from the singular `image` on a
tool screenshot. Adapters encode user attachments in the original user message.
Busy chats have a durable `inbox` of `{id,text,source,createdAt,runId?,images?,fromChatId?}`.
User steering and agent messages enter provider input between complete
assistant/tool-result groups. Delivered user followups have `steering:true`.
Pending items survive Stop/restart without starting a run automatically.
Messages may include `fromChatId` and `runId` for attribution.
Run: `{id,chatId,providerId,model,modelDisplayName?,requestMessageId?,parentRunId?,status,startedAt,endedAt?,error?,toolEvents:[],modelCalls:[]}`.
The connection/model and `grants`/`projectGrants` are captured when a run starts;
older saved runs may omit them. External runs also carry `externalSessionId`.
Each model call records `{id,sequence,providerId,model,startedAt,endedAt?,status,usage?}`.
Usage contains provider-reported `inputTokens`, `outputTokens` and optional
`cachedInputTokens`/`reasoningTokens`; absent fields mean unknown, not zero.
Cached/reasoning counts are subsets, not additions to the input/output counts.
Calls with no final usage, including failures and older saved runs, remain
unreported. Usage records are not appended to model conversation content.
Tool event: `{id,name,args,status,result?,error?,startedAt,endedAt?,toolCallId?,sourceMessageId?,modelCallId?}`.
New model-issued events and tool messages reference their triggering assistant
message and model call. The renderer interleaves live activity using those links;
older saved runs use available call IDs and transcript ordering. These fields are
UI attribution metadata, not extra provider conversation content.
Approval: `{id,chatId,runId,permission,summary,rememberable?,externalSessionId?}`.
Project approvals use `kind:'project',permission:'project',sourceProjectId`,
`targetProjectId?`, `targetProjectPath` and `projectName`; a newly requested
project without an ID cannot be remembered.
Provider: `{id,name,kind,baseUrl,model,hasKey,reasoningEffort?}`. Tool metadata
excludes execute. Saving a connection does not select it for a chat.

Responses uses `/responses` with `store:false` and opaque encrypted reasoning
continuation. Completed output items are retained on the assistant message as
`providerOutput`, bound to the exact provider ID, endpoint and model. They are
not rendered as chat text and are not replayed to a different connection/model.
Only completed, validated function calls reach the shared registry; partial or
failed streams do not execute tools. Opaque continuation items are preserved
exactly rather than truncated into invalid API input.

`chat_read` returns chat metadata and a message index. Optional `messageIds`
selects full original message text. `agent_read` and `agent_wait` return run
metadata and message/tool-event indexes; `agent_read.toolEventIds` selects
individual ordinary tool results. Final assistant replies are available without
copying the entire transcript; agent inspection binds the final reply to the
requested run. Inspecting one's own chat returns the final reply
as metadata, since its text is already in context. These outputs exclude opaque
provider items and image bytes. Nested inspection outputs remain references even
when selected, preventing recursive snapshots; ordinary tool data is unchanged.

Historical inspection tool results with matching recorded call provenance are
replaced by references in provider input. Their durable message contents remain
unchanged. This projects redundant inspection snapshots, not a character or
message budget. All ordinary conversation/tool content and actual provider
continuation items remain intact.

## Host-only external authority and startup

`runtime.withExternalProvider({providerId,model?},callback)` validates a saved
non-account connection and holds the provider-edit lock while the callback uses
its cloned configuration. It exposes no credential and rejects account relaying.

`runtime.createExternalSession({projectId,providerId,model,title?,toolNames,allowAutomatic:false})`
returns `{id,tools(),callTool({name,args,signal?}),close()}`. It creates a dedicated
chat with fixed project/provider/model, pins allowed registered execute functions,
uses fresh grants per call, disables automatic tool authority and supplies an
empty `ctx.runtime`. Administrative/coordination tools are unavailable.
Close cancels work and archives the chat; restart archives old external chats.
The gateway fixes the shipped tool allowlist and authenticates every route/
handshake. Extensions and approved shell/native actions remain trusted host code.

Profiles separate runtime data/credentials/browser state while sharing the
versioned source workbench. The default keeps its existing directory; new profiles
live under `%LOCALAPPDATA%\FaberProfiles\profiles\<id>`. The installer-owned
journal tracks starting/ready/clean/failed. An incomplete previous run or
`--safe-mode` suppresses addon autoload. Independent recovery does not import
broken editable application code. See [INSTALLING.md](INSTALLING.md) for limits
and the same-version workbench warning.

## Extending and upgrading

Executable extensions export a versioned manifest, tool definitions and
declarative UI actions (labels/tool names/argument fields). The renderer builds
buttons/forms from that registry so an agent can add a feature with an entry
point. Extension loading is trusted local code, explicitly enabled by the user;
it is not a security sandbox. Failed validation keeps the active version.

Core/UI self-upgrade uses a separate staged source copy, constrained patch paths,
explicit verification, reviewed activation and rollback backup. Never rewrite
running files or relaunch automatically without an accepted upgrade action.
Renderer-only changes (with optional tests) request an interface refresh after
activation. Test-only changes need no runtime activation. Changes to host-loaded
modules or dependencies require restart; mixed upgrades do not refresh the UI
against an older backend. `createUpgrades().activationStatus()` compares backend
source with its startup baseline and fails closed during source mutation or if
that comparison is unavailable. Upgrade results distinguish source application,
required activation, requested refresh and pending refresh; they do not claim
that a page is active merely because its files were written.

The renderer snapshots only composer text/attachments, selection and view state.
It defers automatic refresh during modal/Models editing, file reads, message
submission, other pending mutations and voice input. Settings provides an
explicit Refresh interface action, subject to the same draft and backend checks.
Unsubmitted settings/connection secrets are not copied into a handoff. Approved
extension tools and declarative actions already replace their registry live.
Provide a sample extension plus a small test proving its tool and UI registration.
Source/extension actions must describe changed files and preserve user data.
Installed extensions retain exact-source approvals across restart. Extension
and updater mutations are serialized across concurrent agents. The source
updater protects dependency manifests, launchers, `desktop/bootstrap.cjs`,
`desktop/boot-state.cjs`, `desktop/profile-path.cjs`, `desktop/packaged-paths.mjs`
and `desktop/recovery.mjs`;
the launcher can run that independent recovery entry without importing the app.
Alpha 2.0 retains the staged `native/src/**/*.rs` / `native/worker.mjs` support
introduced in RMb2.0.1.
Rust source changes compile and run Rust tests before the existing Node suite.
The generated `native/runtime.json` selects an immutable digest-named executable;
it is backed up/restored with source, and a backend pins its executable until
restart. Cargo manifests, toolchain, vendor dependencies and build/integrity
helpers stay installer-owned. JS-only upgrades need no compiler. Independent
recovery supports both legacy source records and compiled-pointer records.
See [RUST_MIGRATION.md](RUST_MIGRATION.md) for build and activation details.
Before staged apply/rollback and desktop shell execution, `backupCore` retains
a hash-verified snapshot under `<profile>/upgrades/<id>/backup`, with
`core-backup.json` and `last-core-backup.json` records. Coverage includes source,
renderer assets, tests, bundled addons, manifests, build/scripts/docs, launchers
and the active Rust worker. Weights, profiles, dependency/runtime caches, native
vendor/target trees and unrelated binaries are excluded. Unchanged backups can
be reused after source/backup hash checks; drift rejects the mutation. This is
not a full-profile/system restore. Automatic rollback still restores only the
eligible last-upgrade manifest and refuses newer unrelated edits.

Ordinary `files_write` refuses writes to the running harness source, including
symlink aliases. Shell grants remain unrestricted user-account authority.

Ordinary runs receive registered tool schemas and conversation/tool input subject
to the checkpoint projection below. There is no fixed harness character/message
budget or turn-count cutoff. The former `contextChars`, `contextMessages` and `maxTurns`
settings are removed on startup and are no longer accepted by settings updates.
Only the newest tool screenshot is included; earlier screenshot omissions remain
explicit. Pasted user images remain with their original messages in context.
Image, transport and individual tool limits still apply. Model/provider context
capacity remains authoritative; Ollama uses its server/model context settings.
Runs stop on completion, errors, user cancellation or an enabled overall time
limit (ten minutes by default; `0` disables it). Agent depth/concurrency and
approval controls remain active.

## Verification and truthfulness

Use fake provider tests for deterministic agent/tool/stop/error scenarios, and
label them as such. Check actual local inference separately if available.
Native PC/voice functions must report real availability and errors. No fabricated
conversations, working badges, tool results or completion claims in the UI.
Keep credentials, chat history, recordings, screenshots and runtime data outside
Git/OneDrive. No cloud fallback or paid API calls during this build.

## Context checkpoints and progress

chat.compact {chatId} is a user bridge operation that starts a tool-free context
summary followed by continuation of the existing request; it adds no user message.
chat.contextCheckpoint version 2 stores a summary/boundary, validated
`requestFacts` and any retained latest request ID; chat.messages remains the full
transcript. Version 1/unmarked checkpoints are ignored for model projection.
Saved originals feed a bounded rebuild before a response when known capacity
requires it; upgrading may need one extra compaction. Failed/canceled rebuilds
do not rewrite the old stored checkpoint/history.

Checkpoints end on whole assistant/tool groups. Summary output must be a
substantive JSON handoff with valid original `sourceMessageIds`; an invalid
handoff receives one feedback retry. Selected exact historical user literals
retain source IDs outside the lossy summary. They may be superseded and confer
no permission. Failure to fit required retained facts fails without silently
dropping them. Source-reference validation does not prove semantic completeness;
summaries remain lossy.
A model call may have purpose response or compaction, phase, and a public
progressSummary. Summary calls retain usage and use bounded internal output.

Transient progress events carry chatId/runId/modelCallId, phase, summary, sequence,
streamSequence, lastAssistantId and metrics. Delta events with replace:true carry
the entire canonical text, not an appended chunk. Snapshots retain cumulative
text and progress so renderer reload cannot duplicate either. Completed Responses
items remain exact for continuation. When a completed response has an empty
output list, Faber uses validated completed item events from that stream.
Malformed or incomplete fallback batches fail before any tool executes. A context rejection may trigger bounded compaction retries; a run with
contextOverflow:true exposes manual recovery. This does not restore finite user
turn limits or trim the saved transcript.

## Scheduled worker authority (a2.7)

Scheduled and file-triggered jobs use the same durable routine definitions,
grants, project paths, credential identity, Stop and action receipts as manual
jobs. Each occurrence or file revision has a persisted admission identity.
Timezone/DST, missed-run and overlap policies are explicitly reviewed; child
agents share the job's budget and cannot widen scope. Model usage is reserved
before transport dispatch and unknown bounds are never invented. The daily
folder report requires an owned local Qwen model, preserves per-input coverage
and exceptions, and atomically creates one dated report without replacing an
unexpected destination. See [the scheduler contract](SCHEDULER.md).

## Boot, restore and installer authority (a2.9)

Boot work is a separately reviewed credential-free local tier. It uses an
ordinary user S4U token at least privilege, admits only bound local CPU/file
work, and defers session-dependent or approval-dependent steps. A visible launch
checkpoints the boot owner before reacquiring the same kernel profile lock.
Portable routine restore stays paused, revokes grants and boot access, requires
project/account review and cannot replace newer independent effect history.
Installer-owned helpers checkpoint and version the worker journal before file
replacement; incomplete migration retains receipts and opens paused. See
[worker recovery](WORKER-RECOVERY.md) and the [a2.9 evidence](docs/a2.9-worker-verification.md).
Physical pre-login and prior-installer acceptance remain separate gates.

## Static 3D attachments (a2.9)

GLB/glTF/STL outputs publish one immutable root and only explicitly supplied,
individually authorized buffer/texture references. Graph and file hashes bind
the validated dependencies. The isolated viewer cannot fetch arbitrary project,
app or network resources. Stop, disconnect and disposal revoke pending transfers;
Save As preserves original bytes and verifies revisions before replacement. See
[3D attachment contracts and evidence](docs/a2.9-scenes-verification.md).

## Live capture (a3.0)

Capture is a user-only desktop operation. The trusted top frame requests a
specific source and optional paired viewer, obtains a native confirmation and
consumes a short-lived permission when Start sharing invokes the browser API.
Other frames and audio capture are denied. Models, tools and controllers cannot
grant or start capture. The host owns the source, viewer, lifetime and Stop.

The paired transport exposes only capture status, join, bounded-frame read and
leave for the approved device/view identity. It keeps one JPEG frame in memory,
records no media and never converts a reconnect into permission. Window hiding,
reload, lock, suspend, stale heartbeats or a changed viewing session ends sharing.
The sidebar keeps live viewing, scene support and Host Work Inbox capabilities
conditional across initial and unchanged directory responses. See [live media](LIVE_MEDIA.md).
