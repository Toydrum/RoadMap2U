import { BASE, launchPage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 900, height: 800 });

const plots = () => page.locator('.plot').count();
const undoBtn = page.locator('.toast button', { hasText: 'Deshacer' });

// 1 — forest tree archive → undo → tree back in the meadow
await page.goto(`${BASE}/forest?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const before = await plots();
// A FRUITLESS tree keeps the plain confirm (fruited trees open the despedida
// ritual now — 0.0.95). «Idea nueva» has no fruit in the demo. Hover first to
// reveal the 🗃 button (raised z-index + opacity), like verify-forest-archive.
await page.hover('.plot:has-text("Idea nueva")');
await page.waitForTimeout(300);
await page.click('.plot:has-text("Idea nueva") .plot-archive');
await page.locator('.confirm button', { hasText: 'Que descanse' }).click();
await page.waitForTimeout(400);
const during = await plots();
await undoBtn.click();
await page.waitForTimeout(400);
const after = await plots();
console.log(`1 tree-undo: ${before} -> ${during} -> ${after} | OK=${before === after && during === before - 1}`);

// 2 — node subtree archive → undo → glyphs restored
await page.goto(`${BASE}/tree/demo-guitar?seed=demo&node=demo-g-first-song`, { waitUntil: 'networkidle' });
await page.waitForSelector('.sheet');
const glyphs = () => page.locator('g.node').count();
const g0 = await glyphs();
await page.locator('.sheet button', { hasText: 'Guardar en el archivo' }).click();
await page.locator('.confirm button', { hasText: 'Que descanse' }).click();
await page.waitForTimeout(400);
const g1 = await glyphs();
await undoBtn.click();
await page.waitForTimeout(400);
const g2 = await glyphs();
console.log(`2 node-undo: ${g0} -> ${g1} -> ${g2} | OK=${g0 === g2 && g1 < g0}`);

// 3 — trail footprint let-go → undo → row back
await page.goto(`${BASE}/trail?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const fps = () => page.locator('.footprint:not(.word-card)').count();
const f0 = await fps();
await page.locator('.footprint:not(.word-card) .x').first().click();
await page.locator('button', { hasText: 'Dejarla ir' }).click();
await page.waitForTimeout(300);
const f1 = await fps();
await undoBtn.click();
await page.waitForTimeout(300);
const f2 = await fps();
console.log(`3 footprint-undo: ${f0} -> ${f1} -> ${f2} | OK=${f0 === f2 && f1 === f0 - 1}`);

// 4 — note release → undo → exact text back
const noteText = (await page.locator('.word-card .note').first().textContent()).trim();
await page.locator('.word-card .x').first().click();
await page.locator('button', { hasText: 'Dejarla ir' }).click();
await page.waitForTimeout(300);
await undoBtn.click();
await page.waitForTimeout(300);
const restored = (await page.locator('.word-card .note').first().textContent()).trim();
console.log(`4 note-undo exact text: ${JSON.stringify(noteText)} == ${JSON.stringify(restored)} | OK=${noteText === restored}`);

// 5 — an undo toast expires on its own; the commit stands
await page.goto(`${BASE}/forest?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const p0 = await plots();
await page.hover('.plot:has-text("Idea nueva")'); // fruitless → plain confirm
await page.waitForTimeout(300);
await page.click('.plot:has-text("Idea nueva") .plot-archive');
await page.locator('.confirm button', { hasText: 'Que descanse' }).click();
await page.waitForTimeout(400);
await page.waitForTimeout(8600);
const toastGone = (await page.locator('.toast').count()) === 0;
const pEnd = await plots();
console.log(`5 expiry: toast-gone=${toastGone} plots=${p0}->${pEnd} | OK=${toastGone && pEnd === p0 - 1}`);

await browser.close();
