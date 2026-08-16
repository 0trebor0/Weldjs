# TODO

Open work for WeldJS, ordered by when it will hurt rather than by effort.

Measurements quoted here are reproducible from the notes in `TASK_PROGRESS.md`.

## Done

- **The browser export contract is settled.** Exports land on one `window.weld` object rather
  than bare globals, which removes the collision class entirely: `weld` is the only name a page
  must leave alone. Breaking change to the client contract, taken deliberately while the page
  count is small. Verified in a real browser — `weld.users` populated, no bare global created,
  no console errors.

- **`watch()` tracks the real dependency graph.** It no longer reads `page.dependencies`
  synchronously (empty before the first compile), and reconciles the watched set after every
  rebuild, so includes added or removed while the server runs are picked up. Handles are reused
  rather than reopened, so repeated rebuilds do not accumulate them.
- **The export limit is exact.** The finished `<script>` payload is measured with
  `Buffer.byteLength(..., 'utf8')`. The walk-time budget is kept as an early guard but its charges
  are now strict lower bounds, so it can no longer reject a payload that actually fits. The limit
  is defined as the whole emitted element, summed across blocks, per render.
- **CI.** `npm test` on Node 20/22/24 (Linux) plus Node 20 on Windows and macOS, and a packaging
  job that installs the built tarball and requires it.
- **Package metadata.** `repository`, `bugs`, `homepage`; `files` and `license` verified against
  `npm pack --dry-run` and `LICENSE`.
- **Docs audited against the implementation.** Several documented behaviours were wrong; see the
  changelog. The README now opens with install and a copy-pasteable example, and carries an API
  stability statement.

- **Client-side global collisions.** A `<weld var="x">` whose name is also declared by a
  `<script>` on the same page is now rejected at compile time. Two `const x` declarations
  are a `SyntaxError` that disables every script on the page while the server still returns
  200. The check is conservative — it looks only at top-level declarations, so occurrences
  inside a nested block or a string do not trigger it. *Residual risk below.*
- **Export size is now bounded per render, not per block.** One budget is shared by every
  block on the page, so five blocks can no longer produce five times the limit. The page
  that previously returned 4.29 MB holding 18.9 MB now fails on the second block.
- **Export limit is configurable** via `compileSource(src, { maxExportBytes })`, validated
  at compile time rather than on the first request.
- **Setup-scope guardrail.** A top-level `let`/`var` in a setup block now emits a warning
  naming the bindings, because the cross-user leak needs a mutable binding. Heuristic, not
  proof. Opt out with `{ warnOnMutableSetup: false }`.
- **Errors report line and column** instead of a byte offset, and carry `.line`/`.column`.
- **Literal `<weld>` in a page.** No code change was needed: `&lt;weld&gt;` renders as
  `<weld>` in a browser and is not matched by the scanner, so a page can document the syntax.
  Now covered by a test. *Caveat below.*
- **`page.parts` is frozen through**, not only at the top level.
- **Packaging.** `LICENSE` (MIT), `.gitattributes` (`* text=auto eol=lf`, ending the
  LF/CRLF churn), hand-written `types/index.d.ts`, and a `package.json` with `files`,
  `exports`, `types`, `license` and `keywords` instead of `private: true`.

## Remaining

### Watcher tests are unverified on macOS — help wanted

CI runs macOS as **advisory**: it reports but does not gate the build. The watcher tests have
failed there twice, both times for timing rather than a product bug — a fixed wait for an
`fs.watch` event that was long enough on Linux and Windows and not on macOS. The second round
replaced those fixed waits with condition polling on a 15 s timeout, and macOS still failed.

Nobody on the project has a Mac, so the remaining cause has not been reproduced. It is not
known whether this is:

- still latency, and the 15 s poll is somehow not applying to whichever assertion fails;
- `os.tmpdir()` resolving to `/var/folders/...`, which is a symlink to `/private/var/folders/...`
  — `path.resolve` does not resolve symlinks, so a watcher registered under one form and an
  event delivered under the other would never match; or
- `fs.watch` on macOS genuinely not reporting a write to a file watched by path.

The symlink case is the most likely and the easiest to check first: log `fs.realpathSync` of the
page path alongside `page.filename` inside a failing run.

- **What to do:** run `npm test` on a Mac, read the actual failure, and either fix the watcher
  or fix the test. Then remove `advisory: true` from the macOS matrix entry in
  `.github/workflows/ci.yml`.
- **Why it is not gating:** a permanently red build trains people to ignore it, and tuning
  timings blind against a runner nobody can reproduce on is how tests become meaningless.

### watch() opens a file handle per file

At 1,000 pages plus partials, development hits Linux's inotify limit (commonly 8,192) with
`ENOSPC: System limit for number of file watchers reached` — an error that reads like a disk
problem.

- **Fix:** watch directories rather than individual files and map an event back to the
  pages it affects.
- **Why deferred:** reconsidered during the dependency-tracking fix and not chosen. Per-file
  watching with reconciliation was the smaller change and kept the existing `watcher.files`
  contract; directory watching would have needed its own event-to-page mapping on top. It only
  bites in development at a page count nobody has reached yet.

### Setup blocks all run at boot

1,000 pages run 1,000 setup blocks before the first request. Pages that open their own
connections instead of using `shared()` will exhaust a pool at startup.

- **Fix:** a lazy option on `load()` that defers compilation to the first request, trading
  first-request latency for boot cost.

### Decide whether the syntax is final

The `<node>` to `<weld>` rename was breaking, and the failure mode was silent: an
unrecognised tag passes through as ordinary HTML. Any future change carries that property.

- **Fix:** decide while the page count is small; optionally warn on tags that look like a
  WeldJS block but are not recognised.

### Literal `<weld>` inside a `<script>` body

HTML entities are not decoded inside `<script>`, so `&lt;weld&gt;` there renders literally.
A script that needs the exact text must split it (`"<wel" + "d>"`).

- **Fix:** an explicit escape or ignore directive, if this ever comes up in practice.

## Coverage

99.80% lines, 98.88% branches, 97.67% functions overall. Four of six source files are at 100%
across all three; `compiler.js` is at 99.57 / 97.95 / 96.30 and `scanner.js` at 100 / 99.11 / 100.

Two residuals, both known:

- `Object.getPrototypeOf(async function () {})` exists to obtain the AsyncFunction constructor,
  so the inner function is never invoked and cannot be. A coverage artefact rather than
  untested code.
- The `clearTimeout` inside `watcher.close()` only executes when close lands inside the 20 ms
  debounce window with an event already delivered. The *behaviour* is covered — "closing a
  watcher cancels a rebuild that is still pending" asserts no rebuild happens — but whether
  that specific branch executes depends on filesystem event timing, so it is not reliably hit.
  Forcing it would mean a sleep-tuned test that is flaky on CI, which is worse than the gap.

## Known gaps

- **A persistently broken page recompiles on every request** (0.45 ms versus 0.012 ms
  healthy). Accepted deliberately; revisit with a minimum retry interval if it matters.
- **`MAX_DEPTH` is still a constant** — only the export limit became configurable.
- **The Express example is not executed by any test**, because Express is not a dependency.
  Its call sequence is verified against a real `http.ServerResponse`, but routing,
  `express.static` and the error middleware are not.
- **`page.handler` without a `next` is a footgun.** It returns the promise rather than
  swallowing the failure, which is the right contract, but
  `http.createServer(page.handler)` therefore leaves the rejection unhandled and the first
  failing block terminates the process. Documented in the README and API reference; consider
  whether a `page.listener` convenience that catches and sends a 500 is worth adding.

## Verified, no longer a concern

- **Backpressure with a slow client.** A 1.6 MB page served to a client stalled for 400 ms
  completed correctly, with `Content-Length` matching the body exactly. Previously tested
  only against fake response objects.
- **The README quick start.** Copied verbatim into an empty directory and run: serves the
  documented HTML, and returns 500 without dying when a block throws.
- **Published package contents.** `npm pack --dry-run` produces exactly the eleven intended
  files; CI installs the tarball into a clean project and requires it.
- **TypeScript declarations.** Checked with `tsc --strict` against representative usage of
  `load`, `watch`, `router`, `compileSource`, `serialize` and the page surface.

## Considered, not chosen

- **Block-level caching**, e.g. `<weld var="nav" cache="60">`, for data identical across
  users. The attribute parser already rejects unknown attributes, so this slots in cleanly.
- **Body parsing, sessions, CSRF.** Deliberately out of scope; Express covers them.
- **Nested layouts or slots.** Includes cover shared headers and footers; a page that wants
  to be *wrapped* by a layout still cannot express that.
