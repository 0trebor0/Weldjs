# Changelog

## Unreleased — 2026-08-15

### Changed — project renamed to WeldJS

- The project is now **WeldJS**; the package name is `weldjs`.
- **The block delimiter is now `<weld>` / `</weld>`.** Every page must be updated — `<node>` is no longer recognised and will be passed through as ordinary HTML rather than executed. This is silent at compile time, so check existing pages.
- `NodeHtmlSyntaxError` is renamed `WeldSyntaxError`.
- `scan()` parts now use `type: 'weld'` where they previously used `type: 'node'`.
- `test/nodehtml.test.js` is renamed `test/weld.test.js`.

### Added

- `docs/index.html` — self-contained documentation page covering the tutorial, block model, request isolation, `req`/`res` access, Express integration, API reference, and security notes. No external assets, so it can be opened directly or served as a static file.

### Security

- Exported values are now validated and copied in a single walk, so the value that passes validation is necessarily the value that is written to the page. Previously validation and serialization were two separate walks over the same data, which let an accessor property (or a proxy) return a benign value to the validator and a different value to the serializer, making every export restriction advisory rather than enforced.
- Objects containing a `__proto__` key are now rejected. Exported data is spliced into a `const name = {...}` object literal, where a `__proto__` key replaces the object's prototype on the client instead of defining a property. Escaping the key does not avoid this, because the object-literal special case matches the key's string value, which an escape sequence preserves.
- Exported data nested deeper than 64 levels is now rejected with a `TypeError`. Deeply nested data previously exhausted the call stack and failed the request with a `RangeError`.

### Changed

- `assertSerializable(value)` no longer accepts the internal `seen` and `path` arguments that were previously part of its signature.
- `MAX_DEPTH` is now exported from the package root.
- A compiled page's `parts` array now holds `{ type: 'html', buffer }` entries instead of `{ type: 'html', start, end }` byte ranges, and no longer contains `{ type: 'setup' }` placeholders. This is a breaking change only for code that inspects `page.parts` directly; `render()` and `renderToBuffer()` are unaffected and produce identical bytes.

### Fixed

- **Exported values are capped at 1 MB.** A single `<weld var>` block returning an unbounded query result previously serialized the whole thing into the page, holding the copy, the JSON string, and the response buffer in memory at once. The budget is spent during the walk, so an oversized value fails as soon as the limit is crossed rather than after the structure has been copied, and the error names where it ran out: `Cannot export more than 1048576 bytes; limit reached at $[8421].email`. The limit is per export, so each block gets its own budget. Exported as `MAX_EXPORT_BYTES`. Measured cost on a normal 224 KB payload: about 1-2%.
- **`render()` is now two-phase.** All request blocks are resolved concurrently, then the finished response is written. Three independent blocks of ~10 ms each went from 42.9 ms to 14.4 ms. Total time is now the slowest block rather than the sum.
- **Failures are atomic.** Nothing is written until every block has succeeded and every value has serialized, so a failing block leaves zero bytes sent and the caller can still send a real error status. Previously a block that threw after the first write left a truncated page under an already-sent 200, and an Express error handler would hit `ERR_HTTP_HEADERS_SENT` on top of it.
- **Responses carry `Content-Length`.** The finished size is known before anything is sent, so responses no longer fall back to chunked encoding. Writes are corked so they coalesce, and the static buffers are still written without being copied. Use `res.setHeader(...)`, not `res.writeHead(...)`, in your route — `writeHead` marks headers as sent and prevents this.
- `response.setHeader()` now works inside a `<weld var>` block, since blocks run before anything is written.
- A compiled page no longer retains its original source Buffer, and `page.source` is removed. Every static run is copied into its own allocation at compile time instead of leaving a subarray view, which previously pinned the whole source alive alongside the merged copies. Across 1,000 pages of 10 KB, retained memory fell from 2.12x the source to 1.20x — buffer memory specifically from 17.6 MB to 9.2 MB, about 47% less. Compile time rose from 72 ms to 78 ms for those 1,000 pages; render speed is unchanged.
- `render()` no longer routes every chunk through an awaited helper. That helper allocated a promise for each write even though backpressure is rare; the write is now inlined and awaited only when it reports a full buffer. Streaming a 51 KB page went from ~730,000 to ~870,000 renders/sec, about 18% faster. Backpressure behaviour is unchanged.
- Export errors now name the block and page that produced them — `<weld var="beta"> in /app/views/profile.html: Cannot export function at $` — instead of only a path within the value. The original error is preserved as `error.cause`. On a page with many blocks the old message gave no way to locate the failure.
- Duplicate `var` names across `<weld var="...">` blocks are now rejected at compile time. They previously emitted two `const` declarations of the same name, a client-side `SyntaxError` that disabled every script on the page while the server still returned 200.
- Reserved words such as `class` and `let` are now rejected as `var` names, for the same reason.
- Runs of static HTML separated only by a setup `<weld>` block are joined once at compile time, so streaming a page issues one write per run rather than one per original slice. A page with twelve setup blocks interleaved with markup drops from 15 writes to 3.
- `findOpeningTag` in the scanner now uses a loop explicitly bounded by the buffer length instead of `while (true)`.
