import { BASE, launchPage } from './lib/harness.mjs';
const { browser, context, page } = await launchPage({ width: 900, height: 800 });
await context.grantPermissions(['notifications']);

// A — settings toggle: rhythm appears, choice persists across reload
await page.goto(`${BASE}/settings?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.locator('#whispers-toggle').click();
await page.waitForTimeout(300);
const rhythmShown = (await page.locator('button', { hasText: 'Una vez al día' }).count()) === 1;
await page.locator('button', { hasText: 'Cuando el bosque quiera' }).click();
await page.waitForTimeout(300);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const stillOn = (await page.locator('#whispers-toggle').getAttribute('aria-checked')) === 'true';
const rhythmKept = (await page.locator('.chip.opt.selected', { hasText: 'bosque quiera' }).count()) === 1;
console.log(`A toggle: rhythm-shown=${rhythmShown} persisted-on=${stillOn} surprise-kept=${rhythmKept} | OK=${rhythmShown && stillOn && rhythmKept}`);

// B — beat one is a QUESTION with an answer door to the check-in
await page.goto(`${BASE}/ahora?whisper=now`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const msg = (await page.locator('.toast .msg').textContent()).trim();
const isQuestion = msg.includes('¿') && !/sesi|rama|pasito|min/i.test(msg);
await page.locator('.toast .btn-primary', { hasText: 'Contestar' }).click();
await page.waitForURL('**/check-in**', { timeout: 5000 });
console.log(`B beat one: "${msg}" question-not-task=${isQuestion} answer->check-in | OK=${isQuestion}`);

// B2 — beat two: let the question go -> ONE tiny low-energy offer -> 2-min start
await page.goto(`${BASE}/ahora?whisper=now`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await page.locator('.toast .btn-ghost').click(); // let the question go (✕)
await page.waitForTimeout(4500); // test-mode second beat (~4s)
const offer = (await page.locator('.toast .msg').textContent()).trim();
const isTiny = offer.includes('tantita pila') && offer.includes('«');
await page.locator('.toast .btn-primary', { hasText: '2 minutitos' }).click();
await page.waitForTimeout(600);
const sessionStarted = (await page.locator('.session-card').count()) === 1;
console.log(`B2 beat two: "${offer}" tiny=${isTiny} 2min-starts-session=${sessionStarted} | OK=${isTiny && sessionStarted}`);
await page.locator('button', { hasText: 'Terminar' }).click().catch(() => {});

// C — the custom SW (sw.js wrapping ngsw) is the registered worker
await page.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
const swUrl = await page
  .evaluate(async () => {
    for (let i = 0; i < 20; i++) {
      const reg = await navigator.serviceWorker.getRegistration();
      const url = reg?.active?.scriptURL ?? reg?.installing?.scriptURL ?? reg?.waiting?.scriptURL;
      if (url) return url;
      await new Promise((r) => setTimeout(r, 500));
    }
    return 'none';
  })
  .catch(() => 'error');
console.log(`C service worker: ${swUrl} | OK=${swUrl.endsWith('/sw.js')}`);

await browser.close();
