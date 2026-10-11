import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BASE, launchPage, ok, waitForAuthIdentityCleared } from './lib/harness.mjs';

const origin = new URL(BASE);
assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname), 'local mock rehearsal only');
const output = resolve('tools/battery-logs/billing-private-cloud');
await mkdir(output, { recursive: true });
const checks = [],
  errors = [];
const check = (name, passed) => {
  checks.push({ name, passed });
  ok(name, passed);
  assert.ok(passed, name);
};
const { browser, page } = await launchPage(
  { width: 1280, height: 900 },
  { commercialAccess: false, contextOptions: { serviceWorkers: 'block', reducedMotion: 'reduce' } },
);
page.setDefaultTimeout(12_000);
page.on('pageerror', (error) => {
  errors.push(error.message);
  console.log('PAGEERROR', error.message);
});
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
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
          const tx = connection.transaction(store, operation === 'put' ? 'readwrite' : 'readonly');
          const request =
            operation === 'all'
              ? tx.objectStore(store).getAll()
              : tx.objectStore(store)[operation](data);
          let result;
          request.onsuccess = () => {
            result = request.result;
          };
          tx.oncomplete = () => {
            connection.close();
            resolve(result);
          };
          tx.onerror = () => {
            connection.close();
            reject(tx.error);
          };
        };
      }),
    { database, store, operation, data },
  );
}
const cloud = (store, operation, data) => db('roadmap2u-mockcloud', store, operation, data);
const local = (store, operation, data) => db('roadmap2u', store, operation, data);
const panel = () => page.locator('app-privacy-panel');
async function signup(username, invitation) {
  await page.goto(BASE + '/account', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Quiero una llave nueva', exact: true }).click();
  const form = page.locator('.auth-form');
  await form.locator('input[name="signup-age"]').first().waitFor();
  check(
    'age and consent start unchecked: ' + username,
    (await form.locator('input[type="checkbox"]:checked,input[type="radio"]:checked').count()) ===
      0,
  );
  await form.locator('input[autocomplete="username"]').fill(username);
  await form.locator('input[type="email"]').fill(username + '@example.invalid');
  for (const password of await form.locator('input[type="password"]').all())
    await password.fill('LocalProbe123!');
  await form
    .locator('input[name="signup-age"]')
    .nth(invitation ? 1 : 0)
    .check();
  if (invitation) {
    await form.locator('input[maxlength="64"]').fill(invitation);
    await form.locator('input[type="checkbox"]').first().check();
  }
  await form.locator('input[type="checkbox"]').last().check();
  await form.locator('button[type="submit"]').click();
  await page.locator('input[autocomplete="one-time-code"]').fill('123456');
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await page.getByRole('heading', { name: 'Tu cuenta', exact: true }).waitFor();
}
async function settings() {
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
  await panel().getByRole('button', { name: 'Conectar mi bosque', exact: true }).waitFor();
}
try {
  await signup('bill_parent');
  const parent = await cloud('users', 'get', 'u-bill_parent');
  const evidenceKey = `billing.individual.evidence:${parent.userId}:${parent.accountInstanceId}`;
  const paid = {
    source: 'test_seed',
    accountId: parent.userId,
    accountInstanceId: parent.accountInstanceId,
    invoiceId: 'invoice-private-cloud-battery',
    interval: 'month',
    paidThrough: Date.now() + 3_600_000,
    cancelAtPeriodEnd: false,
    revision: 2,
  };
  await cloud('kv', 'put', { key: evidenceKey, value: paid });
  await page.goto(BASE + '/account/subscription', { waitUntil: 'networkidle' });
  await page.locator('.billing-access').filter({ hasText: 'Premium' }).waitFor();
  const parentAccess = (await local('meta', 'get', 'commercial.access:' + parent.userId))?.summary;
  check(
    'adult Premium comes from its individual paid source and bounded paid period',
    parentAccess?.activeSources.length === 1 &&
      parentAccess.activeSources[0].kind === 'subscription' &&
      parentAccess.activeSources[0].scope === 'individual' &&
      parentAccess.offlineValidUntil <= paid.paidThrough,
  );
  check(
    'adult capacity has no sponsored or family coverage fixture',
    !(await cloud('coverages', 'get', parent.userId)),
  );
  await page.goto(BASE + '/account', { waitUntil: 'networkidle' });
  await panel()
    .locator('summary')
    .filter({ hasText: 'Autorizo una cuenta adolescente privada' })
    .click();
  const form = panel().locator('form');
  await form.locator('input[name="guardian-name"]').fill('María Pérez');
  await form.locator('select[name="guardian-relationship"]').selectOption('parent');
  await form.locator('input[type="text"]').last().fill('bill_teen');
  await form.locator('input[type="date"]').fill('2029-10-11');
  for (const box of await form.locator('input[type="checkbox"]').all()) await box.check();
  await form.locator('button[type="submit"]').click();
  await panel().getByText('Autorizada: puede aceptarse', { exact: true }).waitFor();
  const invitation = (await cloud('kv', 'all')).find(
    (row) =>
      row.key.startsWith('private-adolescent-invitation:') &&
      row.value.guardianId === parent.userId,
  );
  check(
    'paid adult can authorize the exact named private adolescent',
    invitation?.value.state === 'authorized' &&
      invitation.value.authorizationMethod === 'account_attestation',
  );
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await waitForAuthIdentityCleared(page);
  await signup('bill_teen', invitation.value.invitationId);
  const teen = await cloud('users', 'get', 'u-bill_teen');
  check(
    'real invitation acceptance isolates a private minor',
    teen.accountType === 'minor' &&
      teen.privacyMode === 'adolescent_private' &&
      teen.socialEnabled === false,
  );
  check(
    'private teen has no subscription purchase link',
    (await page.locator('.billing-account-link').count()) === 0,
  );
  await page.goto(BASE + '/account/subscription', { waitUntil: 'networkidle' });
  await page.locator('.billing-status[aria-busy="false"]').waitFor();
  check(
    'direct subscription route has no payment action for the private adolescent',
    (await page.locator('.billing-checkout,.billing-portal,form').count()) === 0,
  );
  await settings();
  check(
    'private teen settings has no subscription purchase link',
    (await page.locator('.billing-account-link').count()) === 0,
  );
  const connect = () => panel().getByRole('button', { name: 'Conectar mi bosque', exact: true });
  check('paid responsible capacity allows a separate cloud choice', await connect().isEnabled());
  await connect().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  check(
    'adolescent cloud consent starts unchecked',
    !(await dialog.locator('input[type="checkbox"]').isChecked()),
  );
  await dialog.locator('input[type="checkbox"]').check();
  await dialog.getByRole('button', { name: 'Autorizo y conecto mi bosque', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await panel().getByText('Mi autorización de nube está vigente.', { exact: true }).waitFor();
  const privacyKey = `privacy:${encodeURIComponent(teen.userId)}:${encodeURIComponent(teen.accountInstanceId)}`;
  const consent = (await cloud('kv', 'get', privacyKey)).value;
  check(
    'guardian and adolescent cloud consents are separate and current',
    consent.guardianConsent === 'granted' && consent.cloudConsent === 'granted',
  );
  const teenAccess = (await local('meta', 'get', 'commercial.access:' + teen.userId))?.summary;
  check(
    'private cloud leaves personal plan Free and family disabled',
    teenAccess?.effectivePlanKey === 'free' &&
      teenAccess.capabilities.family === false &&
      teenAccess.capabilities.cloudSync === false,
  );
  check(
    'private cloud creates no personal Premium or family membership',
    !(await cloud('coverages', 'get', teen.userId)) &&
      !(await cloud('guardianLinks', 'all')).some(
        (row) => row.guardianId === parent.userId || row.minorId === teen.userId,
      ),
  );
  for (const [name, facts] of [
    ['expired', { ...paid, paidThrough: Date.now() - 1000, revision: 3 }],
    ['review', { ...paid, review: true, revision: 4 }],
    ['wrong account instance', { ...paid, accountInstanceId: 'other-instance', revision: 5 }],
  ]) {
    await cloud('kv', 'put', { key: evidenceKey, value: facts });
    await settings();
    check(name + ' adult payment removes private cloud capacity', await connect().isDisabled());
    const retained = (await cloud('kv', 'get', privacyKey)).value;
    check(
      name + ' capacity loss preserves both consents',
      retained.guardianConsent === 'granted' &&
        retained.cloudConsent === 'granted' &&
        retained.revision === consent.revision,
    );
  }
  await cloud('kv', 'put', { key: evidenceKey, value: { ...paid, revision: 6 } });
  await settings();
  check(
    'fresh verified adult paid source restores capacity without another consent',
    await connect().isEnabled(),
  );
  await page.screenshot({
    path: resolve(output, 'individual-parent-private-cloud.png'),
    fullPage: true,
  });
  check('no runtime errors or external requests', errors.length === 0);
} catch (error) {
  errors.push(error.message);
  process.exitCode = 1;
  await writeFile(resolve(output, 'failure-aria.txt'), await page.locator('body').ariaSnapshot());
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true });
  console.error(error);
} finally {
  await writeFile(
    resolve(output, 'receipt.json'),
    JSON.stringify(
      {
        scope: 'local_mock_only',
        paidSource: 'explicit individual test_seed; exact adult account instance',
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
