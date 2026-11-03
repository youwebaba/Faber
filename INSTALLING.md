# Installing Faber b1.2rc

Run `Faber-Setup-b1.2rc-x64.exe`. This is a per-user Windows x64 installation with
Desktop/Start menu shortcuts and a normal `Faber.exe`; no terminal needs to stay
open. Electron and the local model runtime are included. Node.js, npm and Ollama
are not required to use the installed app's managed GGUF path. Model weights are
separate: choose a download folder in Settings, download a compatible GGUF in
Models, then select **Downloaded models (local)**, Start, and **Use in this chat**.
The initial Local Ollama connection is optional and needs a separate Ollama server.

The bundled [Lightpanda addon](LIGHTPANDA.md) uses a dedicated WSL2 distribution.
Its verified browser tools set up and start that runtime on first use, then stop
it after browser sessions are idle. WSL2 must already be available; local chat and
model controls do not require WSL. The addon can be disabled or uninstalled in Addons. Online addon
sharing and over-the-air updates are not included.

The beta installer is unsigned. Windows may display an unknown-publisher warning.
Only use the artifact from the trusted project source; signing is not configured.

## Updates and data

Close Faber and run the newer installer using the same Windows account. The
installer keeps application identity `ai.clocal.faber` and replaces program
files. Do not uninstall first. Chats, credentials, addons and the selected model
folder are retained outside the installation directory. No OTA update service,
addon publishing, account system or online addon catalog is included.

| Location | Contents |
| --- | --- |
| Selected installation folder | Faber.exe, immutable bootstrap, bundled source and runner |
| `%LOCALAPPDATA%\Faber` (new profiles) | Chats, encrypted keys, settings, downloads and update records |
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
merged into a new base. Addons remain in the shared profile. Reinstalling the same
version preserves its existing workbench. The b1.1 transparent-logo rebuild is a
scoped exception: it refreshes only unchanged original branding files, adds the
SVG assets, and backs up replaced files in `.faber-branding-backup` inside the
workbench. Customized files stay intact; `.faber-branding-refresh.json` records
which files were preserved. Other content changes require a new internal version.

Uninstall removes application files and shortcuts; it retains profile, model and
workbench data. Addon removal/reset is described in [ADDONS.md](ADDONS.md).

## Recovery and self-upgrades

Models receive the shared file, shell, agent, addon and staged-upgrade tools.
New optional features should be local addons. Core/UI changes are staged and
verified against the writable workbench before approved activation. Renderer-only
changes can refresh in place; host/backend changes require restarting.

If an applied source upgrade breaks startup, close Faber and run
`Faber.exe --rollback-last` from its installation folder. Installer-owned recovery
can run without importing the broken workbench. It restores the last eligible
source upgrade, not arbitrary deleted data. Bootstrap, dependency/runtime binaries
and installer files are upgraded by a newer installer rather than the source
patch tool. Shell grants still confer the user's full Windows-account authority.

## Build from source

Use Windows x64 with Node.js 24+, the checked-in npm lockfile, and the exact
reviewed runtime snapshot identified by `build/runtime-lock.json`:

```powershell
npm ci
npm exec -- install-electron
npm run prepare:runtime
node scripts/prepare-lightpanda.mjs
& .\node_modules\.bin\electron.cmd build/render-logos.cjs
powershell -NoProfile -File build/make-icon.ps1
npm test
npm run build:installer
```

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

Output is `release\Faber-Setup-b1.2rc-x64.exe`; the unpacked executable is
`release\win-unpacked\Faber.exe`. Installer revision, appId and versioned workbench
semantics are tested separately from deterministic unit fixtures. The optional
live GPU proof requires an existing model and explicit command-line flags; it is
not run by `npm test`. See [VERIFICATION.md](VERIFICATION.md) for actual evidence.
