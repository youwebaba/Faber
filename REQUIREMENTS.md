# Requested capabilities and acceptance

Requester: Bill Wang, October 31, 2026, current coordinator chat.
Coordinator: `/root`; implementation: delegated core, desktop/tools and UI agents.
Local models are the explicitly selected first live target. Earlier Hermes/glass
plans remain historical context for the separate earlier application.

| Request | Module boundary | Acceptance evidence required |
| --- | --- | --- |
| Fresh Codex-style UI and backbone | renderer, desktop bridge, core | Launch actual desktop, create a project/chat, send/stop, restart and retain history; inspect rendered UI. |
| All harness tools available to AI | shared validated registry | Provider receives registered schemas; model calls dispatch through the same policy as manual UI calls; errors remain visible. |
| Create and coordinate agents | runtime run/chat tree | Child creation, messages, waiting, results and cancellation; inherited grants; no recursive permission escalation. |
| Other chats and projects | state and coordination tools | List/read/create/message isolated harness chats and projects with durable records. |
| PC files, shell and programs | filesystem/process/Windows adapters | Real results, path validation, bounded output, cancellation and visible authorization. |
| Use the PC | Windows observation/input adapter | List windows, capture, focus and input; test only a dedicated fixture when possible; distinguish real input from mocked checks. |
| Connect API or local LLM | provider interface | Ollama, Chat Completions and Responses fixtures; cloud setup/model listing, explicit per-chat selection, host-encrypted credentials, streamed tool continuation and cancellation; real local conversation separate from unrun paid cloud inference. |
| Remove harness context and turn limits | runtime and provider interface | Preserve full conversation/tool/opaque continuation beyond former budgets; no turn-count cutoff, including old saved settings; preserve Stop, timeout and approvals; provider-native context limits still apply. |
| Search/download Hugging Face models from UI and AI | model-hub, desktop bridge, renderer | Search, parameter counts, known/estimated sizes and labeled VRAM; explicit file selection, verified streamed bytes, progress/speed/Cancel, persistent library and configurable destination; tiny public live download separate from fixture tests. |
| Choose/download quantization levels | model-hub variant catalog and renderer | Group published GGUF variants by nominal bit depth; select full shard sets with combined sizes/VRAM estimates; reject incomplete or ambiguous sets; expose the same selections to agents. |
| Voice conversation and per-chat activation phrase | native voice service and UI | Installed recognizer/voice detection, listening on/off, phrase routing, speech output and Stop; audible/microphone test separately identified. |
| Upgrade tools and features | versioned extension manifest | Add a tool and registered UI action, reject incompatible/broken versions, preserve active version. |
| Upgrade harness and UI when asked | staged source updater | Constrained paths, source review, validation before apply, stale-source detection, backups/rollback and deliberate restart. |
| AI adds feature button | declarative UI action registry plus source updates | Real sample action appears and invokes its registered tool; arbitrary layout changes can be staged as renderer source. |

This first implementation is a developer application. Focused checks establish
specific behavior, not general autonomous reliability, a security certification,
or release acceptance. Keep failures and unrun hardware/model checks explicit.
