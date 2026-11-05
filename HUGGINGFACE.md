# Hugging Face model browser and downloads

Browse Hugging Face models with size, parameter count and VRAM information
where available. Users and agents can download models with progress and speed
tracking, and choose the destination in Settings.
This feature downloads files. Loading them for inference still requires a
compatible local runtime; downloaded does not mean installed or running.

## Implementation boundary

- Hub agent owns `model-hub/` and `test/hub*.test.mjs`: API metadata, estimates,
  persistent settings/download jobs, bounded streaming transfers and tool API.
- UI agent owns renderer additions: model browser, file selection, progress and
  Settings. Preserve the existing interface and keep model-hub UI in a module.
- Integration agent owns desktop bridge/start/close wiring and desktop smoke
  tests, plus independent integration review. Preserve unrelated edits.

`model-hub/index.mjs` exports async
`createModelHub({dataDir,sourceDir,host,emit,fetchImpl?})`. It returns
`request(method,args={})`, `tools()` and async `close()`. Host supplies existing
`getSecret`, `setSecret`, `chooseDirectory`, `openPath`; the integration host may
also supply `openExternal` for validated Hugging Face HTTPS model pages only.
Use existing core schema validation and tool grants; no new dependency required.

The desktop allowlists these requests and delegates to the hub manager:

- `models.state` → `{downloadDirectory,hasToken,downloads:[]}`.
- `models.search` `{query?,limit?,format?}` → `{models:[]}`. Default list popular
  public models, bounded result count; format is `all`, `gguf` or `safetensors`.
- `models.inspect` `{repoId,revision?}` → model summary plus pinned `revision`,
  `files:[]`, `quantizations:[]` and `totalBytes` for the current revision.
- `models.download` `{repoId,revision,files?:string[],quantizationId?:string}`
  → background download job. Supply exactly one selection method. A variant ID
  expands its authoritative file list after re-inspecting the pinned revision.
  Never automatically fetch every quantization.
- `models.cancel` `{id}` → updated job.
- `models.settings.save` `{downloadDirectory?,token?,clearToken?}` → hub state.
  Blank omitted token retains the current encrypted credential.
- `models.chooseDirectory` `{}` → `{path:string|null}` (does not save itself).
- `models.openDirectory` `{id?}` → open the job folder or configured root.
- `models.openPage` `{repoId}` → open the canonical Hugging Face model page.

The manager emits `{type:'models',state:<hub state>}` on changes and throttled
progress updates (about 4 per second). Renderer network remains disabled;
metadata and transfers are host-owned. Keep settings/query controls intact when
progress arrives.

Model summary:
`{id,revision?,parameters:number|null,parameterSource?,sizeBytes:number|null,sizeLabel,formats:[],vram:{bytes,basis,note,estimated:true}|null,downloads?,likes?,gated?,pipelineTag?}`.
File: `{path,size:number|null,sha256:string|null,weight:boolean,format,vram?}`.
Quantization:
`{id,label,encoding,bits,files:string[],sizeBytes:number|null,vram,complete,reason?}`.
Identity includes the exact directory and model stem, so unrelated variants
with the same encoding stay separate. Bit depth is the nominal encoding family,
not a measurement of every tensor. A split variant includes all numbered shards;
missing, duplicated or inconsistent shards make it unavailable for variant
download. Unknown names and auxiliary weights remain in the manual file list.
Sizes and VRAM estimates describe the entire selected variant. This downloads
published quantizations; it does not convert weights into another quantization.
Job:
`{id,repoId,revision,status,directory,files:[],quantizationId?,quantizationLabel?,downloadedBytes,totalBytes,speedBytesPerSecond,progress,createdAt,updatedAt,error?}`.
Job status: `queued`, `downloading`, `completed`, `canceled`, `failed`,
`interrupted`. Progress is `0..1` or null if unknown. Job file entries retain
path/size and per-file status/bytes. The destination is fixed when a job starts;
changing Settings affects future downloads and never moves existing models.

Registered AI tools: `hf_search_models`, `hf_model_details`,
`hf_download_model`, `hf_download_status`, `hf_cancel_download`,
`hf_set_download_directory`. Searches/details need network permission; download
needs network plus explicit files approval for its fixed destination/size.
Status/cancel do not grant new authority. The settings tool needs files approval
and never exposes or changes credentials. Jobs run in the background, with a
dedicated Cancel action; shutdown stops transfers and restart marks unfinished
jobs interrupted rather than replaying them. Honor originating run cancellation
while that run remains active.

## Data and transfer requirements

Default destination: `dataDir/models`, outside Git and OneDrive. Reject unsafe
or protected destinations and path traversal, Windows reserved names/ADS, and
symlink escapes. Do not overwrite existing mismatched files. Commit a file only
after its advertised byte length and available SHA-256 are verified. Persist
completion only after publication. Partials are never labeled completed.
Stream data to disk with backpressure using a bounded 1 MiB write buffer per
transfer. Flush full buffers, the final tail, and a received partial batch after
250 ms; progress counts completed writes. Bound concurrent transfers and reject
overlapping output paths. Length/hash verification and cancellation still apply.

Safe publication currently requires hard-link support, such as NTFS. A small
preflight checks this before transferring model bytes and gives an actionable
error for unsupported destinations. A canceled transfer removes its temporary
file. A process/OS crash can leave a hidden `.partial` file in the job folder;
interrupted jobs identify this possibility. Partial transfers do not resume.

Build metadata URLs from validated repository IDs, never arbitrary URLs from a
model card. Pin downloads to the inspected commit. Metadata must not redirect;
file downloads may follow bounded HTTPS Hugging Face/CDN redirects, with no
credential forwarding to CDN origins. Optional tokens use the existing encrypted
host secret store under `huggingface`. Show gated/auth/rate-limit failures as
actionable errors. Do not execute repository code or automatically load weights.

## Metadata and verification

Parameter counts come from explicit Hub `safetensors.total` or `gguf.total`, not
names. Search `gguf.totalFileSize` can describe a representative GGUF variant,
not the repository total. Live inspection of `unsloth/Qwen3.8-27B-GGUF` found
that field matched its Q4_0 file while the repository contained many variants.
Current file sizes come from model detail `siblings` with `blobs=true`. Label
representative sizes, aggregates and unknowns distinctly. Small MTP/mmproj files
are auxiliary weights, not a complete model. The live API rejects `usedStorage` in search `expand[]`, despite
some generated docs listing it; use supported fields.
It also rejects `expand[]=id`; the model ID is returned implicitly. Search
Safetensors sizes use explicit dtype counts where available, are labeled as
estimates, and exclude file headers. File inspection gives exact known sizes.

VRAM is a labeled approximation for weights plus a stated heuristic reserve,
not a fit guarantee. Multiple quantizations, KV cache, context, batching, CPU
offload and runtime support affect actual use. Prefer explicit dtype counts or
selected weight file sizes; do not infer a whole model's VRAM from one shard.

Primary references: [Hub API](https://huggingface.co/docs/hub/api),
[downloads](https://huggingface.co/docs/huggingface_hub/en/guides/download), and
[memory estimator caveats](https://huggingface.co/docs/accelerate/usage_guides/model_size_estimator).

Use deterministic tests for malformed metadata, estimates, HTTP errors,
credential redirects, file containment, concurrent jobs, streamed progress,
cancellation, byte/hash mismatch and persistence/restart. Initial live proof used
public search/details and the 453,864-byte `model.safetensors` from
`hf-internal-testing/tiny-random-gpt2` at
`71034c5d8bde858ff824298bdedc65515b97d2b9` (SHA-256
`8111d5afb0715dbf5a31396d31432cb56370ba23f6650a035ea0fc8a20b4e500`).
No large model download, paid service, inference-provider change or execution of
downloaded code is needed to verify this feature.

The controlled desktop flows and the single public download passed. November 4
checks also compared bounded ranges from a pinned large GGUF; those short samples
do not establish sustained full-model throughput. See [VERIFICATION.md](VERIFICATION.md)
for the report locations and remaining limits.
