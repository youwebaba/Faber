# Installing Faber Alpha 2.0

Run `Faber-Setup-Alpha-2.0-x64.exe`. This is a per-user Windows x64 installation with
Desktop/Start menu shortcuts and a normal `Faber.exe`; no terminal needs to stay
open. Electron and the local model runtime are included. Node.js, npm and Ollama
are not required to use the installed app's managed GGUF path. The compiled Rust
metadata worker is also included; Rust is not required for normal app use. Model weights are
separate: choose a download folder in Settings, download a compatible GGUF in
Models, then select **Downloaded models (local)**, Start, and **Use in this chat**.
The initial Local Ollama connection is optional and needs a separate Ollama server.

Quick start opens on first load. Choose **Continue with ChatGPT** to link an
eligible account in your system browser, or select local hardware before starting
a local model. Account connection does not require an API key; manual API
connections remain separate. See [CHATGPT.md](CHATGPT.md). Settings are also
available from **Edit → Settings** or Ctrl+,; UI scale and prompt presets are saved
in the profile. Claude connection is not yet available.

The bundled [Lightpanda addon](LIGHTPANDA.md) uses a dedicated WSL2 distribution.
Its verified browser tools set up and start that runtime on first use, then stop
it after browser sessions are idle. WSL2 must already be available; local chat and
model controls do not require WSL. The addon can be disabled or uninstalled in Addons. Online addon
sharing and over-the-air updates are not included.

The Alpha 2.0 prerelease installer is unsigned. Windows may display an
unknown-publisher warning.
Only use the artifact from the trusted project source; signing is not configured.

## Alpha 2.0 release identity and workbench

The interface/release name is **Alpha 2.0**. The internal package/app version is
`2.0.2-alpha.1` and the Windows build version is `2.0.2.0`, ordered above
`2.0.1-rm.beta.1` / `2.0.1.2`. Download the current prerelease installer from
[GitHub Releases](https://github.com/youwebaba/Faber/releases). Source/application
checks and release history are recorded in
[VERIFICATION.md](VERIFICATION.md); installer checksums and publication records
accompany the release assets.

The new internal version seeds `%LOCALAPPDATA%\FaberWorkbench\2.0.2-alpha.1`,
so it can load the new startup/readiness contract without reusing the old
RMb2.0.1 host/preload. Profiles, credentials, addons and configured model folders
are retained. Older workbenches/custom core edits stay available and are not
automatically merged. Reinstalling this same internal version preserves its
existing workbench; a same-version installer rebuild does not replace custom
source. Preparing this release does not itself install it.

## Updates and data

Close Faber and run the newer installer using the same Windows account. The
installer keeps application identity `ai.clocal.faber` and replaces program
files. Do not uninstall first. Chats, credentials, addons and the selected model
folder are retained outside the installation directory. No OTA update service,
addon publishing or online addon catalog is included. Alpha 2.0 adds
local Faber profiles; linked ChatGPT accounts remain provider connections.

| Location | Contents |
| --- | --- |
| Selected installation folder | Faber.exe, immutable bootstrap, bundled source and runner |
| `%LOCALAPPDATA%\Faber` (default unless an older location is retained) | Chats, encrypted keys, settings, downloads and update records |
| `%LOCALAPPDATA%\FaberProfiles\profiles.json` (Alpha 2.0) | Local profile registry and selected profile |
| `%LOCALAPPDATA%\FaberProfiles\profiles\<id>` (Alpha 2.0) | Each additional profile's private runtime data |
| Profile `boot-state.json` (Alpha 2.0) | Startup/readiness/clean-shutdown journal |
| Profile `upgrades\<id>\backup` (Alpha 2.0) | Core snapshots; records in `core-backup.json` / `last-core-backup.json` |
| Profile `chatgpt-credentials.bin` | Host-encrypted ChatGPT account sessions; never include in a bug report |
| Profile `addons\<id>` | Installed addon source visible in File Explorer |
| Profile `addon-data\<id>` | Private per-addon data retained by uninstall |
| Profile `addon-manager` | Approved code hashes and one prior addon version |
| Configured model downloads folder | Model weights; can be chosen in Settings |
| `%LOCALAPPDATA%\FaberWorkbench\<version>` | Editable source and tests used by staged core/UI self-upgrades |

An existing b1 profile stays in its original folder and is reused automatically.
No live profile is moved or overwritten during rebranding. Avoid running a
source-launched Faber and installed Faber concurrently against the same profile.

Each new internal application version seeds its own editable workbench. Older
workbenches and approved core modifications are retained, but are not automatically
merged into a new base. Addons remain in their current profile. Reinstalling the same
version preserves its existing workbench. The b1.1 transparent-logo rebuild is a
scoped exception: it refreshes only unchanged original branding files, adds the
SVG assets, and backs up replaced files in `.faber-branding-backup` inside the
workbench. Customized files stay intact; `.faber-branding-refresh.json` records
which files were preserved. Other content changes require a new internal version.

Uninstall removes application files and shortcuts; it retains profile, model and
workbench data. Addon removal/reset is described in [ADDONS.md](ADDONS.md).

## Startup and profiles

In Alpha 2.0, the renderer reports `app.uiReady` after initialization.
A loaded window alone does not mark startup ready. Failure to become ready within
one minute, or an incomplete prior startup/shutdown journal, selects Safe Mode
for the next launch. `--safe-mode` also requests it explicitly from the
installation directory:

```powershell
.\Faber.exe --safe-mode
```

For a source checkout, use `.\node_modules\.bin\electron.cmd . --safe-mode`.

Safe Mode suppresses automatic addon imports/seeding. Profiles, credentials,
workbench and addon private data stay in place; a reviewed addon can still be
explicitly enabled through normal approval. The banner offers addon management
and confirmed Restart normally. If editable application loading fails,
installer-owned recovery offers Safe Mode, rollback, Disable all addons,
Remove an addon, Open addons folder or Quit. Removal selects one ordinary addon
directory, skips executable cleanup and retains private data. Owned WSL/other
external resources may need manual cleanup. Safe Mode does not repair arbitrary
broken core code or profile data.

The switcher and **Settings → Profiles** create/rename/select profiles without
migrating the default. Switching restarts the app. Resolve or explicitly discard
unsent text/images/files/form edits; stop runs, wait for or cancel downloads,
and finish voice, UI refresh/source updates and external requests first. The host
rechecks these barriers and stops an idle gateway before switching. Profiles
share the versioned workbench, with no deletion API or OS security boundary.
An unreadable registry stops startup instead of silently choosing another profile.

**Settings → UI → Overall run time limit** accepts custom minutes or Off.
Changes affect active/future runs from their original elapsed start; a shortened
elapsed deadline stops work. Off preserves Stop/Force stop and separate tool/
network/gateway deadlines. **Settings → External access** remains off until
started; token rotation stops/cancels access. See [GATEWAY.md](GATEWAY.md).

## Recovery and self-upgrades

Models receive the shared file, shell, agent, addon and staged-upgrade tools.
New optional features should be local addons. Core/UI changes are staged and
verified against the writable workbench before approved activation. Renderer-only
changes can refresh in place; host/backend changes require restarting.

Rust source under `native/src/` uses the same staged workflow. Verification runs
the pinned compiler, Rust tests and the Node suite before enabling Apply. It needs
Rust 1.99.1 and Windows MSVC C++ build tools. Dependency sources are bundled, so
Cargo builds run locked and offline once the toolchain is installed. Ordinary
JavaScript/UI upgrades reuse the verified worker and require no compiler. See
[RUST_MIGRATION.md](RUST_MIGRATION.md) for the compiled artifact and recovery rules.

If an applied source upgrade breaks startup, close Faber and run
`Faber.exe --rollback-last` from its installation folder. Installer-owned recovery
can run without importing the broken workbench. It restores the last eligible
source upgrade, not arbitrary deleted data. Bootstrap, dependency/runtime binaries
and installer files are upgraded by a newer installer rather than the source
patch tool. Shell grants still confer the user's full Windows-account authority.

Alpha 2.0 saves a covered application snapshot before staged apply/
rollback and approved desktop shell commands. It includes source/assets, tests,
package manifests, build/scripts/docs, launchers and the active Rust worker.
Unchanged snapshots are reused only after source/backup hash checks; backup
failure prevents the mutation. Weights, profiles/credentials, runtime/dependency
caches and native vendor/target trees are excluded.

Snapshots live under `<profile>\upgrades\<id>\backup`, with `core-backup.json`
and `last-core-backup.json` records. Keep them private. Rollback still restores
only the last eligible staged-upgrade manifest and refuses newer unrelated edits;
a full core snapshot is not an automatic profile/system restore or a guarantee
against out-of-band changes.

## Build from source

Use Windows x64 with Node.js 24+, Rust 1.99.1 (`x86_64-pc-windows-msvc`), Visual
Studio C++ build tools, the checked-in npm lockfile, and the exact
reviewed runtime snapshot identified by `build/runtime-lock.json`:

```powershell
npm ci
npm exec -- install-electron
npm run prepare:native
npm run prepare:runtime
node scripts/prepare-lightpanda.mjs
& .\node_modules\.bin\electron.cmd build/render-logos.cjs
powershell -NoProfile -File build/make-icon.ps1
npm test
npm run privacy:check
npm run build:installer
```

The offline privacy gate checks tracked source, shipped text and the packaged
`app.asar` (including unpacked native workers) for personal names, home paths,
credential literals and private keys. Owned `native/bin` workers are also checked
for embedded ASCII/UTF-16 strings; extra workers outside the runtime manifest fail.
Before packaging, set `FABER_PRIVACY_TERMS` in the current shell to a JSON array
of local names/identifiers to block, then run `npm run privacy:check:release`.
Keep these values out of files, command transcripts and Git. If the OS username
is the complete identity to check on a clean generic machine, explicitly opt in
with `FABER_PRIVACY_USE_OS_IDENTITY=1` instead. Packaging fails without either
configuration. `npm run privacy:check` still checks paths/secrets and the OS
username without this release configuration; third-party legal attribution is
excluded only from name matching. Extracted source/workbenches without `.git`
use the packaging manifest; Git enumeration failures in checkouts stop the check.
Reports contain relative locations and
categories, never matched values. Images and third-party binary metadata require
separate review; this gate does not prove their absence of private data.

Runtime preparation reads the installed Ollama runtime directory by default;
`FABER_RUNTIME_SOURCE` can point to the same reviewed snapshot elsewhere.
Preparation and packaging reject differing or extra binaries. The runtime is
not downloaded implicitly. Maintainers must review compatible binaries and
licenses before deliberately recording a new runtime lock. Generated dependencies,
weights, local data, `.runtime` and `release` stay outside Git.

The supplied SVGs in `renderer/assets/` are the logo masters. Rendering them
regenerates the transparent PNG compatibility assets; the icon script then
builds the Windows ICO with the same transparency and subtle shadow.

Lightpanda preparation retrieves the pinned upstream Linux binary, matching
source, minimal Linux root filesystem and certificate bundle identified in
`build/lightpanda-lock.json`. Packaging verifies those resources; see
[LIGHTPANDA.md](LIGHTPANDA.md) for licenses, setup and ownership checks.
After deliberately editing a bundled addon's source, review the change and run
`npm run prepare:addons` to update its shipped approval digest before packaging.

Output is `release\Faber-Setup-Alpha-2.0-x64.exe`; the unpacked executable is
`release\win-unpacked\Faber.exe`. Installer revision, appId and versioned workbench
semantics are tested separately from deterministic unit fixtures. The optional
live GPU proof requires an existing model and explicit command-line flags; it is
not run by `npm test`. See [VERIFICATION.md](VERIFICATION.md) for actual evidence.
