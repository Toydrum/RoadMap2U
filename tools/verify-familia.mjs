// The familia phase (0.0.49): create a minor (temp password once), per-child
// admin, LAST_GUARDIAN → co-guardian arc, link-existing invites, redemption,
// the guardians view — all on the mock cloud, zero network.
import {
  BASE,
  launchPage,
  provisionSignedInAccess,
  signInAs as signInPage,
} from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 1280, height: 900 });

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
const foreign = [];
page.on('request', (request) => {
  const url = request.url();
  if (!url.startsWith(BASE) && !url.startsWith('data:')) foreign.push(url);
});

const stage = (title) => page.locator('h1', { hasText: title });
const sheetTitle = (title) => page.locator('.familia-sheet h2', { hasText: title });

async function signInAs(username, password, options) {
  await signInPage(page, username, password, options);
}

async function openSettings() {
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await page.locator('.familia').waitFor({ timeout: 6000 });
  await page.waitForTimeout(700); // let the background refresh land
}

// A — the seeded family paints for the parent.
await signInAs('rocio', 'Bosque123');
await stage('Tu cuenta').waitFor({ timeout: 6000 });
await openSettings();
const minorNames = await page.locator('.familia .fam-open .fam-name').allTextContents();
const okA = minorNames.includes('Nico') && minorNames.includes('Val');
console.log(`A seeded family: minors=[${minorNames.join(', ')}] | OK=${okA}`);

// B — create a child; the temp password is revealed once.
await page.locator('button', { hasText: 'Crear cuenta de peque' }).click();
await sheetTitle('Una cuenta para tu peque').waitFor();
// ONE field since 0.0.108: the username doubles as the display name.
await page.fill('.familia-sheet input[autocapitalize="none"]', 'luna');
await page.locator('.familia-sheet button[type=submit]').click();
await sheetTitle('La cuenta de luna está lista').waitFor({ timeout: 8000 });
const tempLuna = (await page.locator('.temp-password').textContent())?.trim() ?? '';
console.log(`B create child: temp="${tempLuna}" | OK=${/^Brote\d{4}$/.test(tempLuna)}`);
await page.locator('.familia-sheet button', { hasText: 'Listo' }).click();

// C — the child's first login uses the temp password → newPassword → family card.
await signInAs('luna', tempLuna, { expect: 'challenge' });
await stage('Estrena tu contraseña').waitFor({ timeout: 6000 });
const pw = page.locator('.auth-form input[type="password"]');
await pw.nth(0).fill('Lunita2026');
await pw.nth(1).fill('Lunita2026');
await page.locator('.auth-form button[type=submit]').click();
await stage('Tu cuenta').waitFor({ timeout: 8000 });
await provisionSignedInAccess(page, { reload: true });
await openSettings();
const guardianNames = await page.locator('.familia .fam-group .fam-name').allTextContents();
const disclosure = await page.locator('.familia .fam-group .hint').textContent();
const okC = guardianNames.includes('Rocío') && !!disclosure?.includes('siguen siendo solo tuyos');
console.log(`C child view: guardians=[${guardianNames.join(', ')}] disclosure=${!!disclosure} | OK=${okC}`);

// D — rename + social toggle from the child sheet (as rocio, on Val).
await signInAs('rocio', 'Bosque123');
await stage('Tu cuenta').waitFor({ timeout: 6000 });
await openSettings();
await page.locator('.fam-open', { hasText: 'Val' }).click();
await sheetTitle('Val').waitFor();
// 0.0.77: the social boolean is an app-switch now (state = aria-checked).
const socialBefore = await page.locator('.fam-switch-row .switch').getAttribute('aria-checked');
await page.locator('.fam-switch-row .switch').click();
await page.waitForTimeout(900);
const socialAfter = await page.locator('.fam-switch-row .switch').getAttribute('aria-checked');
const okD = socialBefore !== socialAfter;
console.log(`D social toggle: ${socialBefore} → ${socialAfter} | OK=${okD}`);
await page.locator('.fam-switch-row .switch').click(); // leave Val social ON as seeded
await page.waitForTimeout(900);
await page.locator('.familia-sheet button', { hasText: 'Cerrar' }).click();

// E — reset Luna's password → NEW temp ≠ old.
await page.locator('.fam-open', { hasText: 'luna' }).click();
await sheetTitle('luna').waitFor();
await page.locator('button', { hasText: 'Nueva contraseña temporal' }).click();
await sheetTitle('Contraseña nueva para luna').waitFor({ timeout: 8000 });
const tempLuna2 = (await page.locator('.temp-password').textContent())?.trim() ?? '';
const okE = /^Brote\d{4}$/.test(tempLuna2) && tempLuna2 !== tempLuna;
console.log(`E reset password: "${tempLuna2}" (old "${tempLuna}") | OK=${okE}`);
await page.locator('.familia-sheet button', { hasText: 'Listo' }).click();

// F — LAST_GUARDIAN: unlinking Nico's only guardian is refused with calm copy.
await page.locator('.fam-open', { hasText: 'Nico' }).click();
await sheetTitle('Nico').waitFor();
await page.locator('button', { hasText: 'Dejar de cuidar esta cuenta' }).click();
await sheetTitle('¿Dejar de cuidar a Nico?').waitFor();
await page.locator('button', { hasText: 'Sí, soltar el vínculo' }).click();
await page.locator('.familia-sheet .error-line').waitFor({ timeout: 8000 });
const lastGuardianCopy = await page.locator('.familia-sheet .error-line').textContent();
const okF = !!lastGuardianCopy?.includes('única persona cuidadora');
console.log(`F LAST_GUARDIAN: "${lastGuardianCopy?.trim().slice(0, 50)}…" | OK=${okF}`);
await page.locator('.familia-sheet button', { hasText: 'Cancelar' }).click();

// G — co-guardian invite for Nico → Ámbar redeems → now the unlink SUCCEEDS.
await page.locator('.fam-open', { hasText: 'Nico' }).click();
await sheetTitle('Nico').waitFor();
await page.locator('button', { hasText: 'Invitar a otro adulto' }).click();
await sheetTitle('Código de invitación').waitFor({ timeout: 8000 });
const coCode = ((await page.locator('.temp-password').textContent()) ?? '').trim();
await page.locator('.familia-sheet button', { hasText: 'Listo' }).click();
await signInAs('ambar', 'Bosque123');
await stage('Tu cuenta').waitFor({ timeout: 6000 });
await openSettings();
await page.locator('button', { hasText: 'Tengo un código' }).click();
await sheetTitle('Canjear un código').waitFor();
await page.fill('.familia-sheet .code-entry', coCode);
await page.locator('.familia-sheet button[type=submit]').click();
await page.waitForTimeout(1200);
const ambarMinors = await page.locator('.familia .fam-open .fam-name').allTextContents();
const okG1 = ambarMinors.includes('Nico');
await signInAs('rocio', 'Bosque123');
await stage('Tu cuenta').waitFor({ timeout: 6000 });
await openSettings();
await page.locator('.fam-open', { hasText: 'Nico' }).click();
await page.locator('button', { hasText: 'Dejar de cuidar esta cuenta' }).click();
await page.locator('button', { hasText: 'Sí, soltar el vínculo' }).click();
await page.waitForTimeout(1200);
const rocioMinors = await page.locator('.familia .fam-open .fam-name').allTextContents();
const okG2 = !rocioMinors.includes('Nico');
console.log(`G co-guardian arc: ambar-has-nico=${okG1} rocio-released=${okG2} | OK=${okG1 && okG2}`);

// H — linkExisting: rocio invites; Val (existing minor account) redeems.
await page.locator('button', { hasText: 'Invitar una cuenta existente' }).click();
await sheetTitle('Código de invitación').waitFor({ timeout: 8000 });
const linkCode = ((await page.locator('.temp-password').textContent()) ?? '').trim();
await page.locator('.familia-sheet button', { hasText: 'Listo' }).click();
await signInAs('ambar', 'Bosque123');
await stage('Tu cuenta').waitFor({ timeout: 6000 });
await openSettings();
await page.locator('button', { hasText: 'Tengo un código' }).click();
await sheetTitle('Canjear un código').waitFor();
await page.fill('.familia-sheet .code-entry', linkCode);
await page.locator('.familia-sheet button[type=submit]').click();
await page.waitForTimeout(1200);
const ambarGuardians = await page.locator('.familia .fam-group').first().locator('.fam-name').allTextContents();
const okH1 = ambarGuardians.includes('Rocío');
await signInAs('rocio', 'Bosque123');
await stage('Tu cuenta').waitFor({ timeout: 6000 });
await openSettings();
const kindChips = await page.locator('.fam-open', { hasText: 'Ámbar' }).locator('.fam-kind').textContent();
const okH2 = !!kindChips?.includes('vinculada');
// Invited links expose NO identity admin: open the sheet, expect no reset button.
await page.locator('.fam-open', { hasText: 'Ámbar' }).click();
await sheetTitle('Ámbar').waitFor();
const resetCount = await page.locator('.familia-sheet button', { hasText: 'Nueva contraseña temporal' }).count();
const deleteCount = await page.locator('.familia-sheet button', { hasText: 'Borrar su cuenta' }).count();
console.log(`H link-existing: ambar-sees-rocio=${okH1} kind=${okH2} no-identity-admin=${resetCount === 0 && deleteCount === 0} | OK=${okH1 && okH2 && resetCount === 0 && deleteCount === 0}`);
await page.locator('.familia-sheet button', { hasText: 'Cerrar' }).click();

// I — export-first delete of Luna: a download fires BEFORE the purge.
let downloaded = '';
page.on('download', (d) => (downloaded = d.suggestedFilename()));
await page.locator('.fam-open', { hasText: 'luna' }).click();
await page.locator('button', { hasText: 'Borrar su cuenta' }).click();
await sheetTitle('¿Borrar la cuenta de luna?').waitFor();
await page.locator('button', { hasText: 'Sí, borrar su cuenta' }).click();
await page.waitForTimeout(1800);
const lunaGone = !(await page.locator('.familia .fam-open .fam-name').allTextContents()).includes('luna');
console.log(`I export-first delete: download="${downloaded}" gone=${lunaGone} | OK=${downloaded.includes('luna') && lunaGone}`);

// J — Luna's login is truly gone.
await signInAs('luna', 'Lunita2026', { expect: 'error' });
await page.locator('.error-line').waitFor({ timeout: 6000 });
const lunaError = await page.locator('.error-line').textContent();
console.log(`J deleted login: "${lunaError?.trim().slice(0, 40)}" | OK=${!!lunaError}`);

console.log(`invariants: pageErrors=${pageErrors.length} foreign=${foreign.length} | OK=${pageErrors.length === 0 && foreign.length === 0}`);
if (pageErrors.length) console.log(pageErrors.join('\n'));

await browser.close();
console.log('familia done');
