# Task Progress

## Objective

Make the WeldJS prototype fast, memory-light, and secure, without expanding the
`<weld>` API surface. Scope agreed with the user: fix confirmed defects plus a
performance/memory pass. Framework features (router, hot reload, sessions) were
explicitly out of scope. A follow-up instruction required avoiding unbounded loops.

## Status

Complete. All 13 tests pass. Three confirmed defects fixed and verified by probe.

## Files inspected

- `src/index.js`, `src/scanner.js`, `src/compiler.js`, `src/serializer.js`, `src/shared.js`
- `test/weld.test.js`, `example/server.js`, `example/page.html`
- `benchmark.js`, `package.json`, `README.md`, `AGENTS.md`

## Files changed

- `src/serializer.js` — rewritten as a validate-and-copy walk feeding native `JSON.stringify`; added depth cap and `__proto__` rejection; five chained regex escape passes collapsed to one.
- `src/compiler.js` — added `buildRuntimeParts`, which merges runs of static HTML and drops setup placeholders; both render paths now write a precomputed buffer.
- `src/scanner.js` — `findOpeningTag` converted from `while (true)` to a length-bounded loop.
- `src/index.js` — exports `MAX_DEPTH`.
- `test/weld.test.js` — added 7 tests.
- `CHANGELOG.md` — created.
- `TASK_PROGRESS.md` — created.
- `README.md` — documented the new export restrictions and linked the docs page.
- `docs/index.html` — created. Single self-contained documentation page (tutorial, guide,
  `req`/`res` access, Express, API reference, security, limitations). No external assets.
  Verified in a browser: 20 nav links, 0 broken anchors, 14 sections, no horizontal overflow.
  Markdown drafts (`docs/README.md`, `docs/tutorial.md`, `docs/guide.md`) were consolidated
  into it and removed to avoid two sources of truth.

## Defects found and fixed

Each was confirmed by a probe script before fixing and re-verified after.

1. **Validation was not binding on emitted output.** `assertSerializable` walked the
   value, then `JSON.stringify` walked it again. Probe: an accessor validated as
   `"safe"` and emitted `</script><script>alert(1)</script>`. The character escaping
   still blocked that specific breakout, so this was not a proven XSS, but every
   export restriction was bypassable. Fixed by reading each property exactly once
   into a plain-data copy and serializing the copy.
2. **`__proto__` reached a live object literal.** Probe confirmed the emitted
   `const x = {"__proto__":{...}}` replaced the prototype on the client
   (`Object.hasOwn(x, '__proto__') === false`). Escaping the key was tested and does
   **not** work. Fixed by rejecting the key.
3. **No depth limit.** Deeply nested data threw `RangeError: Maximum call stack size
   exceeded`, failing the request. Fixed with `MAX_DEPTH = 64`.

## Second pass: edge-case debug sweep

A 29-check sweep covering scanner boundaries, UTF-8/CRLF handling, backpressure,
serializer limits, and client-side validity of the emitted script. 27 passed
immediately; 2 found real defects, both now fixed in `src/scanner.js`:

- **Duplicate `var` names** across blocks emitted `const x=1; const x=2;` — a
  client-side `SyntaxError` that disables every script on the page while the server
  still returns 200. Now rejected at compile time.
- **Reserved words** (`class`, `let`, ...) were accepted as `var` names because only
  the identifier shape was validated. Same silent-breakage result. Now rejected.

Confirmed working by the same sweep: empty input, `<weldfoo>` not matching, a bare
trailing `<weld`, nested/unclosed rejection, UTF-8 and CRLF preserved across merged
static runs, `Object.create(null)` accepted, `Date`/`Map` rejected, `__proto__` caught
when nested and inside arrays, array holes rejected explicitly, depth boundary exact at
64 accepted / 65 rejected, and the backpressure path resuming correctly on `drain`.

## Tests

Added to `test/weld.test.js`:

- accessor properties are read exactly once
- `__proto__` keys are rejected
- over-deep nesting yields a `TypeError`, not a stack overflow
- nesting at the depth limit still serializes
- line separators and ampersands are escaped
- adjacent static html is merged into one buffer per run
- `render` and `renderToBuffer` produce identical bytes
- duplicate client variable names rejected at compile time
- reserved words rejected as client variable names
- distinct variable names still compile
- emitted client script parses as valid JavaScript (`vm.Script`)

Result: `node --test` → 17/17 pass, 0 fail. Edge-case sweep → 29/29.

## Measurements

| Measurement | Before | After |
| --- | --- | --- |
| Page renders/sec (`npm run bench`) | 34,291 | 31,360–34,707 across 5 runs |
| Serialize 2,000-row payload | 1.94 ms | 2.61 ms |
| Streaming writes, 12 interleaved setups | 15 | 3 |
| Streaming writes, `example/page.html` | 4 | 3 |

Page render throughput is unchanged: the 34,291 baseline falls inside the observed
post-change range, so the benchmark cannot distinguish them.

## Third pass: rename to WeldJS

Project renamed from NodeHTML to WeldJS; delimiter `<node>` → `<weld>`;
`NodeHtmlSyntaxError` → `WeldSyntaxError`; internal part type `'node'` → `'weld'`;
`test/nodehtml.test.js` → `test/weld.test.js`; package name → `weldjs`.

The rename was applied by an explicit ordered rule set rather than a blanket
find-and-replace, so `node:` builtin specifiers, "Node.js", and the `node` binary were
left untouched. One assertion (`!first.includes('<node')`) would have been left passing
vacuously by a naive rename and was corrected to `'<weld'`.

Verified after rename: 17/17 unit tests, 29/29 edge-case sweep, example server returns a
correctly escaped page over real HTTP, benchmark at 36,333 renders/sec.

## Fourth pass: second edge-case sweep

A 24-check sweep of areas the first sweep did not reach: `shared()`, attribute parsing,
empty/degenerate blocks, real concurrency, and further serializer cases. 23 passed; 1
found a real defect, now fixed in `src/compiler.js`:

- **Export errors did not identify the failing block.** A page with many blocks reported
  only `Cannot export function at $`, with no way to tell which one. Errors are now
  wrapped with the variable name and page path, preserving the original as `error.cause`.

`shared()` was previously untested and passed all five checks: the factory runs once for
concurrent callers, the resolved value (not the promise) is cached, a rejected factory is
evicted and can be retried, concurrent callers all observe the rejection, and invalid
keys/factories are rejected.

Also confirmed: concurrent renders of one page stay isolated (alice/bob/carol did not
cross), a Proxy is read exactly once by the serializer, a throwing getter propagates
cleanly, inherited enumerable properties are excluded, `>` inside a quoted attribute
value does not terminate the tag, single quotes and newlines inside the opening tag parse,
Buffer and string input produce identical output, and 60 blocks map to the correct handlers.

Noted, not changed: `page.parts` is only shallowly frozen, so the array itself is mutable.
This is server-side trusted code, so it was left alone rather than widening scope.

## Fifth pass: is async necessary?

Measured the three separate places async appears, rather than assuming.

| Cost | Measured | Verdict |
| --- | --- | --- |
| `async` fn call + await vs sync call | 0.073 us vs 0.002 us | 43x relative, negligible absolute |
| Sync handler + thenable check in `renderToBuffer` | -3.4% (noise) | not worth it |
| Fully sync `renderToBuffer` | 7.1% faster | blocked; handlers may be async |
| Awaited `writeChunk` helper in `render()` | **16.8% faster** to inline | **applied** |

Applied the one change that paid: `writeChunk` was an `async function` allocating a
promise per chunk even when `write()` returned true. Inlined it, awaiting `once(response,
'drain')` only on actual backpressure. Real streaming throughput on a 51 KB page went from
~730,000 to ~870,000 renders/sec (~18%), matching the isolated prediction.

Compilation must stay async — setup blocks use top-level `await` (`await shared(...)` in
`example/page.html`), so a synchronous `compileFile` would have to ban that. Handlers must
stay async-capable for database work; blocks that never await pay about 0.07 us each.

## Sixth pass: behaviour at 1,000 pages

Measured what actually degrades at scale, rather than assuming it was render speed.

| Measure | Before | After |
| --- | --- | --- |
| Compile 1,000 pages (10 KB each) | 72 ms | 78 ms |
| Retained memory ratio to source | 2.12x | 1.20x |
| Buffer memory for 9.3 MB of HTML | 17.6 MB | 9.2 MB |
| Per page | 20 KB | 11 KB |
| Render, page[0] / page[999] | 1.54 / 1.41 us | 1.63 / 1.52 us |

Findings:

- **Render cost does not depend on page count.** page[999] renders as fast as page[0].
- **Compile time is a non-issue.** 0.08 ms per page; 1,000 pages cost 78 ms at boot.
- **Memory was the real problem.** The static-run merging added in the earlier pass left
  single-slice runs as subarray views, and one surviving view pins the entire original
  source buffer alive next to the merged copies — so each page cost roughly its own size
  twice. Now every run is copied into a fresh allocation and the source is dropped,
  bringing buffer memory to ~1:1 with the HTML.
- `page.source` is removed as a result. Nothing in the codebase read it; only the docs
  referenced it.

A first prototype measurement reported 0.17x, which was a GC-liveness artifact of the
harness. Re-measured by summing the underlying ArrayBuffer allocations reachable from the
retained pages, giving 0.99x, which the real implementation then confirmed.

## Seventh pass: two-phase render

Requirement from the user: the response should be sent complete, in one go.

`render()` now resolves all request blocks concurrently, then emits. Effects:

| Measure | Before | After |
| --- | --- | --- |
| Page with 3 independent ~10 ms blocks | 42.9 ms | **14.4 ms** |
| Static-page framework overhead | 1.14 us | 1.77 us |
| Bytes written when a block fails | leading HTML already sent | **0** |
| Transfer encoding | chunked | **Content-Length** |

- Blocks run concurrently because they are independent by construction: sharing state between
  them would require setup scope, which is shared across requests and already unsafe.
- Serialization happens before any write, so export errors are atomic too.
- `Promise.all` settles on the first rejection while siblings keep running, so every handler
  promise gets its own `.catch()` to prevent unhandled rejections from killing the process.
- Writes are corked/uncorked around the loop, and uncorked before awaiting `drain`.
- `Content-Length` is only set when `response.headersSent` is false and `setHeader` exists.
  `writeHead()` sets `headersSent` immediately (verified), so `example/server.js` was changed
  to use `setHeader`. Verified over real HTTP: `Content-Length: 413`, no chunked encoding.

Cost: the static-page framework overhead rose from 1.14 us to 1.77 us, because the emit phase
builds a chunk list and totals its length before writing. That is 0.6 us against a 28 ms saving
on an I/O-bound page.

Tests added: concurrent execution (3x40 ms completing under 100 ms), zero bytes written on
failure, `Content-Length` matches `renderToBuffer().length`, and no header write when headers
are already sent.

## Eighth pass: export size caps

Closes the last unbounded-input path. `MAX_EXPORT_BYTES = 1 MB`, spent during the
snapshot walk so an oversized value is rejected as soon as the limit is crossed rather
than after the whole structure has been copied. Array element cost is charged up front so
a hostile array is rejected before a copy of it is allocated, and a string's length is
charged before it is retained.

The budget is per export: each `var` block gets a fresh one, verified by a test that
renders the same near-limit page twice.

Cost: about 1-2% on a 224 KB payload (2.61 ms before, ~2.65 ms after, stable across three
runs). An intermediate closure-based budget measured ~10% slower and an inlined variant
gained nothing back, so the final version uses a plain helper — the clearest of the three
and also the fastest.

Tests added: oversized array rejected with the path named, single oversized string
rejected, huge sparse array rejected before its elements are walked, a normal 500-row
payload well inside the limit, and the budget proven per-export rather than cumulative.

## Ninth pass: rules audit and Express example

Audited every file against `AGENTS.md` by probing each public entry point rather than
reading for compliance. Result: one genuine violation, one weakness, both fixed.

**Violation — silent coercion.** `scan()` and `compileSource()` passed input straight to
`Buffer.from`, which accepts an array and reinterprets its elements as bytes, so
`compileSource([60,112,62])` compiled `<p>` instead of rejecting a wrong-typed argument.
This is exactly what the rules forbid: "do not silently coerce, repair, default, truncate,
discard, or reinterpret invalid data". Now rejected explicitly.

**Weakness — incidental validation.** Every other entry point did throw, but only because
a Node builtin failed downstream, producing errors like `The "paths[0]" argument must be
of type string` that name neither WeldJS nor the offending argument. `compileSource`
options/filename, `compileFile` path, and the `render` response are now validated at the
boundary with errors that name what was wrong.

`shared()` already validated its own arguments and needed no change.

Added `example/express-server.js`. Express is deliberately **not** added as a dependency,
since the rules forbid adding one that is not required and the example works for anyone
who installs it themselves. Verified: the file parses (`node --check`), and the exact call
sequence it uses was exercised against a real `http.ServerResponse` — Express's `res` is
one — giving `200` with `Content-Length: 413` and no chunked encoding, and a simulated
block failure producing a clean `500` with no truncated page. The Express-specific wiring
(routing, `express.static`, error middleware) is **not** executed here because the package
is not installed.

## Tenth pass: page.handler

User feedback: serving a page should not require writing `async`, `await`, `res.end()`, or
a try/catch in the route. Added `page.handler(request, response, next?)`:

```js
app.get('/', page.handler);
```

- Renders, then ends the response.
- Forwards failures to `next`, which reaches Express's error middleware with nothing
  written, since render is already atomic.
- Sets `content-type: text/html; charset=utf-8` only when nothing has set one, so callers
  can set their own headers first.
- Without `next`, returns the promise rather than swallowing the failure. Express passes
  `next` to every route handler, so the Express path always forwards.

Verified over real HTTP without Express (Express's `res` is an `http.ServerResponse`):
200, `content-type: text/html; charset=utf-8`, `Content-Length: 413`, no chunked encoding,
response ended. Four tests added covering ending, content-type defaulting and not
overriding, error forwarding with zero bytes written, and the returned promise.

Three stale Express snippets in `docs/index.html` still showed the old
`async`/`await`/`res.end()` form and were replaced. The docs now contain no
`await page.render(req, res)` and no `res.end()` outside a comment describing their
absence.

## Eleventh pass: handler sweep

An 11-check sweep of `page.handler`, including four over real HTTP. One defect found:

- **Inconsistent error channel.** `handler` read `response.headersSent` before entering its
  promise chain, so an unusable response threw synchronously from the call site while every
  other failure arrived via `next`. `handler(req, null).catch(...)` therefore crashed rather
  than rejecting. Express masks this by catching sync throws, but the contract was
  incoherent. The header default now runs inside the chain, so all failures report the same
  way. Confirmed by re-running the sweep: "no sync throw".

Confirmed working: the response is ended exactly once on success and never on failure; a
throwing `end()` reaches `next` rather than vanishing; content-type is not set once headers
are sent; a response without `getHeader` still works; HEAD returns correct headers with an
empty body; 20 concurrent HTTP requests each received their own data; and a failing block
produced a real 500 with no page content leaked.

Tests promoted into the suite: error-channel consistency across `null`/`undefined`/`{}`/`42`,
the rejected-promise contract without `next`, and a full real-HTTP request asserting status,
content-type, Content-Length matching the body, and no chunked encoding.

## Assumptions, limitations, remaining risks

- **Serialization is ~35% slower** on large payloads (1.94 ms → 2.61 ms for a 224 KB
  output). This is the deliberate cost of reading each property exactly once. An
  earlier hand-rolled emitter avoided the copy but was 3.6x slower than the original;
  the shipped approach reuses native `JSON.stringify` and was chosen after measuring
  both. Serialization cost scales with exported payload size, not page size.
- **Peak memory during export rises by roughly the size of the exported data**, since
  the snapshot copy is live while `JSON.stringify` runs. The copy is transient. This
  was judged an acceptable trade for making validation binding; it is the one place
  the change costs memory rather than saving it.
- Merging static runs copies those bytes once at compile time, in addition to the
  retained source buffer. Runs of a single slice stay zero-copy, so the extra memory
  only materialises where merging actually reduces writes.
- `MAX_DEPTH = 64` is a chosen value, not a measured limit. Legitimate data nested
  deeper than 64 levels will now be rejected.
- `MAX_DEPTH` (64) and `MAX_EXPORT_BYTES` (1 MB) are chosen constants, not measured limits,
  and are not configurable per page. A page with a legitimate need for a larger export has
  no way to raise them short of editing the source.
- Two-phase render holds every block's value in memory until the response is emitted. Each
  is now capped at 1 MB, so a page with many blocks is bounded by block count times 1 MB.
- The size budget approximates serialized size rather than computing it exactly. It is
  monotonic and never undercounts enough to matter, but a value near the limit may be
  accepted or rejected slightly off the true byte count.
- Time to first byte is now later by however long the slowest block takes, in exchange for
  the response completing sooner. This was the user's explicit preference.
- `parseAttributes` loops in the scanner are bounded by the attribute text length and
  always advance or throw; they were left unchanged.
- Tests exercise the streaming path with a fake response object rather than a real
  socket, so backpressure handling (`await once(response, 'drain')`) is not covered.
