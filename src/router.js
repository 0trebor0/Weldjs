'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./compiler');

// Bounds the directory walk. Symlinked directories are skipped rather than
// followed, so a cycle cannot occur, but the cap makes termination provable
// without reasoning about the filesystem.
const MAX_TREE_DEPTH = 32;

const PAGE_EXTENSION = '.html';
const PARAM_PATTERN = /^\[([A-Za-z_$][A-Za-z0-9_$]*)\]$/;

function collectPages(directory, depth, found) {
  if (depth > MAX_TREE_DEPTH) {
    throw new Error(`router() gave up below ${MAX_TREE_DEPTH} directories at ${directory}`);
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    // Dotfiles are never routable, and symlinks are not followed: entry.isDirectory()
    // and entry.isFile() are both false for a symlink, so cycles cannot arise.
    if (entry.name.startsWith('.')) continue;

    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      collectPages(full, depth + 1, found);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(PAGE_EXTENSION)) {
      found.push(full);
    }
  }

  return found;
}

// 'blog/[slug].html' -> ['blog', '[slug]'];  'blog/index.html' -> ['blog']
function routeSegments(relative) {
  const withoutExtension = relative.slice(0, -PAGE_EXTENSION.length);
  const segments = withoutExtension.split(path.sep).filter((part) => part.length > 0);

  if (segments[segments.length - 1] === 'index') segments.pop();

  return segments;
}

function buildRoutes(root) {
  const files = collectPages(root, 0, []);

  const staticRoutes = new Map();
  // Dynamic routes are grouped by segment count so a request only ever compares
  // against candidates that could possibly match.
  const dynamicByLength = new Map();

  for (const file of files) {
    const segments = routeSegments(path.relative(root, file));
    const params = [];
    let dynamic = false;

    for (const segment of segments) {
      const match = PARAM_PATTERN.exec(segment);
      if (!match) continue;
      dynamic = true;
      if (params.includes(match[1])) {
        throw new Error(`router(): duplicate parameter "${match[1]}" in ${file}`);
      }
      params.push(match[1]);
    }

    const routePath = `/${segments.join('/')}`;
    const page = load(file);

    if (!dynamic) {
      if (staticRoutes.has(routePath)) {
        throw new Error(`router(): two files map to ${routePath}`);
      }
      staticRoutes.set(routePath, page);
      continue;
    }

    const bucket = dynamicByLength.get(segments.length) || [];
    bucket.push({ segments, params, page });
    dynamicByLength.set(segments.length, bucket);
  }

  return { staticRoutes, dynamicByLength };
}

function matchDynamic(dynamicByLength, segments) {
  const candidates = dynamicByLength.get(segments.length);
  if (!candidates) return null;

  for (const candidate of candidates) {
    const values = Object.create(null);
    let matched = true;

    for (let i = 0; i < segments.length; i += 1) {
      const pattern = candidate.segments[i];
      const param = PARAM_PATTERN.exec(pattern);

      if (param) {
        if (segments[i].length === 0) { matched = false; break; }
        values[param[1]] = segments[i];
        continue;
      }

      if (pattern !== segments[i]) { matched = false; break; }
    }

    if (matched) return { page: candidate.page, params: values };
  }

  return null;
}

// Splits a request path into decoded segments, or returns null if the request is
// not routable. The route table is fixed at startup and never consulted against
// the filesystem at request time, so a traversal attempt simply matches nothing.
function pathSegments(url) {
  if (typeof url !== 'string' || url.length === 0) return null;

  const queryAt = url.indexOf('?');
  const hashAt = url.indexOf('#');
  let end = url.length;
  if (queryAt !== -1) end = Math.min(end, queryAt);
  if (hashAt !== -1) end = Math.min(end, hashAt);

  const raw = url.slice(0, end);
  const parts = raw.split('/').filter((part) => part.length > 0);
  const segments = [];

  for (const part of parts) {
    let decoded;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null; // malformed percent-encoding
    }

    // Rejected outright rather than normalised: the table holds no such entries,
    // but refusing them keeps the intent explicit.
    if (decoded === '.' || decoded === '..' || decoded.includes('\0')) return null;

    segments.push(decoded);
  }

  return segments;
}

// Maps a directory of .html files to routes, resolved once at startup:
//
//   app.use(weld.router(path.join(__dirname, 'pages')));
//
//   pages/index.html        -> /
//   pages/about.html        -> /about
//   pages/blog/index.html   -> /blog
//   pages/blog/[slug].html  -> /blog/:slug   (request.params.slug)
function router(directory, options = {}) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('router() requires a non-empty string directory');
  }

  if (options === null || typeof options !== 'object') {
    throw new TypeError('router() options must be an object');
  }

  const root = path.resolve(directory);

  const stats = fs.statSync(root, { throwIfNoEntry: false });
  if (!stats || !stats.isDirectory()) {
    throw new Error(`router(): ${root} is not a directory`);
  }

  const { staticRoutes, dynamicByLength } = buildRoutes(root);

  function middleware(request, response, next) {
    const proceed = typeof next === 'function' ? next : () => {};

    if (request.method !== 'GET' && request.method !== 'HEAD') return proceed();

    const segments = pathSegments(request.url);
    if (segments === null) return proceed();

    const routePath = `/${segments.join('/')}`;

    // Static lookup first: one Map hit, no per-route comparison.
    const exact = staticRoutes.get(routePath);
    if (exact) return exact.handler(request, response, next);

    const dynamic = matchDynamic(dynamicByLength, segments);
    if (!dynamic) return proceed();

    if (request.params === undefined || request.params === null) {
      request.params = Object.create(null);
    }
    Object.assign(request.params, dynamic.params);

    return dynamic.page.handler(request, response, next);
  }

  // Exposed for testing and for anyone wanting to see what was mounted.
  middleware.routes = Object.freeze([
    ...[...staticRoutes.keys()],
    ...[...dynamicByLength.values()].flat().map((route) => `/${route.segments.join('/')}`)
  ].sort());

  middleware.root = root;

  return middleware;
}

module.exports = { router };
