'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { router, load, clearLoaded } = require('./src');

const PAGE_COUNT = 1000;
const STATIC_HTML = '<p>Static page content</p>\n'.repeat(400);

function payloadFor(scenario) {
  if (scenario === 'small') return 42;
  if (scenario === 'slow') return 'x'.repeat(800000);
  return Array.from({ length: 2000 }, (_, id) => ({
    id, name: `User ${id}`, text: '<p>日本語 & welcome 🎉</p>'.repeat(2)
  }));
}

async function serveProject(directory, scenario) {
  let server;
  let sampler;
  try {
    const mount = router(directory);
    await Promise.all(mount.routes.map((route) => load(path.join(directory, `${route.slice(1)}.html`)).ready));
    const payload = payloadFor(scenario);
    let failures = 0;
    let backpressureDrains = 0;
    let cpuStart;
    let started;
    let peakRss = 0;
    let peakHeap = 0;
    server = http.createServer((request, response) => {
      try {
        request.benchmarkPayload = payload;
        response.on('drain', () => { backpressureDrains += 1; });
        mount(request, response, (error) => {
          failures += 1;
          response.statusCode = error ? 500 : 404;
          response.end(error ? 'Render failed' : 'Not found');
        });
      } catch (error) {
        failures += 1;
        if (!response.headersSent) response.statusCode = 500;
        response.end('Request failed');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    process.on('message', (message) => {
      try {
        if (message === 'start') {
          cpuStart = process.cpuUsage();
          started = performance.now();
          failures = 0;
          backpressureDrains = 0;
          peakRss = process.memoryUsage().rss;
          peakHeap = process.memoryUsage().heapUsed;
          sampler = setInterval(() => {
            const memory = process.memoryUsage();
            peakRss = Math.max(peakRss, memory.rss);
            peakHeap = Math.max(peakHeap, memory.heapUsed);
          }, 10);
          process.send({ type: 'started' });
        } else if (message === 'stop') {
          clearInterval(sampler);
          const cpu = process.cpuUsage(cpuStart);
          const memory = process.memoryUsage();
          process.send({
            type: 'metrics',
            serverCpuMs: (cpu.user + cpu.system) / 1000,
            serverElapsedMs: performance.now() - started,
            sampledPeakRssMiB: Math.max(peakRss, memory.rss) / 1024 / 1024,
            sampledPeakHeapMiB: Math.max(peakHeap, memory.heapUsed) / 1024 / 1024,
            processPeakRssMiB: process.resourceUsage().maxRSS / 1024,
            serverErrors: failures,
            backpressureDrains
          });
        }
      } catch (error) {
        console.error(`HTTP benchmark server metrics failed: ${error.message}`);
        process.exitCode = 1;
        clearInterval(sampler);
        server.closeAllConnections();
        server.close();
        if (process.connected) process.disconnect();
      }
    });
    process.once('disconnect', () => {
      clearInterval(sampler);
      server.closeAllConnections();
      server.close();
      clearLoaded();
    });
    process.send({ type: 'ready', port: server.address().port, pages: mount.routes.length });
  } catch (error) {
    clearInterval(sampler);
    if (server) server.close();
    clearLoaded();
    throw new Error(`HTTP benchmark server failed: ${error.message}`, { cause: error });
  }
}

function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code, signal) => onError(new Error(`Benchmark server exited (${code ?? signal}) before ${type}`));
    const onMessage = (message) => {
      if (message.type === type) { cleanup(); resolve(message); }
    };
    try {
      timer = setTimeout(() => onError(new Error(`Timed out waiting for benchmark server ${type}`)), 30000);
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
    } catch (error) {
      onError(error);
    }
  });
}

function requestPage(port, agent, index, scenario, encodedPayload) {
  return new Promise((resolve, reject) => {
    let request;
    let resumeTimer;
    const fail = (error) => {
      clearTimeout(resumeTimer);
      if (request) request.destroy();
      reject(error);
    };
    try {
      const page = index % PAGE_COUNT;
      const user = `user-${index}`;
      const expected = Buffer.from(`${STATIC_HTML}<script>(window.weld=window.weld||{}).data=` +
        `{"page":${page},"user":"${user}","payload":${encodedPayload}};</script>`);
      const started = performance.now();
      request = http.get({
        host: '127.0.0.1', port, path: `/${page}`, agent, headers: { 'x-user': user }
      }, (response) => {
        const chunks = [];
        response.on('error', fail);
        response.on('aborted', () => fail(new Error('Benchmark response aborted')));
        response.on('data', (chunk) => {
          chunks.push(chunk);
          if (scenario === 'slow') {
            response.pause();
            resumeTimer = setTimeout(() => response.resume(), 10);
          }
        });
        response.on('end', () => {
          try {
            clearTimeout(resumeTimer);
            const body = Buffer.concat(chunks);
            if (response.statusCode !== 200 || Number(response.headers['content-length']) !== body.length || !body.equals(expected)) {
              throw new Error(`Incorrect benchmark response for page ${page}, user ${user} (status ${response.statusCode})`);
            }
            resolve(performance.now() - started);
          } catch (error) { fail(error); }
        });
      });
      request.setTimeout(15000, () => fail(new Error('Benchmark request timed out')));
      request.on('error', fail);
    } catch (error) { fail(error); }
  });
}

async function runScenario(directory, scenario, smoke) {
  let child;
  let agent;
  try {
    child = fork(__filename, ['--server', directory, scenario], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const ready = await waitForMessage(child, 'ready');
    if (ready.pages !== PAGE_COUNT) throw new Error(`Expected ${PAGE_COUNT} mounted pages, got ${ready.pages}`);
    const concurrency = smoke ? 2 : (scenario === 'slow' ? 8 : 32);
    const count = smoke ? 8 : (scenario === 'small' ? 2000 : scenario === 'slow' ? 64 : 256);
    agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
    const escapes = { '&': '\\u0026', '<': '\\u003c', '>': '\\u003e', '\u2028': '\\u2028', '\u2029': '\\u2029' };
    const encoded = JSON.stringify(payloadFor(scenario)).replace(/[&<>\u2028\u2029]/g, (char) => escapes[char]);
    for (let i = 0; i < (smoke ? 2 : 32); i += 1) await requestPage(ready.port, agent, i, scenario, encoded);

    const startedMessage = waitForMessage(child, 'started');
    child.send('start');
    await startedMessage;
    const latencies = [];
    let errors = 0;
    let firstError;
    let next = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (let index = next++; index < count; index = next++) {
        try {
          latencies.push(await requestPage(ready.port, agent, index, scenario, encoded));
        } catch (error) {
          errors += 1;
          if (!firstError) firstError = error.message;
        }
      }
    }));
    const elapsed = performance.now() - started;
    const metricsMessage = waitForMessage(child, 'metrics');
    child.send('stop');
    const metrics = await metricsMessage;
    delete metrics.type;
    latencies.sort((a, b) => a - b);
    const result = {
      scenario, pages: ready.pages, concurrency, requests: count, verified: latencies.length, errors,
      requestsPerSecond: Number((latencies.length * 1000 / elapsed).toFixed(2)),
      p50Ms: latencies[Math.ceil(latencies.length * 0.50) - 1] ?? null,
      p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null,
      p99Ms: latencies[Math.ceil(latencies.length * 0.99) - 1] ?? null,
      serverCpuPercent: metrics.serverCpuMs * 100 / metrics.serverElapsedMs,
      ...metrics
    };
    console.log(JSON.stringify(result));
    if (errors || metrics.serverErrors) throw new Error(`HTTP benchmark ${scenario} failed: ${firstError || 'server errors'}`);
  } catch (error) {
    throw new Error(`HTTP benchmark ${scenario}: ${error.message}`, { cause: error });
  } finally {
    try {
      if (agent) agent.destroy();
      if (child) {
        const exited = child.exitCode !== null || child.signalCode !== null;
        if (!exited && child.pid !== undefined) {
          const done = once(child, 'exit');
          child.kill();
          await done;
        }
      }
    } catch (error) {
      throw new Error(`HTTP benchmark server cleanup failed: ${error.message}`, { cause: error });
    }
  }
}

async function main() {
  if (process.argv[2] === '--server') {
    await serveProject(process.argv[3], process.argv[4]);
    return;
  }
  let directory;
  try {
    const smoke = process.argv[2] === '--smoke';
    directory = fs.mkdtempSync(path.join(__dirname, '.weld-http-'));
    for (let i = 0; i < PAGE_COUNT; i += 1) {
      fs.writeFileSync(path.join(directory, `${i}.html`), STATIC_HTML +
        `<weld var="data">return { page: ${i}, user: request.headers['x-user'], payload: request.benchmarkPayload };</weld>`);
    }
    for (const scenario of ['small', 'large', 'slow']) await runScenario(directory, scenario, smoke);
  } catch (error) {
    throw new Error(`HTTP benchmark failed: ${error.message}`, { cause: error });
  } finally {
    if (directory) {
      try {
        const resolved = path.resolve(directory);
        if (path.dirname(resolved) !== __dirname || !path.basename(resolved).startsWith('.weld-http-')) {
          throw new Error('Refusing to clean a benchmark directory outside this repository');
        }
        fs.rmSync(resolved, { recursive: true, force: true });
      } catch (error) {
        throw new Error(`HTTP benchmark fixture cleanup failed: ${error.message}`, { cause: error });
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
