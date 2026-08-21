// The natural meadow (0.0.43): scattered clearings — sky safety, determinism,
// drag-that-moves-trees, arrows/dots pagination, mobile fit.
import { BASE, launchPage, newProbePage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 1280, height: 800 });

const names = ['Guitarra', 'Cuidarme', 'Negocio', 'Inglés', 'Cocina', 'Lectura', 'Amigos', 'Jardín', 'Dibujo', 'Ahorro', 'Fotos', 'Huerto', 'Yoga', 'Piano', 'Viaje', 'Club'];
let planted = 0;

await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.locator('button', { hasText: 'Empezar' }).click();
await page.waitForTimeout(250);
await page.locator('.skip').click();
await page.waitForURL('**/ahora**');
await page.locator('nav a', { hasText: 'bosque' }).click();
await page.waitForTimeout(400);

async function plantUpTo(n) {
  while (planted < n) {
    const opener = planted === 0 ? 'Plantar mi primer árbol' : 'Plantar un árbol';
    await page.locator(`button:has-text("${opener}")`).first().click();
    await page.fill('#tree-name', names[planted]);
    await page.locator('form.sheet button[type=submit]').click();
    await page.waitForTimeout(180);
    planted++;
  }
  await page.waitForTimeout(300);
  while (await page.locator('.clearing-nav.prev:not([disabled])').count()) {
    await page.locator('.clearing-nav.prev').click();
    await page.waitForTimeout(220);
  }
  // Park the mouse OFF the meadow — the pagination clicks leave it hovering
  // near the plots, and hover's z 200 can cover a neighbor's center just
  // long enough to flake the hearts check (elementFromPoint reads stacking).
  await page.mouse.move(5, 5);
  await page.waitForTimeout(120);
}

const plotRects = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.plot')].map((p) => {
      const r = p.getBoundingClientRect();
      return { id: p.dataset.treeId, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
    }),
  );

// A — sky safety across sizes + every visible tree keeps a tappable heart
// (elementFromPoint at its center resolves to ITSELF — the archive regression).
for (const n of [1, 5, 10, 16]) {
  await plantUpTo(n);
  const rects = await plotRects();
  const skyline = await page.evaluate(() => innerHeight - Math.min(430, 0.54 * innerHeight) - 160);
  const minTop = Math.min(...rects.map((r) => r.top));
  const arrows = await page.locator('.clearing-nav').count();
  const dots = await page.locator('.clearing-dots .dot').count();
  const expectPages = Math.ceil(n / 6);
  const hearts = await page.evaluate(() =>
    [...document.querySelectorAll('.plot')].every((p) => {
      const r = p.getBoundingClientRect();
      const el = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      return el?.closest('[data-tree-id]') === p;
    }),
  );
  const ok = minTop > skyline && hearts && (expectPages > 1 ? arrows === 2 && dots === expectPages : arrows === 0);
  console.log(`A n=${n}: visible=${rects.length} minTop=${minTop} (skyline<${Math.round(skyline)}) hearts=${hearts} arrows=${arrows} dots=${dots} | OK=${ok}`);
}

// B — determinism: same rects across a reload.
const before = await plotRects();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
while (await page.locator('.clearing-nav.prev:not([disabled])').count()) {
  await page.locator('.clearing-nav.prev').click();
  await page.waitForTimeout(220);
}
const after = await plotRects();
const same =
  before.length === after.length &&
  before.every((b) => {
    const a = after.find((x) => x.id === b.id);
    return a && Math.abs(a.left - b.left) <= 1 && Math.abs(a.top - b.top) <= 1;
  });
console.log(`B determinism across reload: ${same} | OK=${same}`);

// C — drag reorders AND both trees move (swap anchors).
{
  const rects = await plotRects();
  const [a, b] = rects;
  const cx = (r) => (r.left + r.right) / 2;
  const cy = (r) => (r.top + r.bottom) / 2;
  await page.mouse.move(cx(a), cy(a));
  await page.mouse.down();
  await page.waitForTimeout(300); // mouse hold beats the 250ms timer
  // C2 — mid-drag the carried plot rides the pointer (0.0.64): grabbed at
  // its center, the plot's center-x must track the mouse 1:1.
  const mx = (cx(a) + cx(b)) / 2;
  const my = cy(a) - 40;
  await page.mouse.move(mx, my, { steps: 6 });
  await page.waitForTimeout(150); // zoneless CD is frame-scheduled
  const carried = await page.evaluate((id) => {
    const r = document.querySelector(`[data-tree-id="${id}"]`).getBoundingClientRect();
    return (r.left + r.right) / 2;
  }, a.id);
  const followDx = Math.abs(carried - mx);
  console.log(`C2 pointer-follow: dx=${Math.round(followDx)} | OK=${followDx < 40}`);
  await page.mouse.move(cx(b), cy(b), { steps: 8 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForTimeout(700); // > 0.45s settle glide
  const moved = await plotRects();
  const aNow = moved.find((r) => r.id === a.id);
  const swapped = aNow && Math.abs(aNow.left - a.left) > 40;
  console.log(`C drag: "${a.id?.slice(0, 6)}" moved ${Math.abs((aNow?.left ?? 0) - a.left)}px | OK=${!!swapped}`);
}

// D — keyboard nudge still reorders.
{
  const rects = await plotRects();
  const first = rects[0];
  await page.locator(`[data-tree-id="${first.id}"]`).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  const now = await plotRects();
  const firstNow = now.find((r) => r.id === first.id);
  const movedK = firstNow && Math.abs(firstNow.left - first.left) > 40;
  console.log(`D keyboard nudge: moved=${!!movedK} | OK=${!!movedK}`);
}

// E — arrows page through disjoint tree sets.
{
  const page1 = new Set((await plotRects()).map((r) => r.id));
  await page.locator('.clearing-nav.next').click();
  await page.waitForTimeout(400);
  const page2 = new Set((await plotRects()).map((r) => r.id));
  const disjoint = [...page2].every((id) => !page1.has(id));
  console.log(`E pagination: page1=${page1.size} page2=${page2.size} disjoint=${disjoint} | OK=${disjoint && page2.size > 0}`);
}

// F — mobile: everything visible fits the viewport and the band.
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const mob = await plotRects();
const dotsM = await page.locator('.clearing-dots .dot').count();
const fits = mob.every((r) => r.left >= -6 && r.right <= 396 && r.top > 200);
// Phones hold THREE per clearing (0.0.63 — four grown crowns jostle at 390px).
console.log(`F mobile: visible=${mob.length} dots=${dotsM} all-inside=${fits} | OK=${mob.length === 3 && dotsM === 6 && fits}`);

// G — DRY FEET on a WIDE window (Hector's case): no trunk stands in the river.
await page.setViewportSize({ width: 1700, height: 800 });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const wet = await page.evaluate(() => {
  const w = innerWidth;
  const h = innerHeight;
  const sceneH = Math.min(460, 0.58 * h);
  const scale = Math.max(w / 1000, sceneH / 260);
  const visibleVb = w / scale;
  const sceneBottom = document.querySelector('.scene').getBoundingClientRect().bottom;
  const offenders = [];
  for (const p of document.querySelectorAll('.plot')) {
    const r = p.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    // The PAINTED trunk base: GROUND=150 in the mini's 160-high viewBox —
    // measure the real pixel instead of a fixed offset (earned-size scales
    // small trees down, so any fixed approximation drifts wet or dry).
    const svg = p.querySelector('svg.mini');
    const sr = svg ? svg.getBoundingClientRect() : r;
    const trunkBaseY = sr.bottom - sr.height * (10 / 160);
    const xVb = 500 - visibleVb / 2 + (cx / w) * visibleVb;
    let best = { d: Infinity, y: 150, half: 17 };
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const u = 1 - t;
      const bx = u * u * u * 1060 + 3 * u * u * t * 700 + 3 * u * t * t * 400 + t * t * t * -60;
      const by = u * u * u * 96 + 3 * u * u * t * 168 + 3 * u * t * t * 76 + t * t * t * 208;
      if (Math.abs(bx - xVb) < best.d) best = { d: Math.abs(bx - xVb), y: by, half: (22 + 24 * t) / 2 };
    }
    const waterTopY = sceneBottom - (260 - (best.y - best.half)) * scale;
    const waterBottomY = sceneBottom - (260 - (best.y + best.half)) * scale;
    if (trunkBaseY > waterTopY && trunkBaseY < waterBottomY) {
      offenders.push(p.dataset.treeId?.slice(0, 6));
    }
  }
  return offenders;
});
console.log(`G dry feet @1700px: wet-trunks=[${wet.join(' ')}] | OK=${wet.length === 0}`);

// H — earned size: a worked tree stands visibly taller than a fresh sprout.
{
  const { page: page2 } = await newProbePage(browser, { width: 1280, height: 800 });
  await page2.goto(`${BASE}/forest?seed=demo`, { waitUntil: 'networkidle' });
  await page2.waitForTimeout(700);
  // Measure the PAINTED tree (svg content bbox), not the plot box — the
  // internal fit cap is what makes size honest (a tall skinny sapling must
  // never out-render a worked crown).
  const sizes = await page2.evaluate(() =>
    [...document.querySelectorAll('.plot')].map((p) => {
      const svg = p.querySelector('svg.mini');
      const scale = svg.getBoundingClientRect().width / 140;
      return { id: p.dataset.treeId, h: Math.round(svg.getBBox().height * scale) };
    }),
  );
  const guitar = sizes.find((s) => s.id === 'demo-guitar')?.h ?? 0; // 8 branches · 2 blooms
  const idea = sizes.find((s) => s.id === 'demo-seedling')?.h ?? 0; // 1 branch
  const hearts = await page2.evaluate(() =>
    [...document.querySelectorAll('.plot')].every((p) => {
      const r = p.getBoundingClientRect();
      const el = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      return el?.closest('[data-tree-id]') === p;
    }),
  );
  console.log(
    `H earned size: guitarra(8r·2🌸)=${guitar}px vs idea(1r)=${idea}px ratio=${(guitar / idea).toFixed(2)} hearts=${hearts} | OK=${guitar > idea * 1.25 && hearts}`,
  );
  await page2.close();
}

await browser.close();
console.log('meadow done');
