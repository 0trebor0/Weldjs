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
    sourceBytes: Buffer.byteLength(source),
    compileMs: Number(compileMs.toFixed(3)),
    iterations,
    totalMs: Number(elapsed.toFixed(3)),
    rendersPerSecond: Math.round(iterations / (elapsed / 1000)),
    averageRenderMs: Number((elapsed / iterations).toFixed(6))
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
