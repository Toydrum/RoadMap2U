import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchPage, BASE, ok } from './lib/harness.mjs';
const origin = new URL(BASE),
  output = resolve('output/playwright/private-adolescent-copy-2026-10-08');
assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname));
await mkdir(output, { recursive: true });
const checks = [],
  errors = [];
const { browser, page } = await launchPage(
  { width: 390, height: 844 },
  {
    commercialAccess: false,
    contextOptions: { serviceWorkers: 'block' },
  },
);
const check = (name, passed) => {
  checks.push({ name, passed });
  ok(name, passed);
  assert.ok(passed, name);
};
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', async (route) => {
  if (new URL(route.request().url()).origin !== origin.origin) {
    errors.push('ExternalRequestBlocked');
    await route.abort();
  } else await route.continue();
});
try {
  for (const locale of ['es', 'en']) {
    if (locale === 'en') {
      await page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'English', exact: true }).click();
      await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    }
    await page.goto(BASE + '/account', { waitUntil: 'networkidle' });
    await writeFile(
      resolve(output, locale + '-account-before.txt'),
      await page.locator('body').ariaSnapshot(),
    );
    await page
      .getByRole('button', {
        name: locale === 'es' ? 'Quiero una llave nueva' : 'I want a new key',
        exact: true,
      })
      .click();
    const form = page.locator('.auth-form');
    await form.locator('input[name="signup-age"]').first().waitFor();
    const content = await page.locator('body').innerText();
    check(
      locale + ': registration describes authenticated declaration',
      (locale === 'es' ? /declaración autenticada/i : /authenticated declaration/i).test(content),
    );
    check(
      locale + ': registration has no claim of verified representation',
      !(locale === 'es' ? /representación verificada/i : /verified representation/i).test(content),
    );
    check(
      locale + ': age and terms remain unselected',
      (await form.locator('input[type="checkbox"]:checked,input[type="radio"]:checked').count()) ===
        0,
    );
    check(
      locale + ': mobile has no horizontal overflow',
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    );
    check(
      locale + ': account inputs have accessible labels',
      await form
        .locator('input[autocomplete="username"]')
        .evaluate((element) => element.labels.length > 0),
    );
    await form.locator('input[autocomplete="username"]').focus();
    await page.keyboard.press('Tab');
    check(
      locale + ': keyboard reaches the email input',
      await form
        .locator('input[type="email"]')
        .evaluate((element) => document.activeElement === element),
    );
    await page.screenshot({ path: resolve(output, locale + '-signup-mobile.png'), fullPage: true, animations: 'disabled' });
    await writeFile(
      resolve(output, locale + '-signup-aria.txt'),
      await page.locator('body').ariaSnapshot(),
    );
  }
  check('no runtime errors or external traffic', errors.length === 0);
} catch (error) {
  process.exitCode = 1;
  errors.push(error.message);
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true, animations: 'disabled' });
  await writeFile(resolve(output, 'failure-aria.txt'), await page.locator('body').ariaSnapshot());
  console.error(error.message);
} finally {
  await writeFile(
    resolve(output, 'receipt.json'),
    JSON.stringify(
      {
        scope: 'local_mock_registration_only',
        checkedAtUtc: new Date().toISOString(),
        viewport: { width: 390, height: 844 },
        accountsCreated: 0,
        cloudDecisions: 0,
        externalResourceWrites: 0,
        checks,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  await browser.close();
}
