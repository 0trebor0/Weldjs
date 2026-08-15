# WeldJS prototype

A dependency-free vanilla Node.js experiment for PHP-like one-file pages.

The HTML file is left alone except for special `<weld>` blocks:

```html
<weld>
const db = require('./db.js');
</weld>

<h1>Users</h1>

<weld var="users">
return await db.users();
</weld>

<script>
console.log(users);
</script>
```

- `<weld>...</weld>` runs once when the page is compiled/loaded. Its declarations live in the page closure.
- `<weld var="name">...</weld>` runs once per request and must return JSON-compatible data.
- The request block is replaced at response time with `<script>const name=...;</script>`.
- All non-`<weld>` HTML is retained as slices of the original Buffer.
- The page is compiled once; normal requests do not rescan or recompile the HTML.
- `shared(key, factory)` is available inside setup code for resources that should be shared across pages.
- `load(file)` returns a page synchronously and compiles it in the background, so a server needs no async wrapper.
- `page.handler` is a ready-made route handler: `app.get('/', page.handler)` renders, ends the response, and forwards errors to `next`.

## Documentation

Full docs — tutorial, guide, API reference, and security notes — are a single
self-contained page at [`docs/index.html`](docs/index.html). Open it directly, or
serve it:

```js
app.use('/docs', express.static(path.join(__dirname, 'docs')));
```

## Express

`example/express-server.js` shows the same page served through Express, including
static docs and an error handler. Express is not a dependency of this project, so
install it yourself to run that example:

```bash
npm install express
node example/express-server.js
```

The whole server is synchronous:

```js
const { load } = require('weldjs');

const page = load(path.join(__dirname, 'page.html'));
const app = express();

app.get('/', page.handler);
app.listen(3000);
```

Use `res.setHeader(...)` rather than `res.writeHead(...)` — `writeHead` marks the
headers as sent, which stops `render()` adding `Content-Length`.

## Run

```bash
npm test
npm start
```

Then open `http://127.0.0.1:3000`.

## Security boundary

`<weld>` is trusted server application code with normal Node.js privileges. It is **not** a sandbox. Only returned values from `<weld var="...">` are serialized to the client. Exported values are restricted to JSON-compatible primitives, arrays, and plain objects. The serializer escapes characters that could break out of the generated `<script>`.

Export rules, all enforced at render time:

- Values are validated and copied in a single walk, so each property is read exactly once. What is validated is what is written, even if the source object uses accessors.
- A `__proto__` key is rejected. The output is spliced into an object literal, where that key would set the client object's prototype.
- Data nested deeper than 64 levels is rejected.
- `undefined`, functions, symbols, bigints, non-finite numbers, circular references, and non-plain objects are rejected.

## Prototype limitations

- Literal `<weld>` / `</weld>` sequences are reserved delimiters anywhere in the file.
- Nested `<weld>` blocks are rejected.
- Only the `var` attribute is currently supported.
- No hot reload, router, body parser, sessions, database abstraction, or production hardening yet.
