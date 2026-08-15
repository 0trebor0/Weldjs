'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { scan } = require('./scanner');
const { clientScript } = require('./serializer');
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

async function compileSource(input, options = {}) {
  // Validated here rather than left to path.resolve, so a bad argument names
  // the option that was wrong instead of surfacing as "paths[0]".
  if (options === null || typeof options !== 'object') {
    throw new TypeError('compileSource() options must be an object');
  }

  if (options.filename !== undefined && typeof options.filename !== 'string') {
    throw new TypeError('compileSource() options.filename must be a string');
  }

  const filename = path.resolve(options.filename || 'page.html');
  const parsed = scan(input);
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
    const chunks = [];

    for (const part of runtimeParts) {
      if (part.type === 'html') {
        chunks.push(part.buffer);
        continue;
      }

      chunks.push(scriptFor(part, values[part.valueIndex]));
    }

    return Buffer.concat(chunks);
  }

  // The serializer reports a path within the value ("$.rows[2]"), which is not
  // enough to locate the block on a page with many of them.
  function scriptFor(part, value) {
    try {
      return clientScript(part.varName, value);
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

    const chunks = [];
    let total = 0;

    for (const part of runtimeParts) {
      const chunk = part.type === 'html'
        ? part.buffer
        : scriptFor(part, values[part.valueIndex]);

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
    parts: runtimeParts,
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

  const ready = compileFile(absolute);
  let compiled = null;

  ready.then(
    (result) => {
      compiled = result;
    },
    (error) => {
      // Evicted so a corrected file can be loaded without restarting the
      // process, matching shared(), which also drops a failed entry. Caching the
      // failure would leave a page broken for the lifetime of the process even
      // after the author fixed it.
      loaded.delete(absolute);

      // A compile failure would otherwise stay invisible until the first
      // request, where compileFile used to stop the server at boot. Report it
      // immediately and keep the rejection handled; callers who want to exit can
      // await page.ready.
      console.error(`WeldJS: failed to compile ${absolute}`);
      console.error(error);
    }
  );

  const page = Object.freeze({
    filename: absolute,
    ready,

    // Present once compilation finishes, so a loaded page exposes the same
    // surface as a compiled one.
    get parts() {
      return compiled === null ? undefined : compiled.parts;
    },

    handler(request, response, next) {
      const finished = ready.then((compiled) => compiled.handler(request, response));

      if (typeof next === 'function') {
        finished.catch(next);
        return undefined;
      }

      return finished;
    },

    render(request, response) {
      return ready.then((compiled) => compiled.render(request, response));
    },

    renderToBuffer(request, response) {
      return ready.then((compiled) => compiled.renderToBuffer(request, response));
    }
  });

  loaded.set(absolute, page);
  return page;
}

function clearLoaded() {
  loaded.clear();
}

module.exports = { compileSource, compileFile, load, clearLoaded };
