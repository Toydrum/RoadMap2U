// «Tu bosque, a salvo» (0.0.77). A: the data card shows the honest no-copy
// line. B: the reminder switch persists. C: exporting stamps «Última copia».
// D: with a 31-day-old forest and no copy, ONE gentle toast offers the
// download after the boot delay (opt-out respected by B's round-trip).
// F (0.0.88): the envelope carries the harvests and import restores them.
import fs from 'node:fs/promises';
import { BASE, launchPage, ok, anyFailed } from './lib/harness.mjs';
const { browser, page } = await launchPage();

await page.goto(`${BASE}/settings?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

// A — no copy yet: the honest line.
const mark = (await page.locator('.backup-mark').textContent()).trim();
ok('A no-copy line', mark.includes('no tiene copia'), `"${mark}"`);

// B — the reminder switch flips and persists.
const remRow = page.locator('.row:has-text("Recordarme") .switch');
const before = await remRow.getAttribute('aria-checked');
await remRow.click();
await page.waitForTimeout(400);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const after = await page.locator('.row:has-text("Recordarme") .switch').getAttribute('aria-checked');
ok('B reminder persists', before === 'true' && after === 'false', `${before} -> ${after}`);
await page.locator('.row:has-text("Recordarme") .switch').click(); // back ON
await page.waitForTimeout(400);

// C — export stamps the last-copy mark.
const dl = page.waitForEvent('download');
await page.locator('button', { hasText: 'Exportar' }).click();
await dl;
await page.waitForTimeout(500);
const marked = (await page.locator('.backup-mark').textContent()).trim();
ok('C export stamps', marked.includes('Última copia'), `"${marked}"`);

// D — a 31-day-old forest with the stamp cleared earns ONE gentle offer.
await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const age = (store, fn) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const all = os.getAll();
    all.onsuccess = () => { fn(os, all.result); tx.oncomplete = () => res(); };
    all.onerror = rej;
  });
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  await age('trees', (os, rows) => rows.forEach((r) => { r.createdAt = old; os.put(r); }));
  await age('meta', (os, rows) => rows.forEach((r) => {
    if (r.key === 'settings') { r.value.lastBackupAt = null; r.value.lastBackupNudgeAt = old; os.put(r); }
  }));
  db.close();
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(9500); // BOOT_DELAY_MS + margin
const toastText = (await page.locator('.toast').textContent().catch(() => '')) ?? '';
ok('D gentle offer', toastText.includes('copia de tu bosque'), `"${toastText.trim().slice(0, 60)}"`);
await page.locator('.toast .btn-ghost').click().catch(() => {});

// E — 0.0.79 arm-first: with NO stamps at all (a synced-in or pre-0.0.77
// forest), the first evaluation arms the 30-day clock SILENTLY — no toast,
// stamp written.
await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  await new Promise((res, rej) => {
    const tx = db.transaction('meta', 'readwrite');
    const os = tx.objectStore('meta');
    const all = os.getAll();
    all.onsuccess = () => {
      for (const r of all.result) {
        if (r.key === 'settings') { r.value.lastBackupAt = null; r.value.lastBackupNudgeAt = null; os.put(r); }
      }
      tx.oncomplete = () => res();
    };
    all.onerror = rej;
  });
  db.close();
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(9500);
const quiet = ((await page.locator('.toast').textContent().catch(() => '')) ?? '').includes('copia de tu bosque');
const armed = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const row = await new Promise((res, rej) => {
    const rq = db.transaction('meta').objectStore('meta').get('settings');
    rq.onsuccess = () => res(rq.result);
    rq.onerror = rej;
  });
  db.close();
  return typeof row?.value?.lastBackupNudgeAt === 'number';
});
ok('E arm-first is silent', !quiet && armed, `toast=${quiet} armed=${armed}`);

// F — «la cosecha» rides the envelope: export carries the harvests (the
// demo backfill seeded them), a wipe loses them, import brings them home.
const dlF = page.waitForEvent('download');
await page.locator('button', { hasText: 'Exportar' }).click();
const fileF = await (await dlF).path();
const envelope = JSON.parse(await fs.readFile(fileF, 'utf8'));
const exportedHarvests = envelope.data?.harvests?.length ?? 0;
ok(
  'F1 envelope carries harvests + preserves',
  envelope.schemaVersion === 13 &&
    envelope.data?.trees?.every((tree) => typeof tree.heartId === 'string') &&
    exportedHarvests > 0 && Array.isArray(envelope.data?.preserves),
  `v=${envelope.schemaVersion} harvests=${exportedHarvests} preserves=${envelope.data?.preserves?.length}`,
);

// Exercise the permanent compatibility door, not only a same-version
// round-trip: schema 12 + pre-rename app id + no persisted heartId.
const legacyEnvelope = structuredClone(envelope);
legacyEnvelope.app = 'rodemap2u';
legacyEnvelope.schemaVersion = 12;
for (const tree of legacyEnvelope.data.trees) delete tree.heartId;

await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  await new Promise((res, rej) => {
    const tx = db.transaction('harvests', 'readwrite');
    tx.objectStore('harvests').clear();
    tx.oncomplete = () => res();
    tx.onerror = rej;
  });
  db.close();
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const importInput = page.locator('input[type="file"]');
const importButton = page.getByRole('button', { name: 'Importar una copia' });
const preview = page.getByRole('dialog', { name: 'Restaurar respaldo' });
const legacyFile = {
  name: 'rodemap2u-v12.json',
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify(legacyEnvelope)),
};
const readForest = () => page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const state = await new Promise((res, rej) => {
    const tx = db.transaction(['harvests', 'trees'], 'readonly');
    const harvests = tx.objectStore('harvests').getAll();
    const trees = tx.objectStore('trees').getAll();
    tx.oncomplete = () => res({
      harvests: harvests.result.length,
      hearts: trees.result.map((tree) => tree.heartId),
    });
    tx.onerror = rej;
  });
  db.close();
  return state;
});
const beforeRestore = await readForest();
const restoreDownloads = [];
page.on('download', (download) => restoreDownloads.push(download));

const fileChooser = page.waitForEvent('filechooser');
await importButton.click();
await (await fileChooser).setFiles(legacyFile);
await preview.waitFor({ state: 'visible' });
const previewText = await preview.textContent();
ok(
  'F2 preview shows date, counts and cloud scope without replacing the forest',
  /Fecha del respaldo/.test(previewText) &&
    /árbol/.test(previewText) &&
    /sincronización/.test(previewText) &&
    (await readForest()).harvests === beforeRestore.harvests &&
    restoreDownloads.length === 0,
  previewText.trim(),
);
await preview.getByRole('button', { name: 'Cancelar' }).click();
await preview.waitFor({ state: 'hidden' });
const cancelled = await readForest();
ok(
  'F3 cancelling leaves the forest untouched and returns focus to the picker',
  cancelled.harvests === beforeRestore.harvests &&
    restoreDownloads.length === 0 &&
    await importButton.evaluate((button) => document.activeElement === button),
);

await importInput.setInputFiles({
  name: 'invalid.json',
  mimeType: 'application/json',
  buffer: Buffer.from('{"data": null}'),
});
await page.getByText('Ese archivo no se pudo leer como respaldo.').waitFor({ state: 'visible' });
ok('F4 invalid files leave the forest untouched', (await readForest()).harvests === beforeRestore.harvests && restoreDownloads.length === 0);

await importInput.setInputFiles(legacyFile);
await preview.waitFor({ state: 'visible' });
const preImportDownload = page.waitForEvent('download');
await preview.getByRole('button', { name: 'Restaurar bosque' }).click();
const safetyFile = await preImportDownload;
const safetyCopy = JSON.parse(await fs.readFile(await safetyFile.path(), 'utf8'));
ok(
  'F5 confirmation downloads the pre-import forest',
  safetyFile.suggestedFilename().startsWith('roadmap2u-pre-import-') &&
    safetyCopy.data.harvests.length === beforeRestore.harvests,
);
await page.getByText('Tu bosque llegó completo.').waitFor({ state: 'visible' });
const restored = await readForest();
ok(
  'F6 legacy v12 import migrates hearts + restores pantry',
  restored.harvests === exportedHarvests && restored.hearts.every((heartId) => typeof heartId === 'string'),
  `restored=${restored.harvests}/${exportedHarvests} hearts=${restored.hearts.join(',')}`,
);

console.log(`SUMMARY backup: ${anyFailed() ? 'OK=false' : 'ALL OK'}`);
await browser.close();
