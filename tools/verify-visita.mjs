// Co-gardening (0.0.50): the guardian enters a kid's forest, the whole tree
// toolkit works on the KID'S cloud copy, and not one byte lands in the
// visitor's local IndexedDB.
import { BASE, launchPage, signInAs } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 1280, height: 900 });

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
const foreign = [];
page.on('request', (request) => {
  const url = request.url();
  if (!url.startsWith(BASE) && !url.startsWith('data:')) foreign.push(url);
});

const idbAll = (db, store) =>
  page.evaluate(
    ([dbName, storeName]) =>
      new Promise((resolve) => {
        const open = indexedDB.open(dbName);
        open.onsuccess = () => {
          const conn = open.result;
          if (!conn.objectStoreNames.contains(storeName)) {
            conn.close();
            resolve([]);
            return;
          }
          const req = conn.transaction(storeName, 'readonly').objectStore(storeName).getAll();
          req.onsuccess = () => {
            conn.close();
            resolve(req.result ?? []);
          };
          req.onerror = () => resolve([]);
        };
        open.onerror = () => resolve([]);
      }),
    [db, store],
  );

// Sign in as the guardian with the same bounded lease as every mutation probe.
await signInAs(page, 'rocio', 'Bosque123');

const localNodesBefore = (await idbAll('roadmap2u', 'nodes')).length;
const localTreesBefore = (await idbAll('roadmap2u', 'trees')).length;

// A — familia → Nico's sheet → "Entrar a su bosque" → his garden's doorway.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.locator('.familia').waitFor();
await page.waitForTimeout(700);
await page.locator('.fam-open', { hasText: 'Nico' }).click();
await page.locator('button', { hasText: 'Entrar a su bosque' }).click();
await page.waitForURL('**/visit/**', { timeout: 6000 });
await page.locator('h1', { hasText: 'El jardín de Nico' }).waitFor({ timeout: 8000 });
const hintA = await page.locator('.visita-head .hint').textContent();
const cardA = (await page.locator('.visita-plot .visita-name').allTextContents()).map((t) => t.trim());
const okA = !!hintA?.includes('cuidando su jardín') && cardA.includes('Andar en bici sin rueditas');
console.log(`A doorway: hint-editable=${!!hintA?.includes('cuidando')} trees=[${cardA.join('|')}] | OK=${okA}`);

// B — inside his tree: full toolkit, visit chip on, session/archive hidden.
await page.locator('.visita-plot', { hasText: 'Andar en bici' }).click();
await page.locator('h1', { hasText: 'Andar en bici' }).waitFor({ timeout: 8000 });
await page.waitForTimeout(600);
const chipB = await page.locator('.visit-chip').textContent();
const focusHidden = (await page.locator('.tree-focus').count()) === 0;
const archiveHidden = (await page.locator('.tree-archive').count()) === 0;
const nodeCountB = await page.locator('app-tree-canvas svg text').count();
const okB = !!chipB?.includes('jardín de Nico') && focusHidden && archiveHidden;
console.log(`B inside: chip="${chipB?.trim()}" no-⏳=${focusHidden} no-🗃=${archiveHidden} labels=${nodeCountB} | OK=${okB}`);

// C — co-gardening write: plant a branch; it lands in HIS cloud copy.
await page.locator('header.bar button', { hasText: 'Plantar' }).click();
await page.locator('#root-title').fill('Timbre nuevo');
// Planting closes its own sheet since 0.0.110 — no «Listo» to click.
await page.locator('form.sheet button[type=submit]').click();
await page.waitForTimeout(900);
const cloudRecords = await idbAll('roadmap2u-mockcloud', 'records');
const planted = cloudRecords.find(
  (r) => r.ownerId === 'mock-child' && r.store === 'nodes' && r.record?.title === 'Timbre nuevo',
);
console.log(`C plant lands in HIS cloud: found=${!!planted} rev=${planted?.record?.rev} | OK=${!!planted}`);

// D — the branch survives a full reload (fresh getForest).
await page.reload({ waitUntil: 'networkidle' });
await page.locator('h1', { hasText: 'Andar en bici' }).waitFor({ timeout: 8000 });
await page.waitForTimeout(800);
await page.locator('.tree-outline-toggle').click();
await page.waitForTimeout(300);
const outlineTitles = await page.locator('.outline-rail').textContent();
const okD = !!outlineTitles?.includes('Timbre nuevo');
console.log(`D reload persistence: in-tablita=${okD} | OK=${okD}`);

// E — node sheet on a visit: ⏳ hidden, status edit writes through.
const timbreRow = page.locator('.outline-rail li.line', { hasText: 'Timbre nuevo' }).locator('button.row');
await timbreRow.click();
await page.waitForTimeout(250);
await timbreRow.click();
await page.waitForTimeout(400);
const sheetFocusBtn = await page.locator('app-node-detail button', { hasText: '⏳' }).count();
const bloomChip = page.locator('app-node-detail .status-row .chip:has(.status-dot.achieved)');
let statusWrote = false;
if (await bloomChip.count()) {
  await bloomChip.first().click();
  await page.waitForTimeout(900);
  const cloudAfter = await idbAll('roadmap2u-mockcloud', 'records');
  statusWrote =
    cloudAfter.find(
      (r) => r.ownerId === 'mock-child' && r.record?.title === 'Timbre nuevo',
    )?.record?.status === 'achieved';
}
console.log(`E node sheet: no-⏳=${sheetFocusBtn === 0} bloom-wrote-cloud=${statusWrote} | OK=${sheetFocusBtn === 0 && statusWrote}`);

// F — INTEGRITY: the visitor's local IndexedDB never gained a record.
const localNodesAfter = (await idbAll('roadmap2u', 'nodes')).length;
const localTreesAfter = (await idbAll('roadmap2u', 'trees')).length;
const okF = localNodesAfter === localNodesBefore && localTreesAfter === localTreesBefore;
console.log(
  `F local integrity: nodes ${localNodesBefore}→${localNodesAfter} trees ${localTreesBefore}→${localTreesAfter} | OK=${okF}`,
);

// G — the mutual direction (minor → guardian) is read-only by contract.
await page.goto(`${BASE}/account`, { waitUntil: 'networkidle' });
await page.locator('button', { hasText: 'Cerrar sesión' }).click();
await page.locator('h1', { hasText: 'Una llave' }).waitFor();
await page.locator('button', { hasText: 'Ya tengo mi llave' }).click();
await page.fill('.auth-form input[autocomplete="username"]', 'val');
await page.fill('.auth-form input[type="password"]', 'Bosque123');
await page.locator('.auth-form button[type=submit]').click();
await page.locator('h1', { hasText: 'Tu cuenta' }).waitFor({ timeout: 6000 });
await page.goto(`${BASE}/visit/mock-parent`, { waitUntil: 'networkidle' });
await page.locator('h1', { hasText: 'El jardín de Rocío' }).waitFor({ timeout: 8000 });
const hintG = await page.locator('.visita-head .hint').textContent();
const treesG = await page.locator('.visita-plot .visita-name').allTextContents();
const okG = !!hintG?.includes('de visita') && treesG.length === 2;
console.log(`G mutual view: hint-read-only=${!!hintG?.includes('de visita')} trees=${treesG.length} | OK=${okG}`);

console.log(`invariants: pageErrors=${pageErrors.length} foreign=${foreign.length} | OK=${pageErrors.length === 0 && foreign.length === 0}`);
if (pageErrors.length) console.log(pageErrors.join('\n'));

await browser.close();
console.log('visita done');
