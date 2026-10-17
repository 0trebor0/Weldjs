'use strict';

const { performance } = require('node:perf_hooks');
const { compileSource } = require('./src');

async function main() {
  const staticBlock = '<div class="row">static html</div>\n'.repeat(1000);
  const source = `<!doctype html>\n${staticBlock}<weld>const base = 40;</weld><weld var="answer">return { value: base + 2 };</weld>${staticBlock}`;

  const beforeCompile = performance.now();
  const page = await compileSource(source, { filename: __filename });
  const compileMs = performance.now() - beforeCompile;

  // Warm up V8/JIT.
  for (let i = 0; i < 1000; i += 1) await page.renderToBuffer();

  const iterations = 10000;
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    await page.renderToBuffer();
  }
  const elapsed = performance.now() - start;

  console.log({
    scenario: 'buffer-small-export',
    sourceBytes: Buffer.byteLength(source),
    compileMs: Number(compileMs.toFixed(3)),
    iterations,
    totalMs: Number(elapsed.toFixed(3)),
    rendersPerSecond: Math.round(iterations / (elapsed / 1000)),
    averageRenderMs: Number((elapsed / iterations).toFixed(6))
  });

  // Large exports exercise snapshotting, escaping, UTF-8 sizing, and Buffer
  // allocation rather than only the cost of copying static HTML.
  const payloads = [
    { name: 'large-ascii', value: 'x'.repeat(200000) },
    { name: 'large-unicode', value: '日本🎉'.repeat(25000) },
    { name: 'html-text', value: '<p>Hello & welcome</p>'.repeat(6000) },
    {
      name: '2000-rows',
      value: Array.from({ length: 2000 }, (_, id) => ({
        id,
        name: 'Example user',
        email: `user${id}@example.com`,
        text: 'a'.repeat(40)
      }))
    }
  ];
  const dataPage = await compileSource('<weld var="data">return request.payload;</weld>');
  // This sink isolates render CPU work; it does not measure HTTP throughput,
  // socket writes, or backpressure. The existing tests cover those behaviors.
  const sink = { headersSent: true, write() { return true; } };

  for (const payload of payloads) {
    const request = { payload: payload.value };
    const output = await dataPage.renderToBuffer(request);
    for (const mode of ['renderToBuffer', 'render']) {
      for (let i = 0; i < 30; i += 1) await dataPage[mode](request, sink);

      const sampleIterations = 200;
      const before = performance.now();
      for (let i = 0; i < sampleIterations; i += 1) await dataPage[mode](request, sink);
      const sampleMs = performance.now() - before;

      console.log({
        scenario: payload.name,
        mode,
        outputBytes: output.length,
        iterations: sampleIterations,
        averageRenderMs: Number((sampleMs / sampleIterations).toFixed(6))
      });
    }
  }

  // Retain all compiled pages to represent a project loaded at startup rather
  // than repeatedly compiling and immediately dropping a single page.
  const pages = [];
  const pageHtml = '<p>Static page content</p>\n'.repeat(400);
  const beforeProject = performance.now();
  for (let i = 0; i < 1000; i += 1) {
    pages.push(await compileSource(
      `${pageHtml}<weld>const pageId = ${i};</weld><weld var="page">return pageId;</weld>`
    ));
  }
  console.log({
    scenario: '1000-pages',
    pages: pages.length,
    compileMs: Number((performance.now() - beforeProject).toFixed(3)),
    lastPageBytes: (await pages[pages.length - 1].renderToBuffer()).length
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
