# WeldJS

**Keep HTML as HTML.** WeldJS adds small server-side JavaScript blocks to ordinary
`.html` files for loading data and composing pages — no template language, no build
step, no client-side framework, and no dependencies.

```bash
npm install weldjs
```

## Quick start

Two files. Copy them, run them, and it works.

**`page.html`** — an ordinary HTML file with one `<weld>` block:

```html
<!doctype html>
<html>
  <body>
    <h1>Users</h1>
    <ul id="list"></ul>

    <weld var="users">
    return [
      { name: 'Ada', email: 'ada@example.com' },
      { name: 'Grace', email: 'grace@example.com' }
    ];
    </weld>

    <script>
      document.getElementById('list').innerHTML =
        weld.users.map((u) => `<li>${u.name}</li>`).join('');
    </script>
  </body>
</html>
```

**`server.js`**:

```js
const http = require('node:http');
const path = require('node:path');
const { load } = require('weldjs');

const page = load(path.join(__dirname, 'page.html'));

http.createServer((request, response) => {
  // Without a `next`, handler returns the promise rather than swallowing the
  // failure — so a vanilla server has to catch it. Express users just write
  // `app.get('/', page.handler)`; see below.
  page.handler(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end('Internal Server Error');
  });
}).listen(3000, () => {
  console.log('http://127.0.0.1:3000');
});
```

```bash
node server.js
```

The `<weld var="users">` block ran on the server. The browser received this in its
place, and the `<script>` below it reads the data as `weld.users`:

```html
<h1>Users</h1>
<ul id="list"></ul>

<script>(window.weld=window.weld||{}).users=[{"name":"Ada","email":"ada@example.com"},{"name":"Grace","email":"grace@example.com"}];</script>

<script>
  document.getElementById('list').innerHTML = ...
</script>
```

That is the whole idea: **data is fetched on the server and arrives in the document**,
with no client-side fetch, no loading state, and no serialization code to write.

Every export lands on one `window.weld` object — one global for the whole page, rather
than a bare `users` that collides with whatever else the page loads. The namespace guard
is idempotent, so block order does not matter.

## Why

Most ways to get server data into a page ask you to pick one:

| Approach | Cost |
| --- | --- |
| Template language (EJS, Handlebars, Pug) | A second syntax to learn; your HTML stops being HTML |
| SPA framework | A build pipeline, a client runtime, and a loading state for every screen |
| Client-side `fetch` | An extra round trip, an API endpoint to write, and a flash of empty page |
| WeldJS | JavaScript inside HTML; the file stays a valid `.html` file |

WeldJS is aimed at the middle: **server-rendered pages that need real data but do not
need a framework.** If you want components, reactivity, or client-side routing, use a
framework — that is deliberately not what this is.

## How it works

A page is compiled once at startup. Each request re-runs only the blocks that produce
data. Everything else is pre-computed buffers.

```html
<weld>
const db = require('./db.js');
</weld>

<h1>Users</h1>

<weld var="users">
return await db.users();
</weld>
```

- **`<weld>`** runs **once**, when the page is compiled. Its declarations live in the
  page closure. Use it for configuration and shared clients — see
  [Request isolation](#request-isolation) before putting anything else there.
- **`<weld var="name">`** runs **once per request** and must return JSON-compatible
  data. At response time it becomes `<script>(window.weld=window.weld||{}).name=...;</script>`,
  so the browser reads it as `weld.name`.
- **`<weld src="partials/header.html">`** includes another file at compile time, so
  layouts cost nothing per request.
- Non-`<weld>` HTML is copied into static buffers once at compile time; the original
  source Buffer is not retained.
- Blocks on a page run **concurrently**, so the cost is the slowest block, not the sum.
- Nothing is written until the whole response is known to succeed, so a failing block
  gives a clean error rather than a truncated page under an already-sent 200.

Beyond that:

- **`load(file)`** returns a page synchronously and compiles it in the background, so a
  server needs no async wrapper.
- **`router(dir)`** maps a directory of `.html` files to routes, including `[slug]`
  parameters.
- **`watch(page)`** recompiles on edit during development, tracking files pulled in by
  `<weld src>` as they are added and removed. Pages share one OS watch handle per
  directory; edits rebuild only the pages subscribed to that file. If the OS omits
  the filename, all subscribers in that directory rebuild.
- **`shared(key, factory)`** is a process-wide resource cache for setup blocks.
- **`page.handler`** is a ready-made route handler: `app.get('/', page.handler)` renders,
  ends the response, and forwards errors to `next`.
- A CSP nonce on `res.locals.cspNonce` is applied to the emitted script automatically.

## Request isolation

**Setup scope is shared by every request for the life of the process.** It is
process-shared state, not per-request state:

```html
<weld>
let currentUser = null;              // ❌ shared by every request
</weld>
<weld var="profile">
currentUser = request.query.user;    // ❌ another request can overwrite this
const row = await lookup(currentUser);
return { name: currentUser };        // ❌ may now be someone else's value
</weld>
```

Keep per-request values local to the block:

```html
<weld>
const db = await shared('db', () => openDatabase());   // ✅ genuinely shared
</weld>
<weld var="profile">
const user = request.query.user;     // ✅ local to this invocation
return { user, rows: await db.recentFor(user) };
</weld>
```

A top-level `let` or `var` in a setup block emits a warning. It is a **heuristic, not a
safety check**: `const` does not make setup state request-safe either, since a `const`
object can still be mutated. Silence means no reassignable binding was found, not that
the page is safe.

## Express

```js
const path = require('node:path');
const express = require('express');
const { load } = require('weldjs');

const page = load(path.join(__dirname, 'page.html'));
const app = express();

app.get('/', page.handler);
app.listen(3000);
```

Use `res.setHeader(...)` rather than `res.writeHead(...)` — `writeHead` marks the headers
as sent, which stops `render()` adding `Content-Length`.

`example/express-server.js` serves the SQLite users page at `/users`, file-routed
pages at `/`, `/about`, `/blog`, `/blog/:slug`, and `/with-partials`, and the full
documentation at `/docs`. In development it watches `/users` and `/with-partials`,
including the latter's header and footer. Watching is disabled in production.

Both shipped demo servers require **Node 22.5+** for `node:sqlite`. They serve
`example/public/users.js` at `/assets/users.js`; the users page reads `weld.users`
from this external script so it works under the Express demo's strict CSP.
Documentation inline scripts and styles are allowed by hashes calculated at
startup; restart that demo after changing those inline assets. Express is optional
and is not a library dependency. Install it where you run the Express demo:

```bash
npm install express
node example/express-server.js
```

## Security boundary

`<weld>` is trusted server application code with normal Node.js privileges. It is **not**
a sandbox. Compiling an HTML file is equivalent to `require`-ing it, so **never compile a
file a user supplied, uploaded, or can edit.**

Only values returned from `<weld var="...">` are serialized to the client, and only
JSON-compatible primitives, arrays, and plain objects. Enforced at render time:

- Values are validated and copied in a single walk, so each property is read exactly
  once. What is validated is what is written, even if the source object uses accessors.
- Characters that could break out of the generated `<script>` are escaped.
- A `__proto__` key is rejected — the output is spliced into an object literal, where
  that key would set the client object's prototype.
- `undefined`, functions, symbols, bigints, non-finite numbers, circular references, and
  non-plain objects are rejected.
- Data nested deeper than 64 levels is rejected.
- More than 1 MiB of emitted `<script>` payload per render is rejected, measured in UTF-8
  bytes after escaping and summed across every block on the page. Configurable per page
  with `maxExportBytes`.

## Documentation

The API is pre-1.0. The browser contract is `window.weld.<name>`; low-level exports
such as `scan`, `serialize`, and `page.parts` should be treated as internals.

Full docs — tutorial, guide, API reference, and security notes — are a single
self-contained page at [`docs/index.html`](docs/index.html). Open it directly, or serve it:

```js
app.use('/docs', express.static(path.join(__dirname, 'docs')));
```

Open work and known risks are tracked in [`TODO.md`](TODO.md); change history in
[`CHANGELOG.md`](CHANGELOG.md).

## Requirements

Node.js 20 or newer. No dependencies.

```bash
npm test
```

`npm start` runs `example/server.js`, which reads from SQLite via `node:sqlite` and
therefore needs **Node 22.5 or newer**. The library itself does not — the test that
compiles that example is skipped below 22.5, and everything else runs on Node 20.

From this repository checkout, run `npm run bench` to measure compilation of
1,000 retained pages and rendering
of small exports, large strings, HTML text, and 2,000-row payloads. It reports both
`renderToBuffer()` and `render()` CPU timings; the latter uses a no-socket sink,
so these results do not measure HTTP throughput or client backpressure.

From this repository checkout, run `npm run bench:http` for a real HTTP benchmark
of 1,000 file-routed pages.
It runs concurrent small exports, large row exports, and slow readers, checking
every response byte, request-specific user, and `Content-Length`. Each workload
runs its server in a separate child process and reports requests/sec, p50/p95/p99
latency, server CPU milliseconds and percent of one core, sampled peak RSS/heap,
process-lifetime peak RSS (including startup), errors, and backpressure drain events.
Memory is sampled every 10 ms and may miss short peaks; CPU percent can exceed 100
when Node uses multiple threads. The client and server share this machine, so these
are local measurements, not deployment capacity estimates. For a short verification
run, use `npm run bench:http -- --smoke`. Temporary project files are created inside
this repository and removed afterward.

## Limitations

- Literal `<weld>` / `</weld>` sequences are reserved delimiters anywhere in the file.
- Nested `<weld>` blocks are rejected; `var` and `src` are the only attributes.
- Includes are flat — a page can pull in a partial, but cannot be *wrapped* by a layout.
- Exported data lands on `window.weld`, so `weld` is the one name a page must leave alone.
  A page that exports anything and also declares `weld` at the top level of its own
  `<script>` fails to compile; a `weld` introduced by an external `<script src>` cannot be
  seen at compile time.
- No body parser, sessions, authentication, or database abstraction — by design. Express
  covers them.

## License

MIT
