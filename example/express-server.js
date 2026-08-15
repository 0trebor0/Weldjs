'use strict';

// Express example. Express is not a dependency of this project, so install it
// where you are using it:
//
//   npm install express
//   node example/express-server.js
//
// The vanilla server in example/server.js has no such requirement and is what
// `npm start` runs.

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { load, router, watch } = require('../src');

const app = express();

// A per-request CSP nonce. render() picks res.locals.cspNonce up automatically,
// so the data script is allowed by a strict policy instead of being blocked.
app.use((request, response, next) => {
  response.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  response.setHeader(
    'content-security-policy',
    `default-src 'self'; script-src 'self' 'nonce-${response.locals.cspNonce}'`
  );
  next();
});

app.use('/docs', express.static(path.join(__dirname, '..', 'docs')));

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
// watched too, so editing a shared partial rebuilds the pages that include it.
if (process.env.NODE_ENV !== 'production') {
  watch(home, { onChange: (page) => console.log(`reloaded ${path.basename(page.filename)}`) });
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
  console.log('http://127.0.0.1:3000/with-partials');
  console.log('http://127.0.0.1:3000/docs');
});
