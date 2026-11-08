// «La conservería» (0.0.89). A: a real bloom plays the HARVEST layer —
// full-screen petal fall + the earned-fruit card — beside the act burst.
// B: an almanaque sendero stone celebrates the ACT only (no sky, no card
// — the sky never lies). C: reduce-motion keeps the card (information),
// drops the sky. D: the seal ritual moves fruits' HOME, register intact,
// lifetime count UNCHANGED (nada se gasta). E: «Abrir el frasco» undoes.
// F: one fruit is a whole batch. G: a mixed pot derives «del bosque».
// H: the edited name persists to the shelf + register chip. I: the tea
// action has been retired. J: the meadow holds NO jar (0.0.99) and the
// plot centers stay self-resolving. K: DOORS CANCEL — dismissing the
// ritual mid-way changes nothing.
import { BASE, launchPage, ok } from './lib/harness.mjs';

const { browser, page } = await launchPage();

const idbCounts = () =>
  page.evaluate(async () => {
    const open = indexedDB.open('roadmap2u');
    const db = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = rej;
    });
    const read = (store) =>
      new Promise((res, rej) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = rej;
      });
    const harvests = await read('harvests');
    const preserves = await read('preserves');
    db.close();
    return {
      harvests: harvests.filter((r) => !r.deletedAt).length,
      preserved: harvests.filter((r) => !r.deletedAt && r.preserveId).length,
      jars: preserves.filter((r) => !r.deletedAt).length,
      jarNames: preserves.filter((r) => !r.deletedAt).map((r) => r.name),
    };
  });

await page.goto(`${BASE}/forest?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1100);

// A — bloom a fresh branch → sky (14 petals) + fruit card + toast.
const siteA = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => {
    open.onsuccess = () => res(open.result);
    open.onerror = rej;
  });
  const rows = await new Promise((res, rej) => {
    const req = db.transaction('nodes', 'readonly').objectStore('nodes').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = rej;
  });
  db.close();
  const pick = rows.find(
    (r) =>
      !r.deletedAt && !r.archivedAt && !r.repeatsDaily && r.parentId !== null &&
      (r.status === 'seed' || r.status === 'growing'),
  );
  return { treeId: pick.treeId, nodeId: pick.id };
});
await page.goto(`${BASE}/tree/${siteA.treeId}?node=${siteA.nodeId}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('.status-row .chip.pick', { hasText: 'Florecida' }).click();
await page.waitForTimeout(350);
const petals = await page.locator('.petal-fall .fall-petal').count();
const card = await page.locator('.fruit-card').count();
const cardText = ((await page.locator('.fruit-card').textContent().catch(() => '')) ?? '').trim();
const burstA = await page.locator('.bloom-burst').count();
await page.waitForTimeout(3000);
const skyGone = (await page.locator('.petal-fall').count()) === 0;
const cardGone = (await page.locator('.fruit-card').count()) === 0;
ok(
  'A mint: sky (14) + card + burst, both breathe out',
  petals === 14 && card === 1 && cardText.length > 0 && burstA >= 1 && skyGone && cardGone,
  `petals=${petals} card=${card} "${cardText.slice(0, 26)}"`,
);

// B — sendero stone: act burst only, never the harvest layer.
const senderoTitleB = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => {
    open.onsuccess = () => res(open.result);
    open.onerror = rej;
  });
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
      // its own caminito, and this probe needs a sendero of its OWN.
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
await page.goto(`${BASE}/almanaque`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
// Scope to OUR caminito — the demo seed walks its own since 0.0.106.
await page.locator('.caminito', { hasText: senderoTitleB }).locator('.alm-stone.next').click();
await page.waitForTimeout(300);
const burstB = await page.locator('.bloom-burst').count();
const skyB = await page.locator('.petal-fall').count();
const cardB = await page.locator('.fruit-card').count();
ok('B stone: burst yes, sky/card never', burstB >= 1 && skyB === 0 && cardB === 0, `burst=${burstB} sky=${skyB} card=${cardB}`);

// D + F + H — the seal ritual: ONE fruit is a whole batch, the name is
// editable, the register keeps every fruit and the count never moves.
const before = await idbCounts();
await page.goto(`${BASE}/cosecha`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('.jam-door').click();
await page.waitForTimeout(700);
await page.locator('.fruit-pick').first().click();
await page.waitForTimeout(600);
const potCount = await page.locator('.pot-fruit').count();
await page.waitForTimeout(400);
await page.locator('button', { hasText: 'Remover' }).click();
await page.waitForTimeout(300);
await page.locator('button', { hasText: 'Envasar' }).click();
await page.waitForTimeout(400);
await page.locator('#jam-name').fill('La mermelada de mis exámenes');
await page.locator('.seal-btn').click();
await page.waitForTimeout(900);
const after = await idbCounts();
const shelfJars = await page.locator('.jam-shelf-jar').count();
const shelfName = ((await page.locator('.jam-name').first().textContent().catch(() => '')) ?? '').trim();
ok(
  'D/F/H seal: one-fruit batch, home moves, register intact, name kept',
  potCount === 1 &&
    after.jars === before.jars + 1 &&
    after.preserved === before.preserved + 1 &&
    after.harvests === before.harvests &&
    shelfJars >= 1 &&
    shelfName === 'La mermelada de mis exámenes',
  `jars=${before.jars}→${after.jars} fruits=${before.harvests}→${after.harvests} name="${shelfName.slice(0, 22)}"`,
);
// D2 (0.0.105, owner ask): the hero line speaks for the JAR — fresh fruits
// only (the picture it sits under); the lifetime count lives in the register.
const freshAfter = after.harvests - after.preserved;
const totalLine = ((await page.locator('.total-line').textContent().catch(() => '')) ?? '').trim();
ok(
  'D2 hero line counts the jar (fresh), not the lifetime register',
  totalLine.includes(String(freshAfter)) && totalLine.includes('frasco') && !totalLine.includes(String(after.harvests)),
  `"${totalLine}" fresh=${freshAfter} lifetime=${after.harvests}`,
);

// register chip: the jammed fruit says where it lives now
const chip = await page.locator('.jar-chip').count();
ok('D3 register shows the single-home chip', chip >= 1, `chips=${chip}`);

// E — the seal's «Deshacer» returns the fruits (0.0.90: «abrir» belongs
// to the ceremony now).
await page.locator('.toast button', { hasText: 'Deshacer' }).click();
await page.waitForTimeout(700);
const undone = await idbCounts();
ok(
  'E undo returns the fruit to the fresh jar',
  undone.jars === before.jars && undone.preserved === before.preserved && undone.harvests === before.harvests,
  `jars=${undone.jars} preserved=${undone.preserved}`,
);

// G — a mixed pot derives «del bosque» (two different-accent fruits).
const freshSpecies = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => {
    open.onsuccess = () => res(open.result);
    open.onerror = rej;
  });
  const rows = await new Promise((res, rej) => {
    const req = db.transaction('harvests', 'readonly').objectStore('harvests').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = rej;
  });
  db.close();
  return [...new Set(rows.filter((r) => !r.deletedAt && !r.preserveId).map((r) => r.accent))].length;
});
if (freshSpecies >= 2) {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.locator('.jam-door').click();
  await page.waitForTimeout(700);
  // pick two fruits of DIFFERENT accents via their order in the tray —
  // tray is newest-first; find indices by evaluating the accents.
  const picks = await page.evaluate(async () => {
    const open = indexedDB.open('roadmap2u');
    const db = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = rej;
    });
    const rows = await new Promise((res, rej) => {
      const req = db.transaction('harvests', 'readonly').objectStore('harvests').getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = rej;
    });
    db.close();
    const fresh = rows
      .filter((r) => !r.deletedAt && !r.preserveId)
      .sort((a, b) => b.harvestedAt - a.harvestedAt || (a.id < b.id ? -1 : 1));
    const first = 0;
    const second = fresh.findIndex((r) => r.accent !== fresh[0].accent);
    return { first, second };
  });
  await page.locator('.fruit-pick').nth(picks.first).click();
  await page.locator('.fruit-pick').nth(picks.second).click();
  await page.waitForTimeout(400);
  const tag = ((await page.locator('.pot-tag').textContent().catch(() => '')) ?? '').trim();
  ok('G mixed pot derives del bosque', tag.includes('bosque'), `"${tag}"`);
  // K — DOORS CANCEL: dismiss mid-ritual, nothing changes.
  const preK = await idbCounts();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const postK = await idbCounts();
  const sheetGone = (await page.locator('.jam-sheet').count()) === 0;
  ok(
    'K doors cancel: dismissing the pot changes nothing',
    sheetGone && postK.jars === preK.jars && postK.preserved === preK.preserved,
    `jars=${postK.jars} preserved=${postK.preserved}`,
  );
} else {
  ok('G mixed pot derives del bosque', false, `only ${freshSpecies} species fresh in demo`);
}

// I — a populated pantry no longer offers to brew tea.
ok(
  'I the populated pantry has no tea action',
  (await page.getByRole('button', { name: 'Preparar un té', exact: true }).count()) === 0,
);

// C — reduce-motion: the card (information) stays, the sky steps aside.
await page.emulateMedia({ reducedMotion: 'reduce' });
const siteC = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => {
    open.onsuccess = () => res(open.result);
    open.onerror = rej;
  });
  const rows = await new Promise((res, rej) => {
    const req = db.transaction('nodes', 'readonly').objectStore('nodes').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = rej;
  });
  db.close();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const underDaily = (n) => {
    let cur = n;
    const seen = new Set();
    while (cur?.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      const parent = byId.get(cur.parentId);
      if (!parent) return false;
      if (parent.repeatsDaily && parent.flow === 'steps' && parent.status !== 'branched') return true;
      cur = parent;
    }
    return false;
  };
  const pick = rows.find(
    (r) =>
      !r.deletedAt && !r.archivedAt && !r.repeatsDaily && r.parentId !== null &&
      (r.status === 'seed' || r.status === 'growing') && !underDaily(r),
  );
  return { treeId: pick.treeId, nodeId: pick.id };
});
await page.goto(`${BASE}/tree/${siteC.treeId}?node=${siteC.nodeId}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('.status-row .chip.pick', { hasText: 'Florecida' }).click();
await page.waitForTimeout(350);
const cardRM = await page.locator('.fruit-card').count();
const skyHidden = await page.evaluate(() => {
  const sky = document.querySelector('.petal-fall');
  return sky ? getComputedStyle(sky).display === 'none' : true;
});
ok('C reduce-motion: card stays, sky steps aside', cardRM === 1 && skyHidden, `card=${cardRM} skyHidden=${skyHidden}`);

// J (0.0.99 — the meadow jar was REMOVED; the Conservería tab is the door):
// seal a real jar, then the meadow shows NO jar and every plot center still
// resolves to itself (the anchor law), and the sealed jam waits on the alacena.
await page.emulateMedia({ reducedMotion: null });
await page.goto(`${BASE}/cosecha`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.locator('.jam-door').click();
await page.waitForTimeout(700);
await page.locator('.fruit-pick').first().click();
await page.waitForTimeout(300);
await page.locator('button', { hasText: 'Envasar' }).click();
await page.waitForTimeout(300);
await page.locator('.seal-btn').click();
await page.waitForTimeout(900);
await page.goto(`${BASE}/forest`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
const meadowJarGone = (await page.locator('.meadow-jar').count()) === 0;
const centersOk = await page.evaluate(() =>
  [...document.querySelectorAll('.plot')].every((p) => {
    const r = p.getBoundingClientRect();
    const el = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return el?.closest('[data-tree-id]') === p;
  }),
);
await page.goto(`${BASE}/cosecha`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const alacenaHasJam = (await page.locator('.alacena .jam-shelf-jar').count()) >= 1;
ok(
  'J meadow jar gone + plot centers hold + jam waits on the alacena',
  meadowJarGone && centersOk && alacenaHasJam,
  `jarGone=${meadowJarGone} centers=${centersOk} alacena=${alacenaHasJam}`,
);

// ── 0.0.90 «el premio del frasco» ──────────────────────────────────────

// L — seal ONE fruit WITH a premio: frasquito vessel + 🎀 ribbon + panel
// chip + the open door. N (inside): the pot never speaks tiers forward.
await page.goto(`${BASE}/cosecha`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.locator('.jam-door').click();
await page.waitForTimeout(700);
await page.locator('.fruit-pick').first().click();
await page.waitForTimeout(400);
const potText = ((await page.locator('.jam-sheet').textContent().catch(() => '')) ?? '');
const antiQuota = !/frasquito|frascote|piden|pide un/i.test(potText);
ok('N the pot never computes tiers forward', antiQuota, `"${potText.slice(0, 60).replace(/\s+/g, ' ')}"`);
await page.waitForTimeout(300);
await page.locator('button', { hasText: 'Envasar' }).click();
await page.waitForTimeout(400);
const vesselLineL = ((await page.locator('.vessel-line').textContent().catch(() => '')) ?? '').trim();
await page.locator('.premio-field input').fill('ver un capítulo extra');
await page.waitForTimeout(200);
// savedFor was severed from every input (0.0.108) — assert its ABSENCE.
const savedForGone = (await page.locator('.saved-for-field').count()) === 0;
await page.locator('.seal-btn').click();
await page.waitForTimeout(900);
const jarL = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const rows = await new Promise((res, rej) => {
    const req = db.transaction('preserves', 'readonly').objectStore('preserves').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = rej;
  });
  db.close();
  const live = rows.filter((r) => !r.deletedAt).sort((a, b) => b.madeAt - a.madeAt);
  return live[0] ? { size: live[0].size, premio: live[0].premio, openedAt: live[0].openedAt } : null;
});
const ribbon = await page.locator('.jam-ribbon').count();
ok(
  'L premio seal: frasquito + ribbon + fields (savedFor input gone, 0.0.108)',
  vesselLineL.includes('frasquito') && savedForGone &&
    jarL?.size === 'frasquito' && jarL?.premio === 'ver un capítulo extra' && !jarL?.openedAt && ribbon >= 1,
  `vessel="${vesselLineL.slice(0, 34)}" size=${jarL?.size} savedForGone=${savedForGone} ribbon=${ribbon}`,
);
// Put the SEAL toast away before the ceremony — its protected Deshacer
// (unseal) would otherwise still own the slot when M's Deshacer clicks.
await page.locator('.toast .btn-ghost').click().catch(() => {});
await page.waitForTimeout(300);

// Q (0.0.95 — INVERTED): a memory jar (no premio) NOW opens to a gentle SAVOR
// — it was stuck (no open, no remove). No «Te lo ganaste», no empty «»; it
// empties and moves to «Las disfrutadas».
await page.locator('.alacena .jam-shelf-jar').last().click(); // oldest = J's memory jar
await page.waitForTimeout(400);
// 0.0.106: the demo alacena ships demo-jam-1 (older AND premio'd) — if the
// oldest jar wears a premio chip, J's memory jar sits just before it.
if (await page.locator('.jar-panel .premio-chip').count()) {
  await page.locator('.alacena .jam-shelf-jar').nth(-2).click();
  await page.waitForTimeout(400);
}
const qOpenBtn = await page.locator('.open-jam-btn').count();
const qNoChip = (await page.locator('.jar-panel .premio-chip').count()) === 0;
await page.locator('.open-jam-btn').click();
await page.waitForTimeout(400);
await page.locator('.open-it').click();
await page.waitForTimeout(500);
const qHeadline = ((await page.locator('.earned-headline').textContent().catch(() => '')) ?? '').trim();
const qRewardLine = await page.locator('.earned-premio').count();
await page.keyboard.press('Escape'); // finish savoring (claimed → finish)
await page.waitForTimeout(500);
ok(
  'Q memory jar opens to savor (no reward, no empty «»)',
  qOpenBtn === 1 && qNoChip && qRewardLine === 0 &&
    /saborear|savor/i.test(qHeadline) && !/te lo ganaste|you earned/i.test(qHeadline),
  `btn=${qOpenBtn} chip=${qNoChip} reward=${qRewardLine} headline="${qHeadline}"`,
);
await page.locator('.toast .btn-ghost').click().catch(() => {}); // dismiss opened toast
await page.waitForTimeout(300);

// M — the claiming ceremony: openedAt stamps, the rain falls in the jam's
// tint, «Te lo ganaste» speaks, and Deshacer re-closes.
await page.locator('.alacena .jam-shelf-jar').first().click(); // newest = L's premio jar
await page.waitForTimeout(400);
const premioChip = await page.locator('.premio-chip').count();
await page.locator('.open-jam-btn').click();
await page.waitForTimeout(600);
await page.locator('.open-it').click();
await page.waitForTimeout(400);
const rainM = await page.locator('.petal-fall').count();
const earned = ((await page.locator('.earned').textContent().catch(() => '')) ?? '');
await page.locator('.enjoy-it').click();
await page.waitForTimeout(500);
const openedStamp = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const rows = await new Promise((res, rej) => {
    const req = db.transaction('preserves', 'readonly').objectStore('preserves').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = rej;
  });
  db.close();
  return rows.find((r) => !r.deletedAt && r.premio === 'ver un capítulo extra')?.openedAt ?? null;
});
await page.locator('.toast button', { hasText: 'Deshacer' }).click();
await page.waitForTimeout(500);
const reclosedStamp = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const rows = await new Promise((res, rej) => {
    const req = db.transaction('preserves', 'readonly').objectStore('preserves').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = rej;
  });
  db.close();
  return rows.find((r) => !r.deletedAt && r.premio === 'ver un capítulo extra')?.openedAt ?? null;
});
ok(
  'M ceremony: rain + Te lo ganaste + stamp + Deshacer re-closes',
  premioChip === 1 && rainM === 1 && earned.includes('Te lo ganaste') &&
    earned.includes('ver un capítulo extra') && !!openedStamp && reclosedStamp === null,
  `rain=${rainM} stamp=${!!openedStamp}→${reclosedStamp}`,
);

// P — reduce-motion ceremony: the words stay (information), the sky steps aside.
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('.alacena .jam-shelf-jar').first().click();
await page.waitForTimeout(400);
await page.locator('.open-jam-btn').click();
await page.waitForTimeout(600);
await page.locator('.open-it').click();
await page.waitForTimeout(400);
const skyHiddenP = await page.evaluate(() => {
  const sky = document.querySelector('.petal-fall');
  return sky ? getComputedStyle(sky).display === 'none' : true;
});
const earnedP = ((await page.locator('.earned').textContent().catch(() => '')) ?? '').includes('Te lo ganaste');
await page.locator('.enjoy-it').click();
await page.waitForTimeout(400);
const disfrutada = ((await page.locator('.enjoyed-line').textContent().catch(() => '')) ?? '').trim();
ok('P reduce-motion: words stay, sky aside, jar disfrutada', skyHiddenP && earnedP && disfrutada.length > 0, `"${disfrutada.slice(0, 26)}"`);
await page.emulateMedia({ reducedMotion: null });

// S — «las disfrutadas» (0.0.92) + empty glass (0.0.95) + FOLDED by default
// (0.0.100): the history shelf starts collapsed (no jars in the DOM); its
// toggle opens it; both opened jars left the alacena and render EMPTY.
const alacenaJars = await page.locator('.alacena .jam-shelf-jar').count();
const foldedJars = await page.locator('.disfrutadas .jam-shelf-jar').count();
await page.locator('.enjoyed-toggle').click();
await page.waitForTimeout(300);
const enjoyedJars = await page.locator('.disfrutadas .jam-shelf-jar').count();
const enjoyedLiquid = await page.locator('.disfrutadas .jam-liquid').count();
ok(
  'S disfrutadas fold by default, open on toggle, jars empty + off the alacena',
  // alacena === 1: the 0.0.106 demo seed ships demo-jam-1 (sealed, never
  // opened by this probe) — both PROBE jars must still leave the alacena.
  alacenaJars === 1 && foldedJars === 0 && enjoyedJars === 2 && enjoyedLiquid === 0,
  `alacena=${alacenaJars} folded=${foldedJars} open=${enjoyedJars} liquid=${enjoyedLiquid}`,
);

// O — six fruits make a frascote («una mermelada poderosa»).
await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const accents = ['moss', 'sage', 'sky', 'clay', 'lavender', 'sand'];
  await new Promise((res, rej) => {
    const tx = db.transaction('harvests', 'readwrite');
    const os = tx.objectStore('harvests');
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      os.put({
        id: 'h:probe-o-' + i, createdAt: now, updatedAt: now, rev: 1, deletedAt: null,
        nodeId: 'probe-o-' + i, treeId: 'probe-tree', treeName: 'Sonda', accent: accents[i],
        title: 'Logro ' + (i + 1), harvestedAt: now - i * 1000, preserveId: null,
      });
    }
    tx.oncomplete = () => res();
    tx.onerror = rej;
  });
  db.close();
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('.jam-door').click();
await page.waitForTimeout(700);
for (let i = 0; i < 6; i++) {
  await page.locator('.fruit-pick').nth(i).click();
  await page.waitForTimeout(120);
}
await page.waitForTimeout(300);
await page.locator('button', { hasText: 'Envasar' }).click();
await page.waitForTimeout(400);
const vesselLineO = ((await page.locator('.vessel-line').textContent().catch(() => '')) ?? '').trim();
await page.locator('.seal-btn').click();
await page.waitForTimeout(900);
const sizeO = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const rows = await new Promise((res, rej) => {
    const req = db.transaction('preserves', 'readonly').objectStore('preserves').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = rej;
  });
  db.close();
  return rows.filter((r) => !r.deletedAt).sort((a, b) => b.madeAt - a.madeAt)[0]?.size ?? null;
});
ok('O six fruits = frascote poderosa', vesselLineO.includes('poderosa') && sizeO === 'frascote', `"${vesselLineO.slice(0, 44)}" size=${sizeO}`);

// R — «segunda cosecha» (0.0.91): a sealed fruit is never re-offered in
// the pot; re-achieving its branch leaves the jam UNTOUCHED (immutable
// history) and mints a NEW season fruit into the fresh jar.
const jammed = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const read = (s) =>
    new Promise((res, rej) => {
      const req = db.transaction(s, 'readonly').objectStore(s).getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = rej;
    });
  const rows = await read('harvests');
  const nodes = await read('nodes');
  db.close();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // §B senderoized a demo parent mid-probe — its pasitos (correctly) bear
  // no fruit, so R must pick a jammed fruit whose branch still mints.
  const underDaily = (n) => {
    let cur = n;
    const seen = new Set();
    while (cur?.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      const parent = byId.get(cur.parentId);
      if (!parent) return false;
      if (parent.repeatsDaily && parent.flow === 'steps' && parent.status !== 'branched') return true;
      cur = parent;
    }
    return false;
  };
  const row = rows.find((r) => {
    if (r.deletedAt || !r.preserveId || r.nodeId.startsWith('probe-')) return false;
    const node = byId.get(r.nodeId);
    return !!node && !node.deletedAt && !node.archivedAt && !node.repeatsDaily && !underDaily(node);
  });
  return row
    ? { id: row.id, nodeId: row.nodeId, treeId: row.treeId, title: row.title, harvestedAt: row.harvestedAt, preserveId: row.preserveId }
    : null;
});
ok('R0 a real jammed fruit exists', !!jammed, jammed?.title ?? 'none');
await page.goto(`${BASE}/cosecha`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.locator('.jam-door').click();
await page.waitForTimeout(700);
const trayBefore = (await page.locator('.fruit-pick .pick-title').allTextContents()).map((t) => t.trim());
const excluded = !trayBefore.includes(jammed.title);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('R1 the pot never re-offers a sealed fruit', excluded, `tray=${trayBefore.length}`);

await page.goto(`${BASE}/tree/${jammed.treeId}?node=${jammed.nodeId}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('.status-row .chip.pick', { hasText: 'Creciendo' }).click();
await page.waitForTimeout(600);
await page.locator('.status-row .chip.pick', { hasText: 'Florecida' }).click();
await page.waitForTimeout(800);
const seasons = await page.evaluate(async (info) => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const rows = await new Promise((res, rej) => {
    const req = db.transaction('harvests', 'readonly').objectStore('harvests').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = rej;
  });
  db.close();
  const original = rows.find((r) => r.id === info.id);
  const fresh = rows.filter((r) => !r.deletedAt && r.nodeId === info.nodeId && !r.preserveId);
  return {
    jamUntouched: original.preserveId === info.preserveId && original.harvestedAt === info.harvestedAt,
    freshSeasons: fresh.length,
    seasonId: fresh[0]?.id ?? '',
  };
}, jammed);
await page.goto(`${BASE}/cosecha`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.locator('.jam-door').click();
await page.waitForTimeout(700);
const trayAfter = (await page.locator('.fruit-pick .pick-title').allTextContents()).map((t) => t.trim());
const offeredAgain = trayAfter.includes(jammed.title);
ok(
  'R2 re-achieve: jam immutable + a NEW season fruit is usable',
  seasons.jamUntouched && seasons.freshSeasons === 1 && seasons.seasonId.includes(':s') && offeredAgain,
  `jamUntouched=${seasons.jamUntouched} season=${seasons.seasonId.slice(-10)} offered=${offeredAgain}`,
);

// ── «La promesa» (0.0.93): goal jars ─────────────────────────────────────
// T: the wizard creates an EMPTY pending jar. U: placement fills it + the
// fruit leaves the pot tray + is re-placeable. V: reaching capacity auto-
// seals + the toast's Deshacer reverts to pending. W: «soltar» frees fruits
// + tombstones. X: the count line lives ONLY on the detail (shelves/mesita
// numberless). Y: a sealed goal jar opens via the existing ceremony. Z:
// reconcile seals an over-full pending jar silently (no ceremony).

const seedFresh = (n, tag) =>
  page.evaluate(async ({ n, tag }) => {
    const open = indexedDB.open('roadmap2u');
    const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
    const tx = db.transaction('harvests', 'readwrite');
    const os = tx.objectStore('harvests');
    const now = Date.now();
    const ids = [];
    for (let i = 0; i < n; i++) {
      const id = 'h:' + tag + '-' + i;
      ids.push(id);
      os.put({
        id, createdAt: now, updatedAt: now, rev: 1, deletedAt: null,
        nodeId: tag + '-' + i, treeId: 'probe-tree', treeName: 'Probe', accent: 'moss',
        title: 'Fruta ' + tag + ' ' + (i + 1), harvestedAt: now + i, preserveId: null,
      });
    }
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
    return ids;
  }, { n, tag });

const readJars = () =>
  page.evaluate(async () => {
    const open = indexedDB.open('roadmap2u');
    const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
    const read = (store) => new Promise((res, rej) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => res(req.result); req.onerror = rej;
    });
    const preserves = await read('preserves');
    const harvests = await read('harvests');
    db.close();
    return preserves.filter((p) => !p.deletedAt).map((p) => ({
      id: p.id, name: p.name, plannedAt: p.plannedAt ?? null, sealedAt: p.sealedAt ?? null,
      size: p.size, premio: p.premio ?? null, madeAt: p.madeAt, openedAt: p.openedAt ?? null,
      members: harvests.filter((h) => !h.deletedAt && h.preserveId === p.id).length,
    }));
  });

// T — the wizard mints an empty pending jar (frasquito, capacity 2).
await seedFresh(3, 'u');
await page.goto(`${BASE}/cosecha`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
// ONE screen since 0.0.108: premio + vessel + Prometer (the premio IS the name).
await page.locator('.promise-door').click();
await page.waitForTimeout(300);
await page.fill('#promise-premio', 'un café tranquilo');
await page.locator('.vessel-chip').nth(0).click(); // frasquito
await page.locator('.create-btn').click();
await page.waitForTimeout(600);
let jarsT = await readJars();
const promiseT = jarsT.find((j) => j.name === 'un café tranquilo');
const fillT = ((await page.locator('.fill-line').textContent().catch(() => '')) ?? '').trim();
ok(
  'T wizard creates an empty pending jar (plannedAt, sealedAt null, size, name===premio)',
  !!promiseT && promiseT.plannedAt != null && promiseT.sealedAt == null &&
    promiseT.size === 'frasquito' && promiseT.premio === 'un café tranquilo' &&
    promiseT.name === promiseT.premio && promiseT.members === 0,
  `jar=${JSON.stringify(promiseT ?? {}).slice(0, 90)}`,
);
ok('T2 the fill line shows 0 · caben 2 on the detail', /0/.test(fillT) && /2/.test(fillT), `"${fillT}"`);

// U — place a SPECIFIC fruit; it leaves the pot tray and is re-placeable.
await page.locator('.add-fruit-btn').click(); // open the tray once
await page.waitForTimeout(250);
await page.locator('.add-pick', { hasText: 'Fruta u 1' }).click();
await page.waitForTimeout(600);
let jarsU = await readJars();
const promiseU = jarsU.find((j) => j.name === 'un café tranquilo');
const fillU = ((await page.locator('.fill-line').textContent().catch(() => '')) ?? '').trim();
// pot tray must NOT offer a placed (promised) fruit
await page.locator('.jam-door').click();
await page.waitForTimeout(500);
const potTitles = (await page.locator('.fruit-pick .pick-title').allTextContents()).map((t) => t.trim());
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
ok(
  'U placement fills the jar + the fruit leaves the pot tray',
  promiseU.members === 1 && promiseU.sealedAt == null && /1/.test(fillU) &&
    !potTitles.includes('Fruta u 1'),
  `members=${promiseU.members} fill="${fillU}" potHasIt=${potTitles.includes('Fruta u 1')}`,
);
// re-placeable: take it back out (tray stays open — many fresh remain)
await page.locator('.remove-fruit-btn').first().click();
await page.waitForTimeout(500);
const promiseUback = (await readJars()).find((j) => j.name === 'un café tranquilo');
ok('U2 a placed fruit is re-placeable while pending', promiseUback.members === 0, `members=${promiseUback.members}`);

// V — filling NEVER seals (0.0.96): it fills, celebrates, and offers «Hacer
// mermelada». Tray is still open.
await page.locator('.add-pick', { hasText: 'Fruta u 1' }).click();
await page.waitForTimeout(500);
await page.locator('.add-pick', { hasText: 'Fruta u 2' }).click(); // 2nd fruit → capacity 2 → FULL (not sealed)
await page.waitForTimeout(700);
const fullV = (await readJars()).find((j) => j.name === 'un café tranquilo');
const makeBtn = await page.locator('.make-jam-btn').count();
ok(
  'V filling fills but does NOT seal; offers «Hacer mermelada»',
  fullV.sealedAt == null && fullV.members === 2 && makeBtn >= 1,
  `sealedAt=${fullV.sealedAt != null} members=${fullV.members} makeBtn=${makeBtn}`,
);
// V2 — the user MAKES the jam: cook ceremony → Envasar → the POUR scene plays
// (0.0.100, ~2.4s) → sealed (premio kept).
await page.locator('.make-jam-btn').first().click();
await page.waitForTimeout(500);
await page.locator('.make-sheet .make-btn').click(); // Envasar
await page.waitForTimeout(700);
const pourScene = await page.locator('.make-sheet app-envasar-scene').count();
await page.waitForTimeout(2600); // the pour settles → made → seal
const madeV = (await readJars()).find((j) => j.name === 'un café tranquilo');
ok(
  'V2 Hacer mermelada: pour scene plays, then seals (premio kept)',
  pourScene >= 1 && madeV.sealedAt != null && madeV.members === 2 && madeV.premio === 'un café tranquilo',
  `pour=${pourScene} sealedAt=${madeV.sealedAt != null} members=${madeV.members} premio="${madeV.premio}"`,
);
// V3 — Deshacer un-makes → full pending again (all fruits kept).
await page.locator('.toast button', { hasText: 'Deshacer' }).click();
await page.waitForTimeout(700);
const unmadeV = (await readJars()).find((j) => j.name === 'un café tranquilo');
ok(
  'V3 Deshacer un-makes → full pending again (fruits kept)',
  unmadeV.sealedAt == null && unmadeV.members === 2,
  `sealedAt=${unmadeV.sealedAt != null} members=${unmadeV.members}`,
);

// W — «soltar» frees the fruits and tombstones the jar.
await page.goto(`${BASE}/cosecha`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.locator('.pending-jar').first().click();
await page.waitForTimeout(300);
const freshBeforeW = (await readJars()).reduce((n, j) => n + j.members, 0);
await page.locator('.release-btn').click();
await page.waitForTimeout(300);
await page.locator('.confirm button', { hasText: 'Soltarlo' }).click();
await page.waitForTimeout(600);
const jarsW = await readJars();
const goneW = !jarsW.find((j) => j.name === 'un café tranquilo');
const freedW = await page.evaluate(async () => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const rows = await new Promise((res, rej) => {
    const req = db.transaction('harvests', 'readonly').objectStore('harvests').getAll();
    req.onsuccess = () => res(req.result); req.onerror = rej;
  });
  db.close();
  return rows.filter((h) => !h.deletedAt && h.nodeId.startsWith('u-') && !h.preserveId).length;
});
ok('W soltar frees fruits + tombstones the jar', goneW && freedW >= 1 && freshBeforeW >= 1, `gone=${goneW} freed=${freedW}`);

// X — the count line lives ONLY on the detail; shelves are numberless.
await seedFresh(2, 'x');
await page.goto(`${BASE}/cosecha`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.locator('.promise-door').click();
await page.waitForTimeout(300);
await page.fill('#promise-premio', 'un premio X');
await page.locator('.vessel-chip').nth(0).click();
await page.locator('.create-btn').click();
await page.waitForTimeout(600);
const shelfText = ((await page.locator('.pending-shelf').textContent().catch(() => '')) ?? '').trim();
const detailFill = await page.locator('.fill-line').count();
ok(
  'X the count line is on the detail only; the shelf is numberless',
  !/le caben|lleva/.test(shelfText) && detailFill >= 1,
  `shelfHasCount=${/le caben|lleva/.test(shelfText)} detailFill=${detailFill}`,
);

// Y — fill «un premio X» (frasquito, 2), MAKE the jam (0.0.96), then open it
// via the existing ceremony. Since 0.0.108 name===premio, so the detail's
// premio CHIP hides (it would just re-quote the header) — the ceremony still
// speaks the premio verbatim, and that is the assertion that matters.
await page.locator('.add-fruit-btn').click(); // open the tray once
await page.waitForTimeout(250);
await page.locator('.add-pick', { hasText: 'Fruta x 1' }).click();
await page.waitForTimeout(400);
await page.locator('.add-pick', { hasText: 'Fruta x 2' }).click();
await page.waitForTimeout(600);
// filling no longer auto-seals — the user makes the jam (pour plays ~2.4s)
await page.locator('.make-jam-btn').first().click();
await page.waitForTimeout(400);
await page.locator('.make-sheet .make-btn').click(); // Envasar
await page.waitForTimeout(3200);
await page.locator('.toast button', { hasText: '✕' }).click().catch(() => {}); // dismiss made toast
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.locator('.alacena .jam-shelf-jar').first().click();
await page.waitForTimeout(400);
const premioChipY = await page.locator('.premio-chip').count();
await page.locator('.open-jam-btn').click();
await page.waitForTimeout(400);
await page.locator('.sheet button', { hasText: 'Abrir' }).click();
await page.waitForTimeout(500);
const earnedY = await page.locator('.sheet', { hasText: 'Te lo ganaste' }).count();
const premioSaidY = await page.locator('.sheet', { hasText: 'un premio X' }).count();
const rainY = await page.locator('.petal-fall .fall-petal').count();
ok(
  'Y sealed goal jar: chip hidden (name===premio), ceremony speaks the premio + rain',
  premioChipY === 0 && earnedY >= 1 && premioSaidY >= 1 && rainY >= 1,
  `premioChip=${premioChipY} earned=${earnedY} said=${premioSaidY} rain=${rainY}`,
);
await page.locator('.sheet button', { hasText: 'A disfrutarlo' }).click().catch(() => {});
await page.waitForTimeout(400);

// Z — filling from OUTSIDE (a sync merge places all fruits) does NOT auto-seal
// (0.0.96): the jar waits full + pending, offering «Hacer mermelada».
const zFresh = await seedFresh(5, 'z');
await page.goto(`${BASE}/cosecha`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.locator('.promise-door').click();
await page.waitForTimeout(300);
await page.fill('#promise-premio', 'un premio Z');
await page.locator('.vessel-chip').nth(1).click(); // frasco, capacity 5
await page.locator('.create-btn').click();
await page.waitForTimeout(500);
const jarZ = (await readJars()).find((j) => j.name === 'un premio Z');
// simulate a sync merge: place all 5 fruits directly (never through place())
await page.evaluate(async ({ ids, jarId }) => {
  const open = indexedDB.open('roadmap2u');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej; });
  const tx = db.transaction('harvests', 'readwrite');
  const os = tx.objectStore('harvests');
  for (const id of ids) {
    const row = await new Promise((res, rej) => { const r = os.get(id); r.onsuccess = () => res(r.result); r.onerror = rej; });
    row.preserveId = jarId; row.updatedAt = Date.now(); row.rev = (row.rev ?? 1) + 1;
    os.put(row);
  }
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  db.close();
}, { ids: zFresh, jarId: jarZ.id });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const zJar = (await readJars()).find((j) => j.name === 'un premio Z');
await page.locator('.pending-jar').first().click(); // «un premio Z» (only pending jar left)
await page.waitForTimeout(300);
const zMakeBtn = await page.locator('.make-jam-btn').count();
const zNoToast = (await page.locator('.toast', { hasText: 'Se llenó' }).count()) === 0;
ok(
  'Z an externally-filled jar waits (no auto-seal) + offers «Hacer mermelada»',
  !!zJar && zJar.sealedAt == null && zJar.members === 5 && zMakeBtn >= 1 && zNoToast,
  `sealedAt=${zJar?.sealedAt != null} members=${zJar?.members} makeBtn=${zMakeBtn}`,
);

// ── 0.0.94 «la cocina despejada» ─────────────────────────────────────────
// AA: the folded ritual — no separate fire step; «Envasar» sits on the first
// (pick) screen. AB: one panel at a time — opening a sealed jar closes the
// pending detail (single openId).

// AA — open the pot: «Al fuego» is gone, «Envasar» is on the pick screen.
await seedFresh(2, 'aa');
await page.goto(`${BASE}/cosecha`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.locator('.jam-door').click();
await page.waitForTimeout(500);
const alFuego = await page.locator('button', { hasText: 'Al fuego' }).count();
await page.locator('.fruit-pick', { hasText: 'Fruta aa 1' }).click();
await page.waitForTimeout(250);
const envasarOnPick = await page.locator('.jam-sheet button', { hasText: 'Envasar' }).count();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
ok(
  'AA folded ritual: no «Al fuego» step, «Envasar» on the pick screen',
  alFuego === 0 && envasarOnPick >= 1,
  `alFuego=${alFuego} envasarOnPick=${envasarOnPick}`,
);

// AB — one panel at a time. Make a pending jar, open it, then open a sealed
// jam: the pending panel must close (single openId).
await page.locator('.promise-door').click();
await page.waitForTimeout(300);
await page.fill('#promise-premio', 'un premio AB');
await page.locator('.vessel-chip').nth(1).click();
await page.locator('.create-btn').click();
await page.waitForTimeout(600);
// the wizard auto-opens the new jar's detail — the pending panel is already up
const panelsAfterPending = await page.locator('.jar-panel').count();
await page.locator('.alacena .jam-shelf-jar').first().click();
await page.waitForTimeout(400);
const panelsAfterSealed = await page.locator('.jar-panel').count();
const sealedPanel = await page.locator('#jar-panel').count();
const pendingPanelGone = (await page.locator('#pending-panel').count()) === 0;
ok(
  'AB one panel at a time (opening a sealed jar closes the pending detail)',
  panelsAfterPending === 1 && panelsAfterSealed === 1 && sealedPanel === 1 && pendingPanelGone,
  `pending=${panelsAfterPending} sealed=${panelsAfterSealed} isSealed=${sealedPanel} pendingGone=${pendingPanelGone}`,
);

console.log('conserveria done');
await browser.close();
