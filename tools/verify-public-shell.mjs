import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { BASE, launchPage, ok } from './lib/harness.mjs';

const buildRoot = resolve(process.env.RM_BUILD_ROOT ?? 'dist/roadmap2u/browser');
const indexPath = resolve(buildRoot, 'index.html');
const rawAppBase = process.env.RM_APP_BASE ?? '/';
const appBase = `${rawAppBase.startsWith('/') ? '' : '/'}${rawAppBase}`.replace(/\/*$/, '/');
const appUrl = (path = '') => `${BASE}${appBase}${path.replace(/^\/+/, '')}`;
const viewport = {
  width: Number(process.env.RM_VIEWPORT_WIDTH ?? 980),
  height: Number(process.env.RM_VIEWPORT_HEIGHT ?? 760),
};
const screenshotPath = process.env.RM_SCREENSHOT ? resolve(process.env.RM_SCREENSHOT) : null;
const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent(new URL(request.url ?? '/', BASE).pathname);
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
    const candidate = resolve(buildRoot, `.${pathname}`);
    if (candidate !== buildRoot && !candidate.startsWith(`${buildRoot}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    let file = candidate;
    try {
      if (!(await stat(file)).isFile()) file = indexPath;
    } catch {
      file = indexPath;
    }
    const extension = extname(file);
    response
      .writeHead(200, {
        'content-type': mime[extension] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      .end(await readFile(file));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

const { port } = new URL(BASE);
await new Promise((ready) => server.listen(Number(port), '127.0.0.1', ready));

const { browser, page } = await launchPage(viewport);
const pageErrors = [];
const apiRequests = [];

page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('request', (request) => {
  const url = new URL(request.url());
  if (/\/v1(?:\/|$)/.test(url.pathname)) apiRequests.push(request.url());
});

try {
  await page.goto(appUrl(), { waitUntil: 'networkidle' });
  await page.locator('app-landing h1').waitFor();

  const brandMetrics = await page.locator('app-landing .brand').evaluate((brand) => {
    const image = brand.querySelector('img');
    const linkRect = brand.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(imageRect.width);
    canvas.height = Math.ceil(imageRect.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let paintedRight = -1;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] === 0) continue;
      paintedRight = Math.max(paintedRight, ((index - 3) / 4) % canvas.width);
    }
    return {
      link: { left: linkRect.left, right: linkRect.right, width: linkRect.width },
      image: { left: imageRect.left, right: imageRect.right, width: imageRect.width },
      paintedRight,
      rightInset: canvas.width - 1 - paintedRight,
    };
  });

  if (screenshotPath) {
    await page.waitForTimeout(900);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath });
  }

  const expectedBasePath = appBase;
  ok(
    'A0 landing home link respects base href',
    (await page.locator('app-landing .brand').getAttribute('href')) === expectedBasePath,
  );
  ok(
    'A1 landing account CTA respects base href',
    (await page.locator('app-landing .sign-in').getAttribute('href')) === `${expectedBasePath}account`,
  );
  ok(
    'A2 landing lockup stays inside its link container',
    brandMetrics.image.left >= brandMetrics.link.left - 0.5 &&
      brandMetrics.image.right <= brandMetrics.link.right + 0.5,
    JSON.stringify(brandMetrics),
  );
  ok(
    'A3 landing lockup leaves a painted safety inset at the right edge',
    brandMetrics.rightInset >= 1,
    JSON.stringify(brandMetrics),
  );

  const landingState = await page.evaluate(async () => ({
    databases:
      typeof indexedDB.databases === 'function'
        ? (await indexedDB.databases()).map((database) => database.name)
        : [],
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  ok('A landing renders outside product chrome', (await page.locator('.tabbar').count()) === 0);
  ok(
    'B landing opens no RoadMap2U IndexedDB',
    !landingState.databases.some((name) =>
      ['roadmap2u', 'rodemap2u', 'roadmap2u-mockcloud'].includes(name ?? ''),
    ),
    landingState.databases.join(','),
  );
  ok('C landing registers no service worker', landingState.registrations === 0);
  ok('D landing makes no API request', apiRequests.length === 0, apiRequests.join(','));

  await page.locator('app-landing .sign-in').click();
  await page.locator('app-account').waitFor();
  ok(
    'D1 landing account CTA navigates inside the configured base href',
    new URL(page.url()).pathname === `${appBase}account`,
  );

  await page.goto(appUrl('account'), { waitUntil: 'networkidle' });
  await page.locator('app-account').waitFor();
  await page.waitForTimeout(500);
  const accountRegistrations = await page.evaluate(
    async () => (await navigator.serviceWorker.getRegistrations()).length,
  );
  ok('E account keeps product chrome asleep', (await page.locator('.tabbar').count()) === 0);
  ok('F account registers no service worker', accountRegistrations === 0);
  ok('F1 account owns exactly one main landmark', (await page.locator('main').count()) === 1);
  ok(
    'F2 account skip link targets its main landmark',
    (await page.locator('.skip-link').getAttribute('href')) === '#account-main' &&
      (await page.locator('main#account-main').count()) === 1,
  );

  await page.goto(appUrl('forest?seed=demo'), { waitUntil: 'networkidle' });
  await page.locator('app-forest').waitFor();
  await page.waitForFunction(
    async () => (await navigator.serviceWorker.getRegistrations()).length === 1,
    undefined,
    { timeout: 8_000 },
  );
  const productState = await page.evaluate(async () => ({
    databases:
      typeof indexedDB.databases === 'function'
        ? (await indexedDB.databases()).map((database) => database.name)
        : [],
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  ok('G product shell restores its navigation', (await page.locator('.tabbar').count()) === 1);
  ok('H product initializes its local database', productState.databases.includes('roadmap2u'));
  ok('I product registers the PWA once', productState.registrations === 1);

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('app-forest').waitFor();
  ok('J product deep refresh stays in the product shell', (await page.locator('.tabbar').count()) === 1);
  ok('K no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
