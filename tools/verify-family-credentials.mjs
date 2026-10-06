import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BASE, launchPage, newProbePage, ok, signInAs } from './lib/harness.mjs';

// Local mock accounts only. The live DEV cohort is never used by this probe.
const output = resolve('tools/battery-logs/family-credentials');
await mkdir(output, { recursive: true });
const { browser, page: desktop } = await launchPage({ width: 1280, height: 800 });
const checks = [],
  errors = [],
  foreign = [];
const check = (name, passed) => {
  checks.push({ name, passed });
  ok(name, passed);
  assert.ok(passed, name);
};
try {
  const mobile = (await newProbePage(browser, { width: 375, height: 812 })).page;
  for (const [label, page] of [
    ['desktop', desktop],
    ['mobile', mobile],
  ]) {
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const origin = new URL(route.request().url()).origin;
      if (origin !== new URL(BASE).origin) {
        foreign.push(origin);
        await route.abort();
      } else await route.continue();
    });
    await signInAs(page, 'rocio', 'Bosque123');
    // Match DEV B's initially empty household in a disposable local context.
    await page.evaluate(
      () =>
        new Promise((yes, no) => {
          const request = indexedDB.open('roadmap2u-mockcloud');
          request.onerror = () => no(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(
              ['seatAssignments', 'supervisionLinks', 'guardianLinks'],
              'readwrite',
            );
            tx.objectStore('seatAssignments').delete('household:mock-parent:minor:1');
            tx.objectStore('seatAssignments').delete('household:mock-parent:minor:2');
            tx.objectStore('supervisionLinks').delete(
              'household:mock-parent:mock-parent:mock-child',
            );
            tx.objectStore('supervisionLinks').delete(
              'household:mock-parent:mock-parent:mock-teen',
            );
            tx.objectStore('guardianLinks').delete('link-rocio-nico');
            tx.objectStore('guardianLinks').delete('link-rocio-val');
            tx.oncomplete = () => {
              db.close();
              yes();
            };
            tx.onerror = () => no(tx.error);
          };
        }),
    );
    await page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
    await page.locator('.familia[aria-busy="false"]').waitFor();
    await page.locator('.fam-create').click();
    await page.waitForFunction(
      () => document.querySelector('.familia-sheet') === document.activeElement,
    );
    await page.locator('.fam-username').fill('credential_probe');
    await page.locator('.fam-majority-date').fill('2035-01-01');
    await page.locator('.fam-declaration').check();
    await page.locator('.fam-consent').check();
    await page.locator('.fam-create-submit').click();
    await page.locator('.temp-password').waitFor();
    const password = await page.locator('.temp-password').innerText();
    check(
      label + ' successful local creation displays temporary credentials',
      password.length >= 8,
    );
    // AuthService schedules the provider's quiet validation 4s after boot.
    await page.waitForTimeout(4_500);
    check(
      label + ' unchanged session validation keeps credentials visible',
      (await page.locator('.temp-password').isVisible()) &&
        (await page.locator('.temp-password').innerText()) === password,
    );
    check(
      label + ' credential sheet names the created minor',
      (await page.locator('.familia-sheet h2').innerText()).includes('credential_probe'),
    );
    const overflow = await page
      .locator('.familia-sheet')
      .evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    check(label + ' credential sheet has no horizontal overflow', !overflow);
    await page.screenshot({
      path: resolve(output, label + '.png'),
      mask: [page.locator('.temp-password')],
    });
    await page.locator('.fam-created-done').focus();
    await page.keyboard.press('Tab');
    check(
      label + ' focus stays inside the credential dialog',
      await page
        .locator('.familia-sheet')
        .evaluate((element) => element.contains(document.activeElement)),
    );
    await page.keyboard.press('Escape');
    await page.locator('.familia-sheet').waitFor({ state: 'detached' });
    check(
      label + ' dismissing credentials removes the password',
      (await page.locator('.temp-password').count()) === 0,
    );
    check(
      label + ' dismissing credentials restores focus',
      await page.locator('.fam-create').evaluate((element) => element === document.activeElement),
    );
  }
  check('no browser errors', errors.length === 0);
  check('no external requests', foreign.length === 0);
  await writeFile(
    resolve(output, 'result.json'),
    JSON.stringify(
      {
        status: 'local_family_credentials_verified',
        checkedAt: new Date().toISOString(),
        fixtures: true,
        liveDev: false,
        checks,
        errors,
        foreign,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
}
