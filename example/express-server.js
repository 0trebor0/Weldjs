'use strict';

// Express example. Express is not a dependency of this project, so install it
// where you are using it:
//
//   npm install express
//   node example/express-server.js
//
// The vanilla server in example/server.js has no such requirement and is what
// `npm start` runs. Both use page.html, which needs Node 22.5+ for node:sqlite.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { load, router, watch } = require('../src');

const app = express();

// The self-contained docs have fixed inline assets. Hash their exact contents
// so they work under CSP without granting permission to arbitrary inline code.
const documentationHashes = { script: [], style: [] };
try {
  const documentation = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8');
  for (const block of documentation.matchAll(/<(script|style)>([\s\S]*?)<\/\1>/g)) {
    const hash = crypto.createHash('sha256').update(block[2]).digest('base64');
    documentationHashes[block[1]].push(`'sha256-${hash}'`);
  }
} catch (error) {
  throw new Error(`Cannot prepare documentation CSP: ${error.message}`, { cause: error });
}

// A per-request CSP nonce. render() picks res.locals.cspNonce up automatically,
// so the data script is allowed by a strict policy instead of being blocked.
app.use((request, response, next) => {
  response.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  response.setHeader(
    'content-security-policy',
    `default-src 'self'; script-src 'self' 'nonce-${response.locals.cspNonce}' ` +
    `${documentationHashes.script.join(' ')}; style-src 'self' ${documentationHashes.style.join(' ')}`
  );
  next();
});

app.use('/docs', express.static(path.join(__dirname, '..', 'docs')));
app.use('/assets', express.static(path.join(__dirname, 'public')));

// Every .html under pages/ becomes a route, resolved once at startup:
//   pages/index.html       -> /
//   pages/about.html       -> /about
//   pages/blog/index.html  -> /blog
//   pages/blog/[slug].html -> /blog/:slug   (request.params.slug)
app.use(router(path.join(__dirname, 'pages')));

// A single page mounted by hand, for anything the router does not cover.
// load() returns immediately and compiles in the background, so no async wrapper.
const home = load(path.join(__dirname, 'page.html'));
app.get('/users', home.handler);

// Recompile on edit during development. Files pulled in by <weld src> are
// watched too. The router already loaded with-partials.html; load() returns the
// same cached page, so edits to either partial rebuild the mounted route.
// Pages and partials share OS watch handles for their directories.
if (process.env.NODE_ENV !== 'production') {
  for (const page of [home, load(path.join(__dirname, 'pages', 'with-partials.html'))]) {
    watch(page, { onChange: (changed) => console.log(`reloaded ${path.basename(changed.filename)}`) });
  }
}

// render() writes nothing unless every block succeeded, so a failure arrives
// here with the response untouched and a real status can still be sent.
app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) return next(error);
  response.status(500).type('text/plain').send('Internal Server Error');
});

app.listen(3000, '127.0.0.1', () => {
  console.log('http://127.0.0.1:3000');
  console.log('http://127.0.0.1:3000/users');
  console.log('http://127.0.0.1:3000/with-partials');
  console.log('http://127.0.0.1:3000/docs');
});
