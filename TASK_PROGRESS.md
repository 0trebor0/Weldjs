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
- **Not addressed** (out of the agreed scope): no byte-size or collection-length caps
  on exported payloads, so a very large export is still bounded only by memory. The
  mid-stream failure case also remains — `render()` writes incrementally, so a request
  block that throws after the first write leaves a truncated page under an already-sent
  200 status. `renderToBuffer()` is not affected. Both were option 3 in the scope
  question and were not selected.
- `parseAttributes` loops in the scanner are bounded by the attribute text length and
  always advance or throw; they were left unchanged.
- Tests exercise the streaming path with a fake response object rather than a real
  socket, so backpressure handling (`await once(response, 'drain')`) is not covered.
