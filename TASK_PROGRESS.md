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

## Twelfth pass: load(), removing the async wrapper

User feedback: the server was still wrapped in `async function main()` purely to hold the
`await compileFile(...)`. Added `load(filename)`, which returns the page synchronously and
compiles in the background. The whole server is now synchronous.

- Requests arriving before compilation finishes wait for it. Verified over real HTTP: a
  request fired immediately after `listen` returned 200 with the correct body, and a second
  request returned byte-identical output.
- Pages are cached by resolved path, so `load(abs)` and `load(relative)` return the same
  page and setup blocks are not run twice. This closes the caching gap noted earlier.
- `page.ready` exposes the compile promise.

Trade-off accepted: `compileFile` failed at boot, which stopped a malformed page from ever
serving. `load` cannot do that without an await, so a compile failure is instead reported
on stderr immediately, rejects `page.ready`, and fails each request through `next`. Callers
who want the old behaviour add `page.ready.catch(() => process.exit(1))`, which the example
documents.

Tests added: synchronous return and successful serve, caching across equivalent paths,
compile failure surfaced through both `ready` and `next`, and argument validation.
`clearLoaded()` was added so the cache does not leak between tests.

Docs updated: the tutorial and Express sections no longer contain an `async function main`
wrapper anywhere.

## Thirteenth pass: load() sweep

A 9-check sweep of `load()`. Three defects found, all fixed.

- **A failed compile was cached permanently.** A page that failed to compile stayed broken
  for the life of the process even after the author corrected the file, and a path that did
  not exist yet could never load once it appeared. `shared()` already evicted failed
  entries, so the library had two caches with opposite semantics. `load()` now evicts too.
- **Missing-file failures stuck** for the same reason; same fix.
- **`parts` was absent** on a loaded page, so it did not expose the same surface as a
  compiled one. Added as a getter that reads `undefined` until compilation finishes.

Confirmed working: concurrent `load()` before compilation finishes returns one page, setup
runs exactly once across repeated loads, `clearLoaded()` forces a fresh compile, `render`
and `renderToBuffer` both work through a loaded page, and 30 HTTP requests arriving during
compilation all returned 200 with their own correct data.

## Fourteenth pass: make failed compiles actually recoverable

The thirteenth pass evicted failed entries from the `load()` cache, which was an incomplete
fix. Evicting the map entry only helps a caller that calls `load()` again; a server calls
it once at boot and then holds the page object, whose `ready` promise had already rejected.
Verified: correcting the file left the held page failing forever.

The retry now lives on the page object. `ensureCompiled()` caches only a successful compile
and clears the pending promise on failure, so the next request tries again. `ready` became a
getter for the same reason — a fixed promise would replay the old error forever.

Verified with the real-server pattern: load once, hold the object, compile fails, correct
the file, and the next request succeeds with `parts` populated. No restart, no second
`load()` call.

Cost of the retry, measured on a ~16 KB page: a persistently broken page recompiles per
request at 0.45 ms, against 0.012 ms for a healthy one — about 37x, still 2,200 requests
per second. Accepted without a cooldown: this is a short-lived error state, and a retry
throttle would be speculative complexity. If a broken page under sustained load ever
matters, a minimum interval between attempts is the obvious next step.

Tests added: a held page recovering after correction, and a successful compile not being
repeated on later requests.

## Fifteenth pass: routing, CSP nonce, hot reload, includes

Four features, built in the order the user asked for. Ordering note raised up front: hot
reload needs to know about include dependencies, so `watch()` was designed to take a
dependency set and includes plugged into it without rework.

**File-based routing** (`src/router.js`). Route table built once at startup by walking the
directory; the filesystem is never consulted at request time, so traversal has nothing to
match. Verified over raw sockets, because Node's HTTP *client* normalises `%2e%2e` before
sending and made an early check look like a failure: `/blog/%2e%2e`,
`/%2e%2e/%2e%2e/etc/passwd`, `/blog/..`, `/blog/%00` and `/blog/%ZZ` all return 404.
Static routes are one Map lookup; dynamic routes are bucketed by segment count. Symlinked
directories are not followed and the walk is depth-capped at 32.

**CSP nonce**. The inline `<script>` was incompatible with a strict policy. A nonce on
`res.locals.cspNonce` or `res.locals.nonce` is applied automatically — zero configuration
for the common helmet setups. A malformed nonce is refused rather than escaped: escaping
produces a tag the policy will not match, which fails as a blank page instead of an error.

**Hot reload** (`watch`). Debounced rebuild on change, setup blocks re-run, idempotent per
page, `close()` stops it, and included files are watched too. `page.invalidate()` was added
to support it and is useful on its own.

**Includes**. `<weld src="...">` is expanded before scanning, so the scanner and compiler
are unchanged and the included markup merges into the surrounding static runs — a page with
two partials still writes two buffers. Duplicate variable names across a partial and its
page are caught by the scanner's existing check, for free. Cycles refused, depth capped
at 16.

Regression check: render throughput unchanged at 33,000-35,000 renders/sec across four runs
(one 28,294 outlier was not reproducible). Unit tests 43 -> 64; all five sweeps still pass.

One test earned its keep: "a loaded page exposes the same surface as a compiled one" failed
the moment `dependencies` was added to compiled pages but not loaded ones.

## Forward-looking risks

A review of what works today but becomes a problem as the project grows is recorded in
`TODO.md`. Two items there were confirmed by measurement rather than inspection: client-side
global collisions break every script on a page, and the 1 MB export cap is per block rather
than per page, so five blocks produced a 4.29 MB response holding 18.9 MB per in-flight
request.

## Sixteenth pass: acting on the risk review

Worked through `TODO.md`. Eight items closed, four deferred with reasons recorded there.

| Item | Outcome |
| --- | --- |
| Export cap per block, not per page | Fixed: one budget per render. The 5-block page that produced 4.29 MB now fails on the second block. |
| Client global collisions | Fixed by compile-time detection rather than the namespace change, which would break every existing page. Residual risk (external scripts) recorded. |
| Setup-scope leak | Warning on top-level `let`/`var` in setup blocks, opt-out available. Heuristic. |
| Literal `<weld>` in a page | No code needed: `&lt;weld&gt;` already passes the scanner. Now tested and documented. |
| Byte offsets in errors | Line and column, plus `.line`/`.column`. |
| `page.parts` shallow freeze | Frozen through. |
| Export limit not configurable | `maxExportBytes` option, validated at compile. |
| Packaging | LICENSE, `.gitattributes`, `types/index.d.ts`, real `package.json` fields. |

The collision fix is worth noting as a judgement call. The TODO proposed emitting into a
namespace, which is the complete fix but breaks the client contract for every page written
so far. Detecting the collision at compile time closes the confirmed failure without a
breaking change, and the namespace option is left recorded for when the syntax is settled.

One mistake mid-pass: a scripted edit to `src/serializer.js` was mangled by shell quoting
around a `'$'` literal, duplicating whole blocks. Caught by `node --check`, restored with
`git checkout`, and redone with the editor rather than a shell script. Tests confirmed the
restore before continuing.

Verified: 71 unit tests, all five sweeps, example server, and 33,215 renders/sec.

## Seventeenth pass: test everything

Ran the whole suite plus a new 13-check sweep aimed at feature *interactions*, which
nothing had covered, and a real slow-client test.

One defect found: **syntax errors never named the file.** A plain page reported
`Missing </weld> (line 3, column 3)` with no filename, and a broken partial reported a line
number belonging to the partial, which matches nothing in the page that included it. With
1,000 routed pages and shared partials this is close to undiagnosable. Errors now carry
`.filename` and name the file in the message.

Interactions confirmed working, none of which had been tested before: a CSP nonce reaches
blocks contributed by a partial; the per-page export budget covers partial blocks; a
`<script>` inside a partial is seen by the collision check; a mutable setup binding inside a
partial warns; the router serves an included page with a nonce and a correct
`Content-Length`; and a routed page that failed to compile recovers once the file is fixed,
without a restart.

Security re-checked: a nonce cannot break out of its attribute (3 payloads refused),
hostile export data still cannot break the script tag, and a traversing include path
resolves relative to the page rather than reading somewhere unexpected.

Backpressure was previously only tested against fake response objects. Verified against a
genuinely slow client: a 1.6 MB page with the client stalled for 400 ms completed correctly,
`Content-Length` matching the body exactly. This had been the most plausible remaining
production bug and it is clean.

Packaging verified: all 14 exported names present, `files`/`types`/`license` correct, the
declaration file names the real exports.

## Eighteenth pass: unused code audit

Audited every declaration and export for actual use. No dead declarations, but four
pieces of API surface with nothing behind them, all removed: `router()`'s options
argument (validated then never read), `middleware.root`, the serializer's `NONCE_PATTERN`
export, and an unused type import. `assertSerializable` and `WeldSyntaxError` were
exported, typed and never exercised by a test; they are real API, so they were tested
rather than removed. Every exported name is now exercised.

The README still described the project as "PHP-like one-file pages", which predated
includes and file-based routing. Updated.

## Nineteenth pass: coverage to 100% lines

Per-file coverage was the useful lens: every gap was an error path, and several were
covered only by throwaway sweeps rather than the suite.

| Measure | Before | After |
| --- | --- | --- |
| Lines | 97.41% | **99.84%** |
| Branches | 91.47% | **99.07%** |
| Files at 100% lines | 1 of 6 | **6 of 6** |
| Tests | 79 | 109 |

Newly covered, all reachable in real use: non-finite numbers, circular structures and
`Date`/`Map`/`Set` returned from a block — the three things a real query most often
produces; nested blocks, unsupported attributes, invalid variable names; includes past
the depth limit; the mutable-setup warning; `watch` without a callback, with a bad
dependency list, with an unwatchable dependency, closed mid-rebuild, and a rebuild that
fails then recovers; router query strings, fragments, dotfiles, missing `next`, missing
`url`, and merging into an existing `request.params`.

Four pieces of code were deleted rather than tested, because nothing could reach them:
the unclosed-attribute-value guard, the empty-segment check in dynamic matching, the
trailing-whitespace break in `parseAttributes`, and the `Array.isArray` fallback for a
page's dependency list. Removing the first required `findTagEnd` to distinguish an
unterminated quote from an unclosed tag, which also fixed a misleading error message.

One sweep assertion was found to be passing vacuously: it expected a syntax error for a
bare trailing `<weld`, did not get one, threw its own `Error('expected a syntax error')`,
and its catch matched the word "expected" in that message. The real behaviour — a trailing
`<weld` with nothing after it is not a tag and passes through — is now pinned by the suite.

Residual: one uncallable expression, `Object.getPrototypeOf(async function () {})`, whose
inner function exists to yield a constructor.

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
