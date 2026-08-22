import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'smoke-frontend.mjs');

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function run(frontendUrl, apiBaseUrl) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        script,
        '--frontend-url',
        frontendUrl,
        '--api-base-url',
        apiBaseUrl,
        '--cors-origin',
        frontendUrl,
      ],
      { encoding: 'utf8' },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function frontendServer() {
  const index = `<!doctype html><html><head><base href="/"><link rel="manifest" href="manifest.webmanifest"><link rel="stylesheet" href="styles-HASH.css"></head><body><script src="main-HASH.js"></script></body></html>`;
  return listen((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/' || path === '/account' || path === '/ahora') {
      response.writeHead(200, { 'content-type': 'text/html' }).end(index);
    } else if (path === '/manifest.webmanifest') {
      response
        .writeHead(200, { 'content-type': 'application/manifest+json' })
        .end(
          JSON.stringify({ id: '/', scope: '/', start_url: '/ahora', icons: [{ src: 'icon.png' }] }),
        );
    } else if (path === '/icon.png') {
      response.writeHead(200, { 'content-type': 'image/png' }).end('png');
    } else if (path === '/ngsw.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } else if (path === '/sw.js' || path === '/main-HASH.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end('');
    } else if (path === '/styles-HASH.css') {
      response.writeHead(200, { 'content-type': 'text/css' }).end('');
    } else {
      response.writeHead(404).end();
    }
  });
}

test('checks deep links, every indexed asset, PWA files, icons, CORS, and JSON 401', async () => {
  const frontend = await frontendServer();
  const api = await listen((request, response) => {
    if (request.method === 'OPTIONS') {
      response
        .writeHead(204, {
          'access-control-allow-origin': frontend.url,
          'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type',
        })
        .end();
      return;
    }
    response
      .writeHead(401, {
        'content-type': 'application/json',
        'access-control-allow-origin': frontend.url,
      })
      .end('{"message":"Unauthorized"}');
  });
  try {
    const result = await run(frontend.url, api.url);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /smoke passed/i);
  } finally {
    await frontend.close();
    await api.close();
  }
});

test('rejects a 401 response that is not JSON', async () => {
  const frontend = await frontendServer();
  const api = await listen((request, response) => {
    if (request.method === 'OPTIONS') {
      response
        .writeHead(204, {
          'access-control-allow-origin': frontend.url,
          'access-control-allow-methods': 'GET,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type',
        })
        .end();
      return;
    }
    response
      .writeHead(401, {
        'content-type': 'text/html',
        'access-control-allow-origin': frontend.url,
      })
      .end('<h1>Unauthorized</h1>');
  });
  try {
    const result = await run(frontend.url, api.url);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /401 response must be JSON/i);
  } finally {
    await frontend.close();
    await api.close();
  }
});

test('rejects a 401 response without the exact frontend CORS origin', async () => {
  const frontend = await frontendServer();
  const api = await listen((request, response) => {
    if (request.method === 'OPTIONS') {
      response
        .writeHead(204, {
          'access-control-allow-origin': 'https://wrong.roadmap2u.com',
          'access-control-allow-methods': 'GET,OPTIONS',
          'access-control-allow-headers': 'authorization',
        })
        .end();
      return;
    }
    response
      .writeHead(401, {
        'content-type': 'application/json',
        'access-control-allow-origin': 'https://wrong.roadmap2u.com',
      })
      .end('{"message":"Unauthorized"}');
  });
  try {
    const result = await run(frontend.url, api.url);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CORS.*origin/i);
  } finally {
    await frontend.close();
    await api.close();
  }
});
