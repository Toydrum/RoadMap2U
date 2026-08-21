// Labels (0.0.59): every branch name always visible, never overlapping,
// never "…"-cut — identical at every zoom (tree-labels.ts law).
import { BASE, launchPage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 1200, height: 850 });

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

/** Snapshot the painted labels. Packed labels carry screen rects for the
 *  overlap check; the focused cartouche (an ON-TOP overlay by design) counts
 *  for presence but is excluded from overlap math. */
async function labelSnapshot() {
  return page.evaluate(() => {
    const packed = [...document.querySelectorAll('g.tag:not(.focus-tag) text.title')].map((t) => {
      const r = t.getBoundingClientRect();
      return { text: t.textContent?.trim() ?? '', x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const cartouche = [...document.querySelectorAll('g.tag.focus-tag text.title')].map(
      (t) => t.textContent?.trim() ?? '',
    );
    return { packed, cartouche, total: packed.length + cartouche.length };
  });
}

function overlapCount(labels) {
  let count = 0;
  const SLOP = 2; // stroke-halo anti-aliasing tolerance
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i];
      const b = labels[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > SLOP && oy > SLOP) count++;
    }
  }
  return count;
}

async function zoom(times, dir) {
  for (let i = 0; i < times; i++) {
    await page.locator('.zoom-btn', { hasText: dir }).click();
  }
  await page.waitForTimeout(400);
}

// ── A: demo tree — stability across zooms, zero ellipsis, zero overlap ─────
await page.goto(`${BASE}/tree/demo-guitar?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const atFit = await labelSnapshot();
await zoom(3, '−');
const zoomedOut = await labelSnapshot();
await zoom(5, '+');
const zoomedIn = await labelSnapshot();

const sameCount = atFit.total === zoomedOut.total && atFit.total === zoomedIn.total;
const textsOf = (s) => JSON.stringify(s.packed.map((l) => l.text).sort());
const sameTexts = textsOf(atFit) === textsOf(zoomedOut) && textsOf(atFit) === textsOf(zoomedIn);
const noEllipsis = [...atFit.packed, ...zoomedOut.packed, ...zoomedIn.packed].every(
  (l) => !l.text.includes('…'),
);
const overlapsA =
  overlapCount(atFit.packed) + overlapCount(zoomedOut.packed) + overlapCount(zoomedIn.packed);
const okA = sameCount && sameTexts && noEllipsis && overlapsA === 0 && atFit.total >= 7;
console.log(
  `A zoom-stable demo: count=${atFit.total}/${zoomedOut.total}/${zoomedIn.total} sameTexts=${sameTexts} noEllipsis=${noEllipsis} overlaps=${overlapsA} | OK=${okA}`,
);

// ── B: torture fan — 9 long-named siblings, all named, none colliding ──────
await page.goto(`${BASE}/forest`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('button', { hasText: 'Plantar un árbol' }).first().click();
await page.fill('#tree-name', 'Tortura');
await page.locator('form.sheet button[type=submit]').click();
await page.waitForTimeout(900);
await page.locator('.plot', { hasText: 'Tortura' }).click();
await page.waitForTimeout(1200);

const longNames = [
  'Preparar la presentación larga del proyecto de titulación',
  'Conseguir todos los materiales para el taller de carpintería',
  'Escribir el primer borrador completo de la novela corta',
  'Organizar el archivo fotográfico familiar de los últimos años',
  'Investigar opciones de financiamiento para el proyecto',
  'Aprender los fundamentos de la fotografía con luz natural',
  'Construir la mesa de trabajo del estudio con madera reciclada',
  'Planear el viaje largo por la costa con todas las paradas',
  'Documentar el proceso completo en el cuaderno de bitácora',
];
await page.locator('.bar .plant').click();
await page.waitForTimeout(500);
await page.locator('label', { hasText: 'Varios a la vez' }).click();
await page.fill('#sow-box', longNames.join('\n'));
await page.locator('form.sheet button[type=submit]').click();
await page.waitForTimeout(1200);
await page.keyboard.press('Escape');
await page.waitForTimeout(1200);

const torture = await labelSnapshot();
await zoom(3, '−');
const tortureOut = await labelSnapshot();
const tortureStable = torture.total === tortureOut.total;
const tortureAllNamed = torture.total >= 10; // root branch + 9 siblings
const tortureNoEllipsis = torture.packed.every((l) => !l.text.includes('…'));
const tortureOverlaps = overlapCount(torture.packed) + overlapCount(tortureOut.packed);
const okB = tortureStable && tortureAllNamed && tortureNoEllipsis && tortureOverlaps === 0;
console.log(
  `B torture fan: labels=${torture.total} stable=${tortureStable} noEllipsis=${tortureNoEllipsis} overlaps=${tortureOverlaps} | OK=${okB}`,
);

// ── C: determinism — reload rebuilds the byte-identical WORLD field ────────
// (world attrs, not screen rects: pan history must not pollute the compare;
//  focus is gone after reload, so compare packed labels only by content.)
const worldField = () =>
  page.evaluate(() =>
    JSON.stringify(
      [...document.querySelectorAll('g.tag:not(.focus-tag) text.title')]
        .map((t) => [
          t.textContent?.trim() ?? '',
          t.getAttribute('y'),
          t.querySelector('tspan')?.getAttribute('x') ?? '',
          t.style.fontSize,
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  );
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const before = await worldField();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const afterReload = await worldField();
const okC = before === afterReload;
console.log(`C deterministic reload: identical=${okC} | OK=${okC}`);

console.log(`invariants: pageErrors=${pageErrors.length} | OK=${pageErrors.length === 0}`);
if (pageErrors.length) console.log(pageErrors.join('\n'));

await browser.close();
console.log('labels done');
