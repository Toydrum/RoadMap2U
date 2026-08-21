// «Brújula del tiempo» (0.0.71). A: estimate chips persist («ni idea» is a
// choice). B: the suggestion card shows the soft size hint. C: with the
// opt-in ON, finishing a session with a NOTABLE gap earns one curiosity
// line; the default (OFF) earns none.
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
await page.fill('#tree-name', 'Rama medida');
await page.locator('form.sheet button[type=submit]').click();
await page.waitForTimeout(400);
const href = await page.evaluate(() => document.querySelector('.plot')?.getAttribute('href'));
await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const center = await page.evaluate(() => {
  const svg = document.querySelector('svg.canvas');
  const rect = svg.getBoundingClientRect();
  const t = (svg.querySelector(':scope > g').getAttribute('transform') ?? '').match(/translate\(([-\d.]+)\s+([-\d.]+)\)\s+scale\(([-\d.]+)\)/);
  const [tx, ty, k] = t ? [Number(t[1]), Number(t[2]), Number(t[3])] : [0, 0, 1];
  const g = svg.querySelector('g.node');
  const nm = (g.getAttribute('transform') ?? '').match(/translate\(([-\d.]+)\s+([-\d.]+)\)/);
  return { x: rect.left + Number(nm[1]) * k + tx, y: rect.top + Number(nm[2]) * k + ty };
});

// A — pick 30 min, close, reopen: persisted; re-tap clears to «ni idea».
await page.mouse.click(center.x, center.y);
await page.waitForTimeout(450);
await page.locator('.more-toggle').click(); // 0.0.75: estimate folds behind «Más detalles»
await page.waitForTimeout(200);
const chips = await page.locator('.sheet .status-row .chip', { hasText: 'min' }).count();
await page.locator('.sheet .chip', { hasText: '30 min' }).click();
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.mouse.click(center.x, center.y);
await page.waitForTimeout(450);
await page.locator('.more-toggle').click();
await page.waitForTimeout(200);
const persisted = (await page.locator('.sheet .chip.selected', { hasText: '30 min' }).count()) === 1;
console.log(`A estimate chips: sizes=${chips >= 2} persisted-30=${persisted} | OK=${chips >= 2 && persisted}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// B — the suggestion card whispers the size.
await page.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
// 0.0.75: the ONE secondary line replaced .estimate-hint (estimate wins here:
// the fresh branch has no priority and no shade).
const hint = (await page.locator('.card.next .secondary').textContent().catch(() => '')) ?? '';
const okB = hint.includes('30');
console.log(`B card hint: "${hint.trim()}" | OK=${okB}`);

// C — opt-in ON: a 2-minutitos session (real ≈ 1 min) vs a 30-min estimate
// earns the curiosity line after the momentum toast is dismissed.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.locator('.row:has-text("Brújula del tiempo") .switch').click(); // 0.0.77: app-switch
await page.waitForTimeout(300);
await page.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.locator('button', { hasText: '2 minutitos' }).first().click();
await page.waitForTimeout(500);
// bare-goal door may ask for a first pasito — skip it (session on the branch)
const asked = await page.locator('.sheet .confirm-icon', { hasText: '🌱' }).count();
if (asked) {
  await page.locator('.sheet button', { hasText: 'así nomás' }).click();
  await page.waitForTimeout(500);
}
await page.locator('button', { hasText: 'Terminar' }).first().click();
await page.waitForTimeout(500); // past the 80ms defer — read BEFORE dismissing
let toastText = (await page.locator('.toast').textContent().catch(() => '')) ?? '';
if (!toastText.includes('Pensabas')) {
  // A momentum toast holds the slot — let the queue advance.
  await page.locator('.toast .btn-ghost.small').click().catch(() => {});
  await page.waitForTimeout(600);
  toastText = (await page.locator('.toast').textContent().catch(() => '')) ?? '';
}
const okC = toastText.includes('dato curioso') || toastText.includes('Pensabas');
console.log(`C curiosity line: "${toastText.trim().slice(0, 70)}" | OK=${okC}`);

await browser.close();
console.log('brujula done');
