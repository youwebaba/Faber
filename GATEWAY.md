# External model and tool gateway

To connect a third-party MCP server to a Faber project, open Settings → MCP servers. [MCP client setup](MCP.md)

The endpoint starts **off**, including after restart. It serves one selected
saved local/API model and a fixed set of project-bound Faber tools. It never
starts/downloads a model or forwards ChatGPT/Claude account subscriptions.

## Desktop bridge

- `gateway.status {}` returns
  `{running,activeRequests,activeSessions,hasToken,config,baseUrl,mcpUrl}`.
- `gateway.configure` accepts partial
  `{bindAddress,port,allowRemote,projectId,providerId,model}` while stopped.
  Defaults: `127.0.0.1:8766`, `allowRemote:false`, no selected targets.
  All targets must exist. Port `0` chooses an available port; returned URLs
  contain its actual value.
- `gateway.rotateToken {}` stops/cancels the endpoint and sessions, saves a
  new encrypted host secret, and returns stopped status plus `token` **once**.
  Copy it into the external client's secret storage. Start explicitly again.
  Old tokens and session IDs cease to work.
- `gateway.start {}` / `gateway.stop {}` return status.
- Events: `{type:'gateway',state:<status>}`. No token appears in status,
  events or `gateway.json`. The host secret ID is `external-gateway-token`.

Every route, including MCP initialization, requires
`Authorization: Bearer <token>`. Query-string credentials are unavailable.
Host/Origin validation rejects browser cross-origin requests, duplicate security
headers and forwarded-host overrides. No CORS is enabled.

Choose a literal local interface IP. Wildcard binds are unavailable; non-loopback
requires `allowRemote:true`. **HTTP does not encrypt the bearer token, prompts
or results on the network.** Use a protected network or separately secured
tunnel. TLS, OAuth discovery, router/firewall setup and public hosting are absent.

## Model API

The returned `baseUrl` ends in `/v1`. `GET /v1/models` lists only the selected
model. `POST /v1/chat/completions` accepts JSON/SSE with `model`, `messages`,
`stream`, `stream_options.include_usage`, `tools` (function schemas),
`tool_choice` (`auto`/`none`), `n:1`, and one of `max_tokens` /
`max_completion_tokens`. Unsupported fields are rejected.

Text messages, complete function call/result groups and user text/image parts
with inline PNG/JPEG/WebP are supported. Remote images, strict function schemas,
named/required tool choice, sampling controls, audio, embeddings and an outward
Responses endpoint are unavailable. Schemas use the shared registry's JSON
Schema subset. Client functions are returned for the **client to execute**;
Faber tools are exposed separately through MCP.

Requests use only the client's supplied history, without reading/appending Faber
chats. Upstream keys stay in host credential storage. A core provider lease
blocks edits while inference uses that connection. API calls can incur the
selected provider's normal charges; no cloud fallback is implicit.

Ollama/OpenAI Chat adapters emit incremental text. Responses can revise final
text, so its visible output is buffered until canonical completion before
compatible SSE content is emitted. Calls are emitted once after validation,
without partial arguments. Usage is provider-reported; absent counts are
omitted. Externally returned provider errors are generic.

## MCP tools

The returned `mcpUrl` ends in `/mcp`. Streamable HTTP is pinned to
`2025-11-25`, `2025-06-18` and `2025-03-26`; newer draft transports are absent.
Each POST carries one JSON-RPC message with
`Accept: application/json, text/event-stream`. Responses use JSON.

Initialize, retain `Mcp-Session-Id`, send `notifications/initialized`, then use
`tools/list`, `tools/call` or `ping`. Subsequent calls include the negotiated
`MCP-Protocol-Version` and session ID. `notifications/cancelled` cancels its
request ID; DELETE closes the session. Standalone GET SSE returns 405.
There is no legacy HTTP+SSE or stdio adapter.

Sessions create dedicated auditable chats bound to the selected
project/provider/model. Only available shipped time/file/image, shell, desktop
and browser tools enter the fixed allowlist. Addons, account/configuration,
chat/agent/project coordination and upgrade tools are excluded. Privileged calls
require fresh Faber user approval; automatic browser authority and remembered
external grants are disabled. The token cannot approve itself or select another
chat. Core authority/path checks guard structured project access. Approved
shell/native actions retain Windows-account authority; this is not an OS sandbox.

Stop/rotation/session close/idle expiry cancel pending work and archive its chat.
Late initializers are archived when they settle. Cancellation cannot undo effects.
Limits: 4 MiB body, 16 MiB model/tool result, four concurrent model/tool operations,
sixteen MCP sessions, fifteen-minute session idle expiry, ten-minute operations,
plus finite HTTP connection/header/body ingestion limits. Synchronous trusted host
code cannot be forcibly interrupted by Node.

## Evidence and references

`node --test test/desktop-gateway.test.mjs` exercises synthetic loopback HTTP
with the real runtime, registry, approvals and all three provider adapters.
It covers auth/host/origin, limits, project access, no remembered grants,
cancellation/disconnect, provider leases, canonical output and Stop/rotation races.
Real LAN/editor integrations, paid/live inference, physical desktop actions and
the running user's profile are not tested.

[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
[OpenAI model listing](https://developers.openai.com/api/reference/resources/models/methods/list),
[MCP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
