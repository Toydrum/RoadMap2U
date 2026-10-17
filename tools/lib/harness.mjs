// Shared verify-script harness (B6, 0.0.77+). New tools/verify-*.mjs MUST
// use these helpers; existing scripts migrate whenever they're touched.
// Keeping launch/sign-in/node-center in ONE place is how probe preambles
// stop drifting from the app (the 0.0.75 «Más detalles» fold broke four
// scripts that each carried their own copy).
import { chromium } from 'playwright-core';
export { isolateIndividualBillingFixture } from './individual-probe-fixture.mjs';

export const BASE = 'http://localhost:' + (process.env.RM_PORT ?? '8826');

const ACCESS_LEASE_MS = 24 * 60 * 60 * 1000;
const BATTERY_USER = Object.freeze({
  userId: 'battery-probe-adult',
  username: 'battery_probe',
  email: null,
  displayName: 'Battery probe',
  accountType: 'adult',
});

/** A real, bounded sponsored lease for browser probes that exercise product
 * mutations. This is test state in IndexedDB, never a product bypass: the
 * same AccessService normalization and quota policy still make every call. */
export function commercialAccessFixture(now = Date.now(), user = BATTERY_USER) {
  const summary = {
    effectivePlanKey: 'premium',
    catalogVersion: '2026-09-family-v1',
    status: 'active',
    activeSources: [
      {
        kind: 'sponsored',
        sourceId: 'battery-probe-sponsored',
        planKey: 'premium',
        validUntil: null,
      },
    ],
    limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
    capabilities: { cloudSync: true, social: true, family: false },
    usage: { activeTrees: 0, visibleBranchesByTree: {} },
    revision: 1,
    nextRecomputeAt: null,
    offlineValidUntil: now + ACCESS_LEASE_MS,
  };
  return {
    identity: { key: 'auth.identity', user: { ...user }, cachedAt: now },
    cache: {
      key: `commercial.access:${user.userId}`,
      userId: user.userId,
      summary,
      cachedAt: now,
    },
  };
}

async function writeMetaRows(page, rows) {
  await page.evaluate(
    (fixtureRows) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('roadmap2u');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('meta', 'readwrite');
          for (const row of fixtureRows) tx.objectStore('meta').put(row);
          tx.oncomplete = () => {
            db.close();
            resolve(undefined);
          };
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        };
      }),
    rows,
  );
}

/** Initialize the real local schema, then add a deterministic identity-scoped
 * lease before the actual probe page boots. */
export async function provisionCommercialAccess(page) {
  // `/account` opens the shared IndexedDB schema through auth hydration but
  // deliberately never runs BootService. Using `/forest` here would seal the
  // harvest backfill against an empty forest before a probe can `?seed=demo`.
  await page.goto(`${BASE}/account`, { waitUntil: 'networkidle' });
  await page.locator('app-account').waitFor();
  const fixture = commercialAccessFixture();
  await writeMetaRows(page, [fixture.identity, fixture.cache]);
}

/** Add the commercial fixture to a context that intentionally had to boot
 * without it first (for example, the legacy-database migration probe). The
 * caller performs the next product navigation after its virgin-state checks. */
export async function provisionCommercialAccessForNextBoot(page) {
  await provisionCommercialAccess(page);
}

/** Give the identity that just signed in explicit local mock provider facts.
 * The ordinary API resolves access after reload; existing payment scenarios and
 * optional privacy consent remain untouched. */
export async function provisionSignedInAccess(page, { reload = false } = {}) {
  const user = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('roadmap2u');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('meta', 'readonly');
          const read = tx.objectStore('meta').get('auth.identity');
          read.onsuccess = () => {
            db.close();
            resolve(read.result?.user ?? null);
          };
          read.onerror = () => reject(read.error);
        };
      }),
  );
  if (!user) throw new Error('the signed-in probe identity was not persisted');
  if (new URL(page.url()).origin !== new URL(BASE).origin ||
      !['localhost', '127.0.0.1'].includes(new URL(BASE).hostname)) {
    throw new Error('local mock payment fixture only');
  }
  await page.evaluate((userId) => new Promise((resolve, reject) => {
    const token = localStorage.getItem('rm2u.mock.idToken');
    const identity = token ? JSON.parse(atob(token.split('.')[1])) : null;
    if (identity?.sub !== userId) return reject(new Error('signed-in mock identity required'));
    const open = indexedDB.open('roadmap2u-mockcloud');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['users', 'kv'], 'readwrite');
      let invalid;
      const readUser = tx.objectStore('users').get(userId);
      readUser.onsuccess = () => {
        const owner = readUser.result;
        if (owner?.accountType !== 'adult' || !owner.accountInstanceId ||
            owner.accountInstanceId !== identity.accountInstanceId) {
          invalid = new Error('current synthetic adult instance required');
          tx.abort();
          return;
        }
        const kv = tx.objectStore('kv');
        const suffix = userId + ':' + owner.accountInstanceId;
        const key = 'billing.individual.evidence:' + suffix;
        const evidence = kv.get(key);
        const pending = kv.get('billing.individual.pending:' + suffix);
        let remaining = 2;
        const preserveOrSeed = () => {
          if (--remaining || evidence.result !== undefined || pending.result !== undefined) return;
          kv.put({ key, value: {
            source: 'test_seed',
            accountId: userId,
            accountInstanceId: owner.accountInstanceId,
            invoiceId: 'invoice-battery-' + userId,
            interval: 'month',
            paidThrough: Date.now() + 24 * 60 * 60 * 1000,
            cancelAtPeriodEnd: false,
            revision: 1,
          } });
        };
        evidence.onsuccess = preserveOrSeed;
        pending.onsuccess = preserveOrSeed;
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => { db.close(); reject(invalid ?? tx.error); };
    };
  }), user.userId);
  if (reload) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('app-account .profile-card').waitFor();
  }
}

/** The auth UI turns guest immediately, before its queued provider cleanup and
 * IndexedDB delete finish. Cross-route probes must wait for the durable state,
 * otherwise the next document can legitimately hydrate the retiring user. */
export async function waitForAuthIdentityCleared(page, timeout = 5000) {
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open('roadmap2u');
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('meta')) {
            db.close();
            resolve(true);
            return;
          }
          const read = db.transaction('meta', 'readonly').objectStore('meta').get('auth.identity');
          read.onsuccess = () => {
            const cleared = !read.result?.user;
            db.close();
            resolve(cleared);
          };
          read.onerror = () => {
            db.close();
            resolve(false);
          };
        };
      }),
    undefined,
    { timeout },
  );
}

/** New isolated browser context + page, with the same commercial fixture used
 * by launchPage. Multi-context probes must come through here too. */
export async function newProbePage(
  browser,
  viewport = { width: 900, height: 800 },
  { commercialAccess = true, contextOptions = {} } = {},
) {
  const context = await browser.newContext({ viewport, ...contextOptions });
  if (commercialAccess) {
    const setupPage = await context.newPage();
    await provisionCommercialAccess(setupPage);
    await setupPage.close();
  }
  const page = await context.newPage();
  return { browser, context, page };
}

/** Standard browser + page. Desktop viewport unless overridden. */
export async function launchPage(viewport = { width: 900, height: 800 }, options = {}) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  return newProbePage(browser, viewport, options);
}

let failed = false;

/** Assertion printer — the battery greps `OK=false`, and the runner also
 *  checks the exit code, so both signals must stay honest. */
export function ok(label, cond, detail = '') {
  if (!cond) {
    failed = true;
    process.exitCode = 1;
  }
  console.log(`${label}${detail ? `: ${detail}` : ''} | OK=${!!cond}`);
  return !!cond;
}

export function anyFailed() {
  return failed;
}

/** Screen-space center of a canvas node (first `g.node` by default, or the
 *  nth). The world→screen math every canvas probe used to hand-copy. */
export async function nodeCenter(page, nth = 0) {
  return page.evaluate((index) => {
    const svg = document.querySelector('svg.canvas');
    const rect = svg.getBoundingClientRect();
    const t = (svg.querySelector(':scope > g').getAttribute('transform') ?? '').match(
      /translate\(([-\d.]+)\s+([-\d.]+)\)\s+scale\(([-\d.]+)\)/,
    );
    const [tx, ty, k] = t ? [Number(t[1]), Number(t[2]), Number(t[3])] : [0, 0, 1];
    const g = svg.querySelectorAll('g.node')[index];
    const nm = (g.getAttribute('transform') ?? '').match(/translate\(([-\d.]+)\s+([-\d.]+)\)/);
    return { x: rect.left + Number(nm[1]) * k + tx, y: rect.top + Number(nm[2]) * k + ty };
  }, nth);
}

/** Positive synthetic adult admission uses the rendered choices and normal API.
 * It never supplies optional cloud consent or promotes an unsupported minor. */
export async function admitSyntheticAdult(page) {
  if (!['localhost', '127.0.0.1'].includes(new URL(BASE).hostname)) throw new Error('local mock admission only');
  const profile = page.locator('app-account .profile-card');
  await page.locator('app-account .profile-card, app-account .privacy-panel').first().waitFor();
  if (await profile.count()) return;
  const form = page.locator('app-account .privacy-panel form');
  await form.locator('input[name="privacy-age"][value="adult"]').check();
  await form.locator('input[type="checkbox"]').check();
  await form.locator('button[type="submit"]').click();
  await profile.waitFor();
}

/** Mock-cloud sign-in from anywhere. Profile journeys include explicit adult
 * admission; an admission/error/challenge journey stops before that decision. */
export async function signInAs(page, username, password, { expect = 'profile', commercialAccess = true } = {}) {
  await page.goto(`${BASE}/account`, { waitUntil: 'networkidle' });
  if (await page.locator('h1', { hasText: 'Tu cuenta' }).count()) {
    await page.locator('button', { hasText: 'Cerrar sesión' }).click();
    await page.locator('h1', { hasText: 'Una llave' }).waitFor();
    await waitForAuthIdentityCleared(page);
  }
  await page.locator('button', { hasText: 'Ya tengo mi llave' }).click();
  await page.fill('.auth-form input[autocomplete="username"]', username);
  await page.fill('.auth-form input[type="password"]', password);
  await page.locator('.auth-form button[type="submit"]').click();
  if (expect === 'challenge') return;
  if (expect === 'error') return;
  if (expect === 'admission') {
    await page.locator('app-account .privacy-panel').waitFor();
    return;
  }
  await admitSyntheticAdult(page);
  if (commercialAccess) await provisionSignedInAccess(page, { reload: true });
}

/** Walk the two-screen check-in ritual via skip and land on /ahora. */
export async function skipRitual(page) {
  await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const welcome = page.locator('button', { hasText: 'Empezar' });
  if (await welcome.count()) {
    await welcome.click();
    await page.waitForTimeout(250);
  }
  await page.locator('.skip').click();
  await page.waitForURL('**/ahora**');
}
