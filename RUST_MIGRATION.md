# RMb2.0.1 — Rust Migration beta

This release moves GGUF metadata parsing into Rust while preserving the existing
features and public interfaces. It does not replace Electron, Node orchestration,
model-provider adapters or llama.cpp inference. Model discovery/grouping, model
IDs, UI controls, permissions and saved-data formats retain their existing rules.

## Processing boundary

`local-models/details.mjs` performs the same path validation and opens the model
read-only. `native/worker.mjs` starts the compiled worker with that descriptor as
stdin. Rust owns the bounded binary reads, integer/string validation, metadata
selection and tensor counting. The host validates the result, updates the shared
inspection budget and rechecks file identity before returning the existing shape.

The worker has no network listener or model tools. It returns one versioned JSON
response and exits. Cancellation terminates that process; the parent closes its
file handle. GGUF template text and weight payloads are not returned. The worker
is trusted host code running as the user, not an OS sandbox.

## Build and packaging

`native/rust-toolchain.toml` pins Rust 1.99.1. Cargo dependencies are locked and
vendored with their upstream checksums/licenses. On Windows, MSVC C++ build tools
must also be installed. The compiler is needed only to build or author Rust
upgrades; the installer includes the executable for normal use.
The Windows worker links its C runtime statically so it needs only Windows OS DLLs.

Run `npm run prepare:native` before `npm test`, source launch or packaging. This
runs Rust tests and an optimized build with `--locked --offline`, then publishes
`native/bin/<sha256>.exe` and `native/runtime.json`. Temporary compiler output is
outside the source tree. Generated binaries/manifests are excluded from Git and
included in the installer. Packaging rejects a stale source hash or altered worker.

The release label is `RMb2.0.1`; the package/workbench version is
`2.0.1-rm.beta.1`, and the Windows file version is `2.0.1.2`. The application ID and
profile locations remain unchanged. The new version seeds its own workbench and
preserves older workbenches and user data.

## AI-authored upgrades

Use the existing `upgrade_stage`, `upgrade_verify`, `upgrade_apply` and
`upgrade_rollback` tools. Do not directly rewrite running source or binaries.

1. Stage `.rs` changes under `native/src/` and any related supported JS/test edits.
   Cargo manifests/lockfile, vendor code, compiler configuration, build/integrity
   helpers and recovery bootstrap remain protected installer components.
2. Verification compiles and tests changed Rust in an isolated directory, checks
   source/artifact integrity, then runs all staged Node tests. Compiler failure,
   canceled work or test failure leaves the active source and worker unchanged.
3. Apply retains the current native binary, publishes the verified new binary
   without replacing an existing executable, and backs up the old source and
   manifest. Explicit activation confirmation still applies.
4. Backend changes require restart. A running backend keeps its original worker
   even after a new manifest is written. UI-only refresh rules remain unchanged.
5. Rollback restores the previous source and manifest after checking the saved
   hashes and old binary. Installer-owned `Faber.exe --rollback-last` remains
   independent of the editable application. No compiler is needed for rollback.

JavaScript/UI-only upgrades copy and verify the existing worker without invoking
Cargo. A missing compiler blocks Rust verification, not ordinary app use. The
build toolchain is found on PATH or in the user's standard `.cargo/bin` directory.

## Verification scope

Differential fixtures compare the new parser with the frozen previous parser in
`test/fixtures/legacy-gguf.mjs`; that copy is a test oracle, not a runtime fallback.
Existing details, shard, library, lifecycle and UI tests continue to exercise the
same interfaces. Artifact tampering, cancellation, compiled apply/rollback and
workbench retention have dedicated checks. See [VERIFICATION.md](VERIFICATION.md)
and local `release/verification/RMb2.0.1/` reports for actual results.

Metadata benchmarks do not establish faster token generation, model loading or
whole-application performance. Existing model context limits and lossy-summary
behavior are unchanged by this migration.
