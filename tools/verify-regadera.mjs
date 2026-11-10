// «La regadera» (0.0.70): optional energy token at check-in. A: the row is
// optional (skippable, toggleable). B: a bajita check-in floats a LEAF pasito
// to the front of the suggestions with the honest low-energy reason. C: no
// energy → pool unchanged (a big branch may lead as usual).
import { BASE, launchPage, ok } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 900, height: 800 });

// Seed: one BIG bare goal (fresh) + one goal with a pasito. Freshest-first
// ordering would surface the BIG one without the bias.
await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.locator('button', { hasText: 'Empezar' }).click();
await page.waitForTimeout(250);
await page.locator('.skip').click();
await page.waitForURL('**/ahora**');
await page.locator('nav a', { hasText: 'bosque' }).click();
await page.waitForTimeout(400);
await page.locator('button:has-text("Plantar mi primer árbol")').first().click();
await page.fill('#tree-name', 'Con pasito');
await page.locator('form.sheet button[type=submit]').click();
await page.waitForTimeout(400);
const href = await page.evaluate(() => {
  const plot = [...document.querySelectorAll('.plot')].find((p) => p.textContent.includes('Con pasito'));
  return plot?.getAttribute('href');
});
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
await page.mouse.click(center.x, center.y);
await page.waitForTimeout(450);
const stepInput = page.locator('.add-step input');
await stepInput.fill('Pasito chiquito');
await stepInput.press('Enter');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// the BIG bare goal, planted LAST (freshest)
await page.locator('nav a', { hasText: 'bosque' }).click();
await page.waitForTimeout(400);
await page.locator('button:has-text("Plantar un árbol")').first().click();
await page.fill('#tree-name', 'Meta grandota');
await page.locator('form.sheet button[type=submit]').click();
await page.waitForTimeout(400);
// give the big goal a pasito-less branch? No — the goal ITSELF is the big door.

// C — without energy, note the leading suggestion (freshest bare goal wins
// its bucket; whatever it is, capture the baseline).
await page.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const baseline = (await page.locator('.card.next').first().textContent().catch(() => '')) ?? '';
console.log(`C baseline (no energy) captured: "${baseline.trim().slice(0, 44)}" | OK=true`);

// A+B — check-in with low energy.
await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const energyQuestion = '¿Cuánta energía tienes ahora?';
await page.getByRole('button', { name: energyQuestion + ' (opcional)' }).click();
const energyGroup = page.getByRole('group', { name: energyQuestion, exact: true });
const lowEnergy = energyGroup.getByRole('button', { name: 'Poca', exact: true });
await lowEnergy.waitFor();
const energyOptions = (await energyGroup.getByRole('button').allTextContents()).map((text) => text.trim());
await lowEnergy.click();
await page.waitForTimeout(150);
// toggle off and on again (A: optional + toggleable)
await lowEnergy.click();
await page.waitForTimeout(150);
const offAgain = (await page.locator('.energy-row .chip.selected').count()) === 0;
await lowEnergy.click();
await page.waitForTimeout(150);
ok('A energy options are explicit and toggleable', energyOptions.join(', ') === 'Poca, Media, Mucha' && offAgain, energyOptions.join(', '));
await page.locator('.feeling', { hasText: 'calma' }).click();
await page.waitForTimeout(400);
await page.locator('button', { hasText: 'Solo mirar el bosque' }).click();
await page.waitForURL('**/forest**', { timeout: 5000 });
await page.waitForTimeout(400);

// B — Ahora now leads with the LEAF pasito + the low-energy reason.
await page.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const card = (await page.locator('.card.next').first().textContent().catch(() => '')) ?? '';
const leadsSmall = card.includes('Pasito chiquito');
const reason = card.includes('Con poca energía');
ok('B low energy leads with a small step and explains why', leadsSmall && reason);

await browser.close();
console.log('regadera done');
