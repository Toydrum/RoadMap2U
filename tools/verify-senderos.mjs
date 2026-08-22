// «Senderos» (0.0.72) → «rituales» (0.0.103): repeating paths AND leaves.
// A: the repeats toggle is ALWAYS visible (unburied) + the cadence picker
// appears when on + persists. B: steps bloomed on a PREVIOUS day quietly
// reset to seed at boot (backdated via IndexedDB — the sweep's real trigger
// is the reactive today()); steps bloomed TODAY are never touched. C: a
// non-repeating path never resets. D: a ritual LEAF (lone branch with a
// cadence) resets ITSELF and never mints fruit. E: weekday cadences —
// today's weekday resets a stale bloom; tomorrow's weekday does not.
import { BASE, launchPage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 900, height: 800 });

await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.locator('button', { hasText: 'Empezar' }).click();
await page.waitForTimeout(250);
await page.locator('.skip').click();
await page.waitForURL('**/ahora**');
await page.locator('nav a', { hasText: 'bosque' }).click();
await page.waitForTimeout(400);
await page.locator('button:has-text("Plantar mi primer árbol")').first().click();
await page.fill('#tree-name', 'Mañanas');
await page.locator('form.sheet button[type=submit]').click();
await page.waitForTimeout(400);
const href = await page.evaluate(() => document.querySelector('.plot')?.getAttribute('href'));
await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
// «El corazón del árbol» (0.0.112): the heart is not a ritual — the sendero
// lives on a RAMITA now. Plant it and open its sheet by deep link.
await page.locator('button', { hasText: 'Plantar aquí' }).click();
await page.waitForTimeout(350);
await page.fill('#root-title', 'Rutina');
await page.locator('form.sheet button[type=submit]').click();
await page.waitForTimeout(600);
const rutinaId = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const rows = await new Promise((res, rej) => {
    const rq = db.transaction('nodes', 'readonly').objectStore('nodes').getAll();
    rq.onsuccess = () => res(rq.result);
    rq.onerror = rej;
  });
  db.close();
  return rows.find((n) => n.title === 'Rutina')?.id ?? null;
});
const openRutina = async () => {
  await page.goto(`${BASE}${href}?node=${rutinaId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
};
await openRutina();
for (const t of ['Despertar', 'Desayunar', 'Vestirme']) {
  const input = page.locator('.add-step input');
  await input.fill(t);
  await input.press('Enter');
  await page.waitForTimeout(200);
}
// A — the repeats toggle shows WITHOUT preconditions (0.0.103 unburied);
// checking it reveals the cadence picker (daily preselected).
const repeatsAlways = await page.locator('.repeats-toggle').count();
await page.locator('.order-toggle input').check();
await page.waitForTimeout(300);
await page.locator('.repeats-toggle input').check();
await page.waitForTimeout(300);
const pickerShown = await page.locator('app-cadence-picker').count();
const dailySelected = await page.locator('.cadence-daily.selected').count();
// bloom the first two steps (today)
for (let i = 0; i < 2; i++) {
  await page.locator('.steps li button', { hasText: '🌸' }).first().click();
  await page.waitForTimeout(280);
}
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// re-open: repeats persisted?
await openRutina();
await page.waitForTimeout(450);
const persisted = await page.locator('.repeats-toggle input').isChecked();
console.log(`A repeats toggle: always-visible=${repeatsAlways === 1} picker=${pickerShown === 1} daily=${dailySelected === 1} persisted=${persisted} | OK=${repeatsAlways === 1 && pickerShown === 1 && dailySelected === 1 && persisted}`);
const bloomedToday = await page.locator('.steps .step-name.done').count();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// B — today's blooms survive a reload untouched…
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await openRutina();
await page.waitForTimeout(450);
const stillToday = await page.locator('.steps .step-name.done').count();
console.log(`B1 today's blooms survive boot: ${stillToday}/${bloomedToday} | OK=${stillToday === bloomedToday && bloomedToday === 2}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// …but YESTERDAY's blooms reset to seed. Backdate achievedAt via IndexedDB.
const backdated = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('roadmap2u');
    r.onsuccess = () => res(r.result);
    r.onerror = rej;
  });
  const yesterday = Date.now() - 26 * 3600 * 1000;
  return new Promise((res) => {
    const store = db.transaction('nodes', 'readwrite').objectStore('nodes');
    const all = store.getAll();
    all.onsuccess = () => {
      let n = 0;
      for (const rec of all.result) {
        if (rec.status === 'achieved' && rec.achievedAt) {
          rec.achievedAt = yesterday;
          store.put(rec);
          n++;
        }
        // «La historia se queda» (0.0.106): the UI stamped repeatsSetAt TODAY,
        // which would freeze a backdated bloom — backdate the cadence too
        // (the ritual existed before the bloom, the classic sweep scenario).
        if (rec.repeatsSetAt) {
          rec.repeatsSetAt = yesterday - 48 * 3600 * 1000;
          store.put(rec);
        }
      }
      res(n);
    };
  });
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200); // boot sweep
await openRutina();
await page.waitForTimeout(450);
const doneAfter = await page.locator('.steps .step-name.done').count();
const seeds = await page.locator('.steps .status-dot.seed').count();
console.log(`B2 yesterday's blooms reset: backdated=${backdated} done-after=${doneAfter} seeds=${seeds} | OK=${backdated === 2 && doneAfter === 0 && seeds === 3}`);

// C — turning repeats OFF: backdated blooms stay bloomed.
for (let i = 0; i < 2; i++) {
  await page.locator('.steps li button', { hasText: '🌸' }).first().click();
  await page.waitForTimeout(280);
}
await page.locator('.repeats-toggle input').uncheck();
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('roadmap2u');
    r.onsuccess = () => res(r.result);
    r.onerror = rej;
  });
  const yesterday = Date.now() - 26 * 3600 * 1000;
  return new Promise((res) => {
    const store = db.transaction('nodes', 'readwrite').objectStore('nodes');
    const all = store.getAll();
    all.onsuccess = () => {
      for (const rec of all.result) {
        if (rec.status === 'achieved' && rec.achievedAt) {
          rec.achievedAt = yesterday;
          store.put(rec);
        }
      }
      res(null);
    };
  });
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await openRutina();
await page.waitForTimeout(450);
const doneC = await page.locator('.steps .step-name.done').count();
console.log(`C non-repeating never resets: done=${doneC} | OK=${doneC === 2}`);

// D — a ritual LEAF: planted via the plant-sheet chips («Se repite» → daily),
// then a backdated bloom resets the BRANCH ITSELF and mints NO fruit.
await page.keyboard.press('Escape'); // C left the node sheet open
await page.waitForTimeout(400);
await page.locator('.plant').first().click();
await page.waitForTimeout(300);
await page.fill('#root-title', 'Regar las plantas');
await page.locator('.repeat-ritual').click();
await page.waitForTimeout(200);
const dailyChipD = await page.locator('.cadence-daily.selected').count();
await page.locator('form.sheet button[type=submit]').click();
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const leaf = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('roadmap2u');
    r.onsuccess = () => res(r.result);
    r.onerror = rej;
  });
  const yesterday = Date.now() - 26 * 3600 * 1000;
  return new Promise((res) => {
    const store = db.transaction('nodes', 'readwrite').objectStore('nodes');
    const all = store.getAll();
    all.onsuccess = () => {
      const rec = all.result.find((n) => n.title === 'Regar las plantas');
      if (!rec) { res(null); return; }
      const shape = { repeats: rec.repeats, shadow: rec.repeatsDaily };
      rec.status = 'achieved';
      rec.achievedAt = yesterday;
      store.put(rec);
      res({ id: rec.id, ...shape });
    };
  });
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200); // boot sweep
const afterD = await page.evaluate(async (leafId) => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('roadmap2u');
    r.onsuccess = () => res(r.result);
    r.onerror = rej;
  });
  return new Promise((res) => {
    const tx = db.transaction(['nodes', 'harvests'], 'readonly');
    const nodes = tx.objectStore('nodes').getAll();
    nodes.onsuccess = () => {
      const harvests = tx.objectStore('harvests').getAll();
      harvests.onsuccess = () => {
        const leaf = nodes.result.find((n) => n.id === leafId);
        const fruits = harvests.result.filter((h) => h.nodeId === leafId && !h.deletedAt).length;
        res({ status: leaf?.status, achievedAt: leaf?.achievedAt, fruits });
      };
    };
  });
}, leaf?.id);
console.log(
  `D ritual leaf: repeats=${leaf?.repeats} shadow=${leaf?.shadow === true} chipDaily=${dailyChipD === 1} reset=${afterD.status === 'seed' && afterD.achievedAt === null} fruits=${afterD.fruits} | OK=${leaf?.repeats === 'daily' && leaf?.shadow === true && dailyChipD === 1 && afterD.status === 'seed' && afterD.fruits === 0}`,
);

// D2 — «un ritual no se desmenuza» (0.0.104): the ritual leaf's sheet hides
// the Pasitos input and the Desmenuzar button (a steps sendero keeps both);
// the header wears the ritual chip with the rhythm in words.
await page.locator('.tree-outline-toggle').click();
await page.waitForTimeout(400);
const leafRow = page.locator('.outline-rail .row', { hasText: 'Regar las plantas' }).first();
// the tablita spiral-mark must be read BEFORE opening the sheet (it closes the rail)
const leafSpiralRow = await leafRow.locator('.spiral-mark').count();
await leafRow.click();
await page.waitForTimeout(250);
await leafRow.click(); // second tap opens the sheet
await page.waitForTimeout(500);
const leafAddStep = await page.locator('.add-step').count();
const leafCrumble = await page.locator('.crumble-cta').count();
const leafChip = await page.locator('.ritual-chip').count();
console.log(
  `D2 ritual leaf: no add-step=${leafAddStep === 0} no crumble=${leafCrumble === 0} chip=${leafChip === 1} tablita-spiral=${leafSpiralRow === 1} | OK=${leafAddStep === 0 && leafCrumble === 0 && leafChip === 1 && leafSpiralRow === 1}`,
);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// the sendero path keeps its pasitos affordances (open via the tablita too —
// planting the leaf reflowed the canvas, so the old center is stale; the
// rail closed when the leaf sheet opened, so toggle it back on)
await page.locator('.tree-outline-toggle').click();
await page.waitForTimeout(400);
const pathRow = page.locator('.outline-rail .row', { hasText: 'Rutina' }).first();
await pathRow.click();
await page.waitForTimeout(250);
await pathRow.click();
await page.waitForTimeout(500);
const pathAddStep = await page.locator('.add-step').count();
console.log(`D3 sendero path keeps add-step: ${pathAddStep === 1} | OK=${pathAddStep === 1}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// E — weekday cadences, deterministic on ANY run day: a leaf scheduled on
// TODAY's weekday resets a stale bloom; one scheduled TOMORROW does not.
const eSetup = await page.evaluate(async () => {
  const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const todayWd = WD[new Date().getDay()];
  const tomorrowWd = WD[(new Date().getDay() + 1) % 7];
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('roadmap2u');
    r.onsuccess = () => res(r.result);
    r.onerror = rej;
  });
  const yesterday = Date.now() - 26 * 3600 * 1000;
  return new Promise((res) => {
    const store = db.transaction('nodes', 'readwrite').objectStore('nodes');
    const all = store.getAll();
    all.onsuccess = () => {
      const base = all.result.find((n) => n.title === 'Regar las plantas');
      const mk = (id, title, wd) => ({
        ...base,
        id,
        title,
        repeats: [wd],
        repeatsDaily: true,
        status: 'achieved',
        achievedAt: yesterday,
        updatedAt: Date.now(),
        rev: 1,
      });
      store.put(mk('vs-e-today', 'Ritual de hoy', todayWd));
      store.put(mk('vs-e-tomorrow', 'Ritual de mañana', tomorrowWd));
      res({ todayWd, tomorrowWd });
    };
  });
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const afterE = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('roadmap2u');
    r.onsuccess = () => res(r.result);
    r.onerror = rej;
  });
  return new Promise((res) => {
    const all = db.transaction('nodes', 'readonly').objectStore('nodes').getAll();
    all.onsuccess = () => {
      const t = all.result.find((n) => n.id === 'vs-e-today');
      const m = all.result.find((n) => n.id === 'vs-e-tomorrow');
      res({ todayStatus: t?.status, tomorrowStatus: m?.status });
    };
  });
});
console.log(
  `E weekday sweep (${eSetup.todayWd}/${eSetup.tomorrowWd}): today-reset=${afterE.todayStatus === 'seed'} tomorrow-held=${afterE.tomorrowStatus === 'achieved'} | OK=${afterE.todayStatus === 'seed' && afterE.tomorrowStatus === 'achieved'}`,
);

// F — «la historia se queda» (0.0.106): a bloom from BEFORE the cadence day
// is FROZEN history (the sweep must not reset it); a bloom from AFTER the
// cadence resets as always. Engine-level via IndexedDB (almanac marks are
// vitest-covered in almanac.spec).
await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('roadmap2u');
    r.onsuccess = () => res(r.result);
    r.onerror = rej;
  });
  const now = Date.now();
  return new Promise((res) => {
    const store = db.transaction('nodes', 'readwrite').objectStore('nodes');
    const all = store.getAll();
    all.onsuccess = () => {
      const base = all.result.find((n) => n.title === 'Regar las plantas');
      const mk = (extra) => ({ ...base, updatedAt: now, rev: 1, targetDate: null, ...extra });
      // Cadence set TWO days ago; one bloom predates it (frozen), one follows it (resets).
      store.put(mk({ id: 'vs-f-parent', title: 'Ritual con pasado', parentId: null, flow: 'steps', status: 'growing', achievedAt: null, repeats: 'daily', repeatsDaily: true, repeatsSetAt: now - 48 * 3600 * 1000 }));
      store.put(mk({ id: 'vs-f-frozen', title: 'Paso ya vivido', parentId: 'vs-f-parent', flow: null, repeats: null, repeatsDaily: false, repeatsSetAt: null, status: 'achieved', achievedAt: now - 72 * 3600 * 1000, order: 10 }));
      store.put(mk({ id: 'vs-f-new', title: 'Paso del ritual', parentId: 'vs-f-parent', flow: null, repeats: null, repeatsDaily: false, repeatsSetAt: null, status: 'achieved', achievedAt: now - 26 * 3600 * 1000, order: 20 }));
      res(null);
    };
  });
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200); // boot sweep
const afterF = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('roadmap2u');
    r.onsuccess = () => res(r.result);
    r.onerror = rej;
  });
  return new Promise((res) => {
    const all = db.transaction('nodes', 'readonly').objectStore('nodes').getAll();
    all.onsuccess = () => {
      const frozen = all.result.find((n) => n.id === 'vs-f-frozen');
      const fresh = all.result.find((n) => n.id === 'vs-f-new');
      res({ frozenStatus: frozen?.status, frozenAt: frozen?.achievedAt, newStatus: fresh?.status });
    };
  });
});
console.log(
  `F frozen history stays (0.0.106): frozen-held=${afterF.frozenStatus === 'achieved' && !!afterF.frozenAt} post-cadence-reset=${afterF.newStatus === 'seed'} | OK=${afterF.frozenStatus === 'achieved' && !!afterF.frozenAt && afterF.newStatus === 'seed'}`,
);

await browser.close();
console.log('senderos done');
