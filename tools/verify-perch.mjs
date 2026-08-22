import { BASE, launchPage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 480, height: 860 });

const perch = () => page.locator('.session-perch').count();

// A — no session, no perch anywhere
await page.goto(`${BASE}/forest?seed=demo`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const idle = await perch();
console.log(`A idle: perch=${idle} | OK=${idle === 0}`);

// B — start a session from Ahora; the perch appears on forest/tree/trail, never on timer/ahora
await page.goto(`${BASE}/ahora`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.locator('button', { hasText: 'Tocarla 2 minutitos' }).click();
await page.waitForTimeout(400);
const onAhora = await perch();
await page.goto(`${BASE}/forest`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
const onForest = await perch();
const perchTime = (await page.locator('.perch-time').textContent()).trim();
await page.goto(`${BASE}/tree/demo-guitar`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
const onTree = await perch();
await page.goto(`${BASE}/trail`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
const onTrail = await perch();
await page.goto(`${BASE}/timer`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
const onTimer = await perch();
console.log(`B travels: ahora=${onAhora} forest=${onForest}(${perchTime}) tree=${onTree} trail=${onTrail} timer=${onTimer} | OK=${onAhora === 0 && onForest === 1 && onTree === 1 && onTrail === 1 && onTimer === 0 && /\d:\d\d/.test(perchTime)}`);

// C — poses travel too (CLIENT-SIDE nav, like real taps: pause lives in memory)
await page.locator('button', { hasText: 'Pausa' }).click();
await page.waitForTimeout(200);
await page.locator('.tabbar .tab', { hasText: 'Mi bosque' }).click();
await page.waitForURL('**/forest**', { timeout: 5000 });
await page.waitForTimeout(300);
const restingAway = (await page.locator('.session-perch app-companion-bird.state-resting').count()) === 1;
console.log(`C paused pose travels: resting=${restingAway} | OK=${restingAway}`);

// E — the parakeet perches ON the ramita: the session node's tree shows the
// on-branch perch (still exactly one perch app-wide), time ticking there.
{
  let onBranch = 0;
  let branchTime = '';
  for (const treeId of ['demo-guitar', 'demo-work']) {
    await page.goto(`${BASE}/tree/${treeId}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    onBranch = await page.locator('.session-perch.on-branch').count();
    if (onBranch) {
      branchTime = (await page.locator('.session-perch.on-branch .perch-time').textContent()).trim();
      break;
    }
  }
  const totalE = await perch();
  console.log(`E on-branch: found=${onBranch} time=${branchTime} total=${totalE} | OK=${onBranch === 1 && totalE === 1 && /\d:\d\d/.test(branchTime)}`);
}

// F — the parakeet waits on the session tree's crown in the meadow; walking
// to another clearing hands the bird back to the corner perch.
{
  await page.goto(`${BASE}/forest`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900); // measurement settles after the 480ms pass
  let onTree = await page.locator('.session-perch.on-tree').count();
  if (!onTree && (await page.locator('.clearing-nav.next:not([disabled])').count())) {
    await page.locator('.clearing-nav.next').click();
    await page.waitForTimeout(900);
    onTree = await page.locator('.session-perch.on-tree').count();
  }
  const totalOn = await perch();
  let insidePlot = false;
  if (onTree) {
    insidePlot = await page.evaluate(() => {
      const p = document.querySelector('.session-perch.on-tree').getBoundingClientRect();
      const cx = (p.left + p.right) / 2;
      return [...document.querySelectorAll('.plot')].some((el) => {
        const r = el.getBoundingClientRect();
        return cx >= r.left - 10 && cx <= r.right + 10;
      });
    });
  }
  // now walk to a clearing WITHOUT the session tree (if one exists)
  let fallback = true;
  const nav = (await page.locator('.clearing-nav.prev:not([disabled])').count())
    ? '.clearing-nav.prev'
    : (await page.locator('.clearing-nav.next:not([disabled])').count())
      ? '.clearing-nav.next'
      : null;
  if (nav) {
    await page.locator(nav).click();
    await page.waitForTimeout(900);
    fallback =
      (await page.locator('.session-perch.on-tree').count()) === 0 && (await perch()) === 1;
    // come back so D starts from a clean forest
    await page.locator(nav === '.clearing-nav.prev' ? '.clearing-nav.next' : '.clearing-nav.prev').click();
    await page.waitForTimeout(600);
  }
  console.log(`F on-tree: found=${onTree} inside-plot=${insidePlot} total=${totalOn} corner-fallback=${fallback} | OK=${onTree === 1 && insidePlot && totalOn === 1 && fallback}`);
}

// D — tapping the perch returns to the session; finishing removes it everywhere
await page.locator('.session-perch').click();
await page.waitForURL('**/timer**', { timeout: 5000 });
await page.locator('button', { hasText: 'Seguir' }).click();
await page.locator('button', { hasText: 'Terminar' }).click();
await page.waitForTimeout(400);
await page.locator('.tabbar .tab', { hasText: 'Mi bosque' }).click();
await page.waitForURL('**/forest**', { timeout: 5000 });
await page.waitForTimeout(300);
const afterFinish = await perch();
console.log(`D tap returns + finish clears: perch=${afterFinish} | OK=${afterFinish === 0}`);

await browser.close();
