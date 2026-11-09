# Local Music3 generation

Download a **MiniMax Music3** package in Models → Browse from
[Serveurperso/MiniMax-Music3-GGUF](https://huggingface.co/Serveurperso/MiniMax-Music3-GGUF).
Choose one variant for each of its five components: language model, RVQ depth
decoder, transformer, condition encoder and vocoder. Keep them together in the
private model library. A partial download or ambiguous component selection is
unavailable for generation. The package is a music pipeline; it is not a chat model.

Ask the chat agent to use `music_generate` with the package ID from
`local_models_list`, a musical caption and section-tagged lyrics. Instrumental
requests still need lyrics, for example `[instrumental]`. The tool requires the
chat's files permission, which covers writing the generated audio attachment.
Generation runs locally without a paid API or cloud fallback.
The chat's overall run time limit also applies; increase it or choose Off in
Settings before a longer CPU generation if needed.

The bundled Windows x64 runner supports CPU generation. It does not use the
chat model's CUDA/Vulkan hardware settings. CPU generation can be slow and
requires enough free system memory for the selected components. The pipeline
evicts the language model before loading the synthesis stage. A compact choice
is Q5_K_M language model, Q8_0 depth decoder, Q4_K_M transformer and the two F32
components (about 8.8 GB of downloads; memory use also includes working buffers).

The default request targets 30 seconds, 30 synthesis steps and seed 42. Optional
`duration` accepts 1–360 seconds, `steps` accepts 2–100 and `seed` accepts a
32-bit unsigned integer. The model can end earlier than the requested duration.
Only one music generation runs at a time. Stop cancels its owned subprocess;
interrupted jobs are not resumed automatically. Temporary request/replay files
are removed when the operation ends.

Completed songs appear as WAV audio in chat, with the normal playback and Save
As controls. Paired remote chats use the existing encrypted, chat-owned media
transfer in chunks of at most 256 KiB. Audio bytes do not enter model history.
The shared chat media store validates the WAV signature and enforces its 512 MiB
attachment limit. Generated media survives restart with its chat.

The runner reads GGUF tensors only. Faber validates all five component
architectures, refuses links and incomplete packages, reserves selected files
against managed download/deletion, and supplies exact filenames to the runner.
Repository Python/model code is never imported. User-selected weights remain
subject to their own license, including the
[MiniMax-Music3 Community License](https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE).

## Runner preparation and verification

The installer includes the runner; ordinary use requires no compiler. The
source-built engine is pinned to minimaxmusic.cpp commit
`35ba334b4d23b5a8e631e3c2d97f074a185e41d4` and ggml commit
`210138933b22221ced02943b7b6e4308610ab530`. Both use MIT licenses.
Their exact DLLs, executable and notices are recorded in
`build/music-runtime-lock.json`; generation and installer builds verify those
digests and reject extra backend files. Microsoft runtime notices and the
yyjson/minimp3 notices accompany the payload.

Build the pinned upstream source and its pinned submodule with MSVC x64 using
CMake Release, `GGML_BACKEND_DL=ON`, `GGML_NATIVE=OFF`,
`GGML_CPU_ALL_VARIANTS=ON`, `GGML_CUDA=OFF`, `GGML_VULKAN=OFF`, then build the
`mm-synth` target. Provision using explicit local inputs:

```powershell
npm run prepare:music -- --source <upstream-checkout> --build <build-output> --redist <MSVC-x64-redist>
```

`--record` is only for reviewing and pinning a changed runtime. Ordinary
preparation must match the checked-in lock. `npm test` includes deterministic
request, component, cancellation, media and runner-integrity checks. For an
explicit real inference smoke with downloaded weights:

```powershell
node test/music-live-smoke.mjs <absolute-model-directory> <absolute-private-evidence-directory>
```

That smoke generates a four-second, two-step sample through the shared tool
registry, reads its durable media in bounded chunks, checks stereo PCM and a
non-silent waveform, and records measured output. It does not establish musical
quality, typical generation speed or browser playback by itself.

The completed a2.5 real generation and generated-audio local/remote playback
results are in [Music3 verification](docs/a2.5-music-verification.md).
