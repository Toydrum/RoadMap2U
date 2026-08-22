// The two-screen ritual (0.0.39): welcome-once, notita folded into feeling,
// destination = branch shortcuts + ring + solo-mirar, reviews never interrupt.
import { BASE, launchPage, newProbePage } from './lib/harness.mjs';
const first = await launchPage({ width: 390, height: 844 });
const browser = first.browser;

const latestCheckin = (page) =>
  page.evaluate(
    () =>
      new Promise((res) => {
        const req = indexedDB.open('roadmap2u');
        req.onsuccess = () => {
          const tx = req.result.transaction('checkins', 'readonly');
          const all = tx.objectStore('checkins').getAll();
          all.onsuccess = () =>
            res([...all.result].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null);
        };
        req.onerror = () => res(null);
      }),
  );

// A — FRESH store: welcome shows exactly once; empty forest lands planting.
{
  const page = first.page;
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const landingShown = (await page.locator('app-landing').count()) === 1;
  await page.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
  await page.waitForURL('**/check-in**', { timeout: 5000 });
  await page.waitForTimeout(400);
  const welcomed = (await page.locator('.welcome-stage').count()) === 1;
  await page.locator('button', { hasText: 'Empezar' }).click();
  await page.waitForTimeout(300);
  const atFeeling = (await page.locator('.weather').count()) === 1;
  await page.locator('.feeling').first().click();
  await page.waitForURL('**/forest**', { timeout: 5000 });
  await page.waitForTimeout(400);
  const plantOpen = (await page.locator('#tree-name').count()) === 1;
  // Re-enter: onboarded now — the welcome must NOT come back.
  await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const welcomeGone = (await page.locator('.welcome-stage').count()) === 0;
  const straightToWeather = (await page.locator('.weather').count()) === 1;
  console.log(
    `A fresh: landing=${landingShown} welcome-once=${welcomed} feeling=${atFeeling} empty→plant-sheet=${plantOpen} welcome-gone=${welcomeGone && straightToWeather} | OK=${landingShown && welcomed && atFeeling && plantOpen && welcomeGone && straightToWeather}`,
  );
  await page.close();
}

// B — SEEDED: notita + branch card records WITH nodeId; no review interception.
{
  const { page } = await newProbePage(browser, { width: 390, height: 844 });
  await page.goto(`${BASE}/check-in?seed=demo`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.locator('.note-toggle').click();
  await page.waitForTimeout(200);
  await page.locator('textarea.note').fill('prueba notita');
  await page.locator('.feeling').nth(1).click();
  await page.waitForSelector('.destination-stage');
  const cards = await page.locator('.where').count();
  const ring = (await page.locator('.ring').count()) === 1;
  const soloMirar = (await page.locator('.ring-center').count()) === 1;
  const noReview = (await page.locator('button', { hasText: 'Sigo aquí, a mi ritmo' }).count()) === 0;
  const cardTitle = (await page.locator('.where .node-name').first().textContent()).trim();
  await page.locator('.where').first().click();
  await page.waitForURL('**/tree/**', { timeout: 5000 });
  await page.waitForTimeout(400);
  const rec = await latestCheckin(page);
  const okB = cards > 0 && ring && soloMirar && noReview && rec?.nodeId && rec?.note === 'prueba notita';
  console.log(
    `B destination: cards=${cards} ring=${ring} solo-mirar=${soloMirar} no-review-inside=${noReview} | card "${cardTitle}" → nodeId=${!!rec?.nodeId} note="${rec?.note}" | OK=${okB}`,
  );

  // Ring tree records WITHOUT a node; the 📍 stays put.
  await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.locator('.feeling').first().click();
  await page.waitForSelector('.ring-tree');
  await page.locator('.ring-tree').first().click();
  await page.waitForURL('**/tree/**', { timeout: 5000 });
  await page.waitForTimeout(400);
  const rec2 = await latestCheckin(page);
  console.log(`B2 ring: recorded without node=${rec2 && rec2.nodeId === null} | OK=${rec2 && rec2.nodeId === null}`);
  await page.close();
}

await browser.close();
console.log('checkin2 done');
