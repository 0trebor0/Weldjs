'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

test('HTTP benchmark smoke run verifies all workloads and reports server metrics', () => {
  const result = spawnSync(process.execPath, ['benchmark-http.js', '--smoke'], {
    cwd: ROOT, encoding: 'utf8', timeout: 45000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const reports = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(reports.map((report) => report.scenario), ['small', 'large', 'slow']);
  for (const report of reports) {
    assert.equal(report.pages, 1000);
    assert.equal(report.verified, report.requests);
    assert.equal(report.errors, 0);
    assert.equal(report.serverErrors, 0);
    assert.ok(report.requestsPerSecond > 0);
    assert.ok(report.p50Ms <= report.p95Ms && report.p95Ms <= report.p99Ms);
    assert.ok(report.serverCpuMs >= 0);
    assert.ok(report.serverElapsedMs > 0);
    assert.ok(report.sampledPeakRssMiB > 0);
    assert.ok(report.sampledPeakHeapMiB > 0);
    assert.ok(report.processPeakRssMiB > 0);
  }
  assert.ok(reports[2].backpressureDrains > 0, 'slow-reader run never exercised backpressure');
});

test('HTTP benchmark reports a server startup failure', () => {
  const result = spawnSync(process.execPath, [
    'benchmark-http.js', '--server', path.join(ROOT, '.weld-http-nonexistent'), 'small'
  ], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP benchmark server failed/);
});

test('HTTP benchmark catches request errors and removes its project fixture', () => {
  const before = fs.readdirSync(ROOT).filter((name) => name.startsWith('.weld-http-'));
  const result = spawnSync(process.execPath, ['-e', `
    require('node:http').get = () => { throw new Error('injected request failure'); };
    require('./benchmark-http');
  `], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP benchmark small: injected request failure/);
  assert.deepEqual(fs.readdirSync(ROOT).filter((name) => name.startsWith('.weld-http-')), before);
});

test('HTTP benchmark reports a premature child exit instead of waiting for readiness', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const cp = require('node:child_process');
    const original = cp.fork;
    cp.fork = (...args) => {
      const child = original(...args);
      setImmediate(() => child.kill());
      return child;
    };
    require('./benchmark-http');
  `], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Benchmark server exited .* before ready/);
});

test('HTTP benchmark reports fixture creation errors', () => {
  const result = spawnSync(process.execPath, ['-e', `
    require('node:fs').mkdtempSync = () => { throw new Error('injected fixture failure'); };
    require('./benchmark-http');
  `], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP benchmark failed: injected fixture failure/);
});

test('HTTP benchmark rejects an incorrect response body', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const { EventEmitter } = require('node:events');
    require('node:http').get = (options, callback) => {
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = () => {};
      process.nextTick(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { 'content-length': '1' };
        callback(response);
        response.emit('data', Buffer.from('x'));
        response.emit('end');
      });
      return request;
    };
    require('./benchmark-http');
  `], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Incorrect benchmark response for page 0, user user-0/);
});
