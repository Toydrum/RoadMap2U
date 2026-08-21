import { BASE, launchPage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 900, height: 800 });

// A — the when-then editor saves, persists, and takes over the Ahora reason
await page.goto(`${BASE}/tree/demo-guitar?seed=demo&node=demo-g-record`, { waitUntil: 'networkidle' });
await page.waitForSelector('.sheet');
await page.locator('.more-toggle').click(); // 0.0.75: trigger folds behind «Más detalles»
await page.fill('#nd-trigger', 'Cuando cierre la laptop del trabajo');
await page.locator('#nd-trigger').dispatchEvent('change');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.goto(`${BASE}/tree/demo-guitar?node=demo-g-record`, { waitUntil: 'networkidle' });
await page.waitForSelector('.sheet');
await page.locator('.more-toggle').click();
const persisted = await page.locator('#nd-trigger').inputValue();
await page.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const nextA = (await page.locator('.next-title').textContent()).trim();
const reasonA = (await page.locator('.reason').textContent()).trim();
const okA = persisted === 'Cuando cierre la laptop del trabajo' && nextA === 'Grabarme y escucharme' && reasonA.includes('laptop');
console.log(`A trigger: persisted="${persisted}" next="${nextA}" reason="${reasonA}" | OK=${okA}`);

// B — today picker: choose 3 (a 4th is gently ignored), save, chips + ranking
await page.locator('.today-pick').click();
await page.waitForSelector('.pick-grid');
const chips = page.locator('.pick-chip');
for (let i = 0; i < 4; i++) await chips.nth(i).click(); // 4th must no-op
const selectedCount = await page.locator('.pick-chip.selected').count();
const firstPicked = (await page.locator('.pick-chip.selected').first().textContent()).trim();
await page.locator('button', { hasText: 'Así está bien' }).click();
await page.waitForTimeout(400);
const rowChips = await page.locator('.today-chip').count();
const nextB = (await page.locator('.next-title').textContent()).trim();
const reasonB = (await page.locator('.reason').textContent()).trim();
const okB = selectedCount === 3 && rowChips === 3 && nextB === firstPicked && reasonB.includes('hoy');
console.log(`B today: selected=${selectedCount} chips=${rowChips} next="${nextB}" (first="${firstPicked}") reason="${reasonB}" | OK=${okB}`);

// C — intentions survive a reload (IDB), silent-expiry logic is date-keyed
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const chipsAfterReload = await page.locator('.today-chip').count();
console.log(`C reload persistence: chips=${chipsAfterReload} | OK=${chipsAfterReload === 3}`);

// D — the check-in where-card whispers the twig
await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
await page.locator('.feeling').first().click();
await page.waitForTimeout(300);
const twigLine = (await page.locator('.node-trigger').first().textContent().catch(() => '')).trim();
console.log(`D check-in twig: "${twigLine}" | OK=${twigLine.includes('🧶')}`);

await browser.close();
