'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { compileFile } = require('../src');

async function main() {
  const page = await compileFile(path.join(__dirname, 'page.html'));
  const clientScript = await fs.readFile(path.join(__dirname, 'public', 'users.js'));

  const server = http.createServer(async (request, response) => {
    try {
      // setHeader rather than writeHead: writeHead marks the headers as sent, and
      // render() adds Content-Length once it knows the finished size.
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');

      if (request.url === '/assets/users.js') {
        response.setHeader('content-type', 'application/javascript; charset=utf-8');
        response.setHeader('content-length', clientScript.length);
        response.end(clientScript);
        return;
      }

      await page.render(request, response);
      response.end();
    } catch (error) {
      console.error(error);
      if (!response.headersSent) response.writeHead(500);
      response.end('Internal Server Error');
    }
  });

  server.listen(3000, '127.0.0.1', () => {
    console.log('http://127.0.0.1:3000');
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
