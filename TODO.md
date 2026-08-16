# TODO

Open work for WeldJS, ordered by when it will hurt rather than by effort.

Measurements quoted here are reproducible from the notes in `TASK_PROGRESS.md`.

## Done

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

### watch() opens a file handle per file

At 1,000 pages plus partials, development hits Linux's inotify limit (commonly 8,192) with
`ENOSPC: System limit for number of file watchers reached` — an error that reads like a disk
problem.

- **Fix:** watch directories rather than individual files and map an event back to the
  pages it affects.
- **Why deferred:** it is a rewrite of the watcher's bookkeeping, and it only bites in
  development at a page count nobody has reached yet.

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

### Residual collision risk

The compile-time check catches names declared by the page's own `<script>` blocks. It cannot
see a name introduced by an external script loaded with `src`, so a collision with a vendor
global is still possible and still fails the same way.

- **Fix:** emit into a namespace (`weld.users`) rather than a bare global. This is a breaking
  change to the client contract, which is why it was not done alongside the detection —
  worth deciding before there are many pages.

### Literal `<weld>` inside a `<script>` body

HTML entities are not decoded inside `<script>`, so `&lt;weld&gt;` there renders literally.
A script that needs the exact text must split it (`"<wel" + "d>"`).

- **Fix:** an explicit escape or ignore directive, if this ever comes up in practice.

## Known gaps

- **A persistently broken page recompiles on every request** (0.45 ms versus 0.012 ms
  healthy). Accepted deliberately; revisit with a minimum retry interval if it matters.
- **`MAX_DEPTH` is still a constant** — only the export limit became configurable.
- **The Express example is not executed by any test**, because Express is not a dependency.
  Its call sequence is verified against a real `http.ServerResponse`, but routing,
  `express.static` and the error middleware are not.
- **No CI.** Every check so far has been run locally.

## Verified, no longer a concern

- **Backpressure with a slow client.** A 1.6 MB page served to a client stalled for 400 ms
  completed correctly, with `Content-Length` matching the body exactly. Previously tested
  only against fake response objects.

## Considered, not chosen

- **Block-level caching**, e.g. `<weld var="nav" cache="60">`, for data identical across
  users. The attribute parser already rejects unknown attributes, so this slots in cleanly.
- **Body parsing, sessions, CSRF.** Deliberately out of scope; Express covers them.
- **Nested layouts or slots.** Includes cover shared headers and footers; a page that wants
  to be *wrapped* by a layout still cannot express that.
