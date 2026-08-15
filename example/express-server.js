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

  app.get('/', async (request, response, next) => {
    try {
      // setHeader rather than writeHead: writeHead marks the headers as sent,
      // which stops render() adding Content-Length once it knows the size.
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');

      // Express's req is what <weld var> blocks see as `request`, so
      // request.query, request.params and request.body are all available.
      await page.render(request, response);
      response.end();
    } catch (error) {
      // Express 5 forwards rejected promises automatically; Express 4 does not,
      // and without this the request would hang until it timed out. Passing to
      // next() works on both.
      next(error);
    }
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
