// Ordered pasitos (0.0.40): toggle, numbered list + reorder, chain rendering,
// bloom → next-step, Ahora's "step-in-order" reason + first→then footer.
import { BASE, launchPage } from './lib/harness.mjs';
const { browser, context, page } = await launchPage({ width: 900, height: 800 });

async function centers(p) {
  return p.evaluate(() => {
    const svg = document.querySelector('svg.canvas');
    const rect = svg.getBoundingClientRect();
    const t = (svg.querySelector(':scope > g').getAttribute('transform') ?? '').match(
      /translate\(([-\d.]+)\s+([-\d.]+)\)\s+scale\(([-\d.]+)\)/,
    );
    const [tx, ty, k] = t ? [Number(t[1]), Number(t[2]), Number(t[3])] : [0, 0, 1];
    const out = [];
    for (const g of svg.querySelectorAll('g.node')) {
      const nm = (g.getAttribute('transform') ?? '').match(/translate\(([-\d.]+)\s+([-\d.]+)\)/);
      if (!nm) continue;
      out.push({
        label: (g.getAttribute('aria-label') ?? '').split(' — ')[0],
        x: rect.left + Number(nm[1]) * k + tx,
        y: rect.top + Number(nm[2]) * k + ty,
      });
    }
    return out;
  });
}

// ---- Build: tree + 4 steps, toggle "in order" ---------------------------
await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.locator('button', { hasText: 'Empezar' }).click();
await page.waitForTimeout(250);
await page.locator('.skip').click();
await page.waitForURL('**/ahora**');
await page.locator('nav a', { hasText: 'bosque' }).click();
await page.waitForTimeout(400);
await page.locator('button', { hasText: 'Plantar mi primer árbol' }).click();
await page.fill('#tree-name', 'Aprender piano');
await page.locator('form.sheet button[type=submit]').click();
await page.waitForTimeout(400);
await page.locator('.plot').first().click();
await page.waitForTimeout(700);
const root = (await centers(page)).find((n) => n.label.startsWith('Aprender piano'));
await page.mouse.click(root.x, root.y);
await page.waitForTimeout(450);
for (const t of ['Paso 1', 'Paso 2', 'Paso 3', 'Paso 4']) {
  const input = page.locator('input[placeholder*="pasito"]');
  await input.fill(t);
  await input.press('Enter');
  await page.waitForTimeout(200);
}
await page.locator('.order-toggle input').check();
await page.waitForTimeout(300);

// A — ordered list UI: numbers, next-tag, arrows
const nums = await page.locator('.steps .step-num').count();
const firstRow = (await page.locator('.steps li').first().textContent()).replace(/\s+/g, ' ');
const okA = nums === 4 && firstRow.includes('Paso 1') && firstRow.includes('siguiente');
console.log(`A ordered UI: numbers=${nums} first-row="${firstRow.trim().slice(0, 40)}…" | OK=${okA}`);

// B — reorder: move "Paso 1" down; "Paso 2" becomes first + next
await page.locator('.steps li').first().locator('.reorder button').nth(1).click();
await page.waitForTimeout(350);
const firstAfter = (await page.locator('.steps li').first().textContent()).replace(/\s+/g, ' ');
const okB = firstAfter.includes('Paso 2') && firstAfter.includes('siguiente');
console.log(`B reorder: first-row="${firstAfter.trim().slice(0, 40)}…" | OK=${okB}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// C — persistence + chain rendering after reload
await page.goto(page.url(), { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const m = await centers(page);
const steps = m.nodes ? [] : m.filter((n) => n.label.startsWith('Paso'));
const xs = steps.map((s) => s.x);
const spread = Math.max(...xs) - Math.min(...xs);
const ys = steps.map((s) => s.y).sort((a, b) => b - a);
const gaps = ys.slice(0, -1).map((y, i) => y - ys[i + 1]);
// Screen-space gaps scale with the fit zoom (CHAIN_H 46 ± 16 jitter, k ≤ ~1.2).
const gapsOk = gaps.every((g) => g > 12 && g < 95);
const labels = await page.evaluate(() =>
  [...document.querySelectorAll('g.node .title')].map((t) => t.textContent.trim()).filter(Boolean),
);
const chainLabel = labels.filter((l) => l.startsWith('Paso')).length;
console.log(
  `C chain: steps=${steps.length} x-spread=${spread.toFixed(0)}px gaps=[${gaps.map((g) => g.toFixed(0)).join(',')}] step-labels=${chainLabel} (next only) | OK=${steps.length === 4 && spread < 60 && gapsOk && chainLabel === 1}`,
);
const rootC = (await centers(page)).find((n) => n.label.startsWith('Aprender piano'));
await page.mouse.click(rootC.x, rootC.y);
await page.waitForTimeout(450);
const toggleOn = await page.locator('.order-toggle input').isChecked();
const firstPersist = (await page.locator('.steps li').first().textContent()).replace(/\s+/g, ' ');
console.log(`C2 persisted: toggle=${toggleOn} first="${firstPersist.includes('Paso 2')}" | OK=${toggleOn && firstPersist.includes('Paso 2')}`);

// D — bloom the first step → "¿Siguiente paso?" glows the next one
await page.locator('.steps li').first().locator('button', { hasText: '🌸' }).click();
await page.waitForTimeout(400);
const toastAction = (await page.locator('.toast button, [class*=toast] button').first().textContent().catch(() => '')).trim();
await page.locator('.toast button, [class*=toast] button').first().click().catch(() => {});
await page.waitForTimeout(300);
const glow = await page.locator('.steps li.glow').count();
console.log(`D bloom→next: action="${toastAction}" glow=${glow} | OK=${toastAction.includes('Siguiente') && glow === 1}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// E — Ahora: "El siguiente paso de…" + first→then footer
await page.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const nextTitle = (await page.locator('.next-title').textContent()).trim();
const reason = (await page.locator('.reason').textContent()).trim();
const firstThen = (await page.locator('.card.next .secondary').textContent().catch(() => '')).trim();
const okE = reason.includes('El siguiente paso de') && firstThen.startsWith('Primero:') && nextTitle === 'Paso 1';
console.log(`E ahora: next="${nextTitle}" reason="${reason}" first-then="${firstThen}" | OK=${okE}`);

await browser.close();
console.log('steps done');
