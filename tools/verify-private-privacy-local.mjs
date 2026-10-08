import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchPage, BASE, ok, waitForAuthIdentityCleared } from './lib/harness.mjs';
const origin = new URL(BASE);
assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname), 'local mock probe only');
const output = resolve('output/playwright/private-privacy-2026-10-07');
await mkdir(output, { recursive: true });
const checks = [],
  errors = [];
const check = (name, passed, detail = '') => {
  checks.push({ name, passed, detail });
  ok(name, passed, detail);
  assert.ok(passed, name);
};
const { browser, page } = await launchPage(
  { width: 1280, height: 900 },
  {
    commercialAccess: false,
    contextOptions: { serviceWorkers: 'block', acceptDownloads: true },
  },
);
page.setDefaultTimeout(12000);
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', async (route) => {
  if (new URL(route.request().url()).origin !== origin.origin) {
    errors.push('Unexpected external request');
    await route.abort();
  } else await route.continue();
});
async function db(database, store, operation, data) {
  return page.evaluate(
    ({ database, store, operation, data }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open(database);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const connection = open.result;
          if (!connection.objectStoreNames.contains(store)) {
            connection.close();
            resolve(operation === 'all' ? [] : undefined);
            return;
          }
          const tx = connection.transaction(store, operation === 'put' ? 'readwrite' : 'readonly');
          const request =
            operation === 'put'
              ? tx.objectStore(store).put(data)
              : operation === 'all'
                ? tx.objectStore(store).getAll()
                : tx.objectStore(store).get(data);
          let result;
          request.onsuccess = () => (result = request.result);
          tx.oncomplete = () => {
            connection.close();
            resolve(result);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { database, store, operation, data },
  );
}
const cloud = (store, operation, data) => db('roadmap2u-mockcloud', store, operation, data);
const local = (store, operation, data) => db('roadmap2u', store, operation, data);
const decisions = async () =>
  (await cloud('kv', 'all')).filter(
    (row) => row.key.startsWith('privacy:') && row.key.includes(':command:'),
  ).length;
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const panel = () => page.locator('app-privacy-panel');
async function settings() {
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
  await panel().getByRole('button', { name: 'Conectar mi bosque', exact: true }).waitFor();
}
async function signup(username, invitation) {
  await page.goto(BASE + '/account', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Quiero una llave nueva', exact: true }).click();
  const form = page.locator('.auth-form');
  await form.locator('input[name="signup-age"]').first().waitFor();
  check(
    'signup starts without age or consent selected: ' + username,
    (await form.locator('input[type="checkbox"]:checked,input[type="radio"]:checked').count()) ===
      0,
  );
  await form.locator('input[autocomplete="username"]').fill(username);
  await form.locator('input[type="email"]').fill(username + '@example.invalid');
  for (const password of await form.locator('input[type="password"]').all())
    await password.fill('LocalProbe123!');
  if (!invitation) {
    await form.locator('input[name="signup-age"]').first().check();
    await page.waitForFunction(
      () =>
        !document.querySelector('.auth-form input[type="checkbox"]:checked') &&
        !document.querySelector('.auth-form input[maxlength="64"]'),
    );
    await form.locator('input[type="checkbox"]').last().check();
    await form.locator('input[name="signup-age"]').last().check();
    await page.waitForFunction(
      () => !document.querySelector('.auth-form input[type="checkbox"]:checked'),
    );
    check(
      'changing age clears prior terms',
      (await form.locator('input[type="checkbox"]:checked').count()) === 0,
    );
    await form.locator('input[name="signup-age"]').first().check();
    await form.locator('button[type="submit"]').click();
    await page.locator('.error-line').waitFor();
    check(
      'unchecked terms do not create an account',
      !(await cloud('credentials', 'get', username)),
    );
  } else {
    await form.locator('input[name="signup-age"]').last().check();
    await form.locator('input[maxlength="64"]').fill(invitation);
    await form.locator('input[type="checkbox"]').first().check();
  }
  await form.locator('input[type="checkbox"]').last().check();
  await page.screenshot({ path: resolve(output, username + '-signup.png'), fullPage: true });
  await form.locator('button[type="submit"]').click();
  await page.locator('input[autocomplete="one-time-code"]').fill('123456');
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await page.getByRole('heading', { name: 'Tu cuenta', exact: true }).waitFor();
}
async function signout() {
  await page.goto(BASE + '/account', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await waitForAuthIdentityCleared(page);
}
try {
  await signup('privacy_parent');
  const parent = await cloud('users', 'get', 'u-privacy_parent');
  check(
    'adult signup records terms separately from cloud',
    (await cloud('kv', 'all')).some(
      (row) =>
        row.key.startsWith('privacy:') &&
        row.value?.adultDeclared &&
        row.value.cloudConsent === 'absent',
    ),
  );
  const now = Date.now();
  const tree = {
    id: 'privacy-local-tree',
    name: 'Local test forest',
    accent: 'sage',
    order: 10,
    currentNodeId: null,
    heartId: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    rev: 1,
    deletedAt: null,
  };
  const checkin = {
    id: 'privacy-local-checkin',
    feeling: 'sunny',
    note: 'Synthetic local note: preserve',
    treeId: null,
    nodeId: null,
    createdAt: now,
    updatedAt: now,
    rev: 1,
    deletedAt: null,
  };
  await local('trees', 'put', tree);
  await local('checkins', 'put', checkin);
  await settings();
  const before = await decisions();
  const connect = panel().getByRole('button', { name: 'Conectar mi bosque', exact: true });
  await connect.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  check(
    'cloud authorization is unchecked',
    !(await dialog.locator('input[type="checkbox"]').isChecked()),
  );
  check(
    'unchecked cloud cannot be confirmed',
    await dialog
      .getByRole('button', { name: 'Autorizo y conecto mi bosque', exact: true })
      .isDisabled(),
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  check(
    'Escape records no decision and restores focus',
    (await decisions()) === before &&
      (await connect.evaluate((element) => element === document.activeElement)),
  );
  await connect.click();
  await dialog.waitFor();
  await page.locator('.sheet-backdrop').click({ position: { x: 8, y: 8 } });
  await dialog.waitFor({ state: 'detached' });
  check('backdrop exit records no decision', (await decisions()) === before);
  await connect.click();
  await dialog.waitFor();
  await dialog.locator('input[type="checkbox"]').check();
  await dialog.getByRole('button', { name: 'Autorizo y conecto mi bosque', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await panel().getByText('Mi autorización de nube está vigente.', { exact: true }).waitFor();
  const access = (await local('meta', 'get', 'commercial.access:' + parent.userId))?.summary;
  check(
    'privacy approval does not grant Premium or sync a Free forest',
    access?.effectivePlanKey === 'free' &&
      access.capabilities.cloudSync === false &&
      (await cloud('records', 'all')).every((row) => row.ownerId !== parent.userId),
  );
  await panel()
    .getByRole('button', { name: 'Retiro mi autorización de nube', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Retiro mi autorización', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  check(
    'withdrawal preserves local forest and note',
    JSON.stringify(await local('trees', 'get', tree.id)) === JSON.stringify(tree) &&
      JSON.stringify(await local('checkins', 'get', checkin.id)) === JSON.stringify(checkin),
  );
  await panel()
    .locator('summary')
    .filter({ hasText: 'Autorizo una cuenta adolescente privada' })
    .click();
  const guardianForm = panel().locator('form');
  const parentPremium = {
    coverageId: parent.userId,
    accountId: parent.userId,
    householdId: 'local-parent-premium-fixture',
    seatType: null,
    state: 'active',
    source: 'test_seed',
    validUntil: Date.now() + 86_400_000,
    createdAt: Date.now(),
  };
  await cloud('coverages', 'put', parentPremium);
  await guardianForm.locator('input[name="guardian-name"]').fill('María Pérez');
  await guardianForm.locator('select[name="guardian-relationship"]').selectOption('parent');
  await guardianForm.locator('input[type="text"]').last().fill('privacy_teen');
  await guardianForm.locator('input[type="date"]').fill('2029-10-07');
  for (const box of await guardianForm.locator('input[type="checkbox"]').all()) await box.check();
  await guardianForm.locator('button[type="submit"]').click();
  await panel().getByText('Autorizada: puede aceptarse', { exact: true }).waitFor();
  const invitation = (await cloud('kv', 'all')).find((row) =>
    row.key.startsWith('private-adolescent-invitation:'),
  );
  check(
    'exact authenticated declaration is authorized without an operator or content permission',
    invitation.value.state === 'authorized' &&
      invitation.value.authorizationMethod === 'account_attestation' &&
      !invitation.value.representationVerifiedAt &&
      !invitation.value.verificationCaseId &&
      invitation.value.recipientUsername === 'privacy_teen' &&
      invitation.value.guardianId === parent.userId &&
      !(await cloud('guardianLinks', 'all')).some((link) => link.guardianId === parent.userId),
  );
  await panel().screenshot({ path: resolve(output, 'guardian-metadata.png') });
  await signout();
  await signup('privacy_teen', invitation.value.invitationId);
  const teen = await cloud('users', 'get', 'u-privacy_teen');
  check(
    'teen signup converts technical profile to isolated minor',
    teen.accountType === 'minor' &&
      teen.privacyMode === 'adolescent_private' &&
      teen.socialEnabled === false,
  );
  check(
    'private teen account hides paid key and adult self-closure',
    (await page.locator('app-access-key-form').count()) === 0 &&
      (await page.getByRole('button', { name: 'Cerrar mi cuenta', exact: true }).count()) === 0,
  );
  await settings();
  await cloud('coverages', 'put', { ...parentPremium, state: 'revoked' });
  await settings();
  check(
    'private settings omit family and friends',
    (await page.locator('app-familia-card,app-amigos-card').count()) === 0,
  );
  check(
    'private cloud requires current Premium of the responsible adult',
    await panel().getByRole('button', { name: 'Conectar mi bosque', exact: true }).isDisabled(),
  );
  await panel()
    .getByText(/necesita Premium vigente/)
    .waitFor();
  await page.screenshot({ path: resolve(output, 'private-cloud-no-coverage.png'), fullPage: true });
  // Local coverage fixture only: it grants no personal teen Premium or family membership.
  await cloud('coverages', 'put', parentPremium);
  await settings();
  check(
    'responsible Premium enables a separate teen cloud decision',
    await panel().getByRole('button', { name: 'Conectar mi bosque', exact: true }).isEnabled(),
  );
  check(
    'responsible cloud does not grant teen Premium or family records',
    !(await cloud('coverages', 'get', teen.userId)) &&
      !(await cloud('guardianLinks', 'all')).some(
        (link) => link.minorId === teen.userId || link.guardianId === parent.userId,
      ),
  );
  check(
    'private settings use the admitted minor role',
    !(await page.locator('.account-role').innerText()).includes('adulta'),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  check('Spanish private settings fit small screens', await overflow());
  await panel().scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(output, 'private-settings-es-mobile.png'),
    fullPage: true,
  });
  await panel().getByRole('button', { name: 'Conectar mi bosque', exact: true }).click();
  await dialog.waitFor();
  check(
    'teen has a separate unchecked cloud decision',
    !(await dialog.locator('input[type="checkbox"]').isChecked()),
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await panel().getByRole('button', { name: 'Connect my forest', exact: true }).waitFor();
  await panel().getByRole('button', { name: 'Connect my forest', exact: true }).click();
  await dialog.waitFor();
  check(
    'English consent is translated and unchecked',
    (await dialog.innerText()).includes('health or beliefs') &&
      !(await dialog.locator('input[type="checkbox"]').isChecked()),
  );
  check(
    'English mobile dialog fits and has a named accessible modal',
    (await overflow()) &&
      (await dialog.getAttribute('aria-modal')) === 'true' &&
      !!(await dialog.getAttribute('aria-label')),
  );
  await page.keyboard.press('Tab');
  check(
    'keyboard stays inside the privacy dialog',
    await dialog.evaluate((element) => element.contains(document.activeElement)),
  );
  await dialog.evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
  await page.screenshot({ path: resolve(output, 'private-cloud-en-mobile.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await cloud('coverages', 'put', { ...parentPremium, state: 'revoked' });
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
  await panel().getByRole('button', { name: 'Connect my forest', exact: true }).waitFor();
  check(
    'responsible Premium revocation disables cloud while export stays available',
    (await panel().getByRole('button', { name: 'Connect my forest', exact: true }).isDisabled()) &&
      (await panel()
        .getByRole('button', { name: 'I download my remote data', exact: true })
        .isEnabled()),
  );
  const [exportFile] = await Promise.all([
    page.waitForEvent('download'),
    panel().getByRole('button', { name: 'I download my remote data', exact: true }).click(),
  ]);
  await exportFile.saveAs(resolve(output, 'private-own-export.json'));
  check(
    'Free private teen can export own data without cloud approval',
    exportFile.suggestedFilename().startsWith('RoadMap2U-privacy-'),
  );
  await page.getByRole('button', { name: 'Español', exact: true }).click();
  await panel()
    .getByRole('button', { name: 'Solicito cancelar mi bosque de la nube', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Solicito la cancelación remota', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await panel()
    .getByText(/^Se verificó la supresión/)
    .waitFor();
  check(
    'private erasure preserves account, local tree and note',
    !!(await cloud('users', 'get', teen.userId)) &&
      JSON.stringify(await local('trees', 'get', tree.id)) === JSON.stringify(tree) &&
      JSON.stringify(await local('checkins', 'get', checkin.id)) === JSON.stringify(checkin),
  );
  check('no runtime errors or external requests', errors.length === 0, errors.join('; '));
} catch (error) {
  process.exitCode = 1;
  errors.push(error.message);
  await writeFile(resolve(output, 'failure-aria.txt'), await page.locator('body').ariaSnapshot());
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true });
  console.error(error.message);
} finally {
  await writeFile(
    resolve(output, 'receipt.json'),
    JSON.stringify(
      {
        scope: 'local_mock_only',
        date: '2026-10-07',
        authorizationMethod: 'account_attestation',
        verifiesCivilDocuments: false,
        operatorCalls: 0,
        responsiblePremium: 'local coverage fixture only',
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
