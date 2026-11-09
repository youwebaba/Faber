# Faber blind relay

This separate Node service provides rendezvous and opaque byte forwarding for
Faber remote sessions. The home PC and controller both make outbound WebSocket
connections. The desktop host adapter connects only to its selected, private
`127.0.0.1` HTTPS listener. It cannot forward an arbitrary destination.

The controller verifies the home PC's pinned TLS certificate inside the tunnel
before sending pairing nonces, device tokens, requests or responses. The relay
sees routing, connection metadata and encrypted TLS records. No session traffic,
host secrets or logs are persisted by this service. The relay can deny service;
it cannot authenticate itself as the pinned home PC.

## Windows operator kit

Extract `Faber-Relay-a2.4.zip`, open its `relay` subfolder in PowerShell,
then run `.\Start-FaberRelay.ps1`. Windows x64, Node.js 24+ with npm, and
outbound Internet access are required. The launcher copies service files into
`%LOCALAPPDATA%\FaberRelay`, installs the locked dependency, verifies the pinned
Cloudflare tunnel helper and starts both processes in the background. Open Faber
on the same PC to enable hosting and enroll its public route. See the application
[remote-session guide](https://github.com/youwebaba/Faber/blob/a2.4/REMOTE.md).

Run `.\Start-FaberRelay.ps1 -Stop` to stop the owned processes. The tunnel is
temporary: its public address changes after restart. Keep operator settings,
route files and tunnel logs private; none belong in the distributable kit.

## Local operator setup

Use Node 24 or newer. Install the isolated, lockfile-pinned dependency:

```powershell
npm ci --prefix relay --ignore-scripts --registry=https://registry.npmjs.org
node relay/server.mjs --bind 127.0.0.1 --port 8787 --allow-file C:\private\faber-relay-routes.json
```

The operator's JSON file is either `{ "routes": ["ROUTE_ID"] }` or an array of
route IDs, with at most eight entries and 4 KiB in total. It contains public
route hashes only. A missing, unreadable or invalid file admits no hosts.
Updates apply to each upgrade/registration, and removing a route closes its
existing connections within one second. The operator must explicitly authorize
each home PC; strangers cannot register public rooms.

For a fixed route, use repeatable `--allow-route ROUTE_ID` arguments or the
comma-separated `FABER_RELAY_ALLOWED_ROUTES` environment variable instead.
Static routes remain authorized when also present alongside a valid file.

`GET /healthz` returns `{ "ok": true, "protocol": 1 }`. This process binds to
loopback only. A separate operator-managed HTTPS reverse tunnel can expose this
listener on public port 443. The a2.2 pilot uses a temporary Cloudflare Quick
Tunnel; its address changes when recreated and is unavailable while this PC or
the tunnel is off. No cloud account, DNS or router configuration is performed by
this service. Production hosting and unattended service installation are outside
this proof of concept.

## Desktop contract

`desktop/remote-relay.mjs` exports:

- `generateRouteSecret()`: a random 32-byte base64url secret, 43 characters.
- `deriveRouteId(secret)`: base64url SHA-256 of the secret's UTF-8 text, 43
  characters. Only this hash belongs in the operator's admission file or a
  controller's invitation. The registration secret stays on its home PC.
- `validateRelayUrl(url, options)`: canonical relay origin. Default addresses
  must be `wss://NAME.trycloudflare.com` on port 443. Optional
  `approvedRelayHosts` are exact hostnames configured locally by the operator;
  invitations cannot approve their own origin. Credentials, paths, queries,
  fragments, literal IPs and local/private namespaces are rejected. DNS answers
  are checked for public addresses before connecting. The vendored, pinned
  `ws` 8.22.1 client binds those validated answers to the actual TLS dial while
  retaining the original server name and certificate hostname verification.
  No second DNS lookup, redirects or proxy agent is allowed. The narrowly
  scoped `allowLocalRelay: true` accepts
  `ws://127.0.0.1:PORT` or `ws://[::1]:PORT` in deterministic local fixtures.
- `validateRelayConfig({ relayUrl, routeId }, options)`: validated canonical
  route.
- `await createRelayHostAdapter({ relayUrl, routeId, registrationSecret,
  targetPort, signal?, approvedRelayHosts? })`: registers the host, then returns
  `{ status(), close() }`. `status()` is `{ connected, sessions }`; `close()` is
  asynchronous. The adapter reconnects after an established link drops, with
  exponential backoff capped at 30 seconds. Existing sessions are closed and
  requests are never replayed. Initial registration failure rejects the factory.
- `await connectRelayController({ relayUrl, routeId }, { signal?,
  approvedRelayHosts? })`: a connected Node Duplex for `tls.connect({ socket })`.
  The pinned TLS transport supplies identity and remote authorization.

Both connection functions accept a host-owned `WebSocketImpl` option only for
explicit loopback fixtures, allowing native WebSocket observation in tests.
Public connections always use the DNS-pinned client. The renderer cannot select
this option. The default public origin uses Cloudflare-controlled DNS. Operators
approving a custom hostname must control its DNS and TLS endpoint.

`createRelayServer({ host = '127.0.0.1', port = 0, allowedRouteIds = [],
allowedRouteFile? })` in `relay/server.mjs` returns
`{ start(), status(), close() }`. `start()` resolves `{ host, port }`, and
`status()` reports room/socket/session counts without identifiers or bodies.

## Wire format and limits

Native WebSockets use `/v1/host/ROUTE`, `/v1/connect/ROUTE`, and
`/v1/session/ROUTE/SESSION`. Each controller gets a fresh logical session and
separate host socket. Host registration/attachment sends its secret only in the
first WSS control body. A matching public route cannot claim the host role, and
a duplicate host cannot replace the registered host.

Bounded JSON controls provide registration, session admission, heartbeats and
byte credits. Tunnel data is binary TLS records. Each receiver acknowledges
consumed bytes; the relay permits at most 256 KiB outstanding per direction.
The desktop also throttles tunnel writes below the relay's per-socket rate.

The service caps eight provisioned rooms, 48 sockets, 12 initial handshakes,
four sessions per room, 120 unknown/invalid/initial-host upgrade attempts per
minute globally, and a separate bucket for each admitted room with 40 upgrades
per second refill and an 80-upgrade burst (2,400/minute). A controller session
uses two upgrades, so four concurrent controllers polling every 300ms remain
below the sustained room quota. Unknown routes/session IDs cannot consume a
room's quota. Further limits are 64 KiB frames,
2 MiB/second and 256 messages/second per socket, and 64 MiB per session direction.
Initial handshakes expire after ten seconds, idle sessions/hosts after sixty
seconds, sessions after thirty minutes, and host registrations after 24 hours.
Slow or invalid peers are disconnected. These are pilot limits, not a guarantee
of availability under a network-level denial of service.

Run the deterministic integration suite from the application root:

```powershell
npm test --prefix relay
```

It uses the actual local relay listener and Node's native WebSocket client.
Windows additionally exercises generated ephemeral TLS identity, pairing,
concurrent authenticated requests and revocation through the composed transport,
and checks that binary relay frames contain no application plaintext or tokens.

## Permanent operator address

For a stable Windows-hosted relay behind an operator-controlled TLS endpoint, run `Start-FaberRelay.ps1 -PublicUrl wss://relay.example.org -StartAtSignIn`. The optional login task restarts a failed relay. `-Stop` preserves the address and allowlist. `-DisableStartup` removes the task. The public hostname must forward WebSockets to the selected loopback port.
