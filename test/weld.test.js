'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const http = require('node:http');
const fsMod = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { compileSource, compileFile, scan, serialize, clearShared, load, clearLoaded, MAX_DEPTH, MAX_EXPORT_BYTES } = require('../src');

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
`);

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
    /Cannot export more than 1048576 bytes; limit reached at \$\.blob/
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

test('the size budget is per export, not cumulative across renders', async () => {
  const page = await compileSource(
    '<weld var="v">return { blob: "y".repeat(600000) };</weld>'
  );

  // Each render must get a fresh budget; a shared one would fail the second.
  await assert.doesNotReject(() => page.renderToBuffer());
  await assert.doesNotReject(() => page.renderToBuffer());
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
