// «Conectar mi bosque» (0.0.53): explicit opt-in connect, pull of the
// account's cloud forest, debounced push of local writes, idempotent boots,
// and the mismatch guard — all on the mock cloud, zero network.
import assert from 'node:assert/strict';
import { BASE, launchPage, signInAs as signInPage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 1280, height: 900 }, { commercialAccess: false });

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
const foreign = [];
page.on('request', (request) => {
  const url = request.url();
  if (!url.startsWith(BASE) && !url.startsWith('data:')) foreign.push(url);
});

const idbRead = (db, store, key) =>
  page.evaluate(
    ([dbName, storeName, recordKey]) =>
      new Promise((resolve) => {
        const open = indexedDB.open(dbName);
        open.onsuccess = () => {
          const conn = open.result;
          if (!conn.objectStoreNames.contains(storeName)) {
            conn.close();
            resolve([]);
            return;
          }
          const objectStore = conn.transaction(storeName, 'readonly').objectStore(storeName);
          const req = recordKey === null ? objectStore.getAll() : objectStore.get(recordKey);
          req.onsuccess = () => {
            conn.close();
            resolve(req.result ?? []);
          };
          req.onerror = () => resolve([]);
        };
        open.onerror = () => resolve([]);
      }),
    [db, store, key ?? null],
  );

const idbAll = (db, store) => idbRead(db, store);
const cloudPrivacy = (user) => idbRead('roadmap2u-mockcloud', 'kv', 'privacy:' + encodeURIComponent(user.userId) + ':' + encodeURIComponent(user.accountInstanceId));

// Explicit paid-provider facts in this local disposable mock only. The normal
// API must return the individual source; no token read or access guard is changed.
async function paidFixture(ownerId) {
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(BASE).hostname));
  return page.evaluate((ownerId) => new Promise((resolve, reject) => {
    const open = indexedDB.open('roadmap2u-mockcloud');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['users', 'kv'], 'readwrite');
      const read = tx.objectStore('users').get(ownerId);
      let result;
      read.onsuccess = () => {
        const user = read.result;
        if (user?.accountType !== 'adult' || !user.accountInstanceId) return tx.abort();
        const paid = { source: 'test_seed', accountId: user.userId, accountInstanceId: user.accountInstanceId, invoiceId: 'invoice-sync-' + user.userId, interval: 'month', paidThrough: Date.now() + 3600000, cancelAtPeriodEnd: false, revision: 2 };
        tx.objectStore('kv').put({ key: 'billing.individual.evidence:' + user.userId + ':' + user.accountInstanceId, value: paid });
        result = { user, paid };
      };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('invalid synthetic adult')); };
    };
  }), ownerId);
}
async function signInAs(username, password, ownerId) {
  await signInPage(page, username, password, { commercialAccess: false });
  const fixture = await paidFixture(ownerId);
  await page.goto(BASE + '/account/subscription', { waitUntil: 'networkidle' });
  await page.locator('.billing-access').filter({ hasText: 'Premium' }).waitFor();
  const access = (await idbRead('roadmap2u', 'meta', 'commercial.access:' + ownerId))?.summary;
  assert.equal(access?.activeSources.length, 1);
  assert.equal(access.activeSources[0].scope, 'individual');
  assert.equal(access.activeSources[0].sourceId, 'mock:' + fixture.paid.invoiceId);
  assert.ok(access.offlineValidUntil <= fixture.paid.paidThrough);
  assert.equal((await cloudPrivacy(fixture.user))?.value.cloudConsent, 'absent', 'paid access does not grant optional cloud consent');
  return fixture.user;
}
async function authorizeCloud(user) {
  await page.locator('.privacy-panel').getByRole('button', { name: 'Conectar mi bosque', exact: true }).click();
  const sheet = page.locator('app-confirm-sheet');
  assert.equal(await sheet.locator('.btn-primary').isDisabled(), true, 'cloud needs a separate explicit choice');
  await sheet.locator('input[type=checkbox]').check();
  await sheet.locator('.btn-primary').click();
  await sheet.waitFor({ state: 'detached' });
  assert.equal((await cloudPrivacy(user))?.value.cloudConsent, 'granted');
}

try {

// A — connect on a "fresh device": the account's seeded cloud forest PULLS in.
const parent = await signInAs('rocio', 'Bosque123', 'mock-parent');
const localBefore = (await idbAll('roadmap2u', 'trees')).length;
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.locator('.nube').waitFor();
assert.equal(await page.locator('.nube button', { hasText: 'Conectar mi bosque' }).isDisabled(), true, 'cloud is still closed after adult admission');
await authorizeCloud(parent);
await page.locator('.nube .label', { hasText: 'Conectado' }).waitFor({ timeout: 15000 });
await page.waitForTimeout(400);
const localAfter = await idbAll('roadmap2u', 'trees');
const pulledNames = localAfter.map((t) => t.name);
const okA =
  localBefore === 0 &&
  pulledNames.includes('Huerto en el balcón') &&
  pulledNames.includes('Leer más seguido');
console.log(`A connect pulls the cloud forest: ${localBefore}→[${pulledNames.join('|')}] | OK=${okA}`);

// B — the meadow shows the pulled forest.
await page.locator('nav a', { hasText: 'bosque' }).click();
await page.waitForTimeout(700);
const plots = await page.locator('.plot .plot-name, .plot').allTextContents();
const okB = plots.some((t) => t.includes('Huerto en el balcón'));
console.log(`B pulled forest in the meadow: | OK=${okB}`);

// C — a local write pushes (debounce ~1.5s + latency) into MY cloud records.
await page.locator('button', { hasText: 'Plantar un árbol' }).first().click();
await page.fill('#tree-name', 'Sincronizado');
await page.locator('form.sheet button[type=submit]').click();
await page.waitForTimeout(4000); // debounce + push + pull round
const cloud = await idbAll('roadmap2u-mockcloud', 'records');
const pushed = cloud.find(
  (r) => r.ownerId === 'mock-parent' && r.store === 'trees' && r.record?.name === 'Sincronizado',
);
console.log(`C local write pushes to cloud: found=${!!pushed} | OK=${!!pushed}`);

// D — reload: still connected, boot pull runs, nothing duplicates (LWW).
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(4500); // boot pull delay + round
const treesAfterReload = await idbAll('roadmap2u', 'trees');
const names = treesAfterReload.map((t) => t.name).sort();
const unique = new Set(names).size === names.length;
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.locator('.nube').waitFor();
const stillConnected = await page.locator('.nube .label', { hasText: 'Conectado' }).count();
const okD = unique && treesAfterReload.length === 3 && stillConnected === 1;
console.log(`D idempotent boot: trees=${treesAfterReload.length} unique=${unique} connected=${stillConnected} | OK=${okD}`);

// E — an edit round-trips: archive the pulled tree, cloud copy gains the rev.
await page.locator('nav a', { hasText: 'bosque' }).click();
await page.waitForTimeout(600);
await page.locator('.plot', { hasText: 'Sincronizado' }).hover();
await page.locator('.plot:has-text("Sincronizado") .plot-archive').click();
await page.locator('.confirm button', { hasText: 'Que descanse' }).click();
await page.waitForTimeout(4000);
const cloudAfterEdit = await idbAll('roadmap2u-mockcloud', 'records');
const archived = cloudAfterEdit.find(
  (r) => r.ownerId === 'mock-parent' && r.record?.name === 'Sincronizado',
);
const okE = !!archived?.record?.archivedAt && (archived?.record?.rev ?? 0) >= 2;
console.log(`E edit round-trips: archivedAt=${!!archived?.record?.archivedAt} rev=${archived?.record?.rev} | OK=${okE}`);

// F — the second paid adult makes their own cloud choice; the old link stays mismatched.
const other = await signInAs('ambar', 'Bosque123', 'mock-friend');
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.locator('.nube').waitFor();
await authorizeCloud(other);
await page.locator('.nube-mismatch').waitFor();
const mismatch = await page.locator('.nube-mismatch').count();
const cloudBaseline = (await idbAll('roadmap2u-mockcloud', 'records')).filter(
  (r) => r.ownerId === 'mock-friend',
).length;
// A local write as Ámbar must NOT push while mismatched.
await page.locator('nav a', { hasText: 'bosque' }).click();
await page.waitForTimeout(500);
await page.locator('button', { hasText: 'Plantar un árbol' }).first().click();
await page.fill('#tree-name', 'No debería subir');
await page.locator('form.sheet button[type=submit]').click();
await page.waitForTimeout(4000);
const ambarCloud = (await idbAll('roadmap2u-mockcloud', 'records')).filter(
  (r) => r.ownerId === 'mock-friend',
).length;
const okF = mismatch === 1 && ambarCloud === cloudBaseline;
console.log(`F mismatch guard: banner=${mismatch} ambar-cloud ${cloudBaseline}→${ambarCloud} | OK=${okF}`);

// G — disconnect releases the link; local forest untouched.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.locator('.nube button', { hasText: 'Desconectar' }).click();
await page.waitForTimeout(600);
const offCta = await page.locator('.nube button', { hasText: 'Conectar mi bosque' }).count();
const localFinal = (await idbAll('roadmap2u', 'trees')).length;
const okG = offCta === 1 && localFinal === 4;
console.log(`G disconnect: cta-back=${offCta} local-trees=${localFinal} | OK=${okG}`);

console.log(`invariants: pageErrors=${pageErrors.length} foreign=${foreign.length} | OK=${pageErrors.length === 0 && foreign.length === 0}`);
if (pageErrors.length) console.log(pageErrors.join('\n'));

} finally { await browser.close(); }
console.log('sync done');
