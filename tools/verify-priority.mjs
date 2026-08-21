// «La luz» (0.0.60): per-branch priority as light — set in the sheet, seen
// in the tablita/canvas/Ahora, biasing but never tyrannizing, private to
// friends, and never moving the tree.
import { BASE, launchPage, newProbePage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 1200, height: 850 });

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const sheetChip = (label) => page.locator('.light-row .chip', { hasText: label });

// ── A: sheet picker — set, reflect, persist ─────────────────────────────────
await page.goto(`${BASE}/tree/demo-work?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
// demo-w-idea is seeded sunlit; open its sheet via the tablita double-tap.
await page.locator('.tree-outline-toggle').click();
await page.locator('app-tree-outline .row', { hasText: 'Aterrizar la idea' }).click();
await page.locator('app-tree-outline .row', { hasText: 'Aterrizar la idea' }).click();
await page.locator('.light-row').waitFor({ timeout: 6000 });
const sunSelected = await sheetChip('A pleno sol').getAttribute('class');
await sheetChip('A la sombra').click();
await page.waitForTimeout(600);
const shadeSelected = await sheetChip('A la sombra').getAttribute('class');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
await page.locator('.tree-outline-toggle').click();
await page.locator('app-tree-outline .row', { hasText: 'Aterrizar la idea' }).click();
await page.locator('app-tree-outline .row', { hasText: 'Aterrizar la idea' }).click();
await page.locator('.light-row').waitFor({ timeout: 6000 });
const persisted = await sheetChip('A la sombra').getAttribute('class');
await sheetChip('A pleno sol').click(); // restore the fixture
await page.waitForTimeout(600);
const okA =
  sunSelected.includes('selected') && shadeSelected.includes('selected') && persisted.includes('selected');
console.log(`A sheet picker: seeded-sun=${sunSelected.includes('selected')} set-shade=${shadeSelected.includes('selected')} persisted=${persisted.includes('selected')} | OK=${okA}`);
await page.keyboard.press('Escape');

// ── B: default state — «A su ritmo» selected, no badge ─────────────────────
// 0.0.112: 'Lanzar mi proyecto' is a container HEART now (heading row, no
// light) — a plain CHILD carries the default-state assertion instead.
await page.goto(`${BASE}/tree/demo-health`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.locator('.tree-outline-toggle').click();
await page.locator('app-tree-outline .row', { hasText: 'Caminar 3 veces' }).click();
await page.locator('app-tree-outline .row', { hasText: 'Caminar 3 veces' }).click();
await page.locator('.light-row').waitFor({ timeout: 6000 });
const steadySelected = await sheetChip('A su ritmo').getAttribute('class');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.locator('.tree-outline-toggle').click();
await page.waitForTimeout(300);
const rootBadges = await page
  .locator('app-tree-outline .row', { hasText: 'Caminar 3 veces' })
  .locator('.sun-badge')
  .count();
const okB = steadySelected.includes('selected') && rootBadges === 0;
console.log(`B default: steady-selected=${steadySelected.includes('selected')} unbadged=${rootBadges === 0} | OK=${okB}`);
await page.goto(`${BASE}/tree/demo-work`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// ── C: trigger still outranks sunlit (bias, not tyranny) ───────────────────
await page.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const nextTitle = (await page.locator('.next-title').textContent())?.trim();
const reason = (await page.locator('.next .reason').first().textContent()) ?? '';
const okC = nextTitle === '10 min al despertar' && reason.includes('🧶');
console.log(`C twig outranks sun: title="${nextTitle}" twig-reason=${reason.includes('🧶')} | OK=${okC}`);

// ── D+E on a FRESH store: sunlit wins ambient; shade yields but reachable ───
const { page: fresh } = await newProbePage(browser, { width: 1200, height: 850 });
fresh.on('pageerror', (error) => pageErrors.push(String(error)));
await fresh.goto(`${BASE}/forest`, { waitUntil: 'networkidle' });
await fresh.waitForTimeout(900);
// plant two trees from the empty-meadow starters-free path
for (const name of ['Alfa', 'Beta']) {
  await fresh.locator('button', { hasText: /Plantar (mi primer árbol|un árbol)/ }).first().click();
  await fresh.fill('#tree-name', name);
  await fresh.locator('form.sheet button[type=submit]').click();
  await fresh.waitForTimeout(900);
  await fresh.keyboard.press('Escape').catch(() => {});
  await fresh.waitForTimeout(300);
}
// sun Beta's root branch via its sheet
await fresh.locator('.plot', { hasText: 'Beta' }).click();
await fresh.waitForTimeout(1200);
await fresh.locator('.canvas g.node').first().click({ force: true });
await fresh.locator('.light-row').waitFor({ timeout: 6000 });
await fresh.locator('.light-row .chip', { hasText: 'A pleno sol' }).click();
await fresh.waitForTimeout(600);
await fresh.keyboard.press('Escape');
/** /ahora may divert to the check-in once per app-open — a brand-new store
 *  greets first (welcome step), then the ritual; skip both kindly. */
const gotoAhora = async (p) => {
  await p.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const welcome = p.locator('button', { hasText: 'Empezar' });
  if (await welcome.count()) {
    await welcome.click();
    await p.waitForTimeout(700);
  }
  const skip = p.locator('button', { hasText: 'Hoy no quiero responder' });
  if (await skip.count()) {
    await skip.click();
    await p.waitForTimeout(1000);
  }
};
await gotoAhora(fresh);
const freshTitle = (await fresh.locator('.next-title').textContent())?.trim();
const freshReason = (await fresh.locator('.next .reason').first().textContent()) ?? '';
const okD = freshTitle === 'Beta' && freshReason.includes('☀️');
console.log(`D sunlit wins ambient: title="${freshTitle}" sun-reason=${freshReason.includes('☀️')} | OK=${okD}`);

// E: shade yields the AMBIENT turn. Plant Gamma (becomes the 📍 thread —
// deliberate paths ignore shade BY DESIGN), then shade Beta: in the
// today-picker grid (= the pool in rank order) Alfa must now precede Beta,
// and cycling to Beta shows the quiet aside.
await fresh.goto(`${BASE}/forest`, { waitUntil: 'networkidle' });
await fresh.waitForTimeout(800);
await fresh.locator('button', { hasText: 'Plantar un árbol' }).first().click();
await fresh.fill('#tree-name', 'Gamma');
await fresh.locator('form.sheet button[type=submit]').click();
await fresh.waitForTimeout(900);
await fresh.keyboard.press('Escape').catch(() => {});
await fresh.waitForTimeout(300);
const setLight = async (treeName, chipLabel) => {
  await fresh.goto(`${BASE}/forest`, { waitUntil: 'networkidle' });
  await fresh.waitForTimeout(800);
  await fresh.locator('.plot', { hasText: treeName }).click();
  await fresh.waitForTimeout(1200);
  await fresh.locator('.canvas g.node').first().click({ force: true });
  await fresh.locator('.light-row').waitFor({ timeout: 6000 });
  await fresh.locator('.light-row .chip', { hasText: chipLabel }).click();
  await fresh.waitForTimeout(600);
  await fresh.keyboard.press('Escape');
  await fresh.waitForTimeout(300);
};
await setLight('Beta', 'A la sombra'); // was sunlit — now yields
await gotoAhora(fresh);
await fresh.locator('button', { hasText: 'Elegir mis ramas de hoy' }).click();
await fresh.locator('.pick-grid').waitFor({ timeout: 6000 });
const gridChips = await fresh.locator('.pick-grid .pick-chip').allTextContents();
const iAlfa = gridChips.findIndex((c) => c.includes('Alfa'));
const iBeta = gridChips.findIndex((c) => c.includes('Beta'));
await fresh.keyboard.press('Escape');
await fresh.waitForTimeout(400);
let reachedShaded = false;
let sawAside = false;
for (let i = 0; i < 5; i++) {
  const t = (await fresh.locator('.next-title').textContent())?.trim();
  if (t === 'Beta') {
    reachedShaded = true;
    sawAside = (await fresh.locator('.shade-aside').count()) > 0;
    break;
  }
  const cycle = fresh.locator('button', { hasText: 'Otra idea' });
  if (!(await cycle.count())) break;
  await cycle.click();
  await fresh.waitForTimeout(500);
}
const okE = iAlfa !== -1 && iBeta !== -1 && iAlfa < iBeta && reachedShaded && sawAside;
console.log(
  `E shade yields ambient: pool-order alfa@${iAlfa} < beta@${iBeta}=${iAlfa < iBeta} otra-idea-reaches=${reachedShaded} aside=${sawAside} | OK=${okE}`,
);
await fresh.close();

// ── F+G: the lens is a LENS (tree never moves) + cycle round-trip ───────────
await page.goto(`${BASE}/tree/demo-guitar`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
const positionsBefore = await page.evaluate(() =>
  JSON.stringify([...document.querySelectorAll('g.node')].map((g) => g.getAttribute('transform'))),
);
await page.locator('.tree-outline-toggle').click();
await page.locator('app-tree-outline .lens').click();
await page.waitForTimeout(400);
const cycleButtons = await page.locator('app-tree-outline .light-cycle').count();

// Sun the SECOND sibling of an ordered-free pair — the lens must lift it
// above its sibling in the LIST while the canvas stays byte-identical.
const rowIndexOf = async (name) => {
  const names = await page.locator('app-tree-outline .row .name').allTextContents();
  return names.findIndex((n) => n.includes(name));
};
const before10 = await rowIndexOf('10 min');
const beforeSes = await rowIndexOf('Sesión larga');
const sesCycle = page.locator('app-tree-outline li', { hasText: 'Sesión larga' }).locator('.light-cycle');
await sesCycle.click(); // ritmo → sol
await page.waitForTimeout(500);
const after10 = await rowIndexOf('10 min');
const afterSes = await rowIndexOf('Sesión larga');
const positionsAfter = await page.evaluate(() =>
  JSON.stringify([...document.querySelectorAll('g.node')].map((g) => g.getAttribute('transform'))),
);
const okF =
  positionsBefore === positionsAfter &&
  cycleButtons > 0 &&
  beforeSes > before10 &&
  afterSes < after10;
console.log(
  `F lens is a lens: positions-identical=${positionsBefore === positionsAfter} resort ses ${beforeSes}→${afterSes} vs 10min ${before10}→${after10} cycle-buttons=${cycleButtons} | OK=${okF}`,
);
// restore the fixture: sol → sombra → ritmo
await sesCycle.click();
await page.waitForTimeout(400);
await sesCycle.click();
await page.waitForTimeout(400);

const cycleBtn = page
  .locator('app-tree-outline li', { hasText: 'Mi primera canción' })
  .locator('.light-cycle');
const s0 = await cycleBtn.getAttribute('title');
await cycleBtn.click();
await page.waitForTimeout(500);
const s1 = await cycleBtn.getAttribute('title');
await cycleBtn.click();
await page.waitForTimeout(500);
await cycleBtn.click();
await page.waitForTimeout(500);
const s3 = await cycleBtn.getAttribute('title');
const okG = s0 === 'A su ritmo' && s1 === 'A pleno sol' && s3 === 'A su ritmo';
console.log(`G cycle round-trip: ${s0} → ${s1} → … → ${s3} | OK=${okG}`);

// ── H: strip — the guardian sees/sets the light; the friend sees nothing ────
const { page: fam } = await newProbePage(browser, { width: 1200, height: 900 });
fam.on('pageerror', (error) => pageErrors.push(String(error)));
const signIn = async (user, pass) => {
  await fam.goto(`${BASE}/account`, { waitUntil: 'networkidle' });
  await fam.waitForTimeout(400);
  const signOut = fam.locator('button', { hasText: 'Cerrar sesión' });
  if (await signOut.count()) {
    await signOut.click();
    await fam.waitForTimeout(800);
  }
  await fam.locator('button', { hasText: 'Ya tengo mi llave' }).click();
  await fam.fill('.auth-form input[autocomplete="username"]', user);
  await fam.fill('.auth-form input[type="password"]', pass);
  await fam.locator('.auth-form button[type=submit]').click();
  await fam.locator('h1', { hasText: 'Tu cuenta' }).waitFor({ timeout: 9000 });
};
await signIn('rocio', 'Bosque123');
await fam.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await fam.locator('.familia').waitFor();
await fam.waitForTimeout(900);
await fam.locator('.fam-open', { hasText: 'Val' }).click();
await fam.locator('.familia-sheet button', { hasText: 'Entrar a su bosque' }).click();
await fam.locator('h1', { hasText: 'El jardín de Val' }).waitFor({ timeout: 10000 });
await fam.waitForTimeout(700);
await fam.locator('.visita-plot').first().click();
await fam.waitForTimeout(1400);
// The guardian toolkit includes the light: the tablita lens is offered and a
// cycle WRITES THROUGH to the kid's cloud forest (round-tripped clean).
await fam.locator('.tree-outline-toggle').waitFor({ timeout: 8000 });
await fam.locator('.tree-outline-toggle').click();
await fam.locator('app-tree-outline').waitFor({ timeout: 6000 });
await fam.waitForTimeout(400);
const guardianLens = await fam.locator('app-tree-outline .lens').count();
let guardianCycles = false;
if (guardianLens) {
  await fam.locator('app-tree-outline .lens').click();
  await fam.waitForTimeout(400);
  const btn = fam.locator('app-tree-outline .light-cycle').first();
  const t0 = await btn.getAttribute('title');
  await btn.click();
  await fam.waitForTimeout(700);
  const t1 = await btn.getAttribute('title');
  guardianCycles = t0 !== t1;
  // restore: keep cycling until back to the original
  for (let i = 0; i < 2 && (await btn.getAttribute('title')) !== t0; i++) {
    await btn.click();
    await fam.waitForTimeout(600);
  }
}

// friend visit (val → ambar) is look-only AND stripped: no ☀️ anywhere,
// and the tablita offers no lens.
await signIn('val', 'Bosque123');
await fam.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await fam.locator('.amigos').waitFor();
await fam.waitForTimeout(900);
await fam.locator('.amigos-row button', { hasText: 'Visitar' }).first().click();
await fam.locator('h1', { hasText: 'El jardín de' }).waitFor({ timeout: 10000 });
await fam.waitForTimeout(700);
await fam.locator('.visita-plot').first().click();
await fam.waitForTimeout(1400);
const friendSuns = await fam.evaluate(
  () =>
    document.querySelectorAll(
      '.light-halo, .rayito, .sun-badge, .label-pill, .sun-rays, .sign-sun, .sombrilla',
    ).length,
);
await fam.locator('.tree-outline-toggle').click();
await fam.waitForTimeout(400);
const friendLens = await fam.locator('app-tree-outline .lens').count();
const okH = guardianLens > 0 && guardianCycles && friendSuns === 0 && friendLens === 0;
console.log(
  `H strip: guardian-lens=${guardianLens > 0} guardian-cycles=${guardianCycles} friend-suns=${friendSuns} friend-lens=${friendLens} | OK=${okH}`,
);
await fam.close();

// ── J: 0.0.62 robust visuals — sun package, shade package, sign, capullo ───
await page.goto(`${BASE}/tree/demo-work?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
const sunVisuals = await page.evaluate(() => ({
  halo: document.querySelectorAll('.light-halo').length,
  rays: document.querySelectorAll('.sun-rays').length,
  sunPill: document.querySelectorAll('.label-pill.sun').length,
  capullo: document.querySelectorAll('.glyph.capullo').length,
  haloR: document.querySelector('.light-halo')?.getAttribute('r'),
}));
const okJ1 =
  sunVisuals.halo > 0 &&
  sunVisuals.rays > 0 &&
  sunVisuals.sunPill > 0 &&
  sunVisuals.capullo > 0 &&
  sunVisuals.haloR === '40';
console.log(
  `J1 sun package: halo=${sunVisuals.halo} rays=${sunVisuals.rays} pill=${sunVisuals.sunPill} capullo=${sunVisuals.capullo} r=${sunVisuals.haloR} | OK=${okJ1}`,
);

await page.goto(`${BASE}/tree/demo-guitar`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
const shadeVisuals = await page.evaluate(() => ({
  parasolLeaves: document.querySelectorAll('.sombrilla .shade-leaf').length,
  shadePill: document.querySelectorAll('.label-pill.shade').length,
}));
const okJ2 = shadeVisuals.parasolLeaves >= 4 && shadeVisuals.shadePill > 0;
console.log(
  `J2 shade package: parasol-leaves=${shadeVisuals.parasolLeaves} pill=${shadeVisuals.shadePill} | OK=${okJ2}`,
);

await page.goto(`${BASE}/forest`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const signSuns = await page.locator('.sign-sun').count();
const okJ3 = signSuns > 0; // demo-work holds the sunlit fixture
console.log(`J3 meadow sign: sign-suns=${signSuns} | OK=${okJ3}`);

// ── I: timer — the sunlit chip leads with ☀️ ────────────────────────────────
await page.goto(`${BASE}/timer`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
const chips = await page.locator('.pick-node .chip').allTextContents();
const sunChip = chips.find((c) => c.includes('☀️'));
const okI = !!sunChip && sunChip.includes('Aterrizar');
console.log(`I timer chip: sun-chip="${(sunChip ?? '').trim().slice(0, 40)}" | OK=${okI}`);

console.log(`invariants: pageErrors=${pageErrors.length} | OK=${pageErrors.length === 0}`);
if (pageErrors.length) console.log(pageErrors.join('\n'));

await browser.close();
console.log('priority done');
