'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { compileSource, scan, serialize, clearShared, MAX_DEPTH } = require('../src');

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
