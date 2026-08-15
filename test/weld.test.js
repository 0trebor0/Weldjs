'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { compileSource, scan, serialize, clearShared, MAX_DEPTH, MAX_EXPORT_BYTES } = require('../src');

test.afterEach(() => clearShared());

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
