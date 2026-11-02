# Local model controls

The model selector reads the configured Model downloads folder recursively and
offers local Start/Stop actions. These controls are separate from stopping a
chat run. Model selection still requires **Use in this chat**.

## Downloaded files

Standalone GGUF files and complete, originally named GGUF shard sets are listed.
Discovery checks file metadata and the GGUF header. It skips auxiliary models,
hidden/partial files and filesystem links. Incomplete or failed tracked downloads
and unsupported formats are unavailable. File discovery is not a guarantee that
the model is complete, fits memory or supports the selected runtime.

Start rescans the selected file set and launches the installed llama.cpp server
on an authenticated loopback endpoint. It uses the original files directly,
without importing another copy into Ollama. The host owns the process, waits for
readiness, and records a reusable OpenAI-compatible connection. Starting never
selects that connection for a chat. Stop cancels loading or ends the owned server;
closing the harness also ends its managed server. Other applications' servers
are not stopped.

If the download folder changes or a loaded file is renamed, the picker retains
a Stop-only entry for the running model. Refresh the folder and select the new
file entry before starting it again. An abrupt operating-system or harness
process crash may leave a server behind; ordinary Stop and app shutdown are
covered by the process cleanup checks.

The installed Ollama bundle on this PC supplies the server executable. Missing
runtimes or unsupported architectures produce an actionable error; the harness
does not download executables or weights automatically. Separate vision-projector
files are not loaded by this first GGUF launcher. Tool calling depends on the
model and its chat template. Runtime-native context and hardware constraints
apply; the harness does not reinstate a context or turn budget.

## Existing Ollama models

A local Ollama connection also lists its installed models. Start can bring up
the installed local server, verifies the model is already installed, and loads
it with an empty request. Stop unloads only the selected model and leaves the
Ollama service available. These controls never pull a missing model.

## Shared host interface

The validated bridge exposes `localModels.list`, `localModels.start` and
`localModels.stop`. Folder selection uses a scanner-issued `modelId`, not an
arbitrary executable or path. Ollama selection uses an existing local
`providerId` and installed `model` name. Status includes the configured folder,
discovered files, managed provider ID and actual lifecycle state. The
`localModels` event signals changes; callers refresh the selected connection.

`local_models_list`, `local_model_start` and `local_model_stop` expose the same
manager to agents. Start/Stop require the existing computer permission. Lifecycle changes reject
active chats using the target model; the runtime also rejects new runs while a
managed model is unavailable or a lifecycle operation blocks that connection.
No API keys or raw server credentials are exposed in library/status results.
