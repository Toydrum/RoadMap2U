// «El almanaque» (0.0.81). A: the demo's yesterday-dated branch shows its
// capullo + 🍂 on ITS OWN day (owner's golden-rule variant) and the 🍂
// banner lives in Hoy. B: a sendero renders as today's stone path — tapping
// «siguiente» blooms it and Deshacer restores. C: the day page deep-links
// into the branch's tree. D: today wears the green ring; month nav offers
// «Volver a hoy». E: the forest-header 🌾 door navigates.
// (Sendero exclusion from month marks is covered by almanac.spec.ts.)
import { BASE, launchPage, newProbePage, ok } from './lib/harness.mjs';

const { browser, page } = await launchPage();

await page.goto(`${BASE}/almanaque?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);

// A — yesterday's unresolved fecha amable stays on its own cell (at the
// default 900px width that's a chip wearing the 🍂 suffix) + Hoy banner.
const banner = await page.locator('.alm-review').count();
const leafCells = (await page.locator('.alm-cell .chip-leaf').count()) + (await page.locator('.alm-cell .leaf-mark').count());
ok('A passed date stays on its day + banner in Hoy', banner === 1 && leafCells >= 1, `banner=${banner} leafCells=${leafCells}`);

// B — build a sendero via IDB (parent → steps+repeatsDaily), reload: the
// caminito appears; «siguiente» blooms with Deshacer.
const senderoTitleB = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const title = await new Promise((res, rej) => {
    const tx = db.transaction('nodes', 'readwrite');
    const os = tx.objectStore('nodes');
    const all = os.getAll();
    all.onsuccess = () => {
      const rows = all.result.filter((r) => !r.deletedAt && !r.archivedAt);
      const byParent = new Map();
      for (const r of rows) {
        if (!r.parentId) continue;
        byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r]);
      }
      // Skip parents that are already rituals — the 0.0.106 demo seed ships
      // its own caminito; this probe builds a sendero of its OWN.
      const parent = rows.find(
        (r) =>
          (byParent.get(r.id) ?? []).length >= 2 &&
          (r.status === 'seed' || r.status === 'growing') &&
          !r.repeatsDaily && r.repeats == null,
      );
      if (!parent) throw new Error('no live parent with 2+ children in demo');
      parent.flow = 'steps';
      parent.repeatsDaily = true;
      os.put(parent);
      for (const child of byParent.get(parent.id)) {
        child.status = 'seed';
        child.achievedAt = null;
        os.put(child);
      }
      tx.oncomplete = () => res(parent.title);
    };
    all.onerror = rej;
  });
  db.close();
  return title;
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(900);

// Scope to OUR caminito — the demo seed walks its own since 0.0.106.
const ownCaminito = page.locator('.caminito', { hasText: senderoTitleB });
const stones = await ownCaminito.locator('.alm-stone').count();
const nextStone = ownCaminito.locator('.alm-stone.next');
const hadNext = (await nextStone.count()) === 1;
await nextStone.click();
await page.waitForTimeout(500);
const toastText = (await page.locator('.toast').textContent().catch(() => '')) ?? '';
const bloomedNow = await ownCaminito.locator('.alm-stone.bloomed').count();
ok('B caminito blooms from the stone', stones >= 2 && hadNext && toastText.includes('floreció') && bloomedNow >= 1, `stones=${stones} toast="${toastText.trim().slice(0, 40)}"`);

await page.locator('.toast button', { hasText: 'Deshacer' }).click();
await page.waitForTimeout(500);
const nextBack = (await ownCaminito.locator('.alm-stone.next').count()) === 1;
const bloomedAfterUndo = await ownCaminito.locator('.alm-stone.bloomed').count();
ok('B2 Deshacer restores the stone', nextBack && bloomedAfterUndo === 0, `next=${nextBack} bloomed=${bloomedAfterUndo}`);

// C — the day page: open yesterday's cell (it holds the passed capullo —
// chip-leaf in wide mode) and deep-link into the branch's tree.
await page.locator('.alm-cell:has(.chip-leaf), .alm-cell:has(.leaf-mark)').first().click();
await page.waitForTimeout(500);
const sheetUp = await page.locator('.alm-day-panel').count();
const noBackdrop = (await page.locator('.sheet-backdrop').count()) === 0;
const passedLine = await page.locator('.alm-day-panel .passed-line').count();
await page.locator('.alm-day-panel .day-row').first().click();
await page.waitForTimeout(900);
const onTree = page.url().includes('/tree/');
const branchSheet = await page.locator('.sheet').count();
ok('C inline day panel deep-links to the tree', sheetUp === 1 && noBackdrop && passedLine >= 1 && onTree && branchSheet >= 1, `url=${page.url().slice(-30)}`);

// D — today ring + «Volver a hoy» after month nav.
await page.goto(`${BASE}/almanaque`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const todayCell = await page.locator('.alm-cell.alm-today').count();
await page.locator('.month-nav .btn-ghost').first().click();
await page.waitForTimeout(300);
const todayGone = (await page.locator('.alm-cell.alm-today').count()) === 0;
await page.locator('.alm-back-today').click();
await page.waitForTimeout(300);
const todayBack = (await page.locator('.alm-cell.alm-today').count()) === 1;
ok('D today ring + Volver a hoy', todayCell === 1 && todayGone && todayBack, `cell=${todayCell}`);

// E2 — a branch dated exactly TODAY gets its own «Hoy quiere florecer» row
// (0.0.82: it lives in no other list — 🍂 is strictly past, upcoming is
// strictly future).
await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await new Promise((res, rej) => {
    const tx = db.transaction('nodes', 'readwrite');
    const os = tx.objectStore('nodes');
    const all = os.getAll();
    all.onsuccess = () => {
      // Root branches only — section B turned one demo parent into a
      // sendero, and its steps are (correctly) excluded from todayDated.
      const row = all.result.find(
        (r) => !r.deletedAt && !r.archivedAt && !r.parentId && !r.repeatsDaily && (r.status === 'seed' || r.status === 'growing') && !r.targetDate,
      );
      if (!row) throw new Error('no dateless live ROOT branch in demo');
      row.targetDate = todayKey;
      os.put(row);
      tx.oncomplete = () => res();
    };
    all.onerror = rej;
  });
  db.close();
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(900);
const todayRows = await page.locator('.alm-today-dated .upcoming-row').count();
ok('E2 today-dated branch gets its Hoy row', todayRows >= 1, `rows=${todayRows}`);

// E — the wheat TAB (0.0.86): 5 tabs, none wraps at 360px, and the middle
// one navigates to the almanaque and lights up.
await page.setViewportSize({ width: 360, height: 640 });
await page.goto(`${BASE}/forest`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const tabs = await page.locator('.tabbar .tab').count();
const rows = await page.evaluate(() =>
  new Set([...document.querySelectorAll('.tabbar .tab')].map((t) => Math.round(t.getBoundingClientRect().top))).size,
);
await page.locator('.tabbar a[href*="almanaque"]').click();
await page.waitForTimeout(500);
const active = await page.locator('.tabbar a[href*="almanaque"].active').count();
ok('E wheat tab: 5 tabs, one row, navigates + lights', tabs === 5 && rows === 1 && page.url().includes('/almanaque') && active === 1, `tabs=${tabs} rows=${rows}`);

// F — responsive information law (0.0.87): wide viewports render titled
// accent chips; narrow viewports keep the 0.0.85 glyph svg (zero chips).
await page.setViewportSize({ width: 1024, height: 800 });
await page.goto(`${BASE}/almanaque`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const chipsWide = await page.locator('.alm-chip').count();
const chipTitle = ((await page.locator('.alm-chip .chip-title').first().textContent().catch(() => '')) ?? '').trim();
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
const chipsNarrow = await page.locator('.alm-chip').count();
const glyphsNarrow = await page.locator('.alm-cell .glyphs').count();
ok('F chips wide / glyphs narrow', chipsWide >= 1 && chipTitle.length > 0 && chipsNarrow === 0 && glyphsNarrow >= 1, `wide=${chipsWide} "${chipTitle.slice(0, 20)}" narrow=${chipsNarrow}/${glyphsNarrow}`);

// G — disclosure behavior: second tap closes; Escape closes + refocuses the
// cell; aria-expanded flips.
const markedCell = page.locator('.alm-cell .leaf-mark').first().locator('..');
await markedCell.click();
await page.waitForTimeout(400);
const expandedOn = (await markedCell.getAttribute('aria-expanded')) === 'true';
await markedCell.click();
await page.waitForTimeout(400);
const closedByTap = (await page.locator('.alm-day-panel').count()) === 0;
const expandedOff = (await markedCell.getAttribute('aria-expanded')) === 'false';
await markedCell.click();
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const closedByEsc = (await page.locator('.alm-day-panel').count()) === 0;
const refocused = await page.evaluate(() => document.activeElement?.classList.contains('alm-cell'));
ok('G disclosure: toggle + Escape + aria', expandedOn && closedByTap && expandedOff && closedByEsc && !!refocused, `esc=${closedByEsc} focus=${refocused}`);

// H — «Las espirales de hoy» (0.0.104): the shelf always renders with its
// ghost stone; sowing via the ghost creates a ritual leaf that appears as a
// loose stone; blooming it carries Deshacer; a tomorrow-weekday ritual rests
// with the gentle line (words, never countdowns).
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const ghostAlways = await page.locator('.spiral-add').count();
await page.locator('.spiral-add').click();
await page.waitForTimeout(400);
await page.fill('#stone-title', 'Regar las plantas');
const treePicked = await page.locator('.stone-tree-chip.selected').count(); // default pre-picked
await page.locator('.stone-create').click();
await page.waitForTimeout(600);
const sownStone = await page.locator('.spiral-stone.next', { hasText: 'Regar las plantas' }).count();
ok('H ghost stone sows a ritual leaf onto the strip', ghostAlways === 1 && treePicked === 1 && sownStone === 1, `ghost=${ghostAlways} picked=${treePicked} stone=${sownStone}`);

await page.locator('.spiral-stone.next', { hasText: 'Regar las plantas' }).click();
await page.waitForTimeout(500);
const stoneToast = (await page.locator('.toast').textContent().catch(() => '')) ?? '';
const stoneBloomed = await page.locator('.spiral-stone.bloomed', { hasText: 'Regar las plantas' }).count();
await page.locator('.toast button', { hasText: 'Deshacer' }).click();
await page.waitForTimeout(400);
const stoneBack = await page.locator('.spiral-stone.next', { hasText: 'Regar las plantas' }).count();
ok('H2 a piedrita blooms with Deshacer and comes back', stoneToast.includes('floreció') && stoneBloomed === 1 && stoneBack === 1, `bloomed=${stoneBloomed} back=${stoneBack}`);

// H3 — a tomorrow-only ritual rests today: not on the strip, named in the line.
await page.evaluate(async () => {
  const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const tomorrowWd = WD[(new Date().getDay() + 1) % 7];
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  await new Promise((res) => {
    const os = db.transaction('nodes', 'readwrite').objectStore('nodes');
    const all = os.getAll();
    all.onsuccess = () => {
      const base = all.result.find((n) => n.title === 'Regar las plantas');
      os.put({ ...base, id: 'va-h3-rest', title: 'Inventario semanal', repeats: [tomorrowWd], repeatsDaily: true, status: 'seed', achievedAt: null, updatedAt: Date.now() });
      res(null);
    };
  });
  db.close();
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(900);
const restLine = ((await page.locator('.resting-line').textContent().catch(() => '')) ?? '').trim();
const restingOnStrip = await page.locator('.spiral-stone', { hasText: 'Inventario semanal' }).count();
ok('H3 an off-day ritual rests with the gentle line, off the strip', restLine.includes('Inventario semanal') && restingOnStrip === 0, `line="${restLine.slice(0, 48)}" onStrip=${restingOnStrip}`);

async function readPlant(title) {
  return page.evaluate(async (name) => {
    const open = indexedDB.open('roadmap2u');
    const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
    const tx = db.transaction(['nodes', 'harvests'], 'readonly');
    const read = (store) => new Promise((res, rej) => {
      const request = tx.objectStore(store).getAll();
      request.onsuccess = () => res(request.result);
      request.onerror = rej;
    });
    const [nodes, fruits] = await Promise.all([read('nodes'), read('harvests')]);
    db.close();
    const node = nodes.find((row) => row.title === name && !row.deletedAt);
    const heart = nodes.filter((row) => row.treeId === node.treeId && !row.parentId && !row.archivedAt && !row.deletedAt)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
    return { node, heartId: heart.id, fruitCount: fruits.filter((fruit) => fruit.nodeId === node.id && !fruit.deletedAt).length };
  }, title);
}

const plantedSpiral = await readPlant('Regar las plantas');
ok('H4 planting a spiral uses the chosen tree heart',
  plantedSpiral.node.parentId === plantedSpiral.heartId && plantedSpiral.node.repeats === 'daily');

const tomorrow = await page.evaluate(() => {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((v) => String(v).padStart(2, '0')).join('-');
});
await page.goto(`${BASE}/almanaque?day=${tomorrow}`, { waitUntil: 'networkidle' });
const preview = page.locator('.day-spirals .day-row', { hasText: 'Inventario semanal' });
await preview.waitFor();
ok('H5 weekday spirals appear inside a future date, outside its grid marks',
  await page.locator(`.alm-cell[data-date="${tomorrow}"]`, { hasText: 'Inventario semanal' }).count() === 0);

await page.locator('.day-plant').click();
const dateChoice = page.locator('.branch-date input');
const dateIsOptional = !(await dateChoice.isChecked());
await dateChoice.check();
await page.fill('#stone-title', 'Una rama desde el almanaque');
const createBranch = page.locator('.stone-create');
if (await createBranch.isDisabled()) {
  const choices = await page.locator('.stone-tree-chip').all();
  for (const choice of choices) {
    await choice.click();
    await page.waitForFunction((id) => document.querySelector('.stone-tree-chip.selected')?.textContent === id, await choice.textContent());
    if (await createBranch.isEnabled()) break;
  }
}
await createBranch.click();
await page.locator('.stone-sheet').waitFor({ state: 'detached' });
const plantedBranch = await readPlant('Una rama desde el almanaque');
ok('H6 a branch uses the heart and keeps the explicitly chosen gentle date',
  dateIsOptional && plantedBranch.node.parentId === plantedBranch.heartId &&
  plantedBranch.node.targetDate === tomorrow && !plantedBranch.node.repeats);

await preview.click();
const achieved = page.locator('.status-row .chip.pick', { hasText: 'Florecida' });
await page.locator('app-node-detail .hint', { hasText: '«Inventario semanal» descansa hoy' }).waitFor();
ok('H7 an off-day spiral also rests in the branch sheet', await achieved.isDisabled());

await page.goto(`${BASE}/tree/${plantedSpiral.node.treeId}?node=${plantedSpiral.node.id}`, { waitUntil: 'networkidle' });
await achieved.click();
const undo = page.locator('.toast button', { hasText: 'Deshacer' });
await undo.waitFor();
const fromTree = await readPlant('Regar las plantas');
ok('H8 completing the spiral in the tree writes the same occurrence and makes no fruit',
  fromTree.node.status === 'achieved' && fromTree.fruitCount === plantedSpiral.fruitCount);
await undo.click();
await page.locator('.status-row .chip.pick.selected', { hasText: 'Semilla' }).waitFor();
await achieved.click();
await undo.waitFor();
await page.goto(`${BASE}/almanaque`, { waitUntil: 'networkidle' });
const completedSpiral = page.locator('.spiral-stone.bloomed', { hasText: 'Regar las plantas' });
await completedSpiral.waitFor();
ok('H9 the Almanaque reads the completion made in the tree', await completedSpiral.count() === 1);

// I — a mobile tap opens a viewport-bound sheet even in an empty forest,
// with a direct way to create the required tree.
const { context: mobileContext, page: mobile } = await newProbePage(
  browser, { width: 390, height: 700 }, { contextOptions: { isMobile: true, hasTouch: true } },
);
await mobile.goto(`${BASE}/almanaque`, { waitUntil: 'networkidle' });
await mobile.locator('.spiral-add').tap();
const mobileSheet = mobile.locator('.stone-sheet');
await mobileSheet.waitFor();
const mobileBackdrop = await mobileSheet.evaluate((sheet) => {
  const backdrop = sheet.parentElement;
  const { top, bottom } = sheet.getBoundingClientRect();
  return getComputedStyle(backdrop).position === 'fixed' && top >= 0 && bottom <= innerHeight;
});
ok('I the spiral sheet stays in the mobile viewport', mobileBackdrop);
await mobile.keyboard.press('Escape');
await mobileSheet.waitFor({ state: 'hidden' });
const pageUnlocked = await mobile.evaluate(() => document.body.style.overflow !== 'hidden');
ok('I2 closing the spiral sheet restores page scrolling', pageUnlocked);
await mobile.locator('.spiral-add').tap();
await mobileSheet.waitFor();
const createTree = mobileSheet.locator('a[href="/forest?plant=1"]');
const canCreateTree = await createTree.count() === 1;
ok('I3 an empty forest offers to plant the first tree', canCreateTree);
if (canCreateTree) {
  await createTree.tap();
  await mobile.locator('app-forest .sheet').waitFor();
}
await mobileContext.close();

console.log('almanaque done');
await browser.close();
