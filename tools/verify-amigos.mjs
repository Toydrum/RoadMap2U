// Amigos y visitas (0.0.54): friend codes as the only door, mutual-consent
// requests, silent declines, the rate-limit brake, guardian oversight, and
// look-only friend visits (locate, never open; nothing plants).
import { BASE, launchPage, signInAs as signInPage } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 1280, height: 950 });

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
const foreign = [];
page.on('request', (request) => {
  const url = request.url();
  if (!url.startsWith(BASE) && !url.startsWith('data:')) foreign.push(url);
});

async function signInAs(username, password) {
  await signInPage(page, username, password);
}

async function openAmigos() {
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await page.locator('.amigos').waitFor({ timeout: 8000 });
  await page.waitForTimeout(900);
}

// A — Val (social minor) sees her card: seeded friendship with Ámbar + a code.
await signInAs('val', 'Bosque123');
await openAmigos();
const codeA = (await page.locator('.amigos-code').textContent())?.trim() ?? '';
const friendsA = await page.locator('.amigos .amigos-name').allTextContents();
const okA = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codeA) && friendsA.some((n) => n.includes('Ámbar'));
console.log(`A social card: code=${codeA} friends=[${friendsA.join('|')}] | OK=${okA}`);

// B — look-only friend visit: locate works, nothing opens, nothing plants.
await page.locator('.amigos-row', { hasText: 'Ámbar' }).locator('button', { hasText: 'Visitar' }).click();
await page.locator('h1', { hasText: 'El jardín de Ámbar' }).waitFor({ timeout: 8000 });
const hintB = await page.locator('.visita-head .hint').textContent();
await page.locator('.visita-plot', { hasText: 'Cerámica' }).click();
await page.locator('app-tree-canvas').waitFor({ timeout: 8000 });
await page.waitForTimeout(700);
const plantBtn = await page.locator('header.bar button', { hasText: 'Plantar' }).count();
// Tap a node dead-center: on a look-only visit no sheet may open.
const nodePos = await page.evaluate(() => {
  const label = [...document.querySelectorAll('app-tree-canvas svg text')].find((t) =>
    t.textContent?.includes('esmalte'),
  );
  const r = label?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
});
if (nodePos) await page.mouse.click(nodePos.x, nodePos.y);
await page.waitForTimeout(600);
const sheetOpen = await page.locator('app-node-detail').count();
const okB = !!hintB?.includes('de visita') && plantBtn === 0 && sheetOpen === 0;
console.log(`B look-only visit: hint=${!!hintB?.includes('de visita')} plant-btn=${plantBtn} sheet=${sheetOpen} | OK=${okB}`);

// C — full request arc: new adult Lupe redeems Ámbar's seeded code; Ámbar accepts.
await signInAs('val', 'Bosque123'); // leave the visit context cleanly
await page.goto(`${BASE}/account`, { waitUntil: 'networkidle' });
await page.locator('button', { hasText: 'Cerrar sesión' }).click();
await page.locator('h1', { hasText: 'Una llave' }).waitFor();
await page.locator('button', { hasText: 'Quiero una llave nueva' }).click();
await page.fill('.auth-form input[autocomplete="username"]', 'lupe');
// displayName severed from signup (0.0.108) — the field is gone.
await page.fill('.auth-form input[type="email"]', 'lupe@demo.bosque');
const pw = page.locator('.auth-form input[type="password"]');
await pw.nth(0).fill('Bosque123');
await pw.nth(1).fill('Bosque123');
await page.locator('.auth-form button[type=submit]').click();
await page.locator('h1', { hasText: 'Te enviamos un código' }).waitFor({ timeout: 8000 });
await page.fill('.code-input', '123456');
await page.locator('.auth-form button[type=submit]').click();
await page.locator('h1', { hasText: 'Tu cuenta' }).waitFor({ timeout: 8000 });
await openAmigos();
await page.fill('.amigos-redeem .code-entry', 'MBRD2468');
await page.locator('.amigos-redeem button[type=submit]').click();
await page.waitForTimeout(1200);
const outgoing = await page.locator('.amigos-group', { hasText: 'Enviadas' }).locator('.amigos-name').allTextContents();
const okC1 = outgoing.some((n) => n.includes('Ámbar'));
await signInAs('ambar', 'Bosque123');
await openAmigos();
await page.locator('.amigos-row', { hasText: 'lupe' }).locator('button', { hasText: 'Aceptar' }).click();
await page.waitForTimeout(1200);
const ambarFriends = await page
  .locator('.amigos-group', { hasText: 'Tus amistades' })
  .locator('.amigos-name')
  .allTextContents();
const okC2 = ambarFriends.some((n) => n.includes('lupe'));
console.log(`C request arc: outgoing=${okC1} accepted=${okC2} friends=[${ambarFriends.join('|')}] | OK=${okC1 && okC2}`);

// D — silent decline: Lupe requests Val; Val declines; Lupe's outgoing empties.
await signInAs('lupe', 'Bosque123');
await openAmigos();
await page.fill('.amigos-redeem .code-entry', 'VLTN1357');
await page.locator('.amigos-redeem button[type=submit]').click();
await page.waitForTimeout(1200);
await signInAs('val', 'Bosque123');
await openAmigos();
await page.locator('.amigos-row', { hasText: 'lupe' }).locator('button', { hasText: 'Ahora no' }).click();
await page.waitForTimeout(1200);
await signInAs('lupe', 'Bosque123');
await openAmigos();
const outgoingAfter = await page.locator('.amigos-group', { hasText: 'Enviadas' }).count();
console.log(`D silent decline: outgoing-section-gone=${outgoingAfter === 0} | OK=${outgoingAfter === 0}`);

// E — the rate-limit brake: bad codes until RATE_LIMITED copy shows.
let limited = false;
for (let i = 0; i < 6; i++) {
  await page.fill('.amigos-redeem .code-entry', `MAL${i}MAL${i}`);
  await page.locator('.amigos-redeem button[type=submit]').click();
  await page.waitForTimeout(900);
  const err = (await page.locator('.amigos .error-line').textContent().catch(() => '')) ?? '';
  if (err.includes('Muchos intentos')) {
    limited = true;
    break;
  }
}
console.log(`E rate limit: brake-engaged=${limited} | OK=${limited}`);

// F — guardian oversight: Rocío sees Val's friendships and can release one.
await signInAs('rocio', 'Bosque123');
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.locator('.familia').waitFor();
await page.waitForTimeout(800);
await page.locator('.fam-open', { hasText: 'Val' }).click();
await page.locator('.familia-sheet h2', { hasText: 'Val' }).waitFor();
await page.locator('button', { hasText: 'Sus amistades' }).click();
await page.locator('.familia-sheet h2', { hasText: 'Las amistades de Val' }).waitFor({ timeout: 8000 });
await page.waitForTimeout(900);
const childFriends = await page.locator('.familia-sheet .fam-name').allTextContents();
const okF1 = childFriends.some((n) => n.includes('Ámbar'));
await page
  .locator('.familia-sheet .fam-row', { hasText: 'Ámbar' })
  .locator('button', { hasText: 'Soltar' })
  .click();
await page.waitForTimeout(1400);
const childFriendsAfter = await page.locator('.familia-sheet .fam-name').allTextContents();
const okF2 = !childFriendsAfter.some((n) => n.includes('Ámbar'));
console.log(`F oversight: sees=[${childFriends.join('|')}] released=${okF2} | OK=${okF1 && okF2}`);

console.log(`invariants: pageErrors=${pageErrors.length} foreign=${foreign.length} | OK=${pageErrors.length === 0 && foreign.length === 0}`);
if (pageErrors.length) console.log(pageErrors.join('\n'));

await browser.close();
console.log('amigos done');
