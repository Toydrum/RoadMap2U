import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { BASE, launchPage, signInAs, ok } from './lib/harness.mjs';

const output = pathToFileURL(resolve('tools/battery-logs/' + 'family-consents') + '/');
await mkdir(output, { recursive: true });
const { browser, page } = await launchPage({ width: 375, height: 812 });
const errors = [],
  foreign = [],
  checks = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('request', (request) => {
  if (!request.url().startsWith(BASE) && !request.url().startsWith('data:'))
    foreign.push(request.url());
});
const check = (name, passed, detail = '') => {
  checks.push({ name, passed, detail });
  ok(name, passed, detail);
  assert.ok(passed, name + ': ' + detail);
};
const settings = async (username) => {
  if (username) await signInAs(page, username, 'Bosque123');
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
  await page.locator('.familia').waitFor();
};
const cloud = async (stores) =>
  page.evaluate(
    (names) =>
      new Promise((yes, no) => {
        const req = indexedDB.open('roadmap2u-mockcloud');
        req.onerror = () => no(req.error);
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction(names, 'readonly'),
            result = {};
          for (const name of names) {
            const get = tx.objectStore(name).getAll();
            get.onsuccess = () => (result[name] = get.result);
          }
          tx.oncomplete = () => {
            db.close();
            yes(result);
          };
          tx.onerror = () => no(tx.error);
        };
      }),
    stores,
  );
const shoot = async (name) =>
  page.screenshot({ path: new URL(name + '.png', output).pathname.replace(/^\/([A-Z]:)/, '$1') });
const childFriends = async (adult, child) => {
  await settings(adult);
  await page.locator('.fam-open', { hasText: child }).click();
  await page.locator('.fam-friends').click();
  await page.locator('.familia-sheet h2', { hasText: 'Las amistades' }).waitFor();
};
const consentState = async (expected) => {
  const state = await cloud(['minorFriendRequests', 'consents', 'friendships']);
  check('consent count ' + expected, state.consents.length === expected);
  check(
    'friendship activates only at four: ' + expected,
    expected < 4
      ? state.friendships.length === 0 && state.minorFriendRequests[0]?.state === 'pending'
      : state.friendships.length === 1 && state.minorFriendRequests[0]?.state === 'active',
  );
  return state;
};

try {
  await settings('rocio');
  // Two disposable canonical households; preserve every seeded forest byte.
  await page.evaluate(
    () =>
      new Promise((yes, no) => {
        const req = indexedDB.open('roadmap2u-mockcloud');
        req.onerror = () => no(req.error);
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction(
              [
                'users',
                'credentials',
                'guardianLinks',
                'households',
                'seatAssignments',
                'supervisionLinks',
                'coverages',
                'friendships',
              ],
              'readwrite',
            );
          const now = Date.now();
          const nico = tx.objectStore('users').get('mock-child');
          nico.onsuccess = () =>
            tx.objectStore('users').put({ ...nico.result, socialEnabled: true });
          tx.objectStore('credentials').put({
            username: 'nico',
            userId: 'mock-child',
            password: 'Bosque123',
            mustChangePassword: false,
            pendingConfirm: false,
          });
          tx.objectStore('users').put({
            userId: 'mock-sol',
            username: 'sol',
            displayName: 'Sol',
            accountType: 'adult',
            email: 'sol@demo.bosque',
            socialEnabled: true,
            createdAt: now,
          });
          tx.objectStore('credentials').put({
            username: 'sol',
            userId: 'mock-sol',
            password: 'Bosque123',
            mustChangePassword: false,
            pendingConfirm: false,
          });
          tx.objectStore('guardianLinks').delete('link-rocio-val');
          tx.objectStore('seatAssignments').delete('household:mock-parent:minor:2');
          tx.objectStore('supervisionLinks').delete('household:mock-parent:mock-parent:mock-teen');
          tx.objectStore('friendships').clear();
          tx.objectStore('households').put({
            householdId: 'qa-ambar',
            primaryResponsibleId: 'mock-friend',
            country: 'MX',
            state: 'active',
            revision: 1,
            createdAt: now,
            updatedAt: now,
          });
          tx.objectStore('seatAssignments').put({
            assignmentId: 'qa-ambar:minor:1',
            householdId: 'qa-ambar',
            seatType: 'minor',
            position: 1,
            accountId: 'mock-teen',
            majorityAt: '2032-01-01',
            assignedAt: now,
          });
          tx.objectStore('supervisionLinks').put({
            linkId: 'qa-ambar:mock-friend:mock-teen',
            householdId: 'qa-ambar',
            adultId: 'mock-friend',
            minorId: 'mock-teen',
            role: 'primary_responsible',
            state: 'active',
            createdAt: now,
            revokedAt: null,
          });
          for (const [accountId, seatType] of [
            ['mock-friend', null],
            ['mock-teen', 'minor'],
          ])
            tx.objectStore('coverages').put({
              coverageId: accountId,
              householdId: 'qa-ambar',
              accountId,
              seatType,
              state: 'active',
              source: 'test_seed',
              validUntil: null,
              createdAt: now,
            });
          tx.oncomplete = () => {
            db.close();
            yes();
          };
          tx.onerror = () => no(tx.error);
        };
      }),
  );
  await settings();
  const originalForests = JSON.stringify((await cloud(['records'])).records);
  await page.locator('.fam-create').click();
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  await page.locator('.fam-create-cancel').scrollIntoViewIfNeeded();
  check(
    '200 percent creation controls remain reachable',
    (await page.locator('.fam-create-cancel').isVisible()) &&
      (await page.locator('.fam-create-cancel').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      })),
  );
  await shoot('creation-200-controls');
  await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  await page.keyboard.press('Escape');
  await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  await page.locator('.fam-additional-invite').click();
  check(
    'additional invitation needs exact adult identity',
    await page.locator('.fam-additional-submit').isDisabled(),
  );
  await page.locator('.fam-adult-id-input').fill('mock-sol');
  await shoot('additional-invitation');
  await page.locator('.fam-additional-submit').click();
  await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  let state = await cloud(['accountNotices', 'seatAssignments']);
  check(
    'invitation does not grant before recipient accepts',
    state.accountNotices.some(
      (row) => row.kind === 'additional_responsible_invitation' && row.state === 'pending',
    ) && !state.seatAssignments.some((row) => row.accountId === 'mock-sol'),
  );
  await settings('sol');
  await page.locator('.fam-notice-action').click();
  await shoot('additional-acceptance');
  await page.locator('.fam-notice-confirm').click();
  await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  await page.locator('.fam-open', { hasText: 'Nico' }).waitFor();
  check(
    'accepted additional guardian sees only Nico',
    (await page.locator('.fam-open').count()) === 1 &&
      (await page.locator('.fam-scope').innerText()).includes('Nico'),
  );
  await page.locator('.fam-open').click();
  check(
    'additional guardian has no identity or closure controls',
    (await page.locator('.fam-reset,.fam-export,.fam-delete,.fam-rename,.fam-social').count()) ===
      0,
  );
  await page.keyboard.press('Escape');
  await settings('val');
  await page.locator('.amigos').waitFor();
  await page
    .locator('.amigos')
    .getByRole('button', { name: 'Crear código para otra persona menor', exact: true })
    .click();
  await page.locator('.amigos-code').waitFor();
  const code = (await page.locator('.amigos-code').innerText()).replaceAll('-', '').trim();
  await settings('nico');
  await page.locator('.amigos-redeem .code-entry').fill(code);
  await page.locator('.amigos-redeem button[type=submit]').click();
  await page.locator('.amigos-group', { hasText: '1 de 4' }).waitFor();
  await consentState(1);
  await settings('val');
  const incoming = page.locator('.amigos-row', { hasText: 'Nico' });
  await incoming.getByRole('button', { name: 'Aceptar', exact: true }).click();
  await page.locator('.amigos-group', { hasText: '2 de 4' }).waitFor();
  await consentState(2);
  await shoot('minor-pending-two-consents');
  await childFriends('rocio', 'Nico');
  await page
    .locator('.familia-sheet')
    .getByRole('button', { name: 'Aprobar amistad', exact: true })
    .click();
  await page.locator('.familia-sheet', { hasText: '3 de 4' }).waitFor();
  await consentState(3);
  await shoot('guardian-pending-three-consents');
  await childFriends('ambar', 'Val');
  await page
    .locator('.familia-sheet')
    .getByRole('button', { name: 'Aprobar amistad', exact: true })
    .click();
  await page.locator('.fam-friend-remove').waitFor();
  const complete = await consentState(4);
  check(
    'four distinct consent kinds and exact participants',
    new Set(complete.consents.map((row) => row.kind)).size === 4 &&
      complete.consents.some(
        (row) => row.kind === 'requester_responsible_approval' && row.actorId === 'mock-parent',
      ) &&
      complete.consents.some(
        (row) => row.kind === 'recipient_responsible_approval' && row.actorId === 'mock-friend',
      ),
  );
  await shoot('guardian-four-consents');
  await page.locator('.fam-friend-remove').click();
  await page.locator('.fam-friend-remove').waitFor({ state: 'detached' });
  const revoked = await cloud(['friendships', 'minorFriendRequests', 'consents']);
  check(
    'guardian revocation preserves the four historical consents',
    revoked.friendships.length === 0 &&
      revoked.consents.length === 4 &&
      revoked.minorFriendRequests[0]?.state === 'revoked',
  );
  await page.keyboard.press('Escape');
  await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  await page.locator('.fam-open', { hasText: 'Val' }).click();
  await page
    .locator('.familia-sheet')
    .getByRole('button', { name: 'Crear código para vincular a este menor', exact: true })
    .click();
  await page.locator('.temp-password').waitFor();
  const linkCode = (await page.locator('.temp-password').innerText()).trim();
  await settings('rocio');
  await page.locator('.fam-link-request').click();
  await page.locator('.fam-link-code-input').fill(linkCode);
  await page.locator('.fam-link-submit').click();
  await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  state = await cloud(['seatAssignments']);
  check(
    'link request preserves current guardian',
    state.seatAssignments.some(
      (row) => row.accountId === 'mock-teen' && row.householdId === 'qa-ambar',
    ),
  );
  await settings('ambar');
  await page.locator('.fam-notice-action', { hasText: 'Aprobar salida' }).click();
  await shoot('link-source-approval');
  await page.locator('.fam-notice-confirm').click();
  await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  state = await cloud(['seatAssignments']);
  check(
    'source approval still preserves guardian until acceptance',
    state.seatAssignments.some(
      (row) => row.accountId === 'mock-teen' && row.householdId === 'qa-ambar',
    ),
  );
  await settings('rocio');
  await page.locator('.fam-notice-action', { hasText: 'Aceptar responsabilidad' }).click();
  await shoot('link-recipient-acceptance');
  await page.locator('.fam-notice-confirm').click();
  await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  await page.locator('.fam-open', { hasText: 'Val' }).waitFor();
  state = await cloud(['seatAssignments', 'records']);
  check(
    'accepted link moves Val and keeps forest bytes',
    state.seatAssignments.some(
      (row) => row.accountId === 'mock-teen' && row.householdId === 'household:mock-parent',
    ) && JSON.stringify(state.records) === originalForests,
  );
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.locator('.familia h2', { hasText: 'Family' }).waitFor();
  check(
    'English family copy is translated',
    !(await page.locator('.familia').innerText()).includes('RESPONSABLE PRINCIPAL') &&
      (await page.locator('.familia').innerText()).includes('Nico'),
  );
  await page.locator('.familia').scrollIntoViewIfNeeded();
  await shoot('household-en-375');
  await page.getByRole('button', { name: 'Español', exact: true }).click();
  check(
    'no browser errors or foreign requests',
    errors.length === 0 && foreign.length === 0,
    JSON.stringify({ errors, foreign }),
  );
} finally {
  await writeFile(
    new URL('result.json', output),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        errors,
        foreign,
        backend: 'isolated mock',
        awsWrites: 0,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await browser.close();
}
