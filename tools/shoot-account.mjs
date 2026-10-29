// Screenshots of the account ritual for self-review (desktop + mobile).
import { BASE, launchPage, admitSyntheticStandard } from './lib/harness.mjs';
const OUT = process.env.SHOT_DIR ?? 'shots';
const { browser, page } = await launchPage({ width: 1280, height: 800 }, { commercialAccess: false });

await page.goto(`${BASE}/account`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/account-welcome.png` });

await page.locator('button', { hasText: 'Iniciar sesión' }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/account-signin.png` });

await page.fill('.auth-form input[autocomplete="username"]', 'rocio');
await page.fill('.auth-form input[type="password"]', 'Bosque123');
await page.locator('.auth-form button[type=submit]').click();
await admitSyntheticStandard(page);
await page.locator('h1', { hasText: 'Tu cuenta' }).waitFor({ timeout: 5000 });
await page.screenshot({ path: `${OUT}/account-profile.png` });

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/account`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/account-profile-mobile.png` });

// The temp-password challenge screen (nico) — sign out first.
await page.locator('button', { hasText: 'Cerrar sesión' }).click();
await page.locator('h1', { hasText: 'Una llave' }).waitFor();
await page.locator('button', { hasText: 'Iniciar sesión' }).click();
await page.fill('.auth-form input[autocomplete="username"]', 'nico');
await page.fill('.auth-form input[type="password"]', 'Semilla1!');
await page.locator('.auth-form button[type=submit]').click();
await page.locator('h1', { hasText: 'Estrena tu contraseña' }).waitFor({ timeout: 5000 });
await page.screenshot({ path: `${OUT}/account-newpassword-mobile.png` });

await browser.close();
console.log('shots done');
