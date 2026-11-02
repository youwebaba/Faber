# Local addons in Faber b1.1

Open **Addons** in the sidebar or **Manage addons** in Settings. Import a local
folder or a `.faber-addon.json` package. No catalog, publishing, account system,
online sharing, or automatic addon updates are included in this beta.

[Lightpanda Browser](LIGHTPANDA.md) ships as the first removable addon. Its
dedicated WSL2 runtime has an explicit setup action. A per-profile installation
record respects Disable, Uninstall and manual folder removal across updates.
Its verified cleanup hook removes the owned runtime before Uninstall or Reset
data; normal addon preferences otherwise follow the rules below.

Addons are executable trusted JavaScript with the Windows account's authority.
The native trust prompt covers the exact package hash before importing code.
Declared tool permissions go through the shared agent approval system, but do
not restrict what trusted addon JavaScript itself can do. This is not a sandbox.
Only install code whose source and author you trust. An addon cannot approve
itself. Package validation, path checks, and hashes are not malware detection.

## Manage an installed feature

- **Disable** unregisters tools and buttons and signals active addon tools to
  stop. **Enable** reviews and approves the currently installed bytes.
- **Uninstall** removes the feature's files and saved code versions while
  retaining its private data. Disable before **Reset data** to permanently erase
  only that feature's private data. Reset before uninstall for a clean removal.
- **Roll back** restores the previously installed code version after review.
  It does not undo private-data migrations or external effects.
- **Open addons folder** opens the current profile's `addons` folder. Every addon
  has its own `<id>/` folder. Removing that folder manually prevents activation
  at the next startup. Missing, changed, or invalid packages do not prevent
  other valid addons from loading. Changed bytes require fresh approval.

Restart completes cleanup after disabling or removing trusted code. Faber aborts
managed tool calls and invokes an optional `deactivate()` export, but cannot
forcibly stop arbitrary background work or undo arbitrary filesystem changes
performed by JavaScript running in its host. Async initialization has a deadline;
synchronous code that blocks the host still requires closing the application.

Private feature data is kept separately in the current profile's
`addon-data/<id>/` folder. Approval records and immutable
version caches are in `addon-manager/`. Do not include private data, credentials,
chat history, model weights, or dependencies in packages.

## Folder format

A folder contains `addon.json`, its entry `.mjs`, and optional helper modules or
assets. Packages are self-contained; b1 does not resolve addon dependencies or
install npm packages. Limits are 512 files and 32 MiB decoded content. Filesystem
links, path traversal, Windows device names and alternate data streams are
rejected. Paths inside packages use `/`.

```json
{
  "schemaVersion": 1,
  "id": "my-feature",
  "name": "My feature",
  "version": "1.0.0",
  "description": "A local tool and button",
  "entry": "index.mjs",
  "hostApi": 1,
  "permissions": ["read"]
}
```

The entry exports `manifest` and `tools`, using the existing extension contract:

```javascript
export const manifest = {
  schemaVersion: 1, id: 'my-feature', name: 'My feature', version: '1.0.0',
  actions: [{id: 'show', label: 'Show feature', tool: 'my_feature_show', fields: []}]
};
export const tools = [{
  name: 'my_feature_show', description: 'Show a local feature result', permission: 'read',
  parameters: {type: 'object', properties: {}, additionalProperties: false},
  async execute(args, ctx) {
    ctx.signal.throwIfAborted();
    return {message: 'Ready'};
  }
}];
```

IDs and versions must match `addon.json`. Tool names must be globally unique;
prefix them with the addon name. Every tool's permission must be declared in the
package. Actions reference that package's tools and use text, number, or boolean
fields. The renderer creates safe text buttons/forms; addon HTML is not injected
into chat. All models see registered tools through the same validated registry.

Tools receive the usual `ctx` plus `ctx.addon.id` and `ctx.addon.dataDir`. Store
feature-specific settings in that directory, respect `ctx.signal`, and release
optional resources in an exported `deactivate(context)` function. An optional
`uninstall(context)` hook cleans up owned external resources before code removal;
Faber uses the previously approved cached module, not changed/unapproved bytes.
The context contains `id`, `dataDir` and optional bundled `resources`. Avoid changing shared
state destructively; a code rollback cannot reverse such a migration.

## Single-file package format

A `.faber-addon.json` file is JSON with `schemaVersion: 1`, the same `manifest`,
and `files: [{path, content, encoding?}]`. Encoding is `utf8` by default or
`base64` for assets. The manifest becomes `addon.json`; do not list that file in
`files`. Importing another package with the same ID updates that addon and retains
one previous version for code rollback. ZIP import is not part of b1.

The AI tools are `addons_list`, `addon_install`, `addon_enable`, `addon_disable`,
`addon_uninstall`, `addon_reset_data`, and `addon_rollback`. The original
`extension_install`, `extension_sample`, and `extension_disable` remain supported.
Previously approved single-file extensions migrate once to per-addon folders.
If the old source no longer matches its approval, it is not executed.

Core engine changes remain staged workbench upgrades; they are not represented
as removable addons. The installer updates the shipped base and seeds a separate
versioned workbench, preserving the profile, local addons and downloaded models.
