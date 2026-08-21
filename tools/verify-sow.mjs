// Sembrar a manos llenas (0.0.41): multi-add with tab nesting, starter
// saplings on the empty meadow, the one-time burst invitation.
import { BASE, launchPage, newProbePage } from './lib/harness.mjs';
const first = await launchPage({ width: 390, height: 844 });
const browser = first.browser;

// ---- A: starters on the empty meadow + "start blank" hides them --------
{
  const page = first.page;
  await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.locator('button', { hasText: 'Empezar' }).click();
  await page.waitForTimeout(250);
  await page.locator('.skip').click();
  await page.waitForURL('**/ahora**');
  await page.locator('nav a', { hasText: 'bosque' }).click();
  await page.waitForTimeout(400);
  const starters = await page.locator('.starter').count();
  await page.locator('.starter', { hasText: 'Un proyecto' }).click();
  await page.waitForTimeout(600);
  const plots = await page.locator('.plot').count();
  const branchLine = (await page.locator('.plot').first().textContent()).replace(/\s+/g, ' ');
  console.log(`A starters: shown=${starters === 3} planted-tree=${plots === 1} card="${branchLine.trim().slice(0, 40)}" | OK=${starters === 3 && plots === 1 && branchLine.includes('3 ramas')}`);

  // Archive it back to empty, then "start blank" must hide starters for good.
  await page.locator('.plot').first().click();
  await page.waitForTimeout(600);
  await page.locator('button[aria-label*="rchiv"], .btn:has-text("🗃")').first().click();
  await page.waitForTimeout(300);
  await page.locator('button', { hasText: 'Que descanse' }).click().catch(async () => {
    await page.locator('.confirm .btn-primary').click();
  });
  await page.waitForTimeout(500);
  const back = await page.locator('.starter').count();
  await page.locator('button', { hasText: 'Prefiero empezar en blanco' }).click();
  await page.waitForTimeout(300);
  const gone = (await page.locator('.starter').count()) === 0;
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const stillGone = (await page.locator('.starter').count()) === 0;
  console.log(`A2 blank: starters-back=${back === 3} hidden=${gone} persisted=${stillGone} | OK=${back === 3 && gone && stillGone}`);
  await page.close();
}

// ---- B: multi-add with tab nesting + burst invitation -------------------
{
  const { page } = await newProbePage(browser, { width: 900, height: 800 });
  await page.goto(`${BASE}/check-in`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.locator('button', { hasText: 'Empezar' }).click();
  await page.waitForTimeout(250);
  await page.locator('.skip').click();
  await page.waitForURL('**/ahora**');
  await page.locator('nav a', { hasText: 'bosque' }).click();
  await page.waitForTimeout(400);
  await page.locator('button', { hasText: 'Plantar mi primer árbol' }).click();
  await page.fill('#tree-name', 'Mi banda');
  await page.locator('form.sheet button[type=submit]').click();
  await page.waitForTimeout(400);
  await page.locator('.plot').first().click();
  await page.waitForTimeout(700);
  await page.locator('button', { hasText: 'Plantar aquí' }).click();
  await page.waitForTimeout(400);
  await page.locator('.sow-toggle input').check();
  await page.waitForTimeout(250);
  await page
    .locator('#sow-box')
    .fill('Elegir canciones\n\tLa balada\n\tLa movida\nEnsayar juntos\nGrabar demo\nCompartirlo');
  await page.locator('form.sheet button[type=submit]').click();
  await page.waitForTimeout(700);
  // Sembrar CLOSES the sheet itself (0.0.109) — the tree is the next thing
  // you see, and the ≥6 burst invitation fires from that same close.
  const sheetGone = (await page.locator('form.sheet').count()) === 0;
  const toast = (await page.locator('.toast .msg').textContent().catch(() => '')).trim();
  const invited = toast.includes('crecemos');

  // Structure: 6 sown + root = 7 nodes; "La balada"/"La movida" nested.
  const struct = await page.evaluate(
    () =>
      new Promise((res) => {
        const req = indexedDB.open('roadmap2u');
        req.onsuccess = () => {
          const tx = req.result.transaction('nodes', 'readonly');
          const all = tx.objectStore('nodes').getAll();
          all.onsuccess = () => {
            const nodes = all.result;
            const byTitle = Object.fromEntries(nodes.map((n) => [n.title, n]));
            const heart = nodes
              .filter((n) => n.parentId === null)
              .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)[0];
            res({
              count: nodes.length,
              baladaUnderElegir: byTitle['La balada']?.parentId === byTitle['Elegir canciones']?.id,
              movidaUnderElegir: byTitle['La movida']?.parentId === byTitle['Elegir canciones']?.id,
              // «El corazón del árbol» (0.0.112): depth-0 lines hang from
              // the HEART (the first root), never as new trunks.
              ensayarUnderRoot: byTitle['Ensayar juntos']?.parentId === heart?.id,
              orderOk:
                (byTitle['Elegir canciones']?.order ?? 99) < (byTitle['Ensayar juntos']?.order ?? 0) &&
                (byTitle['Ensayar juntos']?.order ?? 99) < (byTitle['Grabar demo']?.order ?? 0),
            });
          };
        };
        req.onerror = () => res(null);
      }),
  );
  const okB =
    struct &&
    struct.count === 7 &&
    struct.baladaUnderElegir &&
    struct.movidaUnderElegir &&
    struct.ensayarUnderRoot &&
    struct.orderOk;
  console.log(
    `B sow: sheet-closed=${sheetGone} nodes=${struct?.count} nesting=${struct?.baladaUnderElegir && struct?.movidaUnderElegir} sibling-order=${struct?.orderOk} burst-invite=${invited} | OK=${okB && sheetGone && invited}`,
  );

  // The invitation's "2 minutitos" starts a session in place.
  await page.locator('.toast button').first().click();
  await page.waitForTimeout(500);
  const perch = await page.locator('.session-perch').count();
  console.log(`B2 invite door: session started (perch visible)=${perch === 1} | OK=${perch === 1}`);
  await page.close();
}

await browser.close();
console.log('sow done');
