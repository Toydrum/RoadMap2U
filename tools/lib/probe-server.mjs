import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export function createProbeBuildServer({ base, buildRoot, appBase = '/' }) {
  const root = resolve(buildRoot);
  const indexPath = resolve(root, 'index.html');
  return createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url ?? '/', base).pathname);
      const baseWithoutSlash = appBase === '/' ? '/' : appBase.slice(0, -1);
      let pathname;
      if (appBase === '/') {
        pathname = requestPath;
      } else if (requestPath === baseWithoutSlash || requestPath === appBase) {
        pathname = '/';
      } else if (requestPath.startsWith(appBase)) {
        pathname = `/${requestPath.slice(appBase.length)}`;
      } else {
        response.writeHead(404).end();
        return;
      }
      const candidate = resolve(root, `.${pathname}`);
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      let file = candidate;
      try {
        if (!(await stat(file)).isFile()) file = indexPath;
      } catch {
        file = indexPath;
      }
      response
        .writeHead(200, {
          'content-type': mime[extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        })
        .end(await readFile(file));
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
}

/** Reuse the battery's already-reachable SPA server. When a visual probe is
 * run standalone, start its private server and return an ownership-aware
 * closer instead. */
export async function ensureProbeServer({ base, server, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(base, { cache: 'no-store' });
    if (response.ok) return null;
  } catch {
    // No shared server: the standalone probe owns the listener below.
  }

  const { port } = new URL(base);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(Number(port), '127.0.0.1', () => {
      server.off('error', onError);
      resolve(undefined);
    });
  });
  return () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
