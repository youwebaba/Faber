# Connect an MCP server

Open **Settings → MCP servers → Add server**. Select the project that can use the connection. For a local server, choose its executable and enter one argument per line. A local server runs with the current Windows user's permissions. A remote server needs its Streamable HTTP URL. Use HTTPS for a remote machine. HTTP is supported on loopback.

Connect, inspect the discovered tools and explicitly allow each tool the project may use. Faber qualifies tool names by server. Changing a published schema invalidates its approval. A routine binds the reviewed tool to its project, schema and grant. Revoking and granting the tool again requires reviewing the routine before its next use. Approved reads can run unattended. Writes require approval for the individual action. If an external change may have succeeded before the connection dropped, inspect its destination before retrying.

Credentials are stored in the profile credential vault. An HTTP credential is sent only to the configured origin. A local credential can be supplied through an explicitly named environment variable. Disable or remove a connection to revoke its active tools. Safe Mode disables MCP server launches.

To let a separate application call Faber, configure its inbound endpoint in **Settings → External access**. [External gateway](GATEWAY.md)

## Built-in web research

In a regular chat, ask Faber to research a topic or give it a list of public URLs. Main chats and child agents can start the bundled crawler over MCP using their **Network** permission. The worker starts on demand, uses a private stdio pipe and closes when the run ends. There is no server address, API key or browser tab to configure. Safe Mode pauses the crawler.

| Tool | What it returns |
| --- | --- |
| `web_search` | Ranked links, snippets and the search provider. Only public search terms belong in a query. |
| `web_scrape` | One page's title, final URL, text, links, retrieval time and any failure. |
| `web_crawl` | A job ID immediately. Give it up to 1,000 seed URLs. Use `maxDepth: 0` to read exactly that batch or a greater depth to follow links on the supplied origins. A job visits up to 5,000 pages. |
| `web_crawl_status` | Counts, errors, excerpts and a cursor. Use `query` to find a phrase in retained results or `waitMs` to wait briefly for the next page. |
| `web_crawl_page` | The next passage from a retained page. Pass the job ID and page ID. Use `find` to jump to a phrase or an explicit character `offset` to reread an earlier section. |
| `web_crawl_cancel` | Stops pending reads for the specified job. |

A crawl defaults to eight simultaneous page reads and allows up to sixteen, with at most two per origin per worker. A batch stays within the seed origins, including redirects. A single scrape can follow a public redirect to a different origin. The reader respects robots.txt, rate-limit delays, response sizes and deadlines. Status counts failed pages separately and marks shortened text. Read an important URL individually when a large batch retained only an excerpt. Save needed findings in the chat before its run ends.

Keyword discovery sends the query to Mwmbl and tries Wiby if Mwmbl has no usable results or is unavailable. Both have their own index coverage. Credit Wiby with a link when using its results. Known URLs can be read directly from the PC, independent of either index. [Mwmbl search API](https://developer.mwmbl.org/) · [Wiby search API](https://wiby.me/json/)

The crawler makes public HTTP(S) GET requests. For a sign-in, job application, upload or page that requires JavaScript, the agent can open its URL in the chat's existing Chromium browser. Browser cookies stay in that browser. Check the retrieved passage and cite its source URL in the answer. [Browser controls](BROWSER.md)

## Project workbooks

A chat with file access can read a worksheet range or update a rectangular range in an authorized XLSX workbook. Updates require the expected original file hash and retain a previous-content backup. A retry with the same resulting cells is idempotent. Faber preserves unaffected sheets, formulas, styles and unrelated package parts, and requests recalculation when the workbook next opens. The editor rejects protected workbooks, macros, signatures and edits that overlap merged cells or shared formulas.

The interoperability checks used the independent reference filesystem server over stdio and authenticated Streamable HTTP. Qwen retrieved a disposable marker through the approved tool over both the llama.cpp OpenAI-compatible HTTP route and an isolated Ollama native API connection. Ollama used its own model store, ran on CPU and returned the same marker in the assistant’s answer. Microsoft Excel reopened the updated workbook with its chart, other worksheet and dependent formula intact. [Reference server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
