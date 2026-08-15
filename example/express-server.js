'use strict';

// Express example. Express is not a dependency of this project, so install it
// where you are using it:
//
//   npm install express
//   node example/express-server.js
//
// The vanilla server in example/server.js has no such requirement and is what
// `npm start` runs.

const path = require('node:path');
const express = require('express');
const { compileFile } = require('../src');

async function main() {
  // Compiled once, at boot. Setup <weld> blocks run here, not per request.
  // Calling this inside a route would recompile the page and re-run setup on
  // every request.
  const page = await compileFile(path.join(__dirname, 'page.html'));

  const app = express();

  // Serve the documentation alongside the app.
  app.use('/docs', express.static(path.join(__dirname, '..', 'docs')));

  // page.handler is already an Express handler: it renders, ends the response,
  // and forwards any failure to the error middleware below. Express's req is
  // what <weld var> blocks see as `request`, so request.query, request.params
  // and request.body are all available inside the page.
  app.get('/', page.handler);

  // Set your own headers first when you need them; handler only fills in
  // content-type if nothing has set it. Use setHeader, never writeHead, which
  // marks headers as sent and stops render() adding Content-Length.
  app.get('/no-cache', (request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    page.handler(request, response, next);
  });

  // render() writes nothing unless every block succeeded, so a failure arrives
  // here with the response untouched and a real status can still be sent.
  app.use((error, request, response, next) => {
    console.error(error);
    if (response.headersSent) return next(error);
    response.status(500).type('text/plain').send('Internal Server Error');
  });

  app.listen(3000, '127.0.0.1', () => {
    console.log('http://127.0.0.1:3000');
    console.log('http://127.0.0.1:3000/docs');
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
