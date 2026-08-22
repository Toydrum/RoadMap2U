import { BASE, launchPage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 1100, height: 900 });
const out = process.argv[2] ?? '.';
await page.goto(`${BASE}/check-in?seed=demo`, { waitUntil: 'networkidle' });
await page.click('.feeling:has-text("En calma")');
// Two-screen ritual: the ring lives on the destination step — no review interception.
await page.waitForSelector('.ring', { timeout: 5000 });
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/circle.png` });
await page.click('.ring-tree:has-text("Cuidarme")');
await page.waitForURL('**/tree/**', { timeout: 5000 });
console.log('circle OK — entered:', page.url());
await browser.close();
