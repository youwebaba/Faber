# Local model controls

The model selector reads the configured Model downloads folder recursively and
offers local Start/Stop actions. These controls are separate from stopping a
chat run. Model selection still requires **Use in this chat**.

## Downloaded files

Standalone GGUF files and complete, originally named GGUF shard sets are listed.
Safetensors files are grouped with their authoritative shard index and supporting
configuration/tokenizer data. Missing shards or configuration make the package
incomplete; a complete package still needs a compatible runtime. Shared support
files are shown in details and retained when recycling weights. Music3's five
GGUF components appear as one music pipeline, excluded from the chat picker.
Multiple component variants require an explicit downloaded package selection.
Discovery checks file metadata and the GGUF header. It skips auxiliary models,
hidden/partial files and filesystem links. Tracked downloads classify auxiliary
files using their repository-relative file paths, so a repository name containing
MTP does not hide its main model. Incomplete or failed tracked downloads
and unsupported formats are unavailable. File discovery is not a guarantee that
the model is complete, fits memory or supports the selected runtime.

Start rescans the selected file set and launches the managed GGUF or native
Safetensors runtime behind an authenticated loopback endpoint. It uses the original files directly,
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

Installed Faber bundles a pinned runner with CPU, CUDA 13 and Vulkan backends.
Source mode can use the installed Ollama bundle or a llama.cpp server on PATH.
Missing runtimes or unsupported architectures produce an actionable error; the
harness does not download executables or weights automatically. Separate vision-projector
files are not loaded by this first GGUF launcher. Tool calling depends on the
model and its chat template. Runtime-native context and hardware constraints
apply; the harness does not reinstate a context or turn budget.

## Native Safetensors chat

Complete original Llama, Qwen2/Qwen3 and Mistral text packages can use the bundled
Windows x64 CPU runtime. Choose the package under **Downloaded models (local)**,
select **Default** context, then **Start** and **Use in this chat**. The host
retains the same chat tools, approvals and Stop controls. Unsupported packages
stay visible with a reason and guidance to use GGUF or an external connection.

**Precision before Start** appears automatically for supported Safetensors.
Its slider and profile selector offer original float32 execution, Q4_0, Q5_0,
Q8_0 and true mixed Q4/Q8 decoder halves. Select the mode before Start; change a loaded model with Stop and another
Start. A successful selection is remembered for that model. Published GGUF
encodings and external connections retain their own settings.

If a newer release saved a precision profile this version cannot load, Faber
retains that setting and shows **Choose a supported profile**. Start remains
disabled until a supported selection is made. Agent default Start also rejects
the unsupported saved choice. Unrelated settings changes preserve the newer data.

Quantization happens inside the native loader using the original weights. Loading
can take longer and temporarily require float32 RAM. Quantized profiles also
write private precision-verification artifacts on the model drive, then remove
them before readiness. The original package remains byte-exact. Norms, embeddings,
output heads and other layers can retain different precision. Actual formats and
the effective packed bit budget are verified and saved for the matching model,
profile and adapter. A 10-bit candidate was tested and is explicitly unsupported
by this pinned backend. See [a2.8 evidence](docs/a2.8-native-precision-fit.md).

The fit display separates selected VRAM (green), system RAM (orange), and
SSD/HDD backing (red), using labels and binary byte units. Each estimate splits
weights, default-context storage and startup workspace, with reserved headroom.
Disk distinguishes existing source files from additional temporary workspace.
The native CPU route does not support GPU offload or RAM/GPU splitting. After
Start, compare the estimates with verified CPU placement and the process working
set sampled at readiness; context can grow later. Estimates are not measured fit
or allocation guarantees.

RAM use can substantially exceed download size, with additional context and
execution buffers. Automatic and CPU modes use
automatic CPU cores; an optional thread count is supported. Custom GPU/core
placement, custom context capacity, prequantized checkpoints, custom model code,
vision, diffusion and music packages are unavailable on this chat route.

Only the selected original weights are hardlinked into a temporary directory
beside the package; checked support files are copied there. This requires a
drive supporting hardlinks, normally NTFS. Stop removes the temporary entries
and preserves the original package. No model files are rewritten or downloaded by
Start. The native inference process has no network listener or executable tool
service; it communicates over private inherited pipes. Faber's separate
loopback endpoint requires its private API key and rejects browser origins.
See [native build and acceptance evidence](docs/a2.6-safetensors.md).

## Per-chat context selection

The composer's **Context** control selects capacity for the next run. Managed
GGUF Start accepts optional `contextTokens` and requests one full slot using
`--ctx-size N --parallel 1`. Actual `n_ctx` from authenticated `/props` or the
runner's slot log must match; unsupported flags or a capped selection fail the
load and stop the owned process. Default leaves runtime flags unchanged.

**Save & restart model** applies a different capacity to a loaded model after
its chats are stopped. New runs reject a selected/loaded mismatch before saving
the message or contacting the model. Editing the managed connection's endpoint
does not transfer these capabilities to another server; Stop/Start restores the
owned connection, or use a separate API connection. Native Ollama instead takes
`options.num_ctx` on chat requests. See [CHAT_CONTROLS.md](CHAT_CONTROLS.md).

## Existing Ollama models

A local Ollama connection also lists its installed models. Start can bring up
the installed local server, verifies the model is already installed, and loads
it with an empty request. Stop unloads only the selected model and leaves the
Ollama service available. These controls never pull a missing model.

## Shared host interface

The validated bridge exposes `localModels.list`, `localModels.details`,
`localModels.hardware`, `localModels.configure`, `localModels.start`,
`localModels.stop` and `localModels.delete`. Folder selection uses a scanner-issued `modelId`, not an
arbitrary executable or path. Ollama selection uses an existing local
`providerId` and installed `model` name. Status includes the configured folder,
discovered files, managed provider ID and actual lifecycle state. The
`localModels` event signals changes; callers refresh the selected connection.

Snapshots include `modelLabels: [{providerId, model, displayName, modelId?}]` for the
exact owned managed connection. The scanner's filename label and model ID are saved
after a successful load and remain available after Stop or restart; the API model
alias stays unchanged. The optional `modelId` restores the exact library selection.
Legacy connections without a saved label resolve only after a scan finds one exact
alias match. The synchronous manager hook `modelDisplayName(providerId, model)`
returns that label or `null`; edited endpoints, kinds and models do not inherit it.

`local_models_list`, `local_model_start` and `local_model_stop` expose the same
manager to agents. Start/Stop require the existing computer permission. Lifecycle changes reject
active chats using the target model; the runtime also rejects new runs while a
managed model is unavailable or a lifecycle operation blocks that connection.
No API keys or raw server credentials are exposed in library/status results.

The additional agent tools are `local_model_details`, `local_model_hardware`
(read), `local_model_configure` (computer), and `local_model_delete` (files).
Configure accepts `{mode: 'auto'|'cpu'|'custom', gpuIds: string[], cpuIds: number[],
threads: number, memoryMap: boolean}`. Details/delete use a scanner-issued model ID.

## Hardware and memory

Expand **Hardware & memory** for Downloaded models (local). Save changes before
Start; stop the managed model before changing its settings.

- **Auto** lets the runner fit layers to available supported devices.
- **CPU only** disables GPU layers. CPU orchestration is still required in GPU
  modes; a GPU checkbox does not make the CPU unused.
- **Custom** selects supported GPUs by checkbox. CPU selection chooses logical
  processors, with an optional thread count; zero means automatic. Strict core
  affinity is unavailable on topologies with more than 64 logical processors.
- **Allow disk-backed memory** controls memory-mapped model files. Clearing it
  requests a normal load. Neither option turns SSD/HDD space into VRAM or disables
  Windows paging. File location determines the backing drive.

Only devices reported by a compatible runtime backend appear. Faber probes
CUDA/Vulkan rather than inferring support from a GPU's marketing name. A single
launch uses the selected compatible backend; it does not combine devices across
CUDA and Vulkan. Missing drivers or unsupported architectures produce errors.
GPU fit depends on free memory, context and model support.

The picker displays requested settings separately from observed offloaded layers
and devices. Custom GPU mode stops if actual placement cannot be confirmed,
instead of quietly continuing on CPU. Settings apply only to Faber's managed
runner, never to remote APIs, local clusters, or another app's Ollama server.

## Library cards, details and deletion

The Models library scans actual files, including manually copied models, and
shows a grid with sizes. Active downloads retain progress and speed. A completed
download record is not evidence that its files still exist.

Click a local card for offline details. Bounded GGUF metadata/tensor-descriptor
reads report architecture, predominant quantization and stored tensor parameter
count, including complete original shard sets. No weights are loaded by this
inspection. Truncated, incompatible or oversized metadata stays unknown; cached
Hub metadata is explicitly labeled and is not a fresh content-integrity check.
VRAM uses file bytes plus estimated overhead, not a measured requirement. Publisher
details provide selectable quantization variants for new downloads.

**Delete** moves only the detected variant's files to Windows Recycle Bin. It
also works on existing shards of incomplete/broken inactive models. It does not
delete missing shards, repository directories, sibling variants or Ollama files
outside the configured library. Loaded files, links, stale selections and
overlapping downloads are rejected. Partial failures identify moved/remaining
files. Recycle Bin space is reclaimed only when the user empties it.
