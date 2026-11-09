# Connect an MCP server

Open **Settings → MCP servers → Add server**. Select the project that can use the connection. For a local server, choose its executable and enter one argument per line. A local server runs with the current Windows user's permissions. A remote server needs its Streamable HTTP URL. Use HTTPS for a remote machine. HTTP is supported on loopback.

Connect, inspect the discovered tools and explicitly allow each tool the project may use. Faber qualifies tool names by server. Changing a published schema invalidates its approval. A routine binds the reviewed tool to its project, schema and grant. Revoking and granting the tool again requires reviewing the routine before its next use. Approved reads can run unattended. Writes require approval for the individual action. If an external change may have succeeded before the connection dropped, inspect its destination before retrying.

Credentials are stored in the profile credential vault. An HTTP credential is sent only to the configured origin. A local credential can be supplied through an explicitly named environment variable. Disable or remove a connection to revoke its active tools. Safe Mode disables MCP server launches.

To let a separate application call Faber, configure its inbound endpoint in **Settings → External access**. [External gateway](GATEWAY.md)

## Project workbooks

A chat with file access can read a worksheet range or update a rectangular range in an authorized XLSX workbook. Updates require the expected original file hash and retain a previous-content backup. A retry with the same resulting cells is idempotent. Faber preserves unaffected sheets, formulas, styles and unrelated package parts, and requests recalculation when the workbook next opens. The editor rejects protected workbooks, macros, signatures and edits that overlap merged cells or shared formulas.

The interoperability checks used the independent reference filesystem server over stdio and authenticated Streamable HTTP. Qwen retrieved a disposable marker through the approved tool over both the llama.cpp OpenAI-compatible HTTP route and an isolated Ollama native API connection. Ollama used its own model store, ran on CPU and returned the same marker in the assistant’s answer. Microsoft Excel reopened the updated workbook with its chart, other worksheet and dependent formula intact. [Reference server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
