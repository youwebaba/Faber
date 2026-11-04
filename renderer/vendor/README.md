# Vendored Markdown lexer

`marked.esm.js` is the unmodified browser ES module from `marked@18.1.3`
(`node_modules/marked/lib/marked.esm.js`). The exact dev dependency and npm
tarball integrity are pinned in the root package lock. Upstream:
https://github.com/markedjs/marked (MIT; see `marked.LICENSE`).

SHA-256 of `marked.esm.js`:
`e76f3b37046a5d294159872002e5f6fcda8ed232e1be45ff76b3863f2919dae3`

It is copied into the renderer so the sandbox loads only packaged local assets.
Faber uses the lexer only, building an allowlisted DOM in `rich-content.mjs`;
it never inserts the parser's HTML output. Update the pinned dependency, this
asset and its license together, then run the rich-content tests and desktop smoke.
