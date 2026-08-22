import { BASE, launchPage, newProbePage } from './lib/harness.mjs';

// A — public landing stays public; the real /ahora deep link owns the gate.
const { browser, page } = await launchPage({ width: 900, height: 800 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
const landingShown = (await page.locator('app-landing').count()) === 1;
await page.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
await page.waitForURL('**/check-in**', { timeout: 5000 });
// Fresh store greets with the one-time welcome first.
await page.locator('button', { hasText: 'Empezar' }).click();
await page.waitForTimeout(300);
await page.locator('.skip').click();
await page.waitForURL('**/ahora**', { timeout: 5000 });
await page.waitForTimeout(400);
const emptyShown = (await page.locator('.empty').count()) === 1;
const tabs = await page.locator('.tabbar .tab').count();
console.log(`A landing=${landingShown} + deep-link gate: skip -> /ahora | empty=${emptyShown} tabs=${tabs} | OK=${landingShown && emptyShown && tabs === 5}`);

// B — thread + suggestion on demo data (a when-then twig outranks everything)
await page.goto(`${BASE}/ahora?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const threadTitle = (await page.locator('.thread .node-title').textContent()).trim();
const nextTitle = (await page.locator('.next-title').textContent()).trim();
const reason = (await page.locator('.reason').textContent()).trim();
const okB = threadTitle === 'Mi primera canción completa' && nextTitle === '10 min al despertar' && reason.includes('🧶') && reason.includes('café');
console.log(`B thread="${threadTitle}" next="${nextTitle}" reason="${reason}" | OK=${okB}`);

// C — "Otra idea" full deterministic cycle (returns home; length = pool size)
const first = nextTitle;
const seen = new Set([first]);
let clicks = 0;
for (; clicks < 20; ) {
  await page.locator('button', { hasText: 'Otra idea' }).click();
  await page.waitForTimeout(150);
  clicks++;
  const t = (await page.locator('.next-title').textContent()).trim();
  if (t === first) break;
  seen.add(t);
}
console.log(`C cycle: ${seen.size} distinct in ${clicks} clicks | OK=${seen.size >= 3 && clicks === seen.size}`);

// D — 2-minute ramp: stays on /ahora, card morphs, bird present, /timer shows same session
await page.locator('button', { hasText: 'Tocarla 2 minutitos' }).click();
await page.waitForTimeout(500);
const stillAhora = page.url().includes('/ahora');
const cardText = (await page.locator('.session-card .of').textContent()).trim();
const birdHere = (await page.locator('app-companion-bird').count()) === 1;
await page.goto(`${BASE}/timer`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const timerOf = (await page.locator('.middle .of').textContent()).trim();
console.log(`D ramp: stays=${stillAhora} card="${cardText}" bird=${birdHere} timer="${timerOf}" | OK=${stillAhora && cardText.includes('2') && birdHere && timerOf.includes('2')}`);

// E — bird poses: pause -> resting, resume -> leaves resting
await page.locator('button', { hasText: 'Pausa' }).click();
await page.waitForTimeout(300);
const resting = (await page.locator('app-companion-bird.state-resting').count()) === 1;
await page.locator('button', { hasText: 'Seguir' }).click();
await page.waitForTimeout(300);
const awake = (await page.locator('app-companion-bird.state-resting').count()) === 0;
console.log(`E bird poses: resting=${resting} awake-again=${awake} | OK=${resting && awake}`);
await page.locator('button', { hasText: 'Terminar' }).click();
await page.waitForTimeout(400);
await page.locator('.toast .btn-ghost').click().catch(() => {});

// F — approaching (a 1-min session is all bridge: immediate, no waiting)
await page.locator('.custom input').fill('1');
await page.locator('.custom input').dispatchEvent('change');
await page.locator('button', { hasText: 'Empezar' }).click();
await page.waitForTimeout(500);
const approachingBird = (await page.locator('app-companion-bird.state-approaching').count()) === 1;
const approachingRing = (await page.locator('.ring .fill.approaching').count()) === 1;
console.log(`F approaching: bird=${approachingBird} ring=${approachingRing} | OK=${approachingBird && approachingRing}`);
await page.locator('button', { hasText: 'Terminar' }).click();
await page.waitForTimeout(300);

// G — the forest NEVER diverts (fresh context, lastCheckInAt null)
const { context: ctx, page: p2 } = await newProbePage(browser, { width: 900, height: 800 });
await p2.goto(`${BASE}/forest`, { waitUntil: 'networkidle' });
await p2.waitForTimeout(600);
console.log(`G forest never diverts: url=${p2.url().includes('/forest')} | OK=${p2.url().includes('/forest')}`);

await browser.close();
