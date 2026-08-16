'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { scan } = require('./scanner');
const { clientScript, createBudget, MAX_EXPORT_BYTES } = require('./serializer');
const { shared } = require('./shared');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function getCode(source, part) {
  return source.subarray(part.codeStart, part.codeEnd).toString('utf8');
}

function buildFactorySource(parsed) {
  const setup = parsed.parts
    .filter((part) => part.type === 'weld' && part.mode === 'setup')
    .map((part) => getCode(parsed.source, part))
    .join('\n\n');

  const requestParts = parsed.parts.filter(
    (part) => part.type === 'weld' && part.mode === 'request'
  );

  const handlers = requestParts.map((part, index) => {
    const code = getCode(parsed.source, part);
    return `async function __weld_${index}(request, response) {\n${code}\n}`;
  }).join('\n\n');

  const handlerList = requestParts.map((_, index) => `__weld_${index}`).join(',');

  return `
"use strict";
${setup}
${handlers}
return [${handlerList}];
`;
}

// Removing setup blocks leaves runs of static HTML separated only by the gap the
// block occupied, so those runs are joined once at compile time. A request then
// writes one buffer per run instead of one per original slice. A run of a single
// slice stays a zero-copy view over the source.
function buildRuntimeParts(parsed, handlers) {
  const runtimeParts = [];
  let pending = [];
  let requestIndex = 0;

  // Every run gets a fresh allocation, even a run of one slice. Keeping a single
  // subarray view would pin the whole original source buffer alive for the life
  // of the page, so a page would cost its own size twice: once for the source,
  // once for the merged runs. Copying every run lets the source be collected.
  function flushStatic() {
    if (pending.length === 0) return;

    let total = 0;
    for (const slice of pending) total += slice.length;

    const buffer = Buffer.allocUnsafe(total);
    let offset = 0;
    for (const slice of pending) {
      slice.copy(buffer, offset);
      offset += slice.length;
    }

    runtimeParts.push({ type: 'html', buffer });
    pending = [];
  }

  for (const part of parsed.parts) {
    if (part.type === 'html') {
      pending.push(parsed.source.subarray(part.start, part.end));
      continue;
    }

    if (part.mode === 'setup') continue;

    flushStatic();
    runtimeParts.push({
      type: 'request',
      varName: part.varName,
      handler: handlers[requestIndex],
      valueIndex: requestIndex
    });
    requestIndex += 1;
  }

  flushStatic();
  return runtimeParts;
}

// Bounds include nesting. A cycle is already caught by the chain check below;
// this also stops a legal but absurd depth from exhausting the stack.
const MAX_INCLUDE_DEPTH = 16;

// Setup scope is shared by every request for the life of the process, so request
// data placed there leaks between users. The leak needs a mutable binding, and
// it is invisible without concurrency, so a top-level let/var in a setup block is
// worth flagging even though the check is only a heuristic: const bindings, which
// cannot be reassigned, are what setup scope is for.
const MUTABLE_SETUP_BINDING = /^[ \t]*(let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

function warnAboutMutableSetup(parsed, filename) {
  const names = [];

  for (const part of parsed.parts) {
    if (part.type !== 'weld' || part.mode !== 'setup') continue;

    const code = getCode(parsed.source, part);
    let match;
    while ((match = MUTABLE_SETUP_BINDING.exec(code)) !== null) names.push(match[2]);
    MUTABLE_SETUP_BINDING.lastIndex = 0;
  }

  if (names.length === 0) return;

  console.warn(
    `WeldJS: ${filename} declares mutable setup bindings (${names.join(', ')}). ` +
    'Setup scope is shared by every request, so anything derived from a request ' +
    'must live inside a <weld var> block instead. Use const for shared resources.'
  );
}

// Replaces every <weld src="..."> with the contents of that file, recursively,
// before anything else runs. The scanner and compiler then work on the expanded
// bytes exactly as they would on a single file, so includes cost nothing per
// request and variable-name collisions across included files are caught by the
// scanner's existing duplicate check.
function expandIncludes(source, filename, chain, depth, dependencies) {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`<weld src> nested deeper than ${MAX_INCLUDE_DEPTH} levels in ${filename}`);
  }

  const parsed = scan(source);
  const includes = parsed.parts.filter((part) => part.type === 'weld' && part.mode === 'include');
  if (includes.length === 0) return parsed.source;

  const directory = path.dirname(filename);
  const pieces = [];
  let cursor = 0;

  for (const part of includes) {
    const resolved = path.resolve(directory, part.src);

    // A file may not include itself, directly or through a chain.
    if (chain.includes(resolved)) {
      throw new Error(
        `<weld src> cycle: ${[...chain, resolved].map((f) => path.basename(f)).join(' -> ')}`
      );
    }

    let included;
    try {
      included = fs.readFileSync(resolved);
    } catch (error) {
      throw new Error(`<weld src="${part.src}"> in ${filename}: ${error.message}`);
    }

    dependencies.add(resolved);

    pieces.push(parsed.source.subarray(cursor, part.tagStart));
    pieces.push(
      expandIncludes(included, resolved, [...chain, resolved], depth + 1, dependencies)
    );
    cursor = part.tagEnd;
  }

  pieces.push(parsed.source.subarray(cursor));
  return Buffer.concat(pieces);
}

async function compileSource(input, options = {}) {
  // Validated here rather than left to path.resolve, so a bad argument names
  // the option that was wrong instead of surfacing as "paths[0]".
  if (options === null || typeof options !== 'object') {
    throw new TypeError('compileSource() options must be an object');
  }

  if (options.filename !== undefined && typeof options.filename !== 'string') {
    throw new TypeError('compileSource() options.filename must be a string');
  }

  // Configurable so a page with a legitimately larger payload does not have to
  // edit the source. createBudget validates the value.
  const exportLimit = options.maxExportBytes === undefined
    ? MAX_EXPORT_BYTES
    : options.maxExportBytes;

  createBudget(exportLimit);   // fail at compile, not on the first request

  const filename = path.resolve(options.filename || 'page.html');

  const dependencies = new Set();
  const expanded = expandIncludes(input, filename, [filename], 0, dependencies);

  const parsed = scan(expanded);
  if (options.warnOnMutableSetup !== false) warnAboutMutableSetup(parsed, filename);

  const factorySource = buildFactorySource(parsed);
  const pageRequire = createRequire(filename);

  // Developer-authored <weld> code is trusted application code, not sandboxed code.
  const factory = new AsyncFunction(
    'require',
    '__filename',
    '__dirname',
    'shared',
    factorySource
  );

  const handlers = await factory(
    pageRequire,
    filename,
    path.dirname(filename),
    shared
  );

  const runtimeParts = buildRuntimeParts(parsed, handlers);

  async function renderToBuffer(request = Object.create(null), response = null) {
    const values = await resolveValues(request, response);
    const nonce = nonceFor(response);
    // One budget for the whole page, so several blocks cannot each spend the
    // full limit and leave the request holding a multiple of it.
    const budget = createBudget(exportLimit);
    const chunks = [];

    for (const part of runtimeParts) {
      if (part.type === 'html') {
        chunks.push(part.buffer);
        continue;
      }

      chunks.push(scriptFor(part, values[part.valueIndex], nonce, budget));
    }

    return Buffer.concat(chunks);
  }

  // The emitted <script> is inline, which a strict Content-Security-Policy
  // blocks outright: the page renders and the data silently never arrives. A
  // nonce on res.locals is picked up automatically, matching what helmet and the
  // common Express setups already set, so no configuration is needed.
  function nonceFor(response) {
    if (response === null || typeof response !== 'object') return undefined;

    const locals = response.locals;
    if (locals === null || typeof locals !== 'object') return undefined;

    return locals.cspNonce !== undefined ? locals.cspNonce : locals.nonce;
  }

  // The serializer reports a path within the value ("$.rows[2]"), which is not
  // enough to locate the block on a page with many of them.
  function scriptFor(part, value, nonce, budget) {
    try {
      return clientScript(part.varName, value, nonce, budget);
    } catch (error) {
      throw new TypeError(
        `<weld var="${part.varName}"> in ${filename}: ${error.message}`,
        { cause: error }
      );
    }
  }

  // Runs every request block concurrently. Blocks are independent by design —
  // anything shared between them would have to live in setup scope, which is
  // shared across requests and therefore already unsafe — so there is nothing to
  // sequence. Total time becomes the slowest block rather than the sum.
  function resolveValues(request, response) {
    const pending = [];

    for (const part of runtimeParts) {
      if (part.type !== 'request') continue;
      const result = part.handler(request, response);
      // Promise.all settles on the first rejection while the rest keep running;
      // without a catch of their own, a later failure would surface as an
      // unhandled rejection and take the process down.
      if (result && typeof result.catch === 'function') result.catch(() => {});
      pending.push(result);
    }

    return Promise.all(pending);
  }

  // Resolve everything, then emit. Nothing is written until the whole response
  // is known to succeed, so a failing block yields a clean error instead of a
  // truncated page under an already-sent 200.
  async function render(request, response) {
    if (response === null || typeof response !== 'object' || typeof response.write !== 'function') {
      throw new TypeError(
        'render() requires a response with a write() method; use renderToBuffer() to get bytes instead'
      );
    }

    const values = await resolveValues(request, response);
    const nonce = nonceFor(response);
    const budget = createBudget(exportLimit);

    const chunks = [];
    let total = 0;

    for (const part of runtimeParts) {
      const chunk = part.type === 'html'
        ? part.buffer
        : scriptFor(part, values[part.valueIndex], nonce, budget);

      chunks.push(chunk);
      total += chunk.length;
    }

    // The exact length is known before anything is sent, so the response can
    // carry Content-Length instead of falling back to chunked encoding.
    if (!response.headersSent && typeof response.setHeader === 'function') {
      response.setHeader('Content-Length', total);
    }

    // Coalesce the writes into as few packets as the socket allows without
    // concatenating the page into one buffer.
    if (typeof response.cork === 'function') response.cork();

    try {
      for (const chunk of chunks) {
        if (!response.write(chunk)) {
          if (typeof response.uncork === 'function') response.uncork();
          await once(response, 'drain');
          if (typeof response.cork === 'function') response.cork();
        }
      }
    } finally {
      if (typeof response.uncork === 'function') response.uncork();
    }
  }

  // A ready-made route handler, so callers do not have to write an async
  // wrapper, remember response.end(), or hand-roll error forwarding:
  //
  //   app.get('/', page.handler);
  //
  // Express passes next to every route handler, so failures reach the error
  // middleware with nothing written. Called without next — a vanilla server —
  // it returns the promise instead, so the failure is still the caller's to
  // handle rather than being swallowed.
  function handler(request, response, next) {
    // Everything runs inside the promise chain, including the header default, so
    // that a bad response reports through the same channel as every other
    // failure. Touching response directly here would throw synchronously from
    // the call site while all other errors arrived via next.
    const finished = Promise.resolve()
      .then(() => {
        if (
          response !== null &&
          typeof response === 'object' &&
          !response.headersSent &&
          typeof response.getHeader === 'function' &&
          response.getHeader('content-type') === undefined
        ) {
          response.setHeader('content-type', 'text/html; charset=utf-8');
        }

        return render(request, response);
      })
      .then(() => {
        response.end();
      });

    if (typeof next === 'function') {
      finished.catch(next);
      return undefined;
    }

    return finished;
  }

  // The source buffer is deliberately not retained: nothing after compilation
  // reads it, and holding it would double the memory cost of every page.
  return Object.freeze({
    filename,
    // Files pulled in by <weld src>, so watch() can rebuild when one changes.
    dependencies: Object.freeze([...dependencies]),
    // Frozen through, not just at the top level: Object.freeze on the page left
    // this array and its entries mutable.
    parts: Object.freeze(runtimeParts.map((part) => Object.freeze(part))),
    handler,
    render,
    renderToBuffer
  });
}

async function compileFile(filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new TypeError('compileFile() requires a non-empty string path');
  }

  const absolute = path.resolve(filename);
  const source = fs.readFileSync(absolute);
  return compileSource(source, { filename: absolute });
}

// Pages already loaded, keyed by resolved path, so that loading the same file
// twice does not compile it twice or run its setup blocks twice.
const loaded = new Map();

// Returns a page synchronously and compiles it in the background, so a server
// needs no async wrapper just to hold the await:
//
//   const home = weld.load('./views/home.html');
//   app.get('/', home.handler);
//   app.listen(3000);
//
// Requests arriving before compilation finishes wait for it rather than failing.
function load(filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new TypeError('load() requires a non-empty string path');
  }

  const absolute = path.resolve(filename);
  const existing = loaded.get(absolute);
  if (existing) return existing;

  let compiled = null;
  let pending = null;

  // A successful compile is kept forever; a failed one is not. Evicting the map
  // entry is not enough on its own, because a server calls load() once at boot
  // and then holds this page object — so the retry has to live here, on the page
  // itself. A corrected file is picked up by the next request, with no restart.
  function ensureCompiled() {
    if (compiled !== null) return Promise.resolve(compiled);
    if (pending !== null) return pending;

    pending = compileFile(absolute).then(
      (result) => {
        compiled = result;
        pending = null;
        return result;
      },
      (error) => {
        pending = null;

        // A compile failure would otherwise stay invisible until the first
        // request, where compileFile used to stop the server at boot. Report it
        // immediately; callers who want to exit can await page.ready.
        console.error(`WeldJS: failed to compile ${absolute}`);
        console.error(error);
        throw error;
      }
    );

    return pending;
  }

  const page = Object.freeze({
    filename: absolute,

    // Files pulled in by <weld src>, so watch() can rebuild when a shared
    // partial changes. Empty until compilation has produced them.
    get dependencies() {
      return compiled === null ? [] : compiled.dependencies;
    },

    // A getter, not a fixed promise: after a failure it starts a fresh attempt,
    // so awaiting it again re-checks the file rather than replaying the error.
    get ready() {
      return ensureCompiled();
    },

    // Present once compilation finishes, so a loaded page exposes the same
    // surface as a compiled one.
    get parts() {
      return compiled === null ? undefined : compiled.parts;
    },

    // Drops the compiled page so the next use rebuilds from disk. Setup blocks
    // run again, which is the point: an edit to setup code takes effect too.
    // In-flight requests keep the page they already resolved.
    invalidate() {
      compiled = null;
      pending = null;
      return ensureCompiled();
    },

    handler(request, response, next) {
      const finished = ensureCompiled().then((page_) => page_.handler(request, response));

      if (typeof next === 'function') {
        finished.catch(next);
        return undefined;
      }

      return finished;
    },

    render(request, response) {
      return ensureCompiled().then((page_) => page_.render(request, response));
    },

    renderToBuffer(request, response) {
      return ensureCompiled().then((page_) => page_.renderToBuffer(request, response));
    }
  });

  loaded.set(absolute, page);

  // Start compiling now rather than on the first request, and keep this kickoff
  // rejection handled — callers observe failures through ready or next.
  ensureCompiled().catch(() => {});
  return page;
}

// Watchers keyed by the page they belong to, so stopping is idempotent and a
// page is never watched twice.
const watchers = new Map();

// Recompiles a page when its file changes. Development only: it holds an open
// file watcher and lets a running server pick up edits without a restart.
//
//   const page = load('./page.html');
//   if (process.env.NODE_ENV !== 'production') watch(page);
//
// dependencies lets a page declare other files that should also trigger a
// rebuild. Nothing produces them yet; includes will.
function watch(page, options = {}) {
  if (page === null || typeof page !== 'object' || typeof page.filename !== 'string') {
    throw new TypeError('watch() requires a page from load()');
  }

  if (options === null || typeof options !== 'object') {
    throw new TypeError('watch() options must be an object');
  }

  const existing = watchers.get(page.filename);
  if (existing) return existing;

  const onChange = typeof options.onChange === 'function' ? options.onChange : null;

  // Files pulled in by <weld src> are watched too, so editing a shared header
  // rebuilds every page that includes it. They are read from the compiled page
  // when it is available; an explicit list overrides that.
  const dependencies = Array.isArray(options.dependencies)
    ? options.dependencies
    : (Array.isArray(page.dependencies) ? page.dependencies : []);

  for (const dependency of dependencies) {
    if (typeof dependency !== 'string' || dependency.length === 0) {
      throw new TypeError('watch() dependencies must be non-empty strings');
    }
  }

  const targets = [page.filename, ...dependencies.map((file) => path.resolve(file))];
  const handles = [];

  // Editors often write a file as several events; a short debounce collapses
  // them into one rebuild instead of compiling the same file three times.
  let timer = null;
  const rebuild = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const invalidated = page.invalidate();
      if (onChange) onChange(page);
      invalidated.catch(() => {});   // failures already report through page.ready
    }, 20);
    if (typeof timer.unref === 'function') timer.unref();
  };

  for (const target of targets) {
    try {
      handles.push(fs.watch(target, { persistent: false }, rebuild));
    } catch (error) {
      // A dependency that cannot be watched should not stop the others.
      console.error(`WeldJS: cannot watch ${target}: ${error.message}`);
    }
  }

  const watcher = Object.freeze({
    page,
    files: Object.freeze(targets.slice()),
    close() {
      if (timer !== null) clearTimeout(timer);
      for (const handle of handles) handle.close();
      watchers.delete(page.filename);
    }
  });

  watchers.set(page.filename, watcher);
  return watcher;
}

function clearLoaded() {
  for (const watcher of [...watchers.values()]) watcher.close();
  loaded.clear();
}

module.exports = { compileSource, compileFile, load, watch, clearLoaded };
