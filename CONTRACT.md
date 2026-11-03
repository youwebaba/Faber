# Faber implementation contract

Bill requested a fresh harness on October 31, 2026, with a Codex-style UI,
modular tools, local/cloud models, agent delegation, chats/projects, PC access,
voice activation and upgrades authored by agents. Local inference is the first
live target. Faber is a separate application. It does not migrate other
applications' data or change their launchers.

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

Use Node's test runner. Electron is the only initial runtime dependency; prefer
standard-library code over adding a framework for this small first version.

## Runtime and tool boundary

`core/runtime.mjs` exports `createRuntime({dataDir, sourceDir, host, provider?})`
as an async factory. Runtime exposes `request(method, params = {})`,
`subscribe(listener)` (returns unsubscribe), `registerTools(tools)`, and
`close()`. The host also uses `emit(event)`, `setExtensions(metadata)` and
`replaceExtensionTools(tools, metadata)`; replacement validates before changing
the active registry. An event is `{type, ...payload}`. A state change emits `state` with
`state`; streaming emits `delta` with `chatId, runId, text`; other supported
types are `approval`, `voice`, `models`, `error`. The `models` event carries a
separate model-hub state snapshot. Runtime state contains `projects, chats, runs,
providers, tools, extensions, approvals, settings`. It never includes secrets.
Live response snapshots are transient UI state, not saved messages or provider
input. Their sequence numbers let a refreshed renderer join an active response
without dropping or repeating chunks received during startup.

Host hooks: `getSecret(id)`, `setSecret(id, value)`, `chooseDirectory()`,
`openPath(path)`, `desktop(action,args,signal)`, `voice(action,args,signal)`,
`reloadExtensions()`, `restart()`, and `openExternal(url)` for validated Hugging
Face model pages. Hooks are optional; missing hooks produce
an honest unavailable result. Host connects native voice events to the UI.
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
permission, including through `ctx.approve`.

Each tool is `{name, description, parameters, permission, execute(args, ctx)}`.
Names use underscores for provider compatibility. Permission is one of `read`,
`files`, `shell`, `computer`, `network`, `upgrade`. Read tools may inspect the
current workspace and harness state. Privileged tools require a run-scoped
approval or an explicit persistent chat grant. A grant is real host authority,
not an OS sandbox; shell/plugins may access anything the user account can.
The verified bundled Lightpanda browser tools have the narrow automatic host
authority described above; configuration changes and unrelated tools do not.
The built-in read tool `system_time` returns the PC clock as UTC, local time,
IANA timezone, UTC offset in minutes and Unix milliseconds without shell access.
Tool args require JSON-schema validation before execution; reject unknown tools.
`ctx` contains `runtime, chat, project, runId, signal, dataDir, sourceDir, host`,
and `approve(permission, summary)`. All agents share the registered tool set;
children inherit grants and cannot grant themselves authority. Stop cancels the
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
- `chat.create` `{projectId,title?}` → chat.
- `chat.update` `{id,title?,providerId?,model?,grants?,voice?,contextTokens?,thinking?}`
  → chat. Context is a positive integer or null (default); thinking is boolean or
  null (provider default). Unsupported explicit values are rejected.
- `chat.controls` `{chatId}` → provider capabilities, selected options, context
  estimate and measured managed capacity when available.
- `chat.send` `{chatId,text,images?}` → `{runId}` immediately; events carry progress.
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
- `approval.resolve` `{id,allow,remember?}` → result.
- `tool.run` `{chatId,name,args}` → result, same policy as model invocation.
- `settings.update` `{theme?,maxDepth?,maxAgents?,runTimeoutMs?}` → settings.
  Theme is `dark`, `light` or `system`; legacy context/turn settings are retired.
- `extensions.reload` → extension metadata.
- `voice.start` `{chatId,mode}` (`dictation` or `assistant`) → result.
- `voice.stop` `{chatId?}` → result.
- `voice.speak` `{text}` → result.
- `voice.status` → actual Windows recognizer/listening status, without starting
  microphone capture.
- `app.openPath` `{path}` → result.
- `app.restart` → result.
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
- `addons.list/import/enable/disable/uninstall/reset/rollback/openDirectory` →
  the local package lifecycle in [ADDONS.md](ADDONS.md). `addons` events carry
  changed state; unchanged reads do not emit another event. Mutations serialize
  and code approval covers the complete package. Online sharing is excluded.

Project: `{id,name,path,createdAt}`. Chat:
`{id,projectId,title,providerId,model,grants:[],voice:{enabled:false,phrase:'Hey Faber',speakReplies:true},messages:[],createdAt,updatedAt,archived:false,parentChatId?}`.
Message: `{id,role,content,createdAt,toolCalls?,toolName?,toolCallId?,status?,images?,runId?,modelCallId?,sourceMessageId?}`.
User `images` are durable attachments, distinct from the singular `image` on a
tool screenshot. Adapters encode user attachments in the original user message.
Busy chats also have a durable `inbox`; agent messages enter the provider
conversation only between complete assistant/tool-result groups. Messages may
include `fromChatId` and `runId` for attribution.
Run: `{id,chatId,providerId,model,modelDisplayName?,requestMessageId?,parentRunId?,status,startedAt,endedAt?,error?,toolEvents:[],modelCalls:[]}`.
The connection/model are captured when a run starts; older saved runs may omit them.
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
Approval: `{id,chatId,runId,permission,summary}`.
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
`desktop/packaged-paths.mjs` and `desktop/recovery.mjs`;
the launcher can run that independent recovery entry without importing the app.
Ordinary `files_write` refuses writes to the running harness source, including
symlink aliases. Shell grants remain unrestricted user-account authority.

The model receives every registered tool schema and the full conversation text,
tool results and arguments. There is no harness character/message budget or
turn-count cutoff. The former `contextChars`, `contextMessages` and `maxTurns`
settings are removed on startup and are no longer accepted by settings updates.
Only the newest tool screenshot is included; earlier screenshot omissions remain
explicit. Pasted user images remain with their original messages in context.
Image, transport and individual tool limits still apply. Model/provider context
capacity remains authoritative; Ollama uses its server/model context settings.
Runs still stop on completion, errors, user cancellation or the configured
wall-clock timeout (ten minutes by default). Agent depth/concurrency and approval
controls remain active.

## Verification and truthfulness

Use fake provider tests for deterministic agent/tool/stop/error scenarios, and
label them as such. Check actual local inference separately if available.
Native PC/voice functions must report real availability and errors. No fabricated
conversations, working badges, tool results or completion claims in the UI.
Keep credentials, chat history, recordings, screenshots and runtime data outside
Git/OneDrive. No cloud fallback or paid API calls during this build.
