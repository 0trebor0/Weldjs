'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const http = require('node:http');
const fsMod = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { compileSource, compileFile, scan, serialize, clearShared, shared, load, clearLoaded, router, watch, assertSerializable, WeldSyntaxError, MAX_DEPTH, MAX_EXPORT_BYTES } = require('../src');

test.afterEach(() => { clearShared(); clearLoaded(); });

test('scanner leaves normal HTML as byte ranges', () => {
  const input = Buffer.from('<h1>A</h1><weld var="x">return 1;</weld><p>B</p>');
  const parsed = scan(input);

  assert.equal(parsed.parts.length, 3);
  assert.equal(parsed.parts[0].type, 'html');
  assert.equal(parsed.parts[1].type, 'weld');
  assert.equal(parsed.parts[1].varName, 'x');
  assert.equal(parsed.parts[2].type, 'html');
});

test('setup runs once and request blocks run on every render', async () => {
  // This page deliberately mutates setup scope to prove setup runs once, which
  // is the pattern the warning exists to discourage. Opted out so the test does
  // not emit it.
  const page = await compileSource(`
<weld>
let count = 0;
const base = 10;
</weld>
<p>before</p>
<weld var="value">
count += 1;
return { count, value: base + count };
</weld>
<p>after</p>
`, { warnOnMutableSetup: false });

  const first = (await page.renderToBuffer()).toString();
  const second = (await page.renderToBuffer()).toString();

  assert.match(first, /const value=\{"count":1,"value":11\}/);
  assert.match(second, /const value=\{"count":2,"value":12\}/);
  assert.ok(!first.includes('<weld'));
  assert.ok(first.includes('<p>before</p>'));
  assert.ok(first.includes('<p>after</p>'));
});

test('request object is visible to request blocks', async () => {
  const page = await compileSource(`
<weld var="method">
return request.method;
</weld>
`);

  const output = (await page.renderToBuffer({ method: 'POST' })).toString();
  assert.match(output, /const method="POST"/);
});

test('serializer prevents script-tag breakout', () => {
  const result = serialize('</script><script>alert(1)</script>');
  assert.ok(!result.includes('</script>'));
  assert.ok(result.includes('\\u003c/script\\u003e'));
});

test('unsupported export values fail', async () => {
  const page = await compileSource(`
<weld var="bad">
return () => 1;
</weld>
`);

  await assert.rejects(() => page.renderToBuffer(), /Cannot export function/);
});

test('accessor properties are read exactly once, so the checked value is the emitted value', () => {
  let reads = 0;
  const value = {
    get name() {
      reads += 1;
      return reads === 1 ? 'safe' : '</script><script>alert(1)</script>';
    }
  };

  const result = serialize(value);

  assert.equal(reads, 1);
  assert.equal(result, '{"name":"safe"}');
});

test('__proto__ keys are rejected rather than assigning a prototype on the client', () => {
  assert.throws(
    () => serialize({ ['__proto__']: { polluted: true } }),
    /Cannot export "__proto__" key/
  );
});

test('over-deep nesting fails with a clear error instead of exhausting the stack', () => {
  let deep = {};
  const root = deep;
  for (let i = 0; i < MAX_DEPTH + 5; i += 1) {
    deep.next = {};
    deep = deep.next;
  }

  assert.throws(() => serialize(root), (error) => {
    assert.ok(error instanceof TypeError, `expected TypeError, got ${error.constructor.name}`);
    assert.match(error.message, /nested deeper than 64 levels/);
    return true;
  });
});

test('nesting at the depth limit still serializes', () => {
  let deep = {};
  const root = deep;
  for (let i = 0; i < MAX_DEPTH - 1; i += 1) {
    deep.next = {};
    deep = deep.next;
  }

  assert.doesNotThrow(() => serialize(root));
});

function fakeResponse() {
  const response = new EventEmitter();
  response.headersSent = false;
  response.headers = {};
  response.chunks = [];
  response.ended = false;
  response.setHeader = (k, v) => { response.headers[k.toLowerCase()] = v; };
  response.getHeader = (k) => response.headers[k.toLowerCase()];
  response.write = (chunk) => { response.chunks.push(Buffer.from(chunk)); return true; };
  response.end = () => { response.ended = true; };
  return response;
}

test('a CSP nonce on res.locals reaches the emitted script', async () => {
  const page = await compileSource('<p>a</p><weld var="v">return 1;</weld>');

  for (const key of ['cspNonce', 'nonce']) {
    const response = fakeResponse();
    response.locals = { [key]: 'r4nd0mBase64Value==' };

    await page.render(Object.create(null), response);

    const body = Buffer.concat(response.chunks).toString();
    assert.ok(
      body.includes('<script nonce="r4nd0mBase64Value==">const v=1;</script>'),
      `${key} was not applied: ${body}`
    );
  }
});

test('no nonce is emitted when none is set', async () => {
  const page = await compileSource('<weld var="v">return 1;</weld>');
  const output = (await page.renderToBuffer()).toString();

  assert.equal(output, '<script>const v=1;</script>');
});

test('a malformed nonce is refused rather than escaped into the tag', async () => {
  const page = await compileSource('<weld var="v">return 1;</weld>');

  // A nonce that could close the attribute would produce markup the policy does
  // not match, which fails as a blank page rather than a visible error.
  for (const bad of ['" onload="alert(1)', 'short', '', 'has spaces', 'x'.repeat(300), 42]) {
    const response = fakeResponse();
    response.locals = { cspNonce: bad };

    await assert.rejects(
      () => page.render(Object.create(null), response),
      /CSP nonce must be/,
      `accepted a bad nonce: ${String(bad)}`
    );
  }
});

test('load returns a page synchronously and serves once compiled', async () => {
  const page = load(path.join(__dirname, '..', 'example', 'page.html'));

  // Available immediately, with no await at the call site.
  assert.equal(typeof page.handler, 'function');
  assert.ok(page.ready && typeof page.ready.then === 'function');

  const response = fakeResponse();
  await new Promise((resolve, reject) => {
    page.handler(Object.create(null), response, (error) => reject(error));
    setTimeout(resolve, 200);
  });

  assert.ok(response.ended, 'response was not ended');
  assert.match(Buffer.concat(response.chunks).toString(), /const users=/);
});

test('load caches by resolved path so setup runs once', async () => {
  const target = path.join(__dirname, '..', 'example', 'page.html');

  const first = load(target);
  const second = load(target);
  const viaRelative = load(path.relative(process.cwd(), target));

  assert.equal(first, second, 'same path returned different pages');
  assert.equal(first, viaRelative, 'relative path was not resolved to the same page');

  await first.ready;
});

test('load reports a compile failure through ready and through next', async () => {
  const broken = path.join(os.tmpdir(), `weld-broken-${process.pid}.html`);
  fsMod.writeFileSync(broken, '<p>a</p><weld var="x">return 1;');

  const page = load(broken);

  await assert.rejects(() => page.ready, /Missing <\/weld>/);

  const error = await new Promise((resolve) => {
    page.handler(Object.create(null), fakeResponse(), resolve);
  });
  assert.match(error.message, /Missing <\/weld>/);

  fsMod.unlinkSync(broken);
});

test('a held page recovers after the file is corrected, without reloading it', async () => {
  const target = path.join(os.tmpdir(), `weld-recover-${process.pid}.html`);
  fsMod.writeFileSync(target, '<p>a</p><weld var="x">return 1;');   // missing </weld>

  // The real server pattern: load once at boot, then hold this object forever.
  const page = load(target);
  await assert.rejects(() => page.ready, /Missing <\/weld>/);

  fsMod.writeFileSync(target, '<p>a</p><weld var="x">return 42;</weld>');

  // Same object, no second load() call, no restart.
  const output = (await page.renderToBuffer()).toString();
  assert.match(output, /const x=42;/);
  assert.ok(Array.isArray(page.parts));

  fsMod.unlinkSync(target);
});

test('a successful compile is not repeated on later requests', async () => {
  const target = path.join(os.tmpdir(), `weld-once-${process.pid}.html`);
  fsMod.writeFileSync(
    target,
    '<weld>globalThis.__weldSetupRuns = (globalThis.__weldSetupRuns || 0) + 1;</weld><weld var="v">return 1;</weld>'
  );

  globalThis.__weldSetupRuns = 0;
  const page = load(target);

  await page.renderToBuffer();
  await page.renderToBuffer();
  await page.ready;

  assert.equal(globalThis.__weldSetupRuns, 1, 'the page recompiled after succeeding');

  delete globalThis.__weldSetupRuns;
  fsMod.unlinkSync(target);
});

test('a failed compile is evicted so a corrected file can be loaded', async () => {
  const target = path.join(os.tmpdir(), `weld-evict-${process.pid}.html`);
  fsMod.writeFileSync(target, '<p>a</p><weld var="x">return 1;');   // missing </weld>

  const broken = load(target);
  await assert.rejects(() => broken.ready, /Missing <\/weld>/);

  // Caching the failure would leave the page broken until the process restarted.
  fsMod.writeFileSync(target, '<p>a</p><weld var="x">return 1;</weld>');
  await assert.doesNotReject(() => load(target).ready);

  fsMod.unlinkSync(target);
});

test('a file that does not exist yet can be loaded once it appears', async () => {
  const target = path.join(os.tmpdir(), `weld-later-${process.pid}.html`);
  try { fsMod.unlinkSync(target); } catch { /* not there yet */ }

  await assert.rejects(() => load(target).ready, /ENOENT/);

  fsMod.writeFileSync(target, '<p>now exists</p>');
  await assert.doesNotReject(() => load(target).ready);

  fsMod.unlinkSync(target);
});

test('a loaded page exposes the same surface as a compiled one', async () => {
  const target = path.join(__dirname, '..', 'example', 'page.html');

  const loaded = load(target);
  assert.equal(loaded.parts, undefined, 'parts should be absent until compiled');

  await loaded.ready;
  const compiled = await compileFile(target);

  const missing = Object.keys(compiled).filter((key) => loaded[key] === undefined);
  assert.deepEqual(missing, [], `loaded page missing: ${missing.join(', ')}`);
  assert.ok(Array.isArray(loaded.parts));
});

function rawRequest(port, line) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${line} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n`);
    });
    let buffer = '';
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.on('end', () => resolve(buffer));
  });
}

async function withRouter(run) {
  const mount = router(path.join(__dirname, '..', 'example', 'pages'));
  const server = http.createServer((request, response) => {
    mount(request, response, () => {
      response.statusCode = 404;
      response.end('not found');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server.address().port, mount);
  } finally {
    server.close();
  }
}

test('router maps files to routes, including index and parameters', async () => {
  await withRouter(async (port, mount) => {
    assert.deepEqual(mount.routes, ['/', '/about', '/blog', '/blog/[slug]', '/with-partials']);

    const cases = [
      ['/', 'home'],
      ['/about', 'about'],
      ['/blog', 'blog-index'],
      ['/blog/hello-world', 'post']
    ];

    for (const [route, name] of cases) {
      const raw = await rawRequest(port, route);
      assert.match(raw, /^HTTP\/1\.1 200 OK/, `${route} did not return 200`);
      assert.match(raw, new RegExp(`"name":"${name}"`), `${route} served the wrong page`);
    }
  });
});

test('router exposes path parameters on request.params', async () => {
  await withRouter(async (port) => {
    const raw = await rawRequest(port, '/blog/my-first-post');
    assert.match(raw, /"slug":"my-first-post"/);

    // Percent-encoded values are decoded before matching.
    const encoded = await rawRequest(port, '/blog/caf%C3%A9');
    assert.match(encoded, /"slug":"café"/);
  });
});

test('router refuses traversal, null bytes and malformed encoding', async () => {
  await withRouter(async (port) => {
    const attacks = [
      '/blog/%2e%2e',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/blog/..',
      '/blog/%2e%2e/%2e%2e',
      '/blog/%00',
      '/blog/%ZZ',
      '/nope'
    ];

    for (const attack of attacks) {
      const raw = await rawRequest(port, attack);
      assert.match(raw, /^HTTP\/1\.1 404 Not Found/, `${attack} was not rejected`);
      assert.ok(!raw.includes('const page='), `${attack} served a page`);
    }
  });
});

test('router passes non-GET methods through', async () => {
  const mount = router(path.join(__dirname, '..', 'example', 'pages'));

  let passed = false;
  mount({ method: 'POST', url: '/about' }, {}, () => { passed = true; });
  assert.ok(passed, 'POST was handled instead of being passed on');
});

test('router validates its arguments', () => {
  assert.throws(() => router(42), /non-empty string directory/);
  assert.throws(() => router(''), /non-empty string directory/);
  assert.throws(() => router(path.join(__dirname, 'nope-not-here')), /is not a directory/);
});

test('weld src includes a file at compile time with no per-request cost', async () => {
  const page = await compileFile(path.join(__dirname, '..', 'example', 'pages', 'with-partials.html'));
  const output = (await page.renderToBuffer()).toString();

  assert.match(output, /<nav><a href="\/">Home<\/a>/, 'header was not included');
  assert.match(output, /Shared footer/, 'footer was not included');
  assert.ok(!output.includes('<weld'), 'an include tag survived into the output');

  // The included markup is merged into the surrounding static runs, so it costs
  // nothing extra to write per request.
  assert.equal(page.parts.filter((part) => part.type === 'html').length, 2);
  assert.equal(page.dependencies.length, 2);
});

test('includes resolve relative to the including file and nest', async () => {
  const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), 'weld-inc-'));
  fsMod.mkdirSync(path.join(dir, 'deep'));

  fsMod.writeFileSync(path.join(dir, 'deep', 'inner.html'), '<i>inner</i>');
  fsMod.writeFileSync(path.join(dir, 'deep', 'middle.html'), '<b><weld src="inner.html"></weld></b>');
  fsMod.writeFileSync(path.join(dir, 'page.html'), '<p><weld src="deep/middle.html"></weld></p>');

  const page = await compileFile(path.join(dir, 'page.html'));
  const output = (await page.renderToBuffer()).toString();

  assert.equal(output, '<p><b><i>inner</i></b></p>');
  assert.equal(page.dependencies.length, 2);

  fsMod.rmSync(dir, { recursive: true, force: true });
});

test('an include cycle is refused rather than looping', async () => {
  const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), 'weld-cycle-'));
  fsMod.writeFileSync(path.join(dir, 'a.html'), '<a><weld src="b.html"></weld></a>');
  fsMod.writeFileSync(path.join(dir, 'b.html'), '<b><weld src="a.html"></weld></b>');

  await assert.rejects(() => compileFile(path.join(dir, 'a.html')), /cycle/);

  // Self-inclusion is the degenerate case.
  fsMod.writeFileSync(path.join(dir, 'self.html'), '<weld src="self.html"></weld>');
  await assert.rejects(() => compileFile(path.join(dir, 'self.html')), /cycle/);

  fsMod.rmSync(dir, { recursive: true, force: true });
});

test('a missing or malformed include is rejected clearly', async () => {
  const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), 'weld-badinc-'));

  fsMod.writeFileSync(path.join(dir, 'missing.html'), '<weld src="nope.html"></weld>');
  await assert.rejects(() => compileFile(path.join(dir, 'missing.html')), /ENOENT/);

  fsMod.writeFileSync(path.join(dir, 'both.html'), '<weld src="x.html" var="y"></weld>');
  await assert.rejects(() => compileFile(path.join(dir, 'both.html')), /cannot also declare var/);

  fsMod.writeFileSync(path.join(dir, 'body.html'), '<weld src="x.html">const a = 1;</weld>');
  await assert.rejects(() => compileFile(path.join(dir, 'body.html')), /must be empty/);

  fsMod.writeFileSync(path.join(dir, 'empty.html'), '<weld src=""></weld>');
  await assert.rejects(() => compileFile(path.join(dir, 'empty.html')), /requires a file path/);

  fsMod.rmSync(dir, { recursive: true, force: true });
});

test('duplicate variable names across included files are caught', async () => {
  const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), 'weld-dupinc-'));
  fsMod.writeFileSync(path.join(dir, 'partial.html'), '<weld var="shared">return 1;</weld>');
  fsMod.writeFileSync(
    path.join(dir, 'page.html'),
    '<weld src="partial.html"></weld><weld var="shared">return 2;</weld>'
  );

  await assert.rejects(
    () => compileFile(path.join(dir, 'page.html')),
    /Duplicate client variable name "shared"/
  );

  fsMod.rmSync(dir, { recursive: true, force: true });
});

test('watch rebuilds a page when its file changes', async () => {
  const target = path.join(os.tmpdir(), `weld-watch-${process.pid}.html`);
  fsMod.writeFileSync(target, '<h1>v1</h1><weld>const n = 1;</weld><weld var="v">return n;</weld>');

  const page = load(target);
  await page.ready;

  const watcher = watch(page);
  try {
    assert.match((await page.renderToBuffer()).toString(), /<h1>v1<\/h1>.*const v=1;/);

    // Setup code changes too, so this proves setup re-ran, not just the markup.
    fsMod.writeFileSync(target, '<h1>v2</h1><weld>const n = 99;</weld><weld var="v">return n;</weld>');
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.match((await page.renderToBuffer()).toString(), /<h1>v2<\/h1>.*const v=99;/);
  } finally {
    watcher.close();
    fsMod.unlinkSync(target);
  }
});

test('watch stops after close and validates its arguments', async () => {
  const target = path.join(os.tmpdir(), `weld-watch-stop-${process.pid}.html`);
  fsMod.writeFileSync(target, '<weld var="v">return 1;</weld>');

  const page = load(target);
  await page.ready;

  const watcher = watch(page);
  assert.equal(watch(page), watcher, 'watching twice created a second watcher');
  watcher.close();

  fsMod.writeFileSync(target, '<weld var="v">return 2;</weld>');
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.match((await page.renderToBuffer()).toString(), /const v=1;/, 'rebuilt after close');

  assert.throws(() => watch(null), /requires a page from load/);
  assert.throws(() => watch({}), /requires a page from load/);
  assert.throws(() => watch(page, null), /options must be an object/);

  fsMod.unlinkSync(target);
});

test('watch also rebuilds when an included file changes', async () => {
  const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), 'weld-watchinc-'));
  const partial = path.join(dir, 'partial.html');
  const target = path.join(dir, 'page.html');

  fsMod.writeFileSync(partial, '<header>one</header>');
  fsMod.writeFileSync(target, '<weld src="partial.html"></weld><weld var="v">return 1;</weld>');

  const page = load(target);
  await page.ready;

  const watcher = watch(page);
  try {
    assert.equal(watcher.files.length, 2, 'the partial was not watched');

    fsMod.writeFileSync(partial, '<header>two</header>');
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.match((await page.renderToBuffer()).toString(), /<header>two<\/header>/);
  } finally {
    watcher.close();
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
});

test('router refuses two files that map to the same route', () => {
  const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), 'weld-dup-route-'));
  fsMod.mkdirSync(path.join(dir, 'about'));

  // A realistic authoring mistake: both of these want to be /about.
  fsMod.writeFileSync(path.join(dir, 'about.html'), '<p>a</p>');
  fsMod.writeFileSync(path.join(dir, 'about', 'index.html'), '<p>b</p>');

  assert.throws(() => router(dir), /two files map to \/about/);

  fsMod.rmSync(dir, { recursive: true, force: true });
});

test('router refuses a repeated parameter name in one route', () => {
  const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), 'weld-dup-param-'));
  fsMod.mkdirSync(path.join(dir, '[id]'));
  fsMod.writeFileSync(path.join(dir, '[id]', '[id].html'), '<p>a</p>');

  assert.throws(() => router(dir), /duplicate parameter "id"/);

  fsMod.rmSync(dir, { recursive: true, force: true });
});

test('shared validates its arguments', async () => {
  await assert.rejects(() => shared('', () => 1), /non-empty string key/);
  await assert.rejects(() => shared(null, () => 1), /non-empty string key/);
  await assert.rejects(() => shared(42, () => 1), /non-empty string key/);
  await assert.rejects(() => shared('k', 'not a function'), /requires a factory function/);
  await assert.rejects(() => shared('k', null), /requires a factory function/);
});

test('a failed shared factory is evicted so it can be retried', async () => {
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('connection refused');
    return { connected: true };
  };

  await assert.rejects(() => shared('flaky', flaky), /connection refused/);

  // Caching the failure would leave the resource unavailable for the process
  // lifetime even once whatever it depends on came back.
  const value = await shared('flaky', flaky);
  assert.deepEqual(value, { connected: true });
  assert.equal(attempts, 2);
});

test('malformed weld attributes are rejected with a position', async () => {
  const cases = [
    ['<weld =bad>x</weld>', /Invalid <weld> attribute name/],
    ['<weld var>x</weld>', /requires a quoted value/],
    ['<weld var=unquoted>x</weld>', /requires a quoted value/],
    // An unterminated quote is caught while finding the end of the tag, before
    // attributes are parsed at all, so this is not "unclosed value".
    ['<weld var="unclosed>x</weld>', /Unclosed <weld> opening tag/],
    ['<weld var="a" var="b">x</weld>', /Duplicate <weld> attribute "var"/]
  ];

  for (const [source, expected] of cases) {
    await assert.rejects(() => compileSource(source), expected, `accepted: ${source}`);
  }
});

test('load validates its argument', () => {
  assert.throws(() => load(42), /non-empty string path/);
  assert.throws(() => load(''), /non-empty string path/);
});

test('handler renders and ends the response without a wrapper', async () => {
  const page = await compileSource('<p>a</p><weld var="v">return 1;</weld><p>b</p>');
  const response = fakeResponse();

  // Called the way Express calls it, with a next that must not fire.
  let nextCalled = null;
  page.handler(Object.create(null), response, (error) => { nextCalled = error; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(nextCalled, null);
  assert.ok(response.ended, 'handler did not end the response');
  assert.equal(
    Buffer.concat(response.chunks).toString(),
    '<p>a</p><script>const v=1;</script><p>b</p>'
  );
});

test('handler defaults content-type to html but does not override one', async () => {
  const page = await compileSource('<p>a</p>');

  const auto = fakeResponse();
  page.handler(Object.create(null), auto, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auto.headers['content-type'], 'text/html; charset=utf-8');

  const explicit = fakeResponse();
  explicit.setHeader('content-type', 'application/xhtml+xml');
  page.handler(Object.create(null), explicit, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(explicit.headers['content-type'], 'application/xhtml+xml');
});

test('handler forwards failures to next with nothing written', async () => {
  const page = await compileSource('<p>lead</p><weld var="v">throw new Error("block failed");</weld>');
  const response = fakeResponse();

  const error = await new Promise((resolve) => {
    page.handler(Object.create(null), response, resolve);
  });

  assert.match(error.message, /block failed/);
  assert.equal(response.chunks.length, 0, 'wrote bytes before failing');
  assert.equal(response.ended, false, 'ended the response on failure');
});

test('handler reports a bad response through next, never by throwing', async () => {
  const page = await compileSource('<p>a</p>');

  for (const bad of [null, undefined, {}, 42]) {
    let threw = null;
    const error = await new Promise((resolve) => {
      try {
        page.handler(Object.create(null), bad, resolve);
      } catch (e) {
        threw = e;
        resolve(null);
      }
    });

    assert.equal(threw, null, `handler threw synchronously for ${String(bad)}`);
    assert.match(error.message, /requires a response with a write\(\) method/);
  }
});

test('handler returns a rejected promise, not a throw, when next is absent', async () => {
  const page = await compileSource('<p>a</p>');

  const result = page.handler(Object.create(null), null);
  assert.ok(result && typeof result.catch === 'function', 'did not return a promise');
  await assert.rejects(() => result, /requires a response with a write\(\) method/);
});

test('handler serves a complete response over real HTTP', async () => {
  const page = await compileSource('<!doctype html><p>hi</p><weld var="v">return { a: 1 };</weld>');
  const server = http.createServer((req, res) => page.handler(req, res, () => {
    res.statusCode = 500;
    res.end();
  }));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const received = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
  });

  server.close();

  assert.equal(received.status, 200);
  assert.equal(received.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(received.headers['content-length'], String(Buffer.byteLength(received.body)));
  assert.equal(received.headers['transfer-encoding'], undefined, 'fell back to chunked encoding');
  assert.match(received.body, /const v=\{"a":1\};/);
});

test('handler returns a promise when called without next', async () => {
  const page = await compileSource('<weld var="v">throw new Error("no next here");</weld>');
  const response = fakeResponse();

  const result = page.handler(Object.create(null), response);
  assert.ok(result && typeof result.then === 'function', 'did not return a promise');
  await assert.rejects(() => result, /no next here/);
});

test('assertSerializable accepts what serialize accepts and rejects what it rejects', () => {
  assert.doesNotThrow(() => assertSerializable({ a: 1, b: ['x', null, true] }));
  assert.throws(() => assertSerializable({ fn: () => 1 }), /Cannot export function/);
  assert.throws(() => assertSerializable({ ['__proto__']: {} }), /__proto__/);

  // It validates without building the output, so it returns nothing.
  assert.equal(assertSerializable({ a: 1 }), undefined);
});

test('WeldSyntaxError is the thrown type and carries its position', async () => {
  await assert.rejects(() => compileSource('<p>a</p>\n<weld var="x">return 1;'), (error) => {
    assert.ok(error instanceof WeldSyntaxError, `got ${error.constructor.name}`);
    assert.ok(error instanceof SyntaxError, 'should still be a SyntaxError');
    assert.equal(error.name, 'WeldSyntaxError');
    assert.equal(typeof error.offset, 'number');
    assert.equal(error.line, 2);
    return true;
  });
});

test('a client variable clashing with a page script is rejected', async () => {
  // Two `const users` declarations are a SyntaxError that disables every script
  // on the page, and the server would still return 200.
  await assert.rejects(
    () => compileSource('<weld var="users">return [1];</weld><script>const users = "mine";</script>'),
    /also declared by a <script> on this page/
  );

  await assert.rejects(
    () => compileSource('<weld var="init">return 1;</weld><script>function init() {}</script>'),
    /also declared by a <script>/
  );
});

test('the collision check does not fire on nested or quoted occurrences', async () => {
  await assert.doesNotReject(() =>
    compileSource('<weld var="users">return [1];</weld><script>function f() { const users = 1; }</script>')
  );

  await assert.doesNotReject(() =>
    compileSource('<weld var="users">return [1];</weld><script>const s = "const users = 1";</script>')
  );
});

test('syntax errors report line and column, not a byte offset', async () => {
  await assert.rejects(
    () => compileSource('<p>a</p>\n<div>\n  <weld var="x">return 1;\n'),
    (error) => {
      assert.match(error.message, /Missing <\/weld> \(line 3, column 3\)/);
      assert.equal(error.line, 3);
      assert.equal(error.column, 3);
      return true;
    }
  );
});

// --- production failure modes -------------------------------------------------
// These exercise conditions a real deployment meets constantly and that unit
// tests with fake response objects cannot reach: clients that vanish mid-write,
// clients that do not read, a query that throws, and concurrent users.

async function serve(page) {
  const server = http.createServer((request, response) => {
    page.handler(request, response, () => {
      if (!response.headersSent) {
        response.statusCode = 503;
        response.setHeader('content-type', 'text/plain');
        response.end('Service Unavailable');
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

function fetchPage(port, headers = {}) {
  return new Promise((resolve) => {
    // agent: false — the global agent keeps sockets alive for seconds after the
    // response, which holds the event loop open long after the assertions run.
    http.get({ host: '127.0.0.1', port, path: '/', headers, agent: false }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
  });
}

test('a block that throws sends nothing and yields a real status', async () => {
  const page = await compileSource(
    '<!doctype html><h1>Dashboard</h1>\n' +
    '<weld var="ok">return 1;</weld>\n' +
    '<p>content that must never be half-sent</p>\n' +
    '<weld var="rows">throw new Error("SQLITE_BUSY: database is locked");</weld>\n' +
    '<footer>end</footer>'
  );

  const { server, port } = await serve(page);
  try {
    const received = await fetchPage(port);

    assert.equal(received.status, 503);
    assert.equal(received.body, 'Service Unavailable');
    // The healthy block and the markup before the failure must not leak.
    assert.ok(!received.body.includes('Dashboard'), 'leaked page content');
    assert.ok(!received.body.includes('footer'), 'leaked page content');
  } finally {
    server.close();
  }
});

test('a client that disconnects mid-write leaves no pending render', async () => {
  // Large enough that write() reports backpressure and render awaits 'drain'.
  const filler = `<p>${'x'.repeat(300)}</p>\n`;
  const page = await compileSource(
    `<!doctype html>${filler.repeat(1200)}<weld var="v">return 1;</weld>${filler.repeat(1200)}`
  );

  let started = 0;
  let settled = 0;
  const server = http.createServer(async (request, response) => {
    started += 1;
    try { await page.render(request, response); response.end(); } catch { /* socket died */ }
    settled += 1;
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write('GET / HTTP/1.1\r\nHost: test\r\n\r\n');
          socket.pause();                                   // never read: back the server up
          setTimeout(() => { socket.destroy(); resolve(); }, 10);
        });
        socket.on('error', () => resolve());
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(started, 10);
    // A render left awaiting 'drain' on a dead socket would leak a promise and
    // its buffers for the lifetime of the process.
    assert.equal(settled, 10, `${started - settled} renders never completed`);
  } finally {
    server.close();
  }
});

test('a slow client still receives the whole page', async () => {
  const filler = `<p>${'y'.repeat(300)}</p>\n`;
  const page = await compileSource(`<!doctype html>${filler.repeat(900)}<weld var="v">return 1;</weld>`);
  const expected = (await page.renderToBuffer()).length;

  const { server, port } = await serve(page);
  try {
    const received = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n');
        socket.pause();                                     // stall, then drain
        setTimeout(() => socket.resume(), 80);
      });

      const chunks = [];
      // Cleared on completion: an uncleared guard keeps the event loop alive for
      // its full duration after the test has already finished.
      const guard = setTimeout(() => reject(new Error('render hung on a slow client')), 6000);

      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => { clearTimeout(guard); resolve(Buffer.concat(chunks)); });
      socket.on('error', (error) => { clearTimeout(guard); reject(error); });
    });

    const headerEnd = received.indexOf('\r\n\r\n') + 4;
    const bodyLength = received.length - headerEnd;
    const declared = /content-length: (\d+)/i.exec(received.subarray(0, headerEnd).toString());

    assert.ok(declared, 'no Content-Length');
    assert.equal(Number(declared[1]), bodyLength);
    assert.equal(bodyLength, expected);
  } finally {
    server.close();
  }
});

test('concurrent users never receive each other data over HTTP', async () => {
  const page = await compileSource(`
<weld var="me">
const user = request.headers['x-user'];
await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 10)));
return { user };
</weld>
`);

  const { server, port } = await serve(page);
  try {
    const users = Array.from({ length: 100 }, (_, i) => `user-${i}`);
    const responses = await Promise.all(users.map((user) => fetchPage(port, { 'x-user': user })));

    responses.forEach((received, i) => {
      assert.equal(received.status, 200);
      assert.match(received.body, new RegExp(`"user":"${users[i]}"`), `request ${i} got another user's data`);
    });
  } finally {
    server.close();
  }
});

test('data from storage is escaped on the way to the client', async () => {
  // Models a value that arrived from a database rather than being written by hand.
  const page = await compileSource(
    '<weld var="post">return { title: "<scr" + "ipt>alert(1)</scr" + "ipt>" };</weld>'
  );

  const { server, port } = await serve(page);
  try {
    const received = await fetchPage(port);

    assert.equal(received.status, 200);
    assert.ok(!received.body.includes('<script>alert(1)</script>'), 'raw script tag reached the page');
    assert.match(received.body, /\\u003cscript\\u003e/);
  } finally {
    server.close();
  }
});

test('syntax errors name the file they came from', async () => {
  const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), 'weld-errfile-'));

  fsMod.writeFileSync(path.join(dir, 'plain.html'), '<p>a</p>\n<div>\n  <weld var="x">return 1;\n');
  await assert.rejects(() => compileFile(path.join(dir, 'plain.html')), (error) => {
    assert.match(error.message, /plain\.html: Missing <\/weld> \(line 3, column 3\)/);
    assert.equal(error.filename, path.join(dir, 'plain.html'));
    return true;
  });

  // A broken partial must name the partial, not the page that included it —
  // its line number belongs to the partial and matches nothing in the page.
  fsMod.writeFileSync(path.join(dir, 'partial.html'), '<div>\n<weld var="y">return 1;\n');
  fsMod.writeFileSync(path.join(dir, 'page.html'), '<p>one</p>\n<weld src="partial.html"></weld>');

  await assert.rejects(() => compileFile(path.join(dir, 'page.html')), (error) => {
    assert.match(error.message, /partial\.html: Missing <\/weld>/);
    assert.equal(error.filename, path.join(dir, 'partial.html'));
    return true;
  });

  fsMod.rmSync(dir, { recursive: true, force: true });
});

test('a page can be documented using the entity form', async () => {
  // &lt;weld&gt; renders as <weld> in a browser but is not matched by the scanner,
  // so a page can describe the syntax without triggering it.
  const page = await compileSource(
    '<p>Write &lt;weld var="x"&gt; to declare a block.</p><weld var="v">return 1;</weld>'
  );

  const output = (await page.renderToBuffer()).toString();
  assert.match(output, /Write &lt;weld var="x"&gt; to declare a block\./);
  assert.match(output, /const v=1;/);
});

test('page.parts is frozen through, not only at the top level', async () => {
  const page = await compileSource('<p>a</p><weld var="v">return 1;</weld>');

  assert.ok(Object.isFrozen(page.parts), 'the parts array is mutable');
  for (const part of page.parts) {
    assert.ok(Object.isFrozen(part), 'a part is mutable');
  }
});

test('source must be a string or Buffer, with no silent coercion', async () => {
  // Buffer.from() accepts an array and reinterprets its elements as bytes, which
  // would compile nonsense instead of rejecting it.
  assert.throws(() => scan([60, 112, 62]), /must be a string or Buffer, received an array/);
  assert.throws(() => scan(null), /received null/);
  assert.throws(() => scan(42), /received a number/);
  assert.throws(() => scan({}), /received a object/);

  await assert.rejects(() => compileSource([60, 112, 62]), /must be a string or Buffer/);
  await assert.doesNotReject(() => compileSource(Buffer.from('<p>ok</p>')));
  await assert.doesNotReject(() => compileSource('<p>ok</p>'));
});

test('compile options are validated at the boundary', async () => {
  await assert.rejects(() => compileSource('<p>x</p>', null), /options must be an object/);
  await assert.rejects(() => compileSource('<p>x</p>', { filename: 42 }), /filename must be a string/);
  await assert.rejects(() => compileFile(42), /non-empty string path/);
  await assert.rejects(() => compileFile(''), /non-empty string path/);
});

test('render rejects a response it cannot write to', async () => {
  const page = await compileSource('<p>a</p><weld var="v">return 1;</weld>');

  await assert.rejects(() => page.render({}, null), /requires a response with a write\(\) method/);
  await assert.rejects(() => page.render({}, {}), /requires a response with a write\(\) method/);
});

test('an oversized export is rejected', () => {
  const rows = [];
  for (let i = 0; i < 40000; i += 1) {
    rows.push({ id: i, name: `user number ${i}`, email: `user${i}@example.com` });
  }

  assert.throws(() => serialize(rows), (error) => {
    assert.ok(error instanceof TypeError, `expected TypeError, got ${error.constructor.name}`);
    assert.match(error.message, /Cannot export more than 1048576 bytes/);
    assert.match(error.message, /limit reached at \$\[\d+\]/);
    return true;
  });
});

test('a single oversized string is rejected', () => {
  assert.throws(
    () => serialize({ blob: 'x'.repeat(MAX_EXPORT_BYTES + 1) }),
    /Cannot export more than 1048576 bytes per page; limit reached at \$\.blob/
  );
});

test('a huge array is rejected before its elements are walked', () => {
  assert.throws(
    () => serialize(new Array(MAX_EXPORT_BYTES + 10)),
    /Cannot export more than 1048576 bytes/
  );
});

test('a normal page payload stays well inside the limit', () => {
  const rows = [];
  for (let i = 0; i < 500; i += 1) {
    rows.push({ id: i, name: `user number ${i}`, email: `user${i}@example.com`, active: i % 2 === 0 });
  }

  assert.doesNotThrow(() => serialize(rows));
  assert.ok(serialize(rows).length < MAX_EXPORT_BYTES);
});

test('the size budget is per render, not cumulative across renders', async () => {
  const page = await compileSource(
    '<weld var="v">return { blob: "y".repeat(600000) };</weld>'
  );

  // Each render must get a fresh budget; a shared one would fail the second.
  await assert.doesNotReject(() => page.renderToBuffer());
  await assert.doesNotReject(() => page.renderToBuffer());
});

test('the size budget is shared by every block on the page', async () => {
  // Each block is under the 1 MB cap on its own; together they are over it.
  const page = await compileSource(
    ['a', 'b', 'c'].map((n) => `<weld var="${n}">return "x".repeat(600000);</weld>`).join('')
  );

  await assert.rejects(
    () => page.renderToBuffer(),
    /Cannot export more than 1048576 bytes per page/,
    'a page produced more than the limit by splitting it across blocks'
  );
});

test('the export limit is configurable per page', async () => {
  const source = '<weld var="v">return "x".repeat(50000);</weld>';

  await assert.rejects(
    () => compileSource(source, { maxExportBytes: 10000 }).then((p) => p.renderToBuffer()),
    /Cannot export more than 10000 bytes per page/
  );

  const roomy = await compileSource(source, { maxExportBytes: 4 * 1024 * 1024 });
  await assert.doesNotReject(() => roomy.renderToBuffer());

  // A nonsensical limit fails at compile rather than on the first request.
  await assert.rejects(() => compileSource(source, { maxExportBytes: 10 }), /at least 1024 bytes/);
  await assert.rejects(() => compileSource(source, { maxExportBytes: 1.5 }), /integer/);
});

test('line separators and ampersands are escaped', () => {
  const input = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c&d`;
  assert.equal(serialize(input), '"a\\u2028b\\u2029c\\u0026d"');
});

test('adjacent static html is merged into one buffer per run', async () => {
  const page = await compileSource(
    '<p>a</p><weld>const x = 1;</weld><p>b</p><weld var="v">return x;</weld><p>c</p>'
  );

  const html = page.parts.filter((part) => part.type === 'html');

  assert.equal(page.parts.length, 3);
  assert.equal(html.length, 2);
  assert.equal(html[0].buffer.toString(), '<p>a</p><p>b</p>');
  assert.equal(html[1].buffer.toString(), '<p>c</p>');

  const output = (await page.renderToBuffer()).toString();
  assert.equal(output, '<p>a</p><p>b</p><script>const v=1;</script><p>c</p>');
});

test('render and renderToBuffer produce identical bytes', async () => {
  const page = await compileSource(
    '<p>a</p><weld>const x = 2;</weld><p>b</p><weld var="v">return { x };</weld><p>c</p>'
  );

  const chunks = [];
  const fakeResponse = new EventEmitter();
  fakeResponse.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    return true;
  };

  await page.render(Object.create(null), fakeResponse);

  assert.deepEqual(Buffer.concat(chunks), await page.renderToBuffer());
});

test('request blocks run concurrently, not one after another', async () => {
  const page = await compileSource(`
<weld var="a">await new Promise((r) => setTimeout(r, 40)); return 1;</weld>
<weld var="b">await new Promise((r) => setTimeout(r, 40)); return 2;</weld>
<weld var="c">await new Promise((r) => setTimeout(r, 40)); return 3;</weld>
`);

  const start = Date.now();
  const output = (await page.renderToBuffer()).toString();
  const elapsed = Date.now() - start;

  assert.match(output, /const a=1;/);
  assert.match(output, /const b=2;/);
  assert.match(output, /const c=3;/);
  // Sequential would be ~120ms; concurrent is ~40ms. 100ms separates them safely.
  assert.ok(elapsed < 100, `blocks appear to run sequentially (${elapsed}ms for 3x40ms)`);
});

test('a failing block sends nothing at all', async () => {
  const page = await compileSource(
    '<p>leading html</p><weld var="ok">return 1;</weld><weld var="bad">throw new Error("query failed");</weld>'
  );

  const written = [];
  const response = new EventEmitter();
  response.headersSent = false;
  response.write = (chunk) => { written.push(chunk); return true; };
  response.setHeader = () => {};

  await assert.rejects(() => page.render(Object.create(null), response), /query failed/);
  assert.equal(written.length, 0, 'bytes were written before the failure was known');
});

test('render sets Content-Length for the finished response', async () => {
  const page = await compileSource('<p>a</p><weld var="v">return { n: 1 };</weld><p>b</p>');

  const headers = {};
  const response = new EventEmitter();
  response.headersSent = false;
  response.setHeader = (k, v) => { headers[k] = v; };
  response.write = () => true;

  await page.render(Object.create(null), response);

  const expected = (await page.renderToBuffer()).length;
  assert.equal(headers['Content-Length'], expected);
});

test('Content-Length counts bytes, not characters', async () => {
  const page = await compileSource('<p>café 日本語 🎉</p><weld var="v">return "日本語";</weld>');

  const headers = {};
  const chunks = [];
  const response = new EventEmitter();
  response.headersSent = false;
  response.setHeader = (k, v) => { headers[k] = v; };
  response.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };

  await page.render(Object.create(null), response);

  const body = Buffer.concat(chunks);
  assert.equal(headers['Content-Length'], body.length);
  assert.notEqual(body.length, body.toString().length, 'page has no multibyte content to test');
});

test('a slow failing block does not escape as an unhandled rejection', async () => {
  const page = await compileSource(`
<weld var="fast">throw new Error('fast fail');</weld>
<weld var="slow">await new Promise((r) => setTimeout(r, 30)); throw new Error('slow fail');</weld>
`);

  let unhandled = null;
  const listener = (error) => { unhandled = error; };
  process.on('unhandledRejection', listener);

  try {
    await assert.rejects(() => page.renderToBuffer(), /fast fail/);
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    process.off('unhandledRejection', listener);
  }

  assert.equal(unhandled, null, `unhandled rejection escaped: ${unhandled && unhandled.message}`);
});

test('render does not set headers once they are already sent', async () => {
  const page = await compileSource('<p>a</p><weld var="v">return 1;</weld>');

  const response = new EventEmitter();
  response.headersSent = true;
  response.setHeader = () => { throw new Error('ERR_HTTP_HEADERS_SENT'); };
  response.write = () => true;

  await assert.doesNotReject(() => page.render(Object.create(null), response));
});

test('export errors identify the block that produced them', async () => {
  const page = await compileSource(
    '<weld var="alpha">return 1;</weld><weld var="beta">return () => 1;</weld>',
    { filename: '/tmp/pages/profile.html' }
  );

  await assert.rejects(() => page.renderToBuffer(), (error) => {
    assert.ok(error instanceof TypeError, `expected TypeError, got ${error.constructor.name}`);
    assert.match(error.message, /var="beta"/);
    assert.match(error.message, /profile\.html/);
    assert.match(error.message, /Cannot export function/);
    assert.ok(error.cause instanceof TypeError, 'original error not kept as cause');
    return true;
  });
});

test('duplicate client variable names are rejected at compile time', async () => {
  await assert.rejects(
    () => compileSource('<weld var="x">return 1;</weld><weld var="x">return 2;</weld>'),
    /Duplicate client variable name "x"/
  );
});

test('reserved words are rejected as client variable names', async () => {
  await assert.rejects(
    () => compileSource('<weld var="class">return 1;</weld>'),
    /Reserved client variable name "class"/
  );

  await assert.rejects(
    () => compileSource('<weld var="let">return 1;</weld>'),
    /Reserved client variable name "let"/
  );
});

test('distinct variable names still compile', async () => {
  const page = await compileSource(
    '<weld var="a">return 1;</weld><weld var="b">return 2;</weld>'
  );

  const output = (await page.renderToBuffer()).toString();
  assert.equal(output, '<script>const a=1;</script><script>const b=2;</script>');
});

test('emitted client script parses as valid JavaScript', async () => {
  const page = await compileSource(
    '<weld var="first">return { a: 1 };</weld><weld var="second">return [1, 2];</weld>'
  );

  const output = (await page.renderToBuffer()).toString();
  const scripts = [...output.matchAll(/<script>(.*?)<\/script>/g)].map((m) => m[1]).join('\n');

  assert.doesNotThrow(() => new vm.Script(scripts));
});

test('page-scope require resolves relative to the page filename', async () => {
  const page = await compileSource(`
<weld>
const path = require('node:path');
const name = path.basename(__filename);
</weld>
<weld var="filename">return name;</weld>
`, { filename: '/tmp/example/page.html' });

  const output = (await page.renderToBuffer()).toString();
  assert.match(output, /const filename="page.html"/);
});
