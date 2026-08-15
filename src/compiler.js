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

  function flushStatic() {
    if (pending.length === 0) return;
    const buffer = pending.length === 1 ? pending[0] : Buffer.concat(pending);
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
      handler: handlers[requestIndex]
    });
    requestIndex += 1;
  }

  flushStatic();
  return runtimeParts;
}

async function compileSource(input, options = {}) {
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
    const chunks = [];

    for (const part of runtimeParts) {
      if (part.type === 'html') {
        chunks.push(part.buffer);
        continue;
      }

      const value = await part.handler(request, response);
      chunks.push(clientScript(part.varName, value));
    }

    return Buffer.concat(chunks);
  }

  async function writeChunk(response, chunk) {
    if (response.write(chunk)) return;
    await once(response, 'drain');
  }

  async function render(request, response) {
    for (const part of runtimeParts) {
      if (part.type === 'html') {
        await writeChunk(response, part.buffer);
        continue;
      }

      const value = await part.handler(request, response);
      await writeChunk(response, clientScript(part.varName, value));
    }
  }

  return Object.freeze({
    filename,
    source: parsed.source,
    parts: runtimeParts,
    render,
    renderToBuffer
  });
}

async function compileFile(filename) {
  const absolute = path.resolve(filename);
  const source = fs.readFileSync(absolute);
  return compileSource(source, { filename: absolute });
}

module.exports = { compileSource, compileFile };
