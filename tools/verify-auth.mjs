// The account ritual (0.0.48): mock sign-in/up, the temp-password challenge,
// session hydration with zero network, and the sacred rule — auth never
// touches local forest data.
import assert from 'node:assert/strict';
import { BASE, admitSyntheticAdult, isolateIndividualBillingFixture, launchPage, newProbePage, provisionSignedInAccess, signInAs, waitForAuthIdentityCleared } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 1280, height: 800 }, { commercialAccess: false });

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
const foreignRequests = [];
page.on('request', (request) => {
  const url = request.url();
  if (!url.startsWith(BASE) && !url.startsWith('data:')) foreignRequests.push(url);
});

const idbGet = (store, key, database = 'roadmap2u') =>
  page.evaluate(
    ([database, s, k]) =>
      new Promise((resolve, reject) => {
        // No explicit version — read at whatever the app created (a pinned
        // version breaks on every DB_VERSION bump; it did on v2/0.0.88).
        const open = indexedDB.open(database);
        open.onsuccess = () => {
          const db = open.result;
          const os = db.transaction(s, 'readonly').objectStore(s);
          const req = k ? os.get(k) : os.getAll();
          req.onsuccess = () => {
            db.close();
            resolve(req.result ?? null);
          };
          req.onerror = () => reject(req.error);
        };
        open.onerror = () => reject(open.error);
      }),
    [database, store, key ?? null],
  );

const stage = (title) => page.locator('h1', { hasText: title });

async function signIn(username, password) {
  await page.fill('.auth-form input[autocomplete="username"]', username);
  await page.fill('.auth-form input[type="password"]', password);
  await page.locator('.auth-form button[type=submit]').click();
}

try {
// Seed the demo forest (no check-in diversion: demo settings mark a fresh check-in).
await page.goto(`${BASE}/forest?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const treesBefore = (await idbGet('trees')).length;

// A — sign in as the demo parent; local forest untouched, identity cached.
await page.goto(`${BASE}/account`, { waitUntil: 'networkidle' });
await stage('Una llave para tu bosque').waitFor({ timeout: 5000 });
await page.locator('button', { hasText: 'Ya tengo mi llave' }).click();
await stage('Entrar a mi cuenta').waitFor();
await signIn('rocio', 'Bosque123');
await page.locator('app-account .privacy-panel').waitFor();
assert.equal(await page.locator('.profile-card').count(), 0, 'sign-in alone does not complete adult admission');
await admitSyntheticAdult(page);
const whoA = await page.locator('.who-name').textContent();
const treesAfterA = (await idbGet('trees')).length;
const identityA = await idbGet('meta', 'auth.identity');
const adultA = await idbGet('users', identityA.user.userId, 'roadmap2u-mockcloud');
const privacyKeyA = 'privacy:' + encodeURIComponent(adultA.userId) + ':' + encodeURIComponent(adultA.accountInstanceId);
const consentA = (await idbGet('kv', privacyKeyA, 'roadmap2u-mockcloud'))?.value;
assert.equal(consentA?.adultDeclared, true);
assert.equal(consentA?.cloudConsent, 'absent', 'the admission transaction does not include optional cloud consent');
const okA = whoA?.trim() === 'Rocío' && treesAfterA === treesBefore && !!identityA?.user;
console.log(
  `A sign-in: who=${whoA?.trim()} trees ${treesBefore}→${treesAfterA} identity=${!!identityA?.user} | OK=${okA}`,
);

// G1 — Settings card reflects the signed-in identity.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const chipText = await page.locator('.account-chip').textContent();
assert.equal(await page.locator('.nube button', { hasText: 'Conectar mi bosque' }).isDisabled(), true, 'adult admission does not grant optional cloud consent');
console.log(`G1 settings card signed-in: "${chipText?.trim().slice(0, 24)}" | OK=${chipText?.includes('Rocío')}`);

// E — a fresh boot hydrates the session from meta with ZERO network.
const foreignBeforeReload = foreignRequests.length;
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const chipAfterReload = await page.locator('.account-chip').textContent();
await page.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const tabsVisible = await page.locator('nav a', { hasText: 'bosque' }).count();
const okE =
  !!chipAfterReload?.includes('Rocío') &&
  foreignRequests.length === foreignBeforeReload &&
  tabsVisible > 0;
console.log(
  `E hydrate on reload: chip=${!!chipAfterReload?.includes('Rocío')} foreign-requests=${foreignRequests.length - foreignBeforeReload} tabs=${tabsVisible} | OK=${okE}`,
);

// F — sign out clears the identity only; the forest stays.
await page.goto(`${BASE}/account`, { waitUntil: 'networkidle' });
await stage('Tu cuenta').waitFor();
await page.locator('button', { hasText: 'Cerrar sesión' }).click();
await stage('Una llave para tu bosque').waitFor({ timeout: 5000 });
await waitForAuthIdentityCleared(page);
const identityF = await idbGet('meta', 'auth.identity');
const treesAfterF = (await idbGet('trees')).length;
const okF = !identityF?.user && treesAfterF === treesBefore;
console.log(`F sign-out: identity-user=${identityF?.user ?? 'null'} trees=${treesAfterF} | OK=${okF}`);

// G2 — Settings card back to the guest invitation.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const guestCta = await page.locator('a', { hasText: 'Abrir mi cuenta' }).count();
console.log(`G2 settings card guest: cta=${guestCta} | OK=${guestCta === 1}`);

// C — wrong password renders calm copy, no unhandled rejection, still guest.
await page.goto(`${BASE}/account`, { waitUntil: 'networkidle' });
await page.locator('button', { hasText: 'Ya tengo mi llave' }).click();
await stage('Entrar a mi cuenta').waitFor();
await signIn('rocio', 'Incorrecta9');
await page.locator('.error-line').waitFor({ timeout: 5000 });
const errText = await page.locator('.error-line').textContent();
const identityC = await idbGet('meta', 'auth.identity');
const okC = !!errText?.includes('no se encontraron juntos') && !identityC?.user;
console.log(`C wrong password: copy=${!!errText} guest=${!identityC?.user} | OK=${okC}`);

// B — sign-up with the always-123456 code lands signed in.
await page.locator('button', { hasText: 'Volver' }).click();
await stage('Una llave para tu bosque').waitFor();
await page.locator('button', { hasText: 'Quiero una llave nueva' }).click();
await stage('Crear mi cuenta').waitFor();
await page.fill('.auth-form input[autocomplete="username"]', 'brisa');
// displayName severed from signup (0.0.108) — the field is gone.
await page.fill('.auth-form input[type="email"]', 'brisa@demo.bosque');
const pwFields = page.locator('.auth-form input[type="password"]');
await pwFields.nth(0).fill('Bosque123');
await pwFields.nth(1).fill('Bosque123');
await page.locator('.auth-form button[type=submit]').click();
await page.locator('.error-line').waitFor();
assert.equal(await idbGet('users', 'u-brisa', 'roadmap2u-mockcloud'), null, 'signup without an age decision creates no account');
await page.locator('.auth-form .age-choice input[type=radio]').first().check();
await page.locator('.auth-form button[type=submit]').click();
assert.equal(await idbGet('users', 'u-brisa', 'roadmap2u-mockcloud'), null, 'signup without terms acceptance creates no account');
await page.locator('.auth-form input[type=checkbox]').check();
await page.locator('.auth-form button[type=submit]').click();
await stage('Te enviamos un código').waitFor({ timeout: 5000 });
await page.fill('.code-input', '123456');
await page.locator('.auth-form button[type=submit]').click();
await page.locator('.profile-card').waitFor({ timeout: 8000 });
const whoB = await page.locator('.who-name').textContent();
const adultB = await idbGet('users', 'u-brisa', 'roadmap2u-mockcloud');
const consentB = (await idbGet('kv', 'privacy:' + encodeURIComponent(adultB.userId) + ':' + encodeURIComponent(adultB.accountInstanceId), 'roadmap2u-mockcloud'))?.value;
assert.equal(consentB?.adultDeclared, true);
assert.equal(consentB?.cloudConsent, 'absent');
// 0.0.108: no displayName at signup — the profile falls back to the username.
console.log(`B sign-up + code: who=${whoB?.trim()} | OK=${whoB?.trim() === 'brisa'}`);
await page.locator('button', { hasText: 'Cerrar sesión' }).click();
await stage('Una llave para tu bosque').waitFor();
await waitForAuthIdentityCleared(page);

// D — the child's first login: temp password → own password → clean re-entry.
await page.locator('button', { hasText: 'Ya tengo mi llave' }).click();
await stage('Entrar a mi cuenta').waitFor();
await signIn('nico', 'Semilla1!');
await stage('Estrena tu contraseña').waitFor({ timeout: 5000 });
const newPw = page.locator('.auth-form input[type="password"]');
await newPw.nth(0).fill('Brotes2026');
await newPw.nth(1).fill('Brotes2026');
await page.locator('.auth-form button[type=submit]').click();
await page.locator('app-account .privacy-panel').waitFor({ timeout: 8000 });
const minorD = await idbGet('meta', 'auth.identity');
assert.equal(minorD?.user?.accountType, 'minor');
assert.equal(await page.locator('.profile-card').count(), 0);
assert.equal(await page.locator('.privacy-panel input[value=adult]').count(), 0, 'an unsupported minor cannot self-declare as an adult');
await page.locator('button', { hasText: 'Cerrar sesión' }).click();
await stage('Una llave para tu bosque').waitFor();
await waitForAuthIdentityCleared(page);
await page.locator('button', { hasText: 'Ya tengo mi llave' }).click();
await signIn('nico', 'Brotes2026');
await page.locator('app-account .privacy-panel').waitFor({ timeout: 8000 });
const minorReentry = await idbGet('meta', 'auth.identity');
assert.equal(minorReentry?.user?.userId, minorD?.user?.userId);
await page.goto(`${BASE}/account/subscription`, { waitUntil: 'networkidle' });
await page.locator('app-subscription-page').waitFor();
assert.equal(await page.getByRole('button', { name: /continúo al pago/ }).count(), 0);
console.log(`D temp→new password: re-entry retains the minor identity and adult Checkout stays unavailable | OK=true`);

// H — the shared positive-login harness uses real mock provider facts and leaves
// the first token read intact, so the privacy panel can initialize on reload.
const probe = await newProbePage(browser, { width: 1280, height: 800 });
probe.page.on('pageerror', (error) => pageErrors.push(String(error)));
probe.page.on('request', (request) => {
  if (!request.url().startsWith(BASE) && !request.url().startsWith('data:')) foreignRequests.push(request.url());
});
try {
  await signInAs(probe.page, 'rocio', 'Bosque123');
  await probe.page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
  await probe.page.locator('.privacy-panel').getByRole('button', { name: 'Conectar mi bosque', exact: true }).waitFor();
  const provider = await probe.page.evaluate(async () => {
    const read = (database, store, key) => new Promise((resolve, reject) => {
      const open = indexedDB.open(database);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const request = db.transaction(store, 'readonly').objectStore(store).get(key);
        request.onsuccess = () => { db.close(); resolve(request.result); };
        request.onerror = () => { db.close(); reject(request.error); };
      };
    });
    const user = await read('roadmap2u-mockcloud', 'users', 'mock-parent');
    const key = 'billing.individual.evidence:' + user.userId + ':' + user.accountInstanceId;
    return {
      user,
      key,
      evidence: (await read('roadmap2u-mockcloud', 'kv', key))?.value,
      privacy: (await read('roadmap2u-mockcloud', 'kv', 'privacy:' + encodeURIComponent(user.userId) + ':' + encodeURIComponent(user.accountInstanceId)))?.value,
      access: (await read('roadmap2u', 'meta', 'commercial.access:' + user.userId))?.summary,
      tokenPresent: !!localStorage.getItem('rm2u.mock.idToken'),
    };
  });
  assert.equal(provider.tokenPresent, true);
  assert.equal(provider.evidence?.accountId, provider.user.userId);
  assert.equal(provider.evidence?.accountInstanceId, provider.user.accountInstanceId);
  assert.equal(provider.access?.activeSources.length, 1);
  assert.equal(provider.access.activeSources[0].scope, 'individual');
  assert.equal(provider.access.activeSources[0].sourceId, 'mock:' + provider.evidence.invoiceId);
  assert.ok(provider.access.offlineValidUntil <= provider.evidence.paidThrough);
  assert.equal(provider.privacy?.cloudConsent, 'absent');
  console.log('H shared login: provider-backed paid access, privacy initialized, optional cloud consent absent | OK=true');

  // Re-entering a probe must preserve an explicit review fixture.
  const review = { ...provider.evidence, review: true, revision: provider.evidence.revision + 1 };
  await probe.page.evaluate(({ key, review }) => new Promise((resolve, reject) => {
    const open = indexedDB.open('roadmap2u-mockcloud');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key, value: review });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { key: provider.key, review });
  await probe.page.goto(BASE + '/account', { waitUntil: 'networkidle' });
  await provisionSignedInAccess(probe.page, { reload: true });
  const afterReview = await probe.page.evaluate((key) => new Promise((resolve, reject) => {
    const open = indexedDB.open('roadmap2u-mockcloud');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      request.onsuccess = () => { db.close(); resolve(request.result?.value); };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }), provider.key);
  assert.deepEqual(afterReview, review);
  // This tests an individual review response, without the separate legacy
  // family seed producing a malformed fallback instead of canonical Free.
  await isolateIndividualBillingFixture(probe.page);
  await probe.page.goto(BASE + '/account/subscription', { waitUntil: 'networkidle' });
  await probe.page.locator('.billing-access').filter({ hasText: 'Free' }).waitFor();
  console.log('I shared login preserves explicit payment review and normal Free access | OK=true');
} finally {
  await probe.context.close();
}

// Whole-run invariants: no unhandled page errors, no network beyond localhost.
console.log(`invariants: pageErrors=${pageErrors.length} foreign=${foreignRequests.length} | OK=${pageErrors.length === 0 && foreignRequests.length === 0}`);
if (pageErrors.length) console.log(pageErrors.join('\n'));
if (foreignRequests.length) console.log(foreignRequests.join('\n'));

} finally { await browser.close(); }
console.log('auth done');
