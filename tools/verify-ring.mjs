import { BASE, launchPage } from './lib/harness.mjs';
const { browser, context, page } = await launchPage({ width: 900, height: 800 });

// Fresh store: welcome once, skip the ritual (lands on /ahora), head to the forest.
await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.locator('button', { hasText: 'Empezar' }).click();
await page.waitForTimeout(300);
await page.locator('.skip').click();
await page.waitForURL('**/ahora**');
await page.goto(`${BASE}/forest`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
for (let i = 1; i <= 12; i++) {
  const opener = i === 1 ? 'Plantar mi primer árbol' : 'Plantar un árbol';
  await page.locator(`button:has-text("${opener}")`).first().click();
  await page.fill('#tree-name', `Árbol de prueba número ${i}`);
  await page.locator('form.sheet button[type=submit]').click();
  await page.waitForTimeout(120);
}
console.log('planted:', await page.locator('.plot').count(), 'trees');

async function measureRing(p, vw, vh, label) {
  await p.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
  await p.locator('.feeling').first().click();
  // Two-screen ritual: the ring lives right on the destination step.
  await p.waitForSelector('.ring-tree');
  await p.waitForTimeout(1400); // let the entrance cascade finish
  const rects = await p.evaluate(() =>
    [...document.querySelectorAll('.ring-tree')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
  let worst = 0;
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const ratio = (ox * oy) / Math.min(a.w * a.h, b.w * b.h);
      worst = Math.max(worst, ratio);
    }
  const inside = rects.every((r) => r.x >= -2 && r.y >= -2 && r.x + r.w <= vw + 2);
  console.log(
    `${label}: ${rects.length} minis, worst overlap ${(worst * 100).toFixed(0)}%, inside-viewport=${inside} | OK=${rects.length === 12 && worst < 0.25 && inside}`,
  );
  await p.screenshot({ path: `${process.argv[2] ?? '.'}/ring-${label}.png` });
}

await measureRing(page, 900, 800, 'desktop');
const mobile = await context.newPage();
await mobile.setViewportSize({ width: 360, height: 740 });
await measureRing(mobile, 360, 740, 'mobile');

await browser.close();
