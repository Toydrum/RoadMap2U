import { BASE, launchPage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 900, height: 800 });

// A — express with a pending review: straight to Ahora, ONE tap — the 🍂
// banner on Ahora holds the date conversation (reviews left the ritual in 0.0.39)
await page.goto(`${BASE}/check-in?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const chipText = (await page.locator('.express').textContent()).trim();
await page.locator('.express').click();
await page.waitForURL('**/ahora**', { timeout: 5000 });
await page.waitForTimeout(400);
const banner = await page.locator('.review-banner').count();
console.log(`A express: chip="${chipText}" landed=/ahora 🍂-banner-on-ahora=${banner === 1} | OK=${banner === 1}`);

// B — express with nothing pending: one tap, straight to Ahora (the thread)
await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
await page.locator('.express').click();
await page.waitForURL('**/ahora**', { timeout: 5000 });
console.log('B express direct: landed=/ahora | OK=true');

// C — two-screen ritual: feeling -> destination (branch cards + ring together),
// notita folded into screen one, gentle back returns to feeling
await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const noteToggle = await page.locator('.note-toggle').count();
await page.locator('.feeling').first().click();
await page.waitForSelector('.destination-stage');
const hasRing = (await page.locator('.ring').count()) === 1;
const hasCards = await page.locator('.where').count();
const noAquiEstoy = (await page.locator('button', { hasText: 'Aquí estoy' }).count()) === 0;
await page.locator('.step-back').click();
await page.waitForTimeout(300);
const backAtFeeling = (await page.locator('.weather').count()) === 1;
console.log(
  `C destination: note-toggle=${noteToggle === 1} ring=${hasRing} branch-cards=${hasCards} no-"Aquí estoy"=${noAquiEstoy} back=${backAtFeeling} | OK=${noteToggle === 1 && hasRing && hasCards > 0 && noAquiEstoy && backAtFeeling}`,
);

await browser.close();
