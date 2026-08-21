import { BASE, launchPage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 900, height: 800 });

// A — session finish offers "Un pasito más" -> /ahora with the next suggestion
await page.goto(`${BASE}/timer?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.locator('button', { hasText: 'Empezar' }).click();
await page.waitForTimeout(1200);
await page.locator('button', { hasText: 'Terminar' }).click();
await page.waitForTimeout(400);
const actionText = (await page.locator('.toast .btn-primary').textContent().catch(() => '')).trim();
await page.locator('.toast .btn-primary').click();
await page.waitForURL('**/ahora**', { timeout: 5000 });
await page.waitForTimeout(400);
const nextCard = (await page.locator('.next').count()) === 1;
console.log(`A finish momentum: action="${actionText}" -> /ahora next-card=${nextCard} | OK=${actionText === 'Un pasito más' && nextCard}`);

// B — blooming a pasito celebrates and hands focus to the add-step input
await page.goto(`${BASE}/tree/demo-guitar?seed=demo&node=demo-g-first-song`, { waitUntil: 'networkidle' });
await page.waitForSelector('.sheet');
await page.locator('.steps li', { hasText: 'Grabarme y escucharme' }).locator('button', { hasText: '🌸' }).click();
await page.waitForTimeout(400);
const toastMsg = (await page.locator('.toast .msg').textContent()).trim();
const toastCount = await page.locator('.toast').count();
await page.locator('.toast .btn-primary', { hasText: '¿Otro pasito?' }).click();
await page.waitForTimeout(300);
const focused = await page.evaluate(() => (document.activeElement)?.getAttribute('placeholder') ?? '');
const okB = toastMsg.includes('floreció') && focused.includes('pasito chiquito');
console.log(`B bloom: toast="${toastMsg}" focus-placeholder="${focused}" | OK=${okB}`);
console.log(`C single toast slot: count=${toastCount} | OK=${toastCount === 1}`);

// D — the status CHIPS stay silent (they are an editor, not a celebration)
await page.locator('.status-row .pick', { hasText: 'Creciendo' }).click();
await page.waitForTimeout(400);
const chipToast = await page.locator('.toast .msg', { hasText: 'floreció' }).count();
console.log(`D chips silent: floreció-toast=${chipToast} | OK=${chipToast === 0}`);

await browser.close();
