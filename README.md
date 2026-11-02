# Faber b1.0

A Windows desktop workspace for local and API-connected AI agents. Bill's
October 31, 2026 direction is a fresh harness with a Codex-style interface,
shared tools, agent delegation, voice, and upgrades the agents can author.
This application lives beside the original Sophia and the Hermes developer app.

This is Beta 1.0. The [verification record](VERIFICATION.md) distinguishes tested
behavior from remaining hardware and release checks.

## Beta desktop release

The b1.0 installer installs **Faber.exe** and shortcuts without a terminal window.
It includes Electron and a local model runner with CPU, CUDA and Vulkan backends;
model weights are downloaded separately. Existing `SophiaHarness` profile data
and the selected model library remain in their original locations.

**Models** provides a grid of local variants and download cards. Click a card for
details. The library scans real files; a completed transfer record alone does
not prove a model is still present. **Delete** moves the selected variant's actual
files to Windows Recycle Bin, including existing files of an incomplete variant.
It refuses active models and overlapping downloads. Emptying Recycle Bin is a
separate user action; deletion does not immediately reclaim the model's space.

The managed local model picker offers automatic, CPU and custom hardware modes,
GPU and CPU resource selection, threads, and disk-backed model memory. These
settings control the harness-owned runner, not remote API servers or another
application's Ollama server. Requested settings and observed placement are shown
separately. Memory mapping is not disk-as-VRAM and cannot disable Windows paging.
There is no new harness context or turn limit.

**Addons** manages local feature packages and their tools/buttons. See
[ADDONS.md](ADDONS.md) for the import format, trust model, reset/removal and
AI-authoring contract. Online addon sharing and OTA updates are not included.

The installed base seeds an editable, versioned workbench for reviewed core
self-upgrades. A subsequent installer preserves the existing profile and addons,
and starts its own version's workbench rather than silently applying old core
patches to new application code. Source-mode setup remains available below.
See [INSTALLING.md](INSTALLING.md) for installation, updates, recovery and builds.

## Run

Requires Windows, Node.js 24 or later, and the npm dependencies in the lockfile.
Use `Start-Faber.cmd` to launch the built executable when present, or set up and
launch the source app. For manual setup, run `npm ci`, `npm exec -- install-electron`,
then `npm start` in this folder. `npm test` runs deterministic checks. `npm run smoke`
checks the desktop with isolated data; it does not prove a model can complete
arbitrary tasks.

`npm run smoke:live` additionally sends real requests to the local Qwen model
through the actual composer and checks tool results and Stop. The microphone is
not used by either desktop smoke command.

For the local connection, run the installed Ollama service, choose Local Ollama
in the connection settings, and test `http://127.0.0.1:11434`. Select an installed
model with tool support, such as the existing `qwen3.5:9b` on this PC. No model
download or cloud fallback is implicit. A connection check lists models; it does
not establish their reasoning, vision, or tool-use quality.
Endpoint redirects are rejected. API keys require HTTPS except on loopback.

## Connect a cloud model to a chat

Click the model selector beside the composer, then **Add cloud/API connection**.
You can also add connections in Settings. Choose **OpenAI Responses API** for
OpenAI models using harness tools. Enter your API key in the app, select an exact
model ID, and optionally set the reasoning effort. Suggested IDs are
`gpt-6-astra` and `gpt-6.1-sol`; availability depends on your API account.
**Save & list models** checks access to the model catalog without sending an
inference request. **OpenAI-compatible Chat Completions** supports other servers
implementing that protocol, with their own endpoint and model IDs.

Saving a connection leaves the chat's model unchanged. Select the connection
and model, then **Use in this chat** to apply it to the next run. The composer
shows both connection and model. Cloud calls send conversation text and tool
results to the selected endpoint and use the provider's API billing. API keys
remain in the encrypted host store. Editing an endpoint's origin requires
explicitly replacing or removing its saved key; finish or stop active runs
before editing their connection.

Cloud models receive the same agent, file, PC and staged-upgrade tools as local
models, under the existing approvals. No cloud fallback is automatic. OpenAI's
[model guide](https://developers.openai.com/api/docs/guides/latest-model)
requires Responses for Astra and GPT-6.1 Sol tool calling; a connection catalog
check does not prove inference access or task quality.

The harness sends full conversation text and tool results without its former
character/message budget or turn-count cutoff. Model/provider context limits
still apply, and sending more history can increase API usage. Ollama uses its
server/model context configuration. Stop remains available, and the existing
run timeout (ten minutes by default) still applies.

Chat and agent inspection tools return message/result references instead of
embedding another full transcript. Selected messages and tool results remain
readable on demand. Existing inspection snapshots are compacted only in model
input; the saved transcript is preserved. Ordinary conversation content and
tool results are still sent in full.

The chat's **Activity → Token usage** view lists each model call's input and output counts
reported by the provider, including calls made between tool executions. Missing
usage is labeled **Not reported**, including older calls recorded before this
feature. Cached input and reasoning counts, when reported, are included within
the input and output totals. These are usage counts, not the rate-limit error's
requested-token estimate or a billing calculation. Responses and Ollama report
usage directly; Chat Completions connections are asked for streaming usage.

Paste an image into the message box with **Ctrl+V**. Review or remove its preview,
then send it with text or on its own. PNG, JPEG and WebP are supported, up to
eight images and 8 MiB of encoded attachment data per message. Image drafts stay
with their chat until sent or removed. Sent images remain in that chat's model
context, so use a model that supports vision. Images are sent to the selected
connection along with the conversation; changing the connection changes where
future requests are sent. Clipboard image drafts are held in memory, like text
drafts; restarting the app clears unsent drafts.

## Find and download models

Open **Models** in the sidebar to search Hugging Face. Results show parameter
counts, available weight sizes and labeled VRAM estimates. Select a repository
to inspect its files. The GGUF quantization picker groups published variants by
nominal bit depth, shows their combined sizes, and selects every shard in the
chosen variant. Incomplete shard sets cannot be downloaded through the picker.
Unrecognized formats and supporting files remain available through manual file
selection. The **Download** button starts a background transfer. **Downloads &
library** shows progress, bytes per second, destination, errors and Cancel.

In **Settings → Model downloads**, choose the destination for future downloads.
The default is `%LOCALAPPDATA%\SophiaHarness\models`. Existing files and active
transfers stay in their original folder. An optional Hugging Face read token is
stored using the desktop's encrypted secret store; accept gated-model terms on
Hugging Face before downloading restricted files.
Use a local folder on a filesystem supporting hard links, such as NTFS.
Interrupted transfers do not resume; a crash may leave a hidden `.partial` file.

Agents have `hf_search_models`, `hf_model_details`, `hf_download_model`,
`hf_download_status`, `hf_cancel_download` and `hf_set_download_directory` in
their shared tool registry. Downloads use the same manager and appear in the
same UI. Agent downloads require network and file permissions.

To load a downloaded model, open the model selector beside the composer and
choose **Downloaded models (local)**, or a local Ollama connection. The local
model dropdown reads the folder configured in **Settings → Model downloads**.
Click **Refresh folder** after adding files manually. Complete GGUF files and
shard sets can be started; incomplete downloads, auxiliary files and unsupported
formats cannot be loaded through this picker.

Choose a model and click **Start model**. Downloaded GGUFs run directly in a
managed local server; existing Ollama models load through Ollama. Loading status
and failures appear in the selector. Click **Use in this chat** when ready to
apply the connection and model. **Stop model** unloads it; active chats using
that model must be stopped first. Starting does not download weights or change
the chat's selection. See [local model controls](LOCAL_MODELS.md) for runtime
requirements and supported formats.

Downloaded files still need a runtime that supports their architecture and
format. This feature does not convert weights.
VRAM is a heuristic, not a fit guarantee. The [Hub contract](HUGGINGFACE.md)
describes metadata sources and transfer behavior. `npm run smoke:models` checks
the real desktop using controlled metadata and streamed test files.

## How the pieces fit

The sandboxed interface talks to the desktop host through a small request/event
bridge. The host owns Windows integration and key encryption. The agent runtime
owns projects, conversations, runs, approvals, and the shared tool registry.
Model adapters translate that same conversation and tool contract for native
Ollama or an OpenAI-compatible API. A different adapter can be added without
rewriting the interface or individual tools.

Every agent sees the same registered tools. Delegation creates another durable
chat and a child run. Children inherit the parent's permissions. Stop propagates
to descendants and pending approvals; interrupted work is not replayed on
restart. Coordination tools can read and message other harness chats/projects.
They do not automatically control chats in a different product.

Modules are ordinary source files behind the contracts in [CONTRACT.md](CONTRACT.md).
An extension registers tools plus declarative UI actions. The interface creates
buttons and argument forms from those actions, allowing an added feature to
have a visible entry point. Core and interface changes use staged upgrades,
verification, activation, and backups for rollback.

## Upgrade and recover

An agent can inspect source with the file tools, call `upgrade_stage` with the
changed files, run `upgrade_verify`, and request `upgrade_apply`. Activation
shows the changed file list and retains source backups. Renderer-only changes
refresh the interface without restarting the desktop host. Running chats,
downloads and loaded models stay in that host. Composer text and attachment
drafts are handed to the refreshed page through temporary host memory.

Refresh waits while you are editing a form, browsing Models, sending a message,
reading attachments or using voice. A notice explains when an update is waiting.
**Settings → Refresh interface** also loads UI edits made through the normal
development workflow. It refuses to refresh if backend source has changed since
startup. Unsubmitted connection credentials and other form fields are not copied
into the handoff; finish or close those forms first.

Core, desktop, preload, tool implementation and model-manager source changes
still require **Settings → Restart app**. Mixed UI/backend upgrades also require
a restart, so a new interface cannot silently run against an old backend.
Test-only changes need no runtime activation. The updater reports the required
action; it does not watch source files or restart automatically.

`upgrade_rollback` restores the last upgrade, including after a restart, and
uses the same UI-versus-backend activation rules. If a broken version cannot
open, close the app and run:

```powershell
.\Start-Sophia-Harness.ps1 -RollbackLast
```

The recovery entry point does not import the potentially broken application.
Rollback checks backup integrity and refuses to overwrite later unrelated edits.
Unapplied stages expire when the app closes. The staged updater excludes package
dependencies, launchers, and the recovery module; changing those requires the
normal development workflow. Staged tests execute local code with host authority.
Verification checks the available tests, not every possible effect of a change.

Use `extension_sample` to enable the bundled Workspace summary tool and button.
`extension_install` accepts a single-file module with a versioned manifest,
tools, and UI action definitions. The source digest is approved before loading;
approved extensions persist and changed bytes require a new installation.
Approved extension installations replace their tools and UI actions live.
The UI draft handoff survives an interface refresh only; it is not a persistent
draft backup and is cleared when the desktop process exits.

## Access and privacy

Runtime data belongs under `%LOCALAPPDATA%\SophiaHarness`, outside the checkout
and OneDrive. API keys belong in the desktop's encrypted secret store; snapshots,
tool metadata and source control must never contain them. The microphone starts
off. Voice mode must show its actual listening or error status; assistant mode
uses the selected chat's configurable activation phrase.

Files in the selected project and harness state are available through scoped
tools. Wider file access, shell commands, PC interaction, network access and
upgrades require an approval or an explicit chat grant. Those grants are actual
Windows-account authority. Shell commands and executable extensions are trusted
code, not an operating-system sandbox. Agents cannot approve their own pending
requests or grant themselves permissions. Changes to source are reviewable and
can be tested; passing tests does not make arbitrary generated code safe.

## Development

- [CONTRACT.md](CONTRACT.md): module ownership, bridge, state and tool contracts.
- [REQUIREMENTS.md](REQUIREMENTS.md): requested capabilities and acceptance work.
- [VERIFICATION.md](VERIFICATION.md): integrated evidence and limitations.
- [HUGGINGFACE.md](HUGGINGFACE.md): model browser, downloads and agent tools.

No existing Sophia data, credentials, startup configuration, devices or model
routes are migrated by installing this separate application.
