import assert from 'node:assert/strict';
import { BASE, launchPage, ok } from './lib/harness.mjs';
import { createProbeBuildServer, ensureProbeServer } from './lib/probe-server.mjs';

const origin = new URL(BASE).origin;
const buildRoot = process.env.RM_CATALOG_BUILD_ROOT ?? 'dist/public-catalog-ci/browser';
const server = createProbeBuildServer({ base: BASE, buildRoot });
const closeServer = await ensureProbeServer({ base: BASE, server });
assert.ok(closeServer, 'The catalog fixture requires its own loopback server');

// Public wire format with confirmed Free limits. Purchases stay unavailable
// throughout this probe. Every API request is answered by the browser fixture.
const planCatalog = {
  version: '2026-08-prepayment-v1',
  pricingVersion: 'launch-2026',
  currency: 'MXN',
  taxInclusive: true,
  paymentsEnabled: false,
  plans: {
    free: {
      limits: { maxActiveTrees: 1, maxVisibleBranchesPerTree: 5 },
      capabilities: { cloudSync: false, social: false, family: false },
    },
    premium: {
      limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
      capabilities: { cloudSync: true, social: true, family: false },
      prices: { month: { amountMinor: 9900 }, year: { amountMinor: 94900 } },
    },
  },
};
const unavailable = { status: 503, json: { error: 'fixture unavailable' } };
const unpublishedQuota = /(?:[12] árbol(?:es)? activ[oa]s?|(?:5|10) ramas|\{trees\}|\{branches\})/;

let browser;
try {
  const launched = await launchPage(
    { width: 390, height: 844 },
    { commercialAccess: false, contextOptions: { serviceWorkers: 'block' } },
  );
  browser = launched.browser;
  const { page } = launched;
  page.setDefaultTimeout(10_000);
  const blocked = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let respondToPlans;
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && request.method() === 'GET') {
      if (url.pathname === '/v1/plans' && url.searchParams.get('policy') === '2') {
        return route.fulfill(await respondToPlans.promise);
      }
      if (url.pathname === '/v1/billing/individual/catalog') return route.fulfill(unavailable);
      if (!url.pathname.startsWith('/v1/')) return route.continue();
    }
    blocked.push(`${request.method()} ${url.origin}${url.pathname}`);
    return route.abort();
  });

  const freeCopy = page.locator('.hero .microcopy, .free-plan, #faq, .final-cta');
  for (const status of [200, 503]) {
    respondToPlans = Promise.withResolvers();
    const requested = page.waitForRequest((request) => new URL(request.url()).pathname === '/v1/plans');
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.locator('app-landing h1').waitFor();
    await requested;
    const pendingCopy = (await freeCopy.allTextContents()).join(' ');
    ok(`Free quota stays hidden while a ${status} response is pending`, !unpublishedQuota.test(pendingCopy));

    const received = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/plans');
    respondToPlans.resolve(status === 200 ? { status, json: planCatalog } : unavailable);
    assert.equal((await received).status(), status);
    await page.waitForLoadState('networkidle');
    if (status === 200) {
      const confirmed = await page.locator('.free-plan').textContent();
      ok('Free displays only the confirmed quota', /1 árbol activo/.test(confirmed) && /5 ramas/.test(confirmed));
    } else {
      const failedCopy = (await freeCopy.allTextContents()).join(' ');
      ok('Free never advertises fallback numbers after HTTP 503', !unpublishedQuota.test(failedCopy));
    }
    const premium = page.locator('.premium-plan');
    ok(
      'A failed Premium catalog shows the unavailable state with no advertised prices',
      (await premium.locator('.individual-offer-status').textContent()).includes('La oferta necesita una revisión') &&
        (await premium.locator('.premium-prices').count()) === 0,
    );
  }
  assert.deepEqual(blocked, [], 'Unexpected network request from the public fixture');
  assert.deepEqual(pageErrors, [], 'Unhandled browser error in the public fixture');
} finally {
  await browser?.close();
  await closeServer();
}
