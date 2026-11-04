# Faber browser

**Browser** opens a tabbed dock beside the chat. Drag its divider to change the
remembered width. The address bar accepts URLs and searches. Back, Forward,
Reload, Stop, new tabs and tab closing work in the selected chat's browser.
History, bookmarks, downloads, Find and page zoom are in its menu.

Each chat, including child agents, has a separate website session. Tabs within
that chat share sign-ins. Open tabs, website storage, ownership, bookmarks and
history survive restart. Metadata restores lazily: websites do not navigate or
mount until explicitly used. Closing a tab retains its website sign-ins. Stopping
an agent preserves tabs and cookies. Saved human ownership stays paused after
restart; saved agent ownership stays available. Older records without ownership
default to human control.

## Monitoring and takeover

Agent mode shows actual Chromium screenshots, normally twice per second, for
the watched tab only. Background tabs do not generate monitor screenshots. The
watched page uses the pane's actual viewport dimensions to fill it. An unmonitored
new tab defaults to 1280 × 800 CSS pixels. Every screenshot/snapshot reports the
actual viewport; resize, navigation and input invalidate old observations.

**Take over** mounts the same Chromium page as a native interactive surface.
Normal clicking, selection, typing, copy/paste, forms and file inputs work
directly. Address-bar navigation and tab controls acquire human control too.
All agent browser tools for that chat pause, including reads and screenshots,
while the user works or signs in. This pauses model continuation. **Resume browsing**
releases those waits as stale operations: old clicks and typing are never
replayed. The agent must observe again. Stop, closing the last tab/chat, and app exit settle
waits promptly.

The native page mounts only after ownership transfer finishes and inside the
measured page slot. It hides for collapsed panels, modals, drawers, divider
dragging, minimized windows and loss of foreground focus. Agent monitoring can
continue while another application has focus. Showing/resizing a page never
activates a Windows window. Agent input uses Chromium's page-local DevTools
transport, never OS pointer movement, keyboard injection or the clipboard.

A hidden, non-focusable parking window keeps the same page renderable between
native attachments. Screenshot and viewport changes run in order, with one
compositor subscription around each raw capture. Ctrl+L/T/W, Ctrl+Tab
and Ctrl+Shift+Tab, Ctrl+F and Ctrl+Plus/Minus/0 operate within browser focus.
They do not intercept the chat composer. An actual human browser key may return
keyboard focus to the toolbar; agent activity does not.

## Shared tools

All main and child agents receive the same validated tools. Optional `tabId`
defaults to the calling chat's active tab. Tools cannot supply another chat's ID.

| Tool | Use |
| --- | --- |
| `browser_open {url,tabId?}` | Open or reuse a tab. |
| `browser_navigate {url,tabId?}` | Navigate an existing tab. |
| `browser_tabs {}` | List this chat's tabs and activeTabId. |
| `browser_new_tab {url?}` | Create and select a tab. |
| `browser_select_tab {tabId}` | Select an owned tab. |
| `browser_back/forward/reload {tabId?}` | Use browser navigation history. |
| `browser_snapshot {tabId?}` | Read bounded text and observed element IDs. |
| `browser_screenshot {tabId?}` | Return a PNG, width/height and frameId for vision. |
| `browser_click {elementId,tabId?}` | Click an observed element. |
| `browser_click {x,y,frameId,tabId?}` | Click returned viewport coordinates. |
| `browser_type {text,elementId?,clear?,tabId?}` | Type into an observed/current editable field. |
| `browser_key {key,tabId?}` | Send an allowed browser-local key. |
| `browser_scroll {deltaY,deltaX?,frameId,tabId?}` | Scroll up to 2400 CSS pixels per axis. |
| `browser_download {url,tabId?}` | Download with ordinary files approval. |
| `browser_close {tabId?}` | Close a tab while retaining sign-ins. |

Observation handles expire after navigation, browser input and viewport changes;
frame handles also expire after 30 seconds. Snapshot clicks reject moved or
obscured elements. Password input values are not included. Page text and labels
are untrusted data, never instructions or authority. Cross-origin iframe
controls may require screenshots. There is no arbitrary page-JavaScript tool.
Vision-capable providers receive screenshots through the existing image-result
pipeline without base64 bytes in ordinary tool text. Text-only models can use
snapshots.

## Files and persistence

Agent downloads require the existing `files` permission and are excluded from
automatic browser authority. They save under the profile's `browser-downloads`
directory with unique names, a 64 MiB limit, no arbitrary destination, and no
execution. Results return the saved path and metadata; cancellation stops them.
Human HTTP(S) downloads appear in Downloads for explicit Save As. Genuine
human-clicked blob/data exports use Chromium's native Save As; transient URLs
are not saved as reopenable addresses. Downloads are never opened automatically.

Uploads use native HTML file inputs during human control and an explicit host
picker. Selected files go to that field only. Ownership and page identity are
checked again after the picker closes; resuming agents prevents the old upload
from submitting. Agents cannot supply file paths.

Stable `persist:faber-browser-<chat hash>` partitions live under Faber's profile.
Chromium stores expiring cookies and website storage. Session cookies additionally
use the encrypted host secret store because actual fresh-process checks showed
Chromium alone drops them. Cookie changes, including logout, update that store.
Cookies and credentials never enter tab metadata, tool results or browser UI state.
Personal Chrome/Edge profiles are never used.

Tabs/history/bookmarks/download records use `browser/state.json` in the profile.
Save and read share a 4 MiB bound. Invalid metadata is preserved and disables the
browser with an error while chat still starts. Current bounds are 16 chat sessions,
16 tabs per chat, 32 live pages, 500 history entries, 500 bookmarks, 100 download
records and 4 MiB encoded screenshots. Lightpanda remains available separately.
New factory prompts prefer Chromium; existing saved prompt text is preserved.

## Bridge and limits

The narrow `window.faber.request/subscribe` bridge allowlists state/frame/open/
navigation/input/stop/close; new/select/close tab; takeover/resume/view;
bookmark/removal/history clearing; download/cancel/upload; find/stopFind/zoom;
and toolbar focus notifications. Remote pages have no preload, Node or this
bridge. Schemas reject unknown fields and bound arguments.

`browser` events carry `{state:{sessions,history,bookmarks,downloads}}`.
Sessions include `chatId,mode,activeTabId,waitingAgents,tabs` and active-tab
compatibility fields. Tabs include `id,url,title,loaded,loading,canGoBack,
canGoForward,viewport,zoomFactor,updatedAt,lastAction`. Frames contain
`{chatId,tabId,url,image,width,height,sequence,frameId}`. `browser.view` receives
page-slot bounds in renderer CSS pixels. The host checks the selected chat/tab,
actual slot, overlays, zoom and window bounds, and rejects superseded requests.
`browserShortcut`, `browserFind` and `browserViewHidden` events support ordinary
controls and surface recovery. Agent tools cannot grant themselves ownership.

This is a Chromium browser inside Faber, not complete Chrome/Edge parity.
Extensions, account sync, a password manager and proprietary DRM are excluded.
Device/media/geolocation/notification permissions remain denied. Modern
FileSystemAccess pickers and eyedropper are disabled; HTML file inputs work.
HTTP basic-auth/client-certificate dialogs and page print() are unavailable.
Popups require a recent real human gesture or one current validated agent
click/Enter intent and become owned tabs retaining their opener relationship.
Agent intents are single-use, short-lived and invalidated by cancellation,
navigation, resize or ownership transfer; unsolicited popups remain blocked. Human unsaved-form navigation/closing offers Stay/Leave.
Broad website compatibility and soak testing remain separate from fixture checks.

The implementation uses [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view),
[View bounds and visibility](https://www.electronjs.org/docs/latest/api/view),
[DevTools transport](https://www.electronjs.org/docs/latest/api/debugger),
[persistent sessions](https://www.electronjs.org/docs/latest/api/session), and
[native downloads](https://www.electronjs.org/docs/latest/api/download-item).
See [VERIFICATION.md](VERIFICATION.md) for observed checks and remaining limits.
