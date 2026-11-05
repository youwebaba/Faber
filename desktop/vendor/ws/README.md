# ws client source

Unmodified client sources from `ws` 8.22.1, copied from the isolated relay's
lockfile-pinned npm dependency. The upstream package metadata and MIT license
are retained. Server, stream-wrapper and package entry-point files are omitted;
Faber imports `lib/websocket.js` directly.

Upstream: https://github.com/websockets/ws

The desktop uses this client to bind validated DNS answers to its actual TLS
connection while retaining normal SNI and certificate hostname checks. Relay
connections disable redirects, compression and HTTP agents. The application
ships these files through its existing recursive `desktop/**` installer and
workbench source copy; the relay's `node_modules` directory is not required by
the installed application.
