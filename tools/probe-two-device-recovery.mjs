import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { BASE, isolateIndividualBillingFixture, launchPage, newProbePage, signInAs } from './lib/harness.mjs';
import { createProbeBuildServer, ensureProbeServer } from './lib/probe-server.mjs';

const origin = new URL(BASE).origin;
const ownerId = 'mock-parent';
const localDb = 'roadmap2u';
const cloudDb = 'roadmap2u-mockcloud';
const treeName = 'Bosque de recuperación CI';
const branchTitle = 'Rama escrita sin conexión';
const buildRoot = process.env.RM_BUILD_ROOT ?? 'dist/roadmap2u/browser';
const server = createProbeBuildServer({ base: BASE, buildRoot });
const closeServer = await ensureProbeServer({ base: BASE, server });
assert.ok(closeServer, 'The recovery fixture requires its own loopback server');

const externalRequests = [];
const pageErrors = [];
function guardRequest(route) {
  const url = new URL(route.request().url());
  if (url.origin === origin && !url.pathname.startsWith('/v1/')) return route.continue();
  externalRequests.push(`${url.origin}${url.pathname}`);
  return route.abort();
}
const options = {
  commercialAccess: false,
  contextOptions: { serviceWorkers: 'block' },
  prepareContext: (context) => context.route('**/*', guardRequest),
};

function observe(page) {
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return page;
}

// Read the app's existing databases. Only the simulated server is writable
// from this probe; each device's real IndexedDB is populated through the UI.
function database(page, name, stores, changes) {
  return page.evaluate(({ name, stores, changes }) => new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onupgradeneeded = () => open.transaction.abort();
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(stores, changes ? 'readwrite' : 'readonly');
      const result = {};
      for (const storeName of stores) {
        const store = tx.objectStore(storeName);
        if (changes) {
          for (const key of changes[storeName]?.remove ?? []) store.delete(key);
          for (const row of changes[storeName]?.put ?? []) store.put(row);
        } else {
          const request = store.getAll();
          request.onsuccess = () => { result[storeName] = request.result; };
        }
      }
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { name, stores, changes });
}

const readLocal = (page) => database(page, localDb, ['trees', 'nodes']);
const readCloud = (page) => database(page, cloudDb, ['users', 'records', 'kv']);
const writeCloud = (page, changes) => database(page, cloudDb, Object.keys(changes), changes);
const open = (page, path) => page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
const paidKey = (owner) => `billing.individual.evidence:${owner.userId}:${owner.accountInstanceId}`;
const privacyKey = (owner) => `privacy:${encodeURIComponent(owner.userId)}:${encodeURIComponent(owner.accountInstanceId)}`;

async function waitFor(read, condition, message) {
  const deadline = Date.now() + 15_000;
  do {
    const value = await read();
    if (condition(value)) return value;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(message);
}

async function waitForAppCache(page) {
  const response = await page.request.get(`${BASE}/ngsw.json`);
  assert.ok(response.ok(), 'The PWA manifest must be available');
  const manifest = await response.json();
  const assets = manifest.assetGroups.find((group) => group.name === 'app')?.urls;
  assert.ok(assets?.includes('/index.html'), 'The prefetched app group must contain the shell');
  await waitFor(
    () => page.evaluate(async (urls) => {
      if (!navigator.serviceWorker.controller) return false;
      for (const key of (await caches.keys()).filter((name) => name.includes(':assets:app:'))) {
        const cache = await caches.open(key);
        const paths = new Set((await cache.keys()).map((request) => new URL(request.url).pathname));
        if (urls.every((url) => paths.has(url))) return true;
      }
      return false;
    }, assets),
    (ready) => ready,
    'The active service worker did not finish caching the app group',
  );
}

// The mock server uses a separate IndexedDB per browser context. Mirror only
// this synthetic owner's server rows, never the device's forest or session.
async function mirrorCloud(from, to, owner) {
  const source = await readCloud(from);
  const target = await readCloud(to);
  const kv = source.kv.filter(({ key }) =>
    ['changeSeq', paidKey(owner), privacyKey(owner)].includes(key));
  assert.equal(kv.length, 3, 'The synthetic account needs its own consent and payment evidence');
  await writeCloud(to, {
    users: { put: [owner] },
    records: {
      remove: target.records.filter((row) => row.ownerId === ownerId).map((row) => row.key),
      put: source.records.filter((row) => row.ownerId === ownerId),
    },
    kv: { put: kv },
  });
}

async function connect(page, { authorize = false } = {}) {
  const cloud = page.locator('.nube');
  const connectDevice = cloud.getByRole('button', { name: /Conectar mi bosque/ });
  if (authorize) {
    await connectDevice.waitFor();
    assert.equal(await connectDevice.isDisabled(), true, 'Paid access cannot bypass consent');
    await page.locator('app-privacy-panel')
      .getByRole('button', { name: 'Conectar mi bosque', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const choice = dialog.getByRole('checkbox');
    assert.equal(await choice.isChecked(), false, 'Cloud consent starts unselected');
    await choice.check();
    await dialog.getByRole('button', { name: 'Autorizar y conectar mi bosque', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  } else {
    await connectDevice.click();
  }
  await cloud.getByText(/Conectado a esta cuenta/).waitFor();
}

let browser;
try {
  const first = await launchPage({ width: 1200, height: 900 }, options);
  browser = first.browser;
  const a = observe(first.page);
  await signInAs(a, 'rocio', 'Bosque123', { commercialAccess: false });
  await isolateIndividualBillingFixture(a);
  const seeded = await readCloud(a);
  const owner = seeded.users.find((row) => row.userId === ownerId);
  assert.ok(owner?.accountInstanceId && owner.accountType === 'adult', 'Expected the built-in mock adult');
  const paid = {
    source: 'test_seed',
    accountId: ownerId,
    accountInstanceId: owner.accountInstanceId,
    invoiceId: 'invoice-browser-recovery-fixture',
    interval: 'month',
    paidThrough: Date.now() + 3_600_000,
    cancelAtPeriodEnd: false,
    revision: 2,
  };
  // Start with one tree so the exported copy remains within the Free limit.
  await writeCloud(a, {
    records: { remove: seeded.records.filter((row) => row.ownerId === ownerId).map((row) => row.key) },
    kv: { put: [{ key: paidKey(owner), value: paid }] },
  });
  await open(a, '/account/subscription');
  await a.locator('.billing-access').filter({ hasText: 'Premium' }).waitFor();
  await open(a, '/settings');
  await connect(a, { authorize: true });

  await a.locator('nav a[href="/forest"]').click();
  await a.getByRole('button', { name: /Plantar (?:mi primer|un) árbol/ }).first().click();
  await a.locator('#tree-name').fill(treeName);
  await a.locator('form.sheet button[type="submit"]').click();
  const saved = await waitFor(
    () => readCloud(a),
    ({ records }) => records.some((row) => row.ownerId === ownerId && row.store === 'trees' && row.record.name === treeName),
    'Device A did not upload its new tree',
  );
  const tree = saved.records.find((row) => row.ownerId === ownerId && row.record.name === treeName).record;
  assert.ok(saved.records.some((row) => row.ownerId === ownerId && row.store === 'nodes' && row.record.id === tree.heartId),
    'The uploaded tree must include its root node');
  console.log('Device A uploads a tree and its root only after explicit consent.');

  const second = await newProbePage(browser, { width: 1200, height: 900 }, {
    ...options, contextOptions: { serviceWorkers: 'allow' },
  });
  let b = observe(second.page);
  // The guest landing leaves the mock database lazy. A rejected local lookup
  // initializes its real schema without signing in or creating an identity.
  await signInAs(b, 'recovery_schema_probe', 'SyntheticProbe123!', { expect: 'error', commercialAccess: false });
  await b.locator('app-account .error-line').waitFor();
  await mirrorCloud(a, b, owner);
  await signInAs(b, 'rocio', 'Bosque123', { commercialAccess: false });
  await isolateIndividualBillingFixture(b);
  assert.equal((await readLocal(b)).trees.length, 0, 'Device B starts with no forest or device link');
  await open(b, '/settings');
  await connect(b);
  const pulled = await waitFor(
    () => readLocal(b),
    ({ trees, nodes }) => trees.some((row) => row.id === tree.id) && nodes.some((row) => row.id === tree.heartId),
    'Device B did not pull the tree and its root from the simulated server',
  );
  assert.equal(pulled.trees.length, 1);
  console.log('Device B recovers the same forest after explicitly connecting the new device.');

  await b.locator('nav a[href="/forest"]').click();
  await b.locator('.plot-link', { hasText: treeName }).click();
  await b.getByRole('button', { name: /Plantar aquí/ }).waitFor();
  const treePath = new URL(b.url()).pathname;
  await waitForAppCache(b);
  await second.context.setOffline(true);
  await b.waitForFunction(() => !navigator.onLine);
  // Let the worker handle the new navigation directly while Chromium is offline.
  await second.context.unroute('**/*', guardRequest);
  await b.getByRole('button', { name: /Plantar aquí/ }).click();
  await b.locator('#root-title').fill(branchTitle);
  await b.locator('form.sheet button[type="submit"]').click();
  await b.locator('nav a[href="/settings"]').click();
  await b.locator('.nube').getByText(/Sin conexión/).waitFor();
  const branch = (await readLocal(b)).nodes.find((row) => row.title === branchTitle);
  assert.equal(branch?.parentId, tree.heartId, 'Offline edit is saved locally under the original tree');
  assert.equal((await readCloud(b)).records.some((row) => row.record.id === branch.id), false);

  await b.close();
  b = observe(await second.context.newPage());
  const reopened = await b.goto(`${BASE}${treePath}`, { waitUntil: 'domcontentloaded' });
  assert.ok(reopened?.ok() && reopened.fromServiceWorker(), 'The worker must reopen the tree offline');
  await b.getByRole('treeitem', { name: new RegExp('^' + branchTitle) }).waitFor();
  assert.ok((await readLocal(b)).nodes.some((row) => row.id === branch.id), 'The exact branch survives reopening');
  await second.context.route('**/*', guardRequest);
  await second.context.setOffline(false);
  await waitFor(
    () => readCloud(b),
    ({ records }) => records.some((row) => row.ownerId === ownerId && row.record.id === branch.id),
    'Reconnection did not upload the pending branch',
  );
  await mirrorCloud(b, a, owner);
  await open(a, '/settings');
  await a.locator('.nube').getByRole('button', { name: /Sincronizar ahora/ }).click();
  const roundTrip = await waitFor(
    () => readLocal(a),
    ({ nodes }) => nodes.some((row) => row.id === branch.id),
    'Device A did not pull the edit made offline on device B',
  );
  assert.equal(roundTrip.nodes.filter((row) => row.id === branch.id).length, 1);
  console.log('An offline edit uploads on reconnection and appears once on the other device.');

  const versionOf = (node) => node && {
    id: node.id, parentId: node.parentId, title: node.title, rev: node.rev, updatedAt: node.updatedAt,
  };
  const localBranch = async (page) => {
    const { nodes } = await readLocal(page);
    return versionOf(nodes.find((node) => node.id === branch.id));
  };
  const cloudBranch = async (page) => {
    const { records } = await readCloud(page);
    return versionOf(records.find((row) =>
      row.ownerId === ownerId && row.store === 'nodes' && row.record.id === branch.id)?.record);
  };
  const baseVersion = versionOf(branch);
  assert.deepEqual(await localBranch(a), baseVersion);
  assert.deepEqual(await localBranch(b), baseVersion);
  assert.deepEqual(await cloudBranch(b), baseVersion);

  // Edit the same base revision from two real UI sessions. B changes first
  // while offline, so equal revs must resolve by updatedAt when B reconnects.
  const editPath = treePath + '?node=' + encodeURIComponent(branch.id);
  await Promise.all([open(a, editPath), open(b, editPath)]);
  const rename = async (page, title) => {
    const input = page.getByRole('dialog', { name: branchTitle, exact: true }).locator('#nd-title');
    await input.fill(title);
    await input.blur();
  };
  const titleB = 'Rama renombrada sin conexión en B';
  const titleA = 'Rama renombrada después en A';
  await second.context.setOffline(true);
  await b.waitForFunction(() => !navigator.onLine);
  assert.equal(await a.evaluate(() => navigator.onLine), true);
  await rename(b, titleB);
  const pendingB = await waitFor(
    () => localBranch(b),
    (version) => version?.title === titleB,
    'Device B did not persist its pending rename locally',
  );
  assert.equal(pendingB.rev, baseVersion.rev + 1);
  assert.deepEqual(await cloudBranch(b), baseVersion, 'Offline B must leave the cloud revision unchanged');

  await waitFor(() => Date.now(), (now) => now > pendingB.updatedAt, 'The edits need distinct timestamps');
  await rename(a, titleA);
  const winner = await waitFor(
    () => cloudBranch(a),
    (version) => version?.title === titleA,
    'Online device A did not upload its rename',
  );
  assert.equal(winner.rev, pendingB.rev, 'Both edits must increment the same base revision once');
  assert.ok(winner.updatedAt > pendingB.updatedAt, 'A must win the equal-revision timestamp comparison');
  await mirrorCloud(a, b, owner);
  assert.deepEqual(await cloudBranch(b), winner);
  assert.deepEqual(await localBranch(b), pendingB, 'B must keep its pending revision while offline');

  await second.context.setOffline(false);
  const converged = await waitFor(
    () => localBranch(b),
    (version) => version?.title === titleA,
    'Device B did not adopt the winning cloud revision after reconnecting',
  );
  assert.deepEqual(converged, winner);
  assert.deepEqual(await localBranch(a), winner);
  assert.deepEqual(await cloudBranch(b), winner, 'The stale rename must not overwrite the cloud winner');
  await b.getByRole('dialog', { name: titleA, exact: true }).waitFor();
  console.log('Two isolated devices edit the same branch and converge on the later timestamp at equal revision.');

  await writeCloud(b, {
    kv: { put: [{
      key: paidKey(owner),
      value: { ...paid, paidThrough: Date.now() - 1_000, terminal: true, revision: 3 },
    }] },
  });
  await open(b, '/account/subscription');
  await b.locator('.billing-access').filter({ hasText: 'Free' }).waitFor();
  await b.getByText(/Mi periodo pagado terminó/).waitFor();
  assert.deepEqual(await localBranch(b), winner, 'Expiry must preserve the winning local edit');
  await open(b, '/settings');
  const downloaded = b.waitForEvent('download');
  await b.getByRole('button', { name: /Exportar/ }).click();
  const backup = await readFile(await (await downloaded).path());
  const envelope = JSON.parse(backup.toString('utf8'));
  assert.deepEqual(envelope.data.trees.map((row) => row.id), [tree.id]);
  assert.deepEqual(versionOf(envelope.data.nodes.find((row) => row.id === branch.id)), winner);
  assert.equal(envelope.data.meta, undefined, 'A backup must not export device identity or link metadata');
  await second.context.close();

  const replacement = await newProbePage(browser, { width: 1200, height: 900 }, options);
  const restored = observe(replacement.page);
  await open(restored, '/settings');
  assert.equal((await readLocal(restored)).trees.length, 0);
  await restored.locator('input[type="file"]').setInputFiles({
    name: 'synthetic-recovery.json', mimeType: 'application/json', buffer: backup,
  });
  const preview = restored.getByRole('dialog', { name: 'Restaurar respaldo' });
  await preview.waitFor();
  assert.equal((await readLocal(restored)).trees.length, 0, 'File selection must not restore data');
  await preview.getByRole('button', { name: 'Restaurar bosque' }).click();
  await waitFor(
    () => readLocal(restored),
    ({ trees, nodes }) => trees.some((row) => row.id === tree.id) && nodes.some((row) => row.id === branch.id),
    'A fresh browser could not restore the exported copy within the Free limit',
  );
  assert.deepEqual(await localBranch(restored), winner);
  console.log('Expired Premium leaves local data exportable; a clean browser can restore the copy.');
  assert.deepEqual(externalRequests, [], 'The browser fixture must never call a live API');
  assert.deepEqual(pageErrors, [], 'Unhandled errors during the recovery journey');
} finally {
  await browser?.close();
  await closeServer();
}
