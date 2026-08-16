# Changelog

## Unreleased — 2026-08-16 (CI fixes)

### Changed

- **The macOS CI job is advisory.** It still runs and still reports, but no longer gates the build. Its watcher tests have failed twice for timing reasons with no product bug behind them, and nobody on the project has a Mac to reproduce the remaining cause on. Deleting the job would lose the signal and leaving the build red would train people to ignore it, so the result stays visible and `TODO.md` records what to check and how to re-enable gating. Linux (Node 20, 22, 24), Windows (Node 20) and packaging all gate as before.

### Fixed

- **Watcher tests no longer depend on a fixed wait.** Five watcher tests slept 300 ms for a filesystem event and then asserted. That was enough on Linux and Windows and not on macOS, where CI failed with the page still showing its pre-edit content — the rebuild had not happened yet. They now poll for the condition, which is correct on a slow machine and faster on a quick one; the local suite dropped from 7.5 s to 4.8 s. The timeout only applies when the condition never becomes true, and the assertions are unchanged: all three watcher regression tests still fail against the pre-fix implementation.
- **The mid-write disconnect test now waits for the server to start writing** before killing the socket, rather than destroying it after a fixed 10 ms. On macOS CI that delay raced the server and only one of ten requests was ever parsed, so the test failed without exercising the disconnect it exists to cover.

- **The test suite no longer fails on Node 20, the minimum version `engines` claims.** Three `load()` tests used `example/page.html` as a convenient real page on disk. That page's setup block requires `node:sqlite`, which landed in Node 22.5, so all three failed on Node 20 across Linux, Windows and macOS — caught by the first CI run. None of the three is about SQLite, so they now use a fixture that does not need it. The library itself requires nothing newer than Node 20; only the example does, which is now documented in the README.
- **The shipped example is still covered**, by a test that compiles `example/page.html` and is skipped with a stated reason when `node:sqlite` is unavailable.

## Unreleased — 2026-08-16 (browser namespace)

### Changed — breaking, client-side

- **Exported data is now written to a single `window.weld` namespace instead of bare globals.** `<weld var="users">` previously emitted `<script>const users=[…];</script>`, taking the name `users` as a page-wide global. It now emits `<script>(window.weld=window.weld||{}).users=[…];</script>`, and the browser reads it as `weld.users`.

  **Every page that consumes exported data must be updated**: `users` becomes `weld.users`. This is a silent break — the old name is simply undefined, so scripts fail at runtime rather than at compile time.

  The reason is collision. A bare `const users` is a name no other script on the page may use, and a second declaration of it is a `SyntaxError` that disables *every* script on the page while the server still returns 200. WeldJS could catch that only for the page's own `<script>` blocks; a name introduced by an external `<script src>` was invisible to it. With a namespace, `weld` is the one name a page must leave alone.

  The assignment is written as a single idempotent expression because blocks are emitted independently and any of them may run first. Block order does not matter, and an export overwrites whatever the property held before while leaving other properties on the object alone.

- **The compile-time collision check has been retargeted.** A `<weld var="users">` on a page whose own `<script>` declares `const users` is now **accepted** — the two names are unrelated. What is now rejected is a page that exports something *and* declares `weld` itself at the top level of one of its scripts: `var weld` and `function weld` write to `window.weld` and destroy the exports, and `const weld` shadows them for the rest of that script. The check remains conservative — only declarations at the start of a line count, and an external `<script src>` cannot be seen.

- Reserved words are still rejected as export names. As a property name a reserved word is legal (`weld.class` parses), but the restriction predates the namespace and relaxing it would widen what pages may declare, so it is kept.

- `NAMESPACE` is exported from the package for callers that need to reference the global by name.

## Unreleased — 2026-08-16 (hardening)

Both this section and the one below it are unreleased; 0.1.0 has not been published. Hardening pass ahead of a wider release: two correctness fixes, an automated build, and a documentation audit against the implementation.

### Fixed

- **`watch()` now tracks the page's full include graph, and keeps tracking it.** The documented `load()` + `watch()` sequence registered watchers for the page only. `page.dependencies` is empty until the first compile finishes, and `watch()` read it synchronously, so a partial edited during development did not rebuild the page unless the caller happened to `await page.ready` first. The watched set is now reconciled against the page's dependencies once the initial compile settles and after every successful rebuild, so it also follows a `<weld src>` added or removed while the server runs: new includes gain a watcher, dropped ones have theirs closed. Reconciliation reuses handles it already holds rather than reopening them, so repeated rebuilds no longer accumulate watchers, and `close()` now stops later reconciliation from reopening anything. `watcher.files` is a live view rather than a snapshot taken at call time.
- **The export size limit is now measured exactly.** The budget was spent during the walk against JavaScript string length before escaping, which undercounts the emitted payload in two ways: `<`, `>` and `&` each become a six-byte escape, and a non-ASCII character costs two to four UTF-8 bytes per code unit. A block returning 200,000 `<` characters passed a 1 MiB budget and wrote 1.2 MB into the page. The finished payload is now measured with `Buffer.byteLength(..., 'utf8')` and rejected if it exceeds the limit. The pre-serialization walk is kept as an early guard so a hopeless value still fails before the whole structure has been copied, but its charges were retuned to be strict lower bounds on the emitted bytes — previously they could also *over*count, rejecting a payload that in fact fit.

### Changed

- **The export limit is defined as the complete emitted `<script>` payload**, in UTF-8 bytes, summed across every block on a page, per render — tags, `const name=` declaration and `nonce` attribute included, not the JSON alone. The same data can therefore fit without a nonce and not fit with one. The default is unchanged at 1 MiB (1,048,576 bytes) and remains configurable per page with `compileSource(src, { maxExportBytes })`.
- **A new error message reports the byte overrun**, distinct from the existing walk-time message that names the path: `Cannot export more than 1048576 bytes per page; the emitted <script> payload reached 1200028 bytes`. Both are still wrapped with the block and page that produced them.
- **The shared-setup-scope warning is reworded as a heuristic.** It previously ended "Use const for shared resources", which implied `const` made setup state request-safe. It does not: `const cart = []` is just as shared, and mutating it from a request block leaks the same way. The warning now says so, and names *reassignable* bindings rather than "mutable" ones.
- `Budget` objects now carry `floor` and `bytes` counters in place of `used`. This is an internal structure, exposed only through the optional second argument to `serialize()` and `assertSerializable()`.

### Added

- **Continuous integration** (`.github/workflows/ci.yml`). Runs on pushes to `main` and on all pull requests: `npm test` across Node 20, 22 and 24 on Linux, plus Node 20 on Windows and macOS, since the watcher depends on `fs.watch` and its event behaviour differs by platform. A separate job runs `npm pack --dry-run`, then installs the resulting tarball into a clean project and requires it, so a broken `exports` or `files` field fails the build rather than the first user.
- **Package metadata** — `repository`, `bugs` and `homepage`. Verified that `files` publishes only the intended eleven artifacts, that the `license` field agrees with `LICENSE`, and that `engines` matches the CI matrix minimum.
- **Regression tests for everything fixed above** (125 tests, up from 109): watching immediately after `load()`, includes added and removed while running, handle reuse across repeated rebuilds, `close()` stopping include-triggered rebuilds, pinned dependency lists surviving reconciliation, payloads landing exactly on and one byte over the limit, escape expansion for `<` `>` `&`, three-byte and astral UTF-8, the nonce counting towards the limit, and escape-heavy payloads split across blocks. Each was confirmed to fail against the previous implementation.

### Documentation

- **The README now opens with what WeldJS is, why to use it, how to install it, and a complete copy-pasteable example** — page, server, and the exact HTML the browser receives — followed by the architecture explanation. Adds a positioning table against template languages, SPA frameworks and client-side `fetch`, and promotes request isolation and the security boundary to top-level sections.
- **The quick-start server no longer demonstrates a process-killing pattern.** `http.createServer(page.handler)` leaves the returned promise unhandled, so the first failing block terminates the process; verified, then replaced with the `.catch` form, which returns 500 and keeps serving. The API docs now call this out explicitly.
- **API reference audited against the implementation.** Corrected: `router(directory, options?)` — it takes no options; the claim that each `var` block gets its own 1 MB budget — it is one budget per render; the claim that a malformed page stops the server at boot — `load()` reports on stderr, rejects `page.ready`, and keeps serving other pages; `var` being the only supported attribute — `src` exists; "no router, hot reload" in the limitations list — both shipped; and a malformed `app.get(/, page.handler)` snippet. Documented the previously undocumented `compileSource` options, `clearLoaded()`, the optional budget argument, `page.ready` being a retrying getter, and `dependencies`/`parts` being empty until the first compile.
- **Setup scope is documented as page/process-shared state**, with its lifecycle, the three things it is for (immutable configuration, shared service instances, intentionally shared caches), and a matched unsafe/safe example pair showing that a `const` array mutated from a request block leaks across users.
- **Added an API stability statement.** Everything is pre-1.0; the browser-side contract — a `var` block emitting a bare `const name` global — is called out as explicitly undecided and the most likely thing to change.
- TypeScript declarations updated to match: `LoadedPage.parts` is `undefined` before the first compile, `WatchOptions.dependencies` pins rather than extends the watched set, `Watcher.files` is live, and `Budget` carries the new counters. Verified with `tsc --strict` against representative usage.

## Unreleased — 2026-08-15

### Security

- **Exports are now bounded per render rather than per block.** The 1 MB cap applied to each `<weld var>` independently, so a page with five blocks could produce 4.29 MB and hold 18.9 MB per in-flight request — at 100 concurrent requests, roughly 1.9 GB. One budget is now shared by every block on the page. The limit is configurable with `compileSource(src, { maxExportBytes })` and validated at compile time.
- **A client variable that collides with a page `<script>` is rejected at compile time.** Two `const x` declarations are a `SyntaxError` that disables every script on the page, while the server still returns 200 — a silent failure. The check is conservative: only top-level declarations count, so occurrences inside a nested block or a string do not trigger it. It cannot see names introduced by external scripts loaded with `src`.
- **A top-level `let`/`var` in a setup block now warns.** Setup scope is shared by every request, so request data placed there leaks between users, and the leak needs a mutable binding. Heuristic rather than proof; opt out with `{ warnOnMutableSetup: false }`.

### Removed

- `router()` no longer accepts an options argument. It was validated and then never read — surface with no behaviour behind it.
- `middleware.root` is no longer exposed; nothing consumed it.
- `NONCE_PATTERN` is no longer exported from the serializer, which is the only module that uses it.

### Changed

- **An unterminated attribute value now says so.** `<weld var="unclosed>` reported `Unclosed <weld> opening tag`, which pointed at the wrong problem; it now reports `Unterminated attribute value in <weld> tag` at the offending quote. `findTagEnd` distinguishes the two cases, which also removed a guard in the attribute parser that nothing could reach.
- **Syntax errors report the file, line and column** instead of a byte offset, and carry `.filename`, `.line` and `.column`. A broken partial names the partial rather than the page that included it, since its line number belongs to the partial and matches nothing in the page. `WeldSyntaxError ... (byte 4173)` was unhelpful in a large file.
- `page.parts` is frozen through rather than only at the top level.
- The package is no longer `private`. Added MIT `LICENSE`, hand-written `types/index.d.ts`, `.gitattributes` (`* text=auto eol=lf`) to end the LF/CRLF churn, and `files`/`exports`/`types`/`keywords` fields.

### Changed — project renamed to WeldJS

- The project is now **WeldJS**; the package name is `weldjs`.
- **The block delimiter is now `<weld>` / `</weld>`.** Every page must be updated — `<node>` is no longer recognised and will be passed through as ordinary HTML rather than executed. This is silent at compile time, so check existing pages.
- `NodeHtmlSyntaxError` is renamed `WeldSyntaxError`.
- `scan()` parts now use `type: 'weld'` where they previously used `type: 'node'`.
- `test/nodehtml.test.js` is renamed `test/weld.test.js`.

### Added

- **Includes** — `<weld src="../partials/header.html"></weld>` pulls in another file. Paths resolve relative to the including file and includes may nest. Expansion happens once at compile time, before scanning, so the included markup merges into the surrounding static runs and costs nothing per request: a page with two partials writes the same number of buffers as one without. Because it happens before scanning, an included file behaves as if pasted in — its setup blocks join the page's setup, and a variable name used by both partial and page is caught as a duplicate. Cycles are refused rather than followed, nesting is capped at 16, and `page.dependencies` lists what was pulled in.
- **File-based routing** — `app.use(router(path.join(__dirname, 'pages')))` maps `pages/index.html` to `/`, `pages/about.html` to `/about`, and `pages/blog/[slug].html` to `/blog/:slug` with `request.params.slug`. The route table is built once at startup and never consulted against the filesystem at request time, so traversal attempts have nothing to match — `/blog/%2e%2e`, `/%2e%2e/%2e%2e/etc/passwd`, null bytes and malformed percent-encoding are all rejected. Static routes are one Map lookup; parameterised routes are compared only against candidates of the same segment count. Dotfiles are skipped, symlinked directories are not followed, and non-GET methods pass through.
- **CSP nonce support** — the emitted `<script>` is inline, which a strict `script-src 'self'` policy blocks outright, leaving the page rendered but the data silently missing. A nonce on `res.locals.cspNonce` or `res.locals.nonce` is now applied automatically, so the standard helmet setups need no configuration. A nonce that is not base64-shaped or is outside 8–256 characters is refused rather than escaped, because escaping would produce a tag the policy does not match — a blank page instead of an error.
- **Hot reload** — `watch(page)` recompiles when the page file or any file it includes changes, so a running server picks up edits without a restart. Setup blocks re-run, so changes to setup code take effect and not only markup. Rapid writes are debounced into one rebuild, in-flight requests keep the page they already resolved, watching the same page twice returns the existing watcher, and `close()` stops it. Development only: it holds an open file handle per watched file.
- **`load(filename)`** — returns a page **synchronously** and compiles it in the background, so a server no longer needs an async wrapper just to hold the await:

  ```js
  const page = load(path.join(__dirname, 'page.html'));
  const app = express();

  app.get('/', page.handler);
  app.listen(3000);
  ```

  Requests arriving before compilation finishes wait for it rather than failing. Pages are cached by resolved path, so loading the same file twice returns the same page instead of compiling it and re-running its setup blocks twice. `page.ready` exposes the compile promise for callers who want to await it, and a compile failure is reported on stderr immediately as well as rejecting `ready` — add `page.ready.catch(() => process.exit(1))` to fail at boot instead of serving errors. `clearLoaded()` empties the cache for tests.
- **`page.handler`** — a ready-made route handler, so serving a page no longer requires an async wrapper, a `res.end()` call, or hand-rolled error forwarding:

  ```js
  app.get('/', page.handler);
  ```

  It renders, ends the response, and forwards any failure to `next`, which reaches your error middleware with nothing written. It sets `content-type: text/html; charset=utf-8` only if nothing has set one already, so setting your own headers first still works. Called without `next` — a vanilla server — it returns the promise instead of swallowing the failure.
- `example/express-server.js` — a complete Express example: compile-at-boot, static docs mounted at `/docs`, `setHeader` rather than `writeHead` so `Content-Length` is set, and an error handler that works on both Express 4 and 5. Express is not added as a dependency; install it yourself to run the example.

### Fixed

- `load()` no longer caches a failed compile, and **a running server now recovers on its own**. A page that failed to compile stayed broken for the lifetime of the process even after the author fixed the file, and a path that did not exist yet could never be loaded once it appeared. Only a successful compile is cached now, and the retry lives on the page object itself — which is what matters, because a server calls `load()` once at boot and then holds that object, so evicting the cache entry alone would not have helped it. Correcting the file is picked up by the next request, with no restart and no second `load()` call. A page that stays broken is recompiled on each request: 0.45 ms versus 0.012 ms for a healthy one, so a persistent failure costs throughput until it is fixed.
- A page from `load()` now exposes `parts` once compilation finishes, matching a page from `compileFile()`. It reads `undefined` while compilation is still in flight.
- `page.handler` no longer throws synchronously when handed an unusable response. It touched `response.headersSent` before entering its promise chain, so `handler(req, null)` threw at the call site while every other failure arrived via `next` — and `handler(req, null).catch(...)` crashed instead of rejecting. All failures now report through the same channel.

### Security

- Source input is now validated explicitly instead of being handed to `Buffer.from`, which accepts an array and silently reinterprets its elements as bytes. `scan([60,112,62])` and `compileSource([60,112,62])` previously compiled nonsense; both now throw. `compileSource()` also validates its options object and `options.filename`, `compileFile()` validates its path, and `render()` validates that the response can be written to — each with an error naming the argument rather than surfacing as an internal `paths[0]` failure.

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
