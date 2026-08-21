// The account ritual (0.0.48): mock sign-in/up, the temp-password challenge,
// session hydration with zero network, and the sacred rule — auth never
// touches local forest data.
import { chromium } from 'playwright-core';
import { waitForAuthIdentityCleared } from './lib/harness.mjs';
const BASE = 'http://localhost:' + (process.env.RM_PORT ?? '8826');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
const foreignRequests = [];
page.on('request', (request) => {
  const url = request.url();
  if (!url.startsWith(BASE) && !url.startsWith('data:')) foreignRequests.push(url);
});

const idbGet = (store, key) =>
  page.evaluate(
    ([s, k]) =>
      new Promise((resolve, reject) => {
        // No explicit version — read at whatever the app created (a pinned
        // version breaks on every DB_VERSION bump; it did on v2/0.0.88).
        const open = indexedDB.open('roadmap2u');
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
    [store, key ?? null],
  );

const stage = (title) => page.locator('h1', { hasText: title });

async function signIn(username, password) {
  await page.fill('.auth-form input[autocomplete="username"]', username);
  await page.fill('.auth-form input[type="password"]', password);
  await page.locator('.auth-form button[type=submit]').click();
}

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
await stage('Tu cuenta').waitFor({ timeout: 5000 });
const whoA = await page.locator('.who-name').textContent();
const treesAfterA = (await idbGet('trees')).length;
const identityA = await idbGet('meta', 'auth.identity');
const okA = whoA?.trim() === 'Rocío' && treesAfterA === treesBefore && !!identityA?.user;
console.log(
  `A sign-in: who=${whoA?.trim()} trees ${treesBefore}→${treesAfterA} identity=${!!identityA?.user} | OK=${okA}`,
);

// G1 — Settings card reflects the signed-in identity.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const chipText = await page.locator('.account-chip').textContent();
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
await stage('Te enviamos un código').waitFor({ timeout: 5000 });
await page.fill('.code-input', '123456');
await page.locator('.auth-form button[type=submit]').click();
await stage('Tu cuenta').waitFor({ timeout: 8000 });
const whoB = await page.locator('.who-name').textContent();
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
await stage('Tu cuenta').waitFor({ timeout: 8000 });
const whoD = await page.locator('.who-name').textContent();
const roleD = await page.locator('.who-role').textContent();
await page.locator('button', { hasText: 'Cerrar sesión' }).click();
await stage('Una llave para tu bosque').waitFor();
await waitForAuthIdentityCleared(page);
await page.locator('button', { hasText: 'Ya tengo mi llave' }).click();
await signIn('nico', 'Brotes2026');
await stage('Tu cuenta').waitFor({ timeout: 8000 });
const straightIn = await page.locator('.who-name').textContent();
const okD =
  whoD?.trim() === 'Nico' && !!roleD?.includes('joven') && straightIn?.trim() === 'Nico';
console.log(
  `D temp→new password: who=${whoD?.trim()} role=${roleD?.trim()} re-entry=${straightIn?.trim()} | OK=${okD}`,
);

// Whole-run invariants: no unhandled page errors, no network beyond localhost.
console.log(`invariants: pageErrors=${pageErrors.length} foreign=${foreignRequests.length} | OK=${pageErrors.length === 0 && foreignRequests.length === 0}`);
if (pageErrors.length) console.log(pageErrors.join('\n'));
if (foreignRequests.length) console.log(foreignRequests.join('\n'));

await browser.close();
console.log('auth done');
