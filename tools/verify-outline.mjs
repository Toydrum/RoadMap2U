// The "tablita" (0.0.42/0.0.43): branch outline rail — locate on tap, open on
// second tap, ordered-steps numbering, close, and auto-collapse on big trees.
import { BASE, launchPage, newProbePage } from './lib/harness.mjs';
const first = await launchPage({ width: 1280, height: 800 });
const browser = first.browser;

async function centers(p) {
  return p.evaluate(() => {
    const svg = document.querySelector('svg.canvas');
    const rect = svg.getBoundingClientRect();
    const t = (svg.querySelector(':scope > g').getAttribute('transform') ?? '').match(
      /translate\(([-\d.]+)\s+([-\d.]+)\)\s+scale\(([-\d.]+)\)/,
    );
    const [tx, ty, k] = t ? [Number(t[1]), Number(t[2]), Number(t[3])] : [0, 0, 1];
    return [...svg.querySelectorAll('g.node')].map((g) => {
      const nm = (g.getAttribute('transform') ?? '').match(/translate\(([-\d.]+)\s+([-\d.]+)\)/);
      return {
        label: (g.getAttribute('aria-label') ?? '').split(' — ')[0],
        x: rect.left + Number(nm[1]) * k + tx,
        y: rect.top + Number(nm[2]) * k + ty,
      };
    });
  });
}

// A/B/C/E — demo tree
{
  const page = first.page;
  await page.goto(`${BASE}/tree/demo-guitar?seed=demo`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.locator('.tree-outline-toggle').click();
  await page.waitForTimeout(400);
  const rows = await page.locator('.outline-rail .row').count();
  const pinned = (await page.locator('.outline-rail .row:has(.pin)').count()) === 1;
  const indents = await page.evaluate(() =>
    [...document.querySelectorAll('.outline-rail .line')].map((r) => parseInt(r.style.paddingLeft)),
  );
  const hasDepth = new Set(indents).size >= 3;
  // Small tree (9 ≤ 12): everything arrives expanded — no ▸ anywhere.
  // (9 rows since 0.0.106: the demo guitar carries the spiral leaf demo-g-tune.)
  const anyFolded = await page.locator('.outline-rail .tri', { hasText: '▸' }).count();
  console.log(`A rail: rows=${rows} pin=${pinned} depth-levels=${new Set(indents).size} small-tree-expanded=${anyFolded === 0} | OK=${rows === 9 && pinned && hasDepth && anyFolded === 0}`);

  // B — first tap locates (focus moves, no sheet)
  const row = page.locator('.outline-rail .row', { hasText: 'Grabarme y escucharme' });
  await row.click();
  await page.waitForTimeout(400);
  const focused = await page.evaluate(
    () => document.querySelector('g.node[tabindex="0"]')?.getAttribute('aria-label') ?? '',
  );
  const noSheet = (await page.locator('#nd-title').count()) === 0;
  const activeRow = await row.evaluate((el) => el.classList.contains('active'));
  console.log(`B locate: focused="${focused.split(' — ')[0]}" no-sheet=${noSheet} row-active=${activeRow} | OK=${focused.startsWith('Grabarme') && noSheet && activeRow}`);

  // C — second tap opens the sheet
  await row.click();
  await page.waitForTimeout(450);
  const title = await page.locator('#nd-title').inputValue().catch(() => null);
  console.log(`C open: sheet="${title}" | OK=${title === 'Grabarme y escucharme'}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // E — ✕ closes the rail
  await page.locator('.outline-rail .close').click();
  await page.waitForTimeout(300);
  const gone = (await page.locator('.outline-rail').count()) === 0;
  console.log(`E close: rail-gone=${gone} | OK=${gone}`);
  await page.close();
}

// D — ordered steps show their numbering in the outline
{
  const { page } = await newProbePage(browser, { width: 1280, height: 800 });
  await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.locator('button', { hasText: 'Empezar' }).click();
  await page.waitForTimeout(250);
  await page.locator('.skip').click();
  await page.waitForURL('**/ahora**');
  await page.locator('nav a', { hasText: 'bosque' }).click();
  await page.waitForTimeout(400);
  await page.locator('button', { hasText: 'Plantar mi primer árbol' }).click();
  await page.fill('#tree-name', 'Ruta');
  await page.locator('form.sheet button[type=submit]').click();
  await page.waitForTimeout(400);
  await page.locator('.plot').first().click();
  await page.waitForTimeout(700);
  await page.locator('svg.canvas g.node').first().click({ force: true });
  await page.waitForTimeout(400);
  for (const t of ['Uno', 'Dos', 'Tres']) {
    const input = page.locator('input[placeholder*="pasito"]');
    await input.fill(t);
    await input.press('Enter');
    await page.waitForTimeout(180);
  }
  await page.locator('.order-toggle input').check();
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.locator('.tree-outline-toggle').click();
  await page.waitForTimeout(400);
  const idx = await page.evaluate(() =>
    [...document.querySelectorAll('.outline-rail .row .idx')].map((e) => e.textContent.trim()),
  );
  console.log(`D numbering: [${idx.join(' ')}] | OK=${idx.join(' ') === '1. 2. 3.'}`);
  await page.close();
}

// F — big tree (13 branches > 12): opens folded to the main branches.
{
  const { page } = await newProbePage(browser, { width: 1280, height: 800 });
  await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.locator('button', { hasText: 'Empezar' }).click();
  await page.waitForTimeout(250);
  await page.locator('.skip').click();
  await page.waitForURL('**/ahora**');
  await page.locator('nav a', { hasText: 'bosque' }).click();
  await page.waitForTimeout(400);
  await page.locator('button', { hasText: 'Plantar mi primer árbol' }).click();
  await page.fill('#tree-name', 'Grande');
  await page.locator('form.sheet button[type=submit]').click();
  await page.waitForTimeout(400);
  await page.locator('.plot').first().click();
  await page.waitForTimeout(700);

  async function addUnder(label, titles) {
    const target = (await centers(page)).find((n) => n.label === label || n.label.startsWith(label + ' '));
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(420);
    for (const t of titles) {
      const input = page.locator('input[placeholder*="pasito"]');
      await input.fill(t);
      await input.press('Enter');
      await page.waitForTimeout(170);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(280);
  }
  await addUnder('Grande', ['1', '2', '3', '4', '5', '6', '7']);
  await addUnder('1', ['1.1', '1.2', '1.3']);
  await addUnder('2', ['2.1', '2.2']);

  await page.locator('.tree-outline-toggle').click();
  await page.waitForTimeout(400);
  const rowsFolded = await page.locator('.outline-rail .row').count();
  const folded = await page.locator('.outline-rail .tri', { hasText: '▸' }).count();
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll('.outline-rail .hidden-count')].map((e) => e.textContent.trim()),
  );
  console.log(
    `F auto-collapse: rows=${rowsFolded} (13 total, subs folded) ▸=${folded} chips=[${chips.join(' ')}] | OK=${rowsFolded === 8 && folded === 2 && chips.join(' ') === '(3) (2)'}`,
  );

  // Expand "1" → its three sub-branches appear; fold it back → they hide.
  const tri1 = page.locator('.outline-rail .line', { hasText: '1' }).first().locator('.tri');
  await tri1.click();
  await page.waitForTimeout(300);
  const rowsOpen = await page.locator('.outline-rail .row').count();
  const sub = (await page.locator('.outline-rail .row', { hasText: '1.2' }).count()) === 1;
  await tri1.click();
  await page.waitForTimeout(300);
  const rowsBack = await page.locator('.outline-rail .row').count();
  console.log(`F2 toggle: expand→${rowsOpen} sub-visible=${sub} fold→${rowsBack} | OK=${rowsOpen === 11 && sub && rowsBack === 8}`);
  await page.close();
}

await browser.close();
console.log('outline done');
