# Lightpanda Browser addon

Faber b1.1 includes Lightpanda 1.0.2 as its first removable bundled addon.
It is the real Lightpanda engine. Upstream does not provide a native Windows
binary; this release runs its Linux x86_64 binary in a dedicated WSL2 distro.
No Chromium substitution, Docker dependency, browser account, or paid API is used.

## Setup and browsing

Open Addons, confirm Lightpanda is enabled, then use **Set up Lightpanda (WSL2)**
in the action list or the `lightpanda_setup` tool. Existing working WSL2 is
required. Setup imports the bundled Ubuntu Base root filesystem into an owned
`FaberLightpanda-<profile hash>` distro. It never enables Windows features,
requests a reboot, installs WSL itself, or reuses another distro. If WSL2 is
unavailable, the tool reports the actual error and leaves the addon available
for a later retry. Import is a bounded critical operation: cancellation waits
for it to settle before removing the owned incomplete runtime.

Every model and delegated agent sees the same registered tools:

- `lightpanda_status`, `lightpanda_setup`, `lightpanda_configure`, `lightpanda_connect`.
- `lightpanda_navigate`, `lightpanda_read`, `lightpanda_click`, `lightpanda_type`,
  and `lightpanda_evaluate`.
- `lightpanda_close` closes this chat's context; `lightpanda_stop` closes all
  addon pages and stops the dedicated runtime.

Setup and runtime control require computer permission. Browsing and page
interaction require network permission; starting the owned browser from a
browsing tool also requests computer approval. Click, type and evaluate can
cause real website effects, including submitting forms. Approval is not a
guarantee that a page is trustworthy. Returned page content is marked untrusted.

Each chat gets its own browser context. The CDP endpoint binds to loopback only;
no public browser server is started. The browser runs as an unprivileged Linux
user, with Windows drive automount and Windows interop disabled and Lightpanda
telemetry disabled. This does not turn trusted addon JavaScript into a sandbox.
Other programs under the same Windows account can still reach loopback services.

An optional existing Lightpanda server can be selected with
`lightpanda_configure` using mode `cdp` and an uncredentialed loopback `ws://`
endpoint. Faber verifies the Lightpanda `LP.getPageStatus` CDP domain instead of
trusting its compatibility Chrome version string. Disconnect never stops an
externally supplied server.

## Disable, uninstall and manual removal

Disable unregisters the tools, aborts current browser operations and stops the
owned browser/distro. Enable restores tools without importing a new runtime.
Uninstall invokes the approved cleanup hook and unregisters only the distro
whose generated name, registered directory and ownership marker match this
addon's private data. Mismatches fail closed instead of removing another distro.
Uninstall preserves ordinary addon preferences but removes its owned WSL runtime.
Reset data on a disabled bundled addon first runs the verified runtime cleanup
hook, then removes preferences and ownership records. If cleanup fails, private
data remains available for diagnosis instead of leaving an unowned distro.

Removing the addon folder manually prevents activation at the next restart.
It does not execute cleanup code: use Uninstall before removing files when you
also want the WSL runtime removed. If approved cached cleanup code is missing or
changed, Uninstall removes the addon files and reports that external cleanup was
skipped. Never manually unregister an unrelated distro to resolve that warning.

Bundled installation is recorded once per profile. Disable, Uninstall and manual
folder removal survive restart and subsequent installers; they do not silently
reinstall the feature. The installer retains dormant factory archives and source
notices under its resources directory. Those archives do not start a browser or
recreate an uninstalled addon. Ordinary imported addons retain their 32 MiB limit.

## Scope and limitations

Lightpanda is a headless DOM and JavaScript browser. These tools do not provide
visual screenshots, pixel clicking, browser extensions, a visible browser tab,
or access to your existing browser cookies/profile. Website support depends on
Lightpanda's implemented web APIs; some sites will fail or render differently.
File upload inputs are refused. Read returns up to 200,000 text characters with
an explicit truncation flag, 200 links and 100 form fields. Page evaluation is
bounded by a 10-second execution timeout and a 512 KiB result limit. Password
field values are omitted from ordinary reads; evaluating page JavaScript is a
powerful permission, not a privacy boundary.

## Pinned distribution and source

`build/lightpanda-lock.json` records every bundled payload's URL, exact byte
length and SHA-256. Build verification rejects altered or additional payloads.
Setup verifies the executable, root filesystem and certificate bundle again.

- Lightpanda 1.0.2, source commit
  `c5f7bb29b127040c899d4e181b5709f76fc71a6f`, unmodified upstream Linux release.
  [Source](https://github.com/lightpanda-io/browser/tree/c5f7bb29b127040c899d4e181b5709f76fc71a6f)
  and [release](https://github.com/lightpanda-io/browser/releases/tag/1.0.2).
  AGPL-3.0-or-later license and exact corresponding project source archive are
  included as `resources/lightpanda/LICENSE-AGPL-3.0.txt` and
  `resources/lightpanda/lightpanda-source.tar.gz`. Upstream dependency/build
  references remain in that source archive. No Lightpanda source modifications
  are made by Faber.
- [Ubuntu Base 24.04.5 amd64](https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/):
  upstream rootfs and published SHA256SUMS are included. Individual package
  copyright/license notices remain inside `/usr/share/doc`; corresponding Ubuntu
  package source is available through [Ubuntu's archive](https://archive.ubuntu.com/ubuntu/).
- [Mozilla CA bundle extracted by curl](https://curl.se/docs/caextract.html),
  dated 2026-10-20, includes its copyright/source notice. The full MPL-2.0 license
  accompanies it as `LICENSE-MPL-2.0.html`.

These third-party notices do not change the licenses of their respective
components. Faber does not claim ownership of Lightpanda, Ubuntu or Mozilla code.

## Verification

`node --test test/desktop-lightpanda.test.mjs test/desktop-bundled-addons.test.mjs`
uses transport and process fixtures without creating a distro. The explicit
opt-in command below creates a unique temporary profile and owned WSL runtime,
serves a controlled page only on the WSL virtual adapter, exercises real CDP
navigation/type/click/read/evaluate, verifies Disable and Uninstall, and writes
an isolated report. It never uses normal browser/profile data or model inference.

```powershell
node test/desktop-lightpanda-live.mjs --allow-owned-wsl-fixture
```
