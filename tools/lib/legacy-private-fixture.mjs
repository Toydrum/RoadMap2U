import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadPrivacyDocuments } from '../validate-individual-publication.mjs';

/** Existing legacy accounts only, inside a fresh localhost mock browser context.
 * This deliberately does not exercise signup or the now-hidden invitation UI.
 * The application has no fixture hook; its ordinary storage and API validate
 * these synthetic historical facts exactly as they validate existing accounts.
 */
export async function provisionLegacyPrivateFixture(page, { prefix }) {
  const url = new URL(page.url());
  assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname), 'local legacy mock fixture only');
  assert.ok(['privacy', 'bill'].includes(prefix), 'synthetic legacy probe namespace required');
  await page.locator('app-account .demo-note').first().waitFor();
  // A virgin guest account page keeps the mock DB lazy. One ordinary rejected
  // local lookup initializes the application's real schema and demo seed;
  // it creates no account, identity or privacy decision. Never copy the schema
  // into this helper or add a fixture route to the application.
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.locator('.auth-form input[autocomplete="username"]').fill(`${prefix}_schema_probe`);
  await page.locator('.auth-form input[type="password"]').fill('SyntheticProbe123!');
  await page.locator('.auth-form button[type="submit"]').click();
  await page.locator('app-account .error-line').waitFor();
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await page.locator('app-account .demo-note').first().waitFor();
  const document = (await loadPrivacyDocuments()).es;
  const hash = createHash('sha256').update(JSON.stringify(document)).digest('hex');
  const now = Date.now();
  const parent = { userId: `u-${prefix}_parent`, username: `${prefix}_parent`, displayName: 'Legacy parent fixture', email: `${prefix}_parent@example.invalid`, accountType: 'adult', socialEnabled: false, createdAt: now - 86400000, accountInstanceId: `legacy-${prefix}-parent-instance` };
  const teen = { userId: `u-${prefix}_teen`, username: `${prefix}_teen`, displayName: 'Legacy private fixture', email: `${prefix}_teen@example.invalid`, accountType: 'minor', privacyMode: 'adolescent_private', majorityAt: '2030-10-29', socialEnabled: false, createdAt: now - 86400000, accountInstanceId: `legacy-${prefix}-teen-instance` };
  const key = (user) => `privacy:${encodeURIComponent(user.userId)}:${encodeURIComponent(user.accountInstanceId)}`;
  const invitationId = createHash('sha256').update(`existing-legacy:${prefix}`).digest('hex');
  const attestation = { subjectId: parent.userId, authenticatedAt: now - 86400000, emailVerified: true, declaredName: 'María Pérez', relationship: 'parent', declaredAt: now - 86400000 };
  const base = { enforcement: 'enforce', revision: 1, adultDeclared: false, cloudConsent: 'absent', canUseCloud: false, erasure: 'none', versions: document.versions, documentHash: hash, updatedAt: now - 86400000 };
  const parentPrivacy = { ...base, userId: parent.userId, scope: 'adult', adultDeclared: true, declarationLanguage: 'es', declarationHash: hash };
  const teenPrivacy = { ...base, userId: teen.userId, scope: 'adolescent_private', privateOnly: true, majorityAt: teen.majorityAt, invitationId, adolescentAcceptedAt: now - 86400000, adolescentLanguage: 'es', adolescentHash: hash, guardianId: parent.userId, guardianInstance: parent.accountInstanceId, guardianConsent: 'granted', guardianLanguage: 'es', guardianHash: hash, guardianAuthorization: { method: 'account_attestation', attestation } };
  const invitation = { invitationId, recipientUsername: teen.username, majorityAt: teen.majorityAt, state: 'accepted', revision: 2, expiresAt: now + 86400000, authorizationMethod: 'account_attestation', attestation, adolescentId: teen.userId, guardianId: parent.userId, guardianInstance: parent.accountInstanceId, language: 'es', documentHash: hash, request: 'synthetic historical fixture; no new enrollment' };
  const evidence = (user, action) => ({ userId: user.userId, action, revision: 1, updatedAt: now - 86400000, document, documentHash: hash, authentication: 'verified_mock_subject', fixture: 'existing_legacy_account_before_common_launch' });
  const rows = [
    { key: key(parent), value: parentPrivacy },
    { key: key(teen), value: teenPrivacy },
    { key: `private-adolescent-invitation:${invitationId}`, value: invitation },
    { key: `${key(parent)}:command:legacy-fixture`, value: evidence(parent, 'declare_adult') },
    { key: `${key(teen)}:command:legacy-fixture`, value: evidence(teen, 'accept_adolescent') },
  ];
  const password = 'LocalProbe123!';
  await page.evaluate(({ parent, teen, password, rows }) => new Promise((resolve, reject) => {
    if (localStorage.getItem('rm2u.mock.idToken')) return reject(new Error('FRESH_UNSIGNED_LOCAL_CONTEXT_REQUIRED'));
    const open = indexedDB.open('roadmap2u-mockcloud');
    open.onupgradeneeded = () => { open.transaction.abort(); reject(new Error('INITIALIZED_LOCAL_MOCK_REQUIRED')); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['users', 'credentials', 'kv'], 'readwrite');
      for (const user of [parent, teen]) {
        // add() intentionally refuses to overwrite a previous account or test run.
        tx.objectStore('users').add(user);
        tx.objectStore('credentials').add({ username: user.username, userId: user.userId, password, mustChangePassword: false, pendingConfirm: false });
      }
      for (const row of rows) tx.objectStore('kv').add(row);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('ISOLATED_LEGACY_FIXTURE_REQUIRED')); };
    };
  }), { parent, teen, password, rows });
  return { parent, teen, invitation, password, historicalDocumentHash: hash };
}
