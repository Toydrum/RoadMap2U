// Household v2: real UI over isolated practice data; no AWS, no payments.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BASE, launchPage, signInAs, ok } from './lib/harness.mjs';
const { browser, page } = await launchPage({ width: 1280, height: 800 });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
const output = resolve('tools/battery-logs/familia');
await mkdir(output, { recursive: true });
try {
  await signInAs(page, 'rocio', 'Bosque123');
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
  await page.locator('.familia').waitFor();
  // Canonical v2 fixture, intentionally separate from legacy demo links.
  await page.evaluate(
    () =>
      new Promise((yes, no) => {
        const req = indexedDB.open('roadmap2u-mockcloud');
        req.onerror = () => no(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(
            ['users', 'households', 'seatAssignments', 'supervisionLinks', 'coverages'],
            'readwrite',
          );
          const users = tx.objectStore('users').getAll();
          users.onsuccess = () => {
            const primary = users.result.find((user) => user.username === 'rocio');
            const minor = users.result.find((user) => user.username === 'nico');
            const additional = users.result.find((user) => user.username === 'ambar');
            const homes = tx.objectStore('households').getAll();
            homes.onsuccess = () => {
              const householdId =
                homes.result.find((home) => home.primaryResponsibleId === primary.userId)
                  ?.householdId ?? 'qa-family';
              const now = Date.now();
              // The demo already has two children. Free only its second canonical
              // seat in this disposable context so creation can exercise the limit.
              tx.objectStore('seatAssignments').delete(householdId + ':minor:2');
              tx.objectStore('households').put({
                householdId,
                primaryResponsibleId: primary.userId,
                country: 'MX',
                state: 'active',
                revision: 1,
                createdAt: now,
                updatedAt: now,
              });
              tx.objectStore('seatAssignments').put({
                assignmentId: householdId + ':minor:1',
                householdId,
                seatType: 'minor',
                position: 1,
                accountId: minor.userId,
                majorityAt: '2035-01-01',
                assignedAt: now,
              });
              tx.objectStore('seatAssignments').put({
                assignmentId: householdId + ':additional',
                householdId,
                seatType: 'additional_responsible',
                position: null,
                accountId: additional.userId,
                majorityAt: null,
                assignedAt: now,
              });
              for (const [adult, role] of [
                [primary, 'primary_responsible'],
                [additional, 'additional_responsible'],
              ]) {
                tx.objectStore('supervisionLinks').put({
                  linkId: householdId + ':' + adult.userId + ':' + minor.userId,
                  householdId,
                  adultId: adult.userId,
                  minorId: minor.userId,
                  role,
                  state: 'active',
                  createdAt: now,
                  revokedAt: null,
                });
              }
              for (const [account, seatType] of [
                [primary, null],
                [minor, 'minor'],
                [additional, 'additional_responsible'],
              ]) {
                tx.objectStore('coverages').put({
                  coverageId: account.userId,
                  accountId: account.userId,
                  householdId,
                  seatType,
                  source: 'test_seed',
                  state: 'active',
                  validUntil: null,
                  createdAt: now,
                });
              }
            };
          };
          tx.oncomplete = () => {
            db.close();
            yes();
          };
          tx.onerror = () => no(tx.error);
        };
      }),
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.fam-open', { hasText: 'Nico' }).waitFor();
  ok(
    'canonical roles and scope',
    (await page.locator('.familia').innerText())
      .toLowerCase()
      .includes('responsable principal de la cuenta') &&
      (await page.locator('.fam-scope').innerText()).includes('Nico'),
  );

  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1280, 800],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await page.locator('.familia').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, 'household-' + width + '.png') });
    const fits = await page
      .locator('.familia')
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    ok('household fits ' + width, fits);
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.fam-create').click();
  await page.locator('.fam-username').fill('luna');
  ok('creation requires declarations', await page.locator('.fam-create-submit').isDisabled());
  await page.locator('.fam-majority-date').fill('2035-01-01');
  await page.locator('.fam-declaration').check();
  await page.locator('.fam-consent').check();
  await page.screenshot({ path: resolve(output, 'create-375.png') });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  ok(
    '200 percent form fits',
    await page.locator('.familia-sheet').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  await page.screenshot({ path: resolve(output, 'create-375-text-200.png') });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.locator('.fam-create-submit').focus();
  await page.keyboard.press('Tab');
  ok(
    'keyboard focus trap',
    await page.locator('.fam-username').evaluate((el) => document.activeElement === el),
  );
  await page.keyboard.press('Escape');
  await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  ok(
    'Escape dismisses and restores opener',
    (await page.locator('.familia-sheet').count()) === 0 &&
      (await page.locator('.fam-create').evaluate((el) => document.activeElement === el)),
  );

  await page.locator('.fam-create').click();
  await page.locator('.fam-username').fill('luna');
  await page.locator('.fam-majority-date').fill('2035-01-01');
  await page.locator('.fam-declaration').check();
  await page.locator('.fam-consent').check();
  await page.locator('.fam-create-submit').click();
  await page.locator('.temp-password').waitFor();
  ok(
    'temporary password revealed once',
    (await page.locator('.temp-password').innerText()).length > 0,
  );
  await page.locator('.familia-sheet button', { hasText: 'Listo' }).click();
  ok('two seats enforce capacity', await page.locator('.fam-create').isDisabled());

  await page.locator('.fam-open', { hasText: 'luna' }).click();
  await page.locator('.fam-reset').waitFor();
  ok(
    'primary identity tools',
    (await page.locator('.fam-reset').count()) === 1 &&
      (await page.locator('.fam-export').count()) === 1 &&
      (await page.locator('.fam-delete').count()) === 1,
  );
  await page.keyboard.press('Escape');
  await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  await page.locator('.fam-transfer').click();
  await page.locator('.fam-transfer-confirm').click();
  await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  ok(
    'transfer proposal preserves primary',
    (await page.locator('.fam-name').first().innerText()) === 'Rocío',
  );
  await signInAs(page, 'ambar', 'Bosque123');
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
  await page.locator('.fam-open', { hasText: 'Nico' }).waitFor();
  ok(
    'additional sees only scoped management',
    (await page.locator('.fam-open').count()) === 1 &&
      (await page.locator('.fam-create').count()) === 0 &&
      (await page.locator('.fam-transfer').count()) === 0,
  );
  await page.locator('.fam-open').click();
  ok(
    'additional has no identity tools',
    (await page
      .locator('.fam-reset, .fam-export, .fam-delete, .fam-rename, .fam-social')
      .count()) === 0,
  );
  await page.keyboard.press('Escape');
  await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  await page.locator('.fam-transfer-accept').click();
  await page.locator('.fam-transfer-confirm').click();
  await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  ok(
    'recipient explicitly accepts transfer',
    (await page.locator('.fam-name').first().innerText()) === 'Ámbar',
  );
  await signInAs(page, 'nico', 'Semilla1!', { expect: 'challenge' });
  const newPasswords = page.locator('.auth-form input[autocomplete="new-password"]');
  await newPasswords.nth(0).fill('SemillaNueva123!');
  await newPasswords.nth(1).fill('SemillaNueva123!');
  await page.locator('.auth-form button[type="submit"]').click();
  await page.locator('h1', { hasText: 'Tu cuenta' }).waitFor();
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
  await page.locator('.fam-scope').waitFor();
  ok(
    'minor is informed without administration',
    (await page.locator('.fam-open, .fam-create, .fam-transfer').count()) === 0 &&
      (await page.locator('.familia').innerText()).includes('siguen siendo solo tuyos'),
  );
  ok('no runtime errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}
