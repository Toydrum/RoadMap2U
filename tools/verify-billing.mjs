import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BASE, launchPage, ok, signInAs } from './lib/harness.mjs';

// Closed-sale browser rehearsal: explicit synthetic provider facts in the mock
// cloud. These are never obtained from Checkout/Portal return query parameters.
assert.ok(['localhost', '127.0.0.1'].includes(new URL(BASE).hostname));
const output = resolve('tools/battery-logs/billing');
await mkdir(output, { recursive: true });
const errors = [];
const check = (label, value) => {
  ok(label, value);
  assert.ok(value, label);
};
const { browser, page } = await launchPage(
  { width: 1280, height: 900 },
  {
    commercialAccess: false,
    contextOptions: { serviceWorkers: 'block', reducedMotion: 'reduce' },
  },
);
page.setDefaultTimeout(12_000);
page.on('pageerror', (error) => {
  errors.push(error.message);
  console.log('PAGEERROR', error.message);
});
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
let portalExits = 0;
await page.route('https://billing.stripe.com/**', async (route) => {
  portalExits++;
  await route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<title>Synthetic Portal</title><p>Local synthetic Portal</p>',
  });
});
await page.route('https://checkout.stripe.com/**', async (route) => {
  errors.push('Unexpected Checkout during closed-sale rehearsal');
  await route.abort();
});
async function cloud(store, operation, value) {
  return page.evaluate(
    ({ store, operation, value }) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('roadmap2u-mockcloud');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(store, operation === 'get' ? 'readonly' : 'readwrite');
          const action = tx.objectStore(store)[operation](value);
          let result;
          action.onsuccess = () => {
            result = action.result;
          };
          tx.oncomplete = () => {
            db.close();
            resolve(result);
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    { store, operation, value },
  );
}
async function subscription(query = '') {
  await page.goto(`${BASE}/account/subscription${query}`, { waitUntil: 'networkidle' });
  await page.locator('app-subscription-page h1').waitFor();
  await page.locator('.billing-status[aria-busy="false"]').waitFor();
}
const body = () => page.locator('app-subscription-page').innerText();
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  check(
    'landing shows the real closed individual catalog',
    (await page.locator('.individual-offer-status').innerText()).includes('compras'),
  );
  check(
    'landing opens the subscription account door',
    (await page.locator('.premium-plan a').getAttribute('href')) === '/account/subscription',
  );
  check(
    'landing keeps both final MXN prices',
    (await page.locator('.premium-prices').innerText()).includes('$114.84 MXN') &&
      (await page.locator('.premium-prices').innerText()).includes('$1,100.84 MXN'),
  );
  await page.goto(`${BASE}/account/subscription`, { waitUntil: 'networkidle' });
  check(
    'guest gets a return-scoped sign-in door',
    (await page.locator('.billing-sign-in').getAttribute('href')).includes(
      'volver=%2Faccount%2Fsubscription',
    ),
  );
  check('guest cannot start Checkout', (await page.locator('.billing-checkout').count()) === 0);
  await page.goto(`${BASE}/subscription-terms?lang=en`, { waitUntil: 'networkidle' });
  check(
    'commercial terms open publicly in requested English',
    (await page.locator('h1').innerText()) === 'Subscription terms',
  );
  check(
    'commercial conditions remain explicitly draft',
    (await page.locator('main').innerText()).includes('draft') &&
      (await page.locator('main').innerText()).includes('$1,100.84 MXN'),
  );

  await signInAs(page, 'rocio', 'Bosque123');
  const declaration = page.locator('app-privacy-panel input[name="privacy-age"][value="adult"]');
  if (await declaration.count()) {
    check(
      'synthetic buyer starts with an explicit adult declaration choice',
      !(await declaration.isChecked()),
    );
    await declaration.check();
    await page.locator('app-privacy-panel form input[type="checkbox"]').last().check();
    await page.locator('app-privacy-panel form button[type="submit"]').click();
    await declaration.waitFor({ state: 'detached' });
  }
  check(
    'account has an individual subscription link',
    (await page.locator('.billing-account-link').getAttribute('href')) === '/account/subscription',
  );
  await subscription('?return=checkout&session_id=forged-success');
  check(
    'forged return does not grant Premium',
    (await page.locator('.billing-access').innerText()).includes('Free'),
  );
  check(
    'pending return never invites another payment',
    (await page.locator('.billing-checkout').count()) === 0 &&
      (await body()).includes('No necesito volver a pagar'),
  );
  await page.locator('.billing-waiting').waitFor({ timeout: 65_000 });
  // The deadline stops new polling. A read started just before it can settle
  // afterward; assert the recovery action only once that bounded read settles.
  await page.locator('.billing-refresh:not([disabled])').waitFor();
  check(
    'one-minute confirmation ends in explicit retry and support',
    (await page.locator('.billing-refresh').isEnabled()) &&
      (await body()).includes('sin iniciar otro pago'),
  );
  check('return status takes no payment command', portalExits === 0);
  await page.screenshot({ path: resolve(output, 'return-waiting-desktop.png'), fullPage: true });

  const buyer = await cloud('users', 'get', 'mock-parent');
  check(
    'synthetic payment is bound to the signed-in account instance',
    typeof buyer.accountInstanceId === 'string' && buyer.accountInstanceId.length > 0,
  );
  const evidenceKey = `billing.individual.evidence:${buyer.userId}:${buyer.accountInstanceId}`;
  const paid = {
    source: 'test_seed',
    accountId: buyer.userId,
    accountInstanceId: buyer.accountInstanceId,
    invoiceId: 'invoice-battery-individual',
    interval: 'month',
    paidThrough: Date.now() + 3_600_000,
    cancelAtPeriodEnd: false,
    revision: 2,
  };
  await cloud('kv', 'put', { key: evidenceKey, value: paid });
  await subscription('?return=checkout');
  await page.locator('.billing-access').filter({ hasText: 'Premium' }).waitFor();
  check(
    'paid fixture is confirmed through summary plus validated access',
    (await body()).includes('suscripción está activa') &&
      (await page.locator('.billing-pending').count()) === 0,
  );
  check(
    'active existing subscriber cannot buy twice',
    (await page.locator('.billing-checkout').count()) === 0,
  );
  check(
    'Portal is accessible while new purchases remain closed',
    (await page.locator('.billing-portal').isEnabled()) &&
      (await page.locator('.billing-closed').count()) === 1,
  );
  await cloud('kv', 'put', {
    key: evidenceKey,
    value: { ...paid, cancelAtPeriodEnd: true, revision: 3 },
  });
  await subscription('?return=portal');
  check(
    'Portal return refreshes cancellation without losing paid access',
    (await body()).includes('La renovación está cancelada') &&
      (await page.locator('.billing-access').innerText()).includes('Premium'),
  );
  await cloud('kv', 'put', { key: evidenceKey, value: { ...paid, review: true, revision: 4 } });
  await subscription();
  check(
    'payment review suspends the individual source without another purchase',
    (await body()).includes('pago está en revisión') &&
      (await page.locator('.billing-access').innerText()).includes('Free') &&
      (await page.locator('.billing-checkout').count()) === 0,
  );
  await cloud('kv', 'put', {
    key: evidenceKey,
    value: { ...paid, paidThrough: Date.now() - 1000, terminal: true, revision: 5 },
  });
  await subscription();
  check(
    'expiry removes paid access and preserves Portal',
    (await page.locator('.billing-access').innerText()).includes('Free') &&
      (await page.locator('.billing-portal').isEnabled()),
  );
  await page.locator('.billing-portal').focus();
  await page.keyboard.press('Enter');
  await page.waitForURL('https://billing.stripe.com/**');
  check('keyboard Portal exit uses the validated server session URL', portalExits === 1);
  await subscription('?return=portal');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('heading', { name: 'My subscription', exact: true }).waitFor();
  check(
    'financial status and support are translated',
    (await body()).includes('My paid period ended') && (await body()).includes('CFDI'),
  );
  await page.screenshot({ path: resolve(output, 'expired-english-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Español', exact: true }).click();
  await page.getByRole('heading', { name: 'Mi suscripción', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  check('subscription page fits mobile width', await overflow());
  await page.screenshot({ path: resolve(output, 'expired-mobile.png'), fullPage: true });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
  });
  check('subscription remains usable with text enlarged to 200 percent', await overflow());
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  check(
    'Settings keeps an adult subscription management door',
    (await page.locator('.billing-account-link').getAttribute('href')) === '/account/subscription',
  );
  check('browser reports no page or console errors', errors.length === 0);
} finally {
  await browser.close();
}
