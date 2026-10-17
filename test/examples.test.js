'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { compileSource, scan } = require('../src');

const EXAMPLE = path.join(__dirname, '..', 'example');

function expressExample(environment = 'development', filesystem = fs) {
  try {
    const uses = [];
    const routes = [];
    const watched = [];
    const pages = new Map();
    const app = {
      use(...args) { uses.push(args); },
      get(...args) { routes.push(args); },
      listen() {}
    };
    const express = () => app;
    express.static = (directory) => ({ directory });
    const modules = {
      'node:crypto': crypto,
      'node:fs': filesystem,
      'node:path': path,
      express,
      '../src': {
        load(filename) {
          if (!pages.has(filename)) pages.set(filename, { filename, handler: () => {} });
          return pages.get(filename);
        },
        router(directory) { return { directory }; },
        watch(page) { watched.push(page.filename); }
      }
    };
    vm.runInNewContext(fs.readFileSync(path.join(EXAMPLE, 'express-server.js'), 'utf8'), {
      require: (name) => modules[name], __dirname: EXAMPLE,
      process: { env: { NODE_ENV: environment } }, console
    });
    return { uses, routes, watched };
  } catch (error) {
    throw new Error(`Express example evaluation failed: ${error.message}`, { cause: error });
  }
}

async function vanillaExample(page, filesystem = fs.promises) {
  try {
    let handler;
    const errors = [];
    const processState = {};
    const modules = {
      'node:path': path,
      'node:fs/promises': filesystem,
      'node:http': {
        createServer(listener) { handler = listener; return { listen() {} }; }
      },
      '../src': { async compileFile() { return page; } }
    };
    await vm.runInNewContext(fs.readFileSync(path.join(EXAMPLE, 'server.js'), 'utf8'), {
      require: (name) => modules[name], __dirname: EXAMPLE,
      process: processState, console: { error: (error) => errors.push(error.message) }
    });
    if (processState.exitCode) throw new Error(errors.join('; '));
    return { handler, errors };
  } catch (error) {
    throw new Error(`Vanilla example evaluation failed: ${error.message}`, { cause: error });
  }
}

function response() {
  return {
    headersSent: false,
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status) { this.statusCode = status; },
    end(body) { if (body !== undefined) this.body = body; }
  };
}

test('Express demo mounts the shared client asset and watches its includes page only in development', () => {
  const development = expressExample();
  assert.equal(development.uses.find((mount) => mount[0] === '/assets')[1].directory, path.join(EXAMPLE, 'public'));
  assert.equal(development.uses.find((mount) => mount[0] === '/docs')[1].directory, path.join(EXAMPLE, '..', 'docs'));
  assert.deepEqual(development.watched, [path.join(EXAMPLE, 'page.html'), path.join(EXAMPLE, 'pages', 'with-partials.html')]);
  assert.equal(development.routes[0][0], '/users');
  assert.deepEqual(expressExample('production').watched, []);
});

test('Express demo CSP permits exact documentation assets and nonced data without unsafe-inline', () => {
  const example = expressExample('production');
  const res = response();
  res.locals = {};
  let next = false;
  example.uses[0][0]({}, res, () => { next = true; });
  const policy = res.headers['content-security-policy'];
  assert.ok(next);
  assert.ok(res.locals.cspNonce.length > 8);
  assert.ok(policy.includes(`'nonce-${res.locals.cspNonce}'`));
  assert.ok(!policy.includes('unsafe-inline'));
  const docs = fs.readFileSync(path.join(EXAMPLE, '..', 'docs', 'index.html'), 'utf8');
  const blocks = [...docs.matchAll(/<(script|style)>([\s\S]*?)<\/\1>/g)];
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    const hash = crypto.createHash('sha256').update(block[2]).digest('base64');
    const directive = policy.split(';').find((part) => part.trim().startsWith(`${block[1]}-src`));
    assert.ok(directive.includes(`'sha256-${hash}'`));
  }
});

test('Express demo reports documentation CSP preparation failures', () => {
  assert.throws(() => expressExample('production', {
    readFileSync() { throw new Error('documentation missing'); }
  }), /Cannot prepare documentation CSP: documentation missing/);
});

test('vanilla demo serves the shared asset with its exact bytes and headers', async () => {
  let renders = 0;
  const example = await vanillaExample({ async render() { renders += 1; } });
  const res = response();
  await example.handler({ url: '/assets/users.js' }, res);
  const expected = fs.readFileSync(path.join(EXAMPLE, 'public', 'users.js'));
  assert.deepEqual(res.body, expected);
  assert.equal(res.headers['content-length'], expected.length);
  assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8');
  assert.equal(renders, 0);
  await example.handler({ url: '/' }, response());
  assert.equal(renders, 1);
});

test('vanilla demo keeps its error response when rendering fails', async () => {
  const example = await vanillaExample({ async render() { throw new Error('query failed'); } });
  const res = response();
  await example.handler({ url: '/' }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body, 'Internal Server Error');
  assert.deepEqual(example.errors, ['query failed']);
});

test('vanilla demo reports a missing client asset at startup', async () => {
  await assert.rejects(() => vanillaExample({}, {
    async readFile() { throw new Error('client asset missing'); }
  }), /client asset missing/);
});

test('example browser script displays namespaced data as text, including markup', () => {
  const users = [{ name: '<script>alert(1)</script>' }];
  const output = { textContent: '' };
  vm.runInNewContext(fs.readFileSync(path.join(EXAMPLE, 'public', 'users.js'), 'utf8'), {
    weld: { users }, document: { querySelector: () => output }
  });
  assert.equal(output.textContent, JSON.stringify(users, null, 2));
  const page = fs.readFileSync(path.join(EXAMPLE, 'page.html'), 'utf8');
  assert.match(page, /<script src="\/assets\/users\.js"><\/script>/);
});

test('README quick-start page compiles and its browser script reads the emitted namespace', async () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const html = readme.match(/```html\r?\n([\s\S]*?)```/)[1];
  const page = await compileSource(html);
  const rendered = (await page.renderToBuffer()).toString();
  const list = { innerHTML: '' };
  const context = vm.createContext({ document: { getElementById: () => list } });
  vm.runInContext('var window = this;', context);
  for (const script of rendered.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(script[1], context);
  }
  assert.equal(list.innerHTML, '<li>Ada</li><li>Grace</li>');
});

test('README weld blocks have valid JavaScript syntax, including annotated examples', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  let blocks = 0;
  for (const snippet of readme.matchAll(/```html\r?\n([\s\S]*?)```/g)) {
    const parsed = scan(snippet[1]);
    for (const part of parsed.parts) {
      if (part.type !== 'weld' || part.mode === 'include') continue;
      const code = parsed.source.subarray(part.codeStart, part.codeEnd).toString();
      assert.doesNotThrow(() => new vm.Script(`(async function () {\n${code}\n})`));
      blocks += 1;
    }
  }
  assert.ok(blocks >= 7, 'README executable examples were not found');
});
