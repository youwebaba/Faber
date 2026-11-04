# Chat controls in Faber b2.0.1

The bottom of the composer has context usage, a context-size control, tokens per
second (TPS), and a brain button. Settings belong to the selected chat and are
captured when a run starts. Changing connection or model resets them to defaults.

Managed local connections display the detected model/file name in the composer,
selector and run details. The internal server alias remains an API routing value.
New runs retain the name captured at their start, including after another model
is selected. A stopped managed connection retains its last known model name.

The selector has **Local & APIs** and **OpenAI** tabs. The latter lists linked
ChatGPT accounts and their advertised models. It shows fixed context capacity
when supplied and reasoning choices when advertised. Unknown capabilities remain
unknown; signing in does not unlock every OpenAI model. See [CHATGPT.md](CHATGPT.md).
Managed local model controls use a green triangle to start and red square to stop.

Choose a system prompt in the model selector. Settings → System prompts edits
the preset library or applies instructions to the selected chat. Each chat keeps
its own snapshot, including an intentionally empty custom prompt. An active run
retains the prompt captured at its start; later edits affect the next run.
The self-upgrader preset prefers dedicated tools over shell commands. Prompts
guide the model but do not confer or restrict operating-system permissions.

## Context size and usage

**Context** opens the size selector. Choose a preset, enter a positive token
count, or use the provider default. The selected number configures runtime
capacity; it does not trim saved messages, limit output tokens, or limit turns.

- Native Ollama receives `options.num_ctx` on each request. With Default, Faber
  omits this override. Ollama/model constraints still apply.
- A Faber-managed GGUF server starts with `--ctx-size N --parallel 1`, so the
  selected capacity is one full inference slot. **Save & restart model** applies
  a change to an already loaded model; stop its active chats first. Faber checks
  the actual slot capacity and rejects a load that silently caps the selection.
  A chat with a different selected size cannot send until the model is restarted
  or its selection is corrected. Default leaves the runtime's defaults alone.
- Fixed-capacity cloud APIs display an unavailable selector with an explanation.
  Faber does not pretend their output-token parameter changes context capacity.

The usage bar updates during drafting and generation. Before provider usage is
available, it estimates serialized text and tool schemas at four characters per
token. Images and opaque reasoning are excluded. Provider-reported counts replace
estimates when available; the current draft/output estimate remains approximate.
The bar is informational and never triggers automatic history deletion. An
unknown capacity stays unknown. A selected Ollama capacity is a request to its
server, not a measured allocation. The managed GGUF capacity is verified at load.

## TPS and thinking

TPS uses reported output tokens and the provider's evaluation duration where
available. Otherwise it uses whole-call elapsed time, including request/prompt
processing; live character-based output rates are labeled approximate. Missing
counts do not become zero. **Activity → Token usage** retains per-call input and
output usage. These counters are not billing or rate-limit reservation estimates.

The brain button opens a thinking slider for this chat, with the selected level,
model name and a reset-to-default button. ChatGPT account connections offer only
the reasoning levels advertised by their catalog; Off appears only when `none`
is supported. Choosing a level clears an older on/off override so the selected
effort reaches the model. Default leaves the model's settings in charge.

Ollama and supported managed GGUFs offer Default, Off and On, since their existing
controls are boolean. Ollama uses `think`; managed GGUFs use the chat template's
`enable_thinking` only when the inspected template declares that parameter.
Unsupported APIs/models have a disabled button with a reason. Existing API
connection-level reasoning settings remain in the connection editor. Changes are
per chat and disabled during an active run. Arrow keys move between slider stops;
Escape or clicking outside closes it. This control does not reveal private
reasoning or guarantee a model's answer quality.

## Chat and project menus

The sidebar orders parent chats by their own activity and keeps each agent below
the chat that spawned it. A child reply reorders siblings without promoting the
family above other parent chats. Nested agents retain their hierarchy.

Right-click a chat, or focus it and press Shift+F10, to archive, delete, force
stop, or move it to an existing/new project. Moving preserves the conversation
and its child-agent chats; it does not move workspace files. Stop active runs
before moving or deleting a chat tree. Right-click a project to archive or delete
it. Archiving keeps the records and stops/hides the affected chat tree.

Every chat/project Delete opens a confirmation with Cancel initially focused,
the selected item's name, and a large red Delete button. Its warning is exactly:

> Are you sure you want to delete this chat? Deleted chats are not recoverable!

Project deletion uses “project” in place of “chat” in the first sentence. Deletion
removes Faber's associated conversation/run records, including child-agent chats;
project folders and their files stay on disk. It cannot be undone in Faber.

**Force stop** cancels the selected chat's runs and descendants, dismisses pending
approvals, and fences late provider/tool results. It cannot undo an external
effect already started or interrupt synchronous JavaScript blocking the host.
Remote providers may continue work after their request is canceled.

## Inspect ongoing work

Activity appears in transcript order, immediately after the assistant output that
requested each tool batch and before its next reply. The same rows update while
tools run and remain at that position after completion or interface refresh.
Click **Working…** to expand the current run's activity inline. Tool rows show
their command/file/action, status, arguments, output or error, and approval state.
Child agents are included. Details stay available after completion. This view
shows actual recorded operations and provider text; it does not invent hidden
reasoning or make unreported command output visible.

## Context recovery and response progress

Faber checks the actual configured/reported context capacity before model calls.
Around 80% estimated usage it condenses older complete conversation/tool groups
into a separate checkpoint, retaining the current prompt and latest user request.
The original saved/visible transcript is unchanged and remains accessible with
chat_read message IDs. Images and opaque provider items are never cut into partial
protocol objects; checkpointed images are represented as references.

Already-full requests recover through smaller, tool-free summary calls to the
same selected model. These calls appear separately as Context summary usage.
Only rejected requests are retried; completed tool actions are not replayed by
the recovery mechanism. Stop cancels summaries too. Unknown token estimates and
a latest request/system prompt that alone cannot fit can still require a larger
context or shorter request. Failed recovery offers Compact & continue without
adding another generic Continue message. Summaries are fallible and consume
additional model usage. Normal model calls still have no harness turn limit or
new output-token cap; only internal summary output is bounded.

Thinking pulses while no visible reply is arriving and honors reduced-motion
settings. Provider-supplied public progress/summary events can replace the generic
status; hidden reasoning is never displayed. Hover over the TPS counter for time
to first visible text and its speed basis. A wall-clock rate is labeled tok/s avg
and includes reported reasoning output. Responses text is assembled per item and
content part and reconciled to the validated completed output before saving.
