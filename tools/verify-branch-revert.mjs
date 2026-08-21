import { BASE, launchPage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 900, height: 800 });

const knots = () => page.locator('g.glyph.knot').count();
const glyphs = () => page.locator('g.node').count();

async function branchRecord() {
  await page.goto(`${BASE}/tree/demo-guitar?seed=demo&node=demo-g-record`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sheet');
  await page.locator('.branch-chip').click();
  await page.waitForSelector('.modal');
  await page.locator('.chip.suggestion').first().click();
  await page.locator('.modal button', { hasText: 'Que crezcan' }).click();
  await page.waitForTimeout(500);
}

// A — branch → celebrate toast → Deshacer → knot gone, children gone
const k0 = await (async () => { await page.goto(`${BASE}/tree/demo-guitar?seed=demo`, { waitUntil: 'networkidle' }); await page.waitForTimeout(400); return knots(); })();
const n0 = await glyphs();
await branchRecord();
const k1 = await knots();
const n1 = await glyphs();
await page.locator('.toast button', { hasText: 'Deshacer' }).click();
await page.waitForTimeout(500);
const k2 = await knots();
const n2 = await glyphs();
console.log(`A toast-undo: knots ${k0}->${k1}->${k2} nodes ${n0}->${n1}->${n2} | OK=${k1 === k0 + 1 && k2 === k0 && n1 === n0 + 1 && n2 === n0}`);

// B — branch again, let the toast go, use the quiet revert affordance
await branchRecord();
await page.locator('.toast .btn-ghost').click(); // dismiss celebrate toast
await page.goto(`${BASE}/tree/demo-guitar?seed=demo&node=demo-g-record`, { waitUntil: 'networkidle' });
await page.waitForSelector('.sheet');
const revertVisible = await page.locator('.revert-branch').count();
await page.locator('.revert-branch').click();
await page.locator('.confirm button', { hasText: 'Que vuelva a crecer' }).click();
await page.waitForTimeout(500);
const hint = (await page.locator('.hint-line').textContent()).trim();
const k3 = await knots();
console.log(`B quiet revert: affordance=${revertVisible === 1} hint="${hint}" knots=${k3} | OK=${revertVisible === 1 && k3 === k0 && hint.includes('en marcha')}`);

// C — a rooted transformation never offers revert (demo-g-daily's child is growing)
await page.goto(`${BASE}/tree/demo-guitar?seed=demo&node=demo-g-daily`, { waitUntil: 'networkidle' });
await page.waitForSelector('.sheet');
const status = (await page.locator('.status-chip').textContent()).trim();
const noRevert = (await page.locator('.revert-branch').count()) === 0;
console.log(`C touched stays earned: status="${status}" revert-hidden=${noRevert} | OK=${status.includes('Ramificada') && noRevert}`);

await browser.close();
