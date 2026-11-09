# Remote sessions

Install Faber a3.0 on the home PC and the laptop. The home PC runs the model, tools and approvals. The laptop shows paired-device projects and chats in the main sidebar alongside its local projects, with separate drafts. Keep the home PC awake and Faber running in the profile you want to control.

## Pair the laptop

Both PCs need a3.0 for live viewing. The host chooses **Share video**, reviews a
source and one paired viewer, approves the native confirmation and chooses
**Start sharing**. The selected controller can then choose **Watch live** in the
host workspace. It cannot start host capture. Stopping the viewer or losing its
session ends the share; reconnection needs fresh host approval.
[Live video details](LIVE_MEDIA.md)

1. On the home PC, open **Edit → Settings → Connections → Control this PC**. If you run the relay on this PC, start it first using the instructions below. Otherwise enter the relay address supplied by your operator and give the operator the public host route ID to authorize.
2. Turn on **Allow connections**. When the host is online, create an invitation. Send it privately to your laptop. A new invitation replaces the previous one.
3. On the laptop, open **Connections → Control other devices** and paste the invitation. For a custom relay domain, enter its address in settings on both devices before pairing.
4. On the home PC, check that the pending device name matches the laptop you are pairing. Approve the laptop on the home PC. On the laptop, choose **Open workspace**. Select a project or chat, send a message or follow-up, watch replies and tool activity, handle a pending approval, or stop a run. You can start a new chat in a home project and choose from the models configured on the home PC.

A paired laptop can direct the host's agents using their existing project and tool permissions. Revoking it from **Control this PC** closes its remote access. A run already started on the host can continue after disconnection. Stop the run in its chat when needed. Disabling hosting also closes current remote connections. Home and laptop can use unrelated networks.

## Chats and images in a2.3

Paired-host chats stay in the main sidebar beside local projects. Their blue
globe identifies them as remote. Hover or focus a chat to see its project and
device. Switching between local and remote chats keeps their drafts separate.
Known chats remain listed when a host goes offline during the current app session.
After restarting Faber, the host must reconnect to load its chat list.

Images that the host displays from attachments or image tools can appear in the
remote chat, including child-agent image results. Images load through the paired
connection as needed, with bounded transfers. The controller does not open
arbitrary host files or automatically fetch image URLs. Both PCs should run
a2.3 for this image flow. Older hosts remain viewable with their existing image
behavior.

## Audio and video in a2.4

Remote chats can play published audio and video with controls, seeking and
fullscreen video. Right-click displayed content to copy text or images and save
media on the controlling PC. Both PCs need a2.4 for this media flow. Playback
and saving use bounded transfers through the paired connection; the host must
remain connected. See [Chat media](MEDIA.md) for formats and limits.

## Run the proof-of-concept relay on a Windows PC

Download the matching relay kit from [Faber releases](https://github.com/youwebaba/Faber/releases) and extract it. The relay operator needs Windows x64, Node.js 24 or newer with npm, and outbound Internet access. In PowerShell, open the extracted `relay` folder and run the launcher.

```powershell
.\Start-FaberRelay.ps1
```

The launcher installs the locked WebSocket dependency and verifies the public Cloudflare tunnel executable against its pinned SHA-256. It starts both processes in the background. The relay binds to loopback. Only its encrypted forwarding endpoint and health check are reachable through the temporary public tunnel. There is no router port to open. On the same PC, Faber discovers the address and enrolls the current profile's public route when you enable hosting. A laptop only needs Faber.

Run `.\Start-FaberRelay.ps1 -Stop` to stop the relay. The processes run for the current Windows session. After restarting the tunnel, its public address changes. Restart Faber on the host or turn hosting off and back on, then create a fresh invitation and pair the laptop again. Cloudflare provides these temporary addresses for testing. [Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## Pairing and transport

The relay forwards encrypted bytes. Each connection uses an additional TLS session between the two Faber installations. The invitation pins the home PC's certificate and expires after a short time. The host approves each device locally. Desktop credentials are stored with Windows encryption. The relay sees routing information, timing and traffic size. Paired devices can read visible conversations, including content that you or a model placed in those conversations.

The operator can move the standalone relay behind a stable public WebSocket address later. The operator package includes service and route-allowlist instructions. Each Faber profile has separate devices and host credentials. Safe mode suspends hosting. This release supports Windows desktop controllers.
