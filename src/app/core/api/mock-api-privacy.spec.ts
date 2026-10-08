import { beforeEach, describe, expect, it } from 'vitest';
import { MockApi } from './mock-api';
import { MockApiMemoryDb } from './mock-api-test-memory.spec-helper';
import { ADULT_PRIVACY_VERSIONS, type PrivacyConsentCommand } from './contracts';
import { privacyDocument } from './privacy-document';
import { mockPrivateInvitationKey } from './mock-privacy';
import type { MockUserRow, MockRecordRow } from './mock-cloud';
import type { AuthProvider } from '../auth/auth-provider';
import { SCHEMA_VERSION } from '../db/schema';
const memory = new MockApiMemoryDb();
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: memory.indexedDb });
let owner: MockUserRow;
let api: MockApi;
let hash = '';
const currentParentPremium = () => ({
  coverageId: 'adult',
  accountId: 'adult',
  householdId: 'parent-premium-test',
  seatType: null,
  state: 'active',
  source: 'test_seed',
  validUntil: Date.now() + 86_400_000,
  createdAt: Date.now(),
});
beforeEach(async () => {
  memory.reset();
  memory.seed('kv', 'seeded', { key: 'seeded', value: true });
  owner = {
    userId: 'adult',
    username: 'adult',
    displayName: 'Adult',
    email: null,
    accountType: 'adult',
    socialEnabled: false,
    createdAt: 1,
    accountInstanceId: 'instance-adult-1',
  };
  memory.seed('users', owner.userId, owner);
  const token = `mock.${btoa(JSON.stringify({ sub: owner.userId, username: owner.username, accountInstanceId: owner.accountInstanceId, auth_time: Math.floor(Date.now() / 1000), email_verified: true }))}.token`;
  api = new MockApi({ idToken: async () => token } as unknown as AuthProvider, {
    adultPrivacyMode: 'enforce',
    privateAdolescentMode: 'enforce',
  });
  hash = (await privacyDocument('es')).hash;
});
function command(action: PrivacyConsentCommand['action'], revision: number): PrivacyConsentCommand {
  return {
    action,
    commandId: `${action}-${revision}`,
    expectedRevision: revision,
    language: 'es',
    documentHash: hash,
    ...ADULT_PRIVACY_VERSIONS,
    ...(action === 'declare_adult' ? { declareAdult: true, acceptTerms: true } : {}),
    ...(action === 'grant_cloud' ? { accepted: true } : {}),
  } as PrivacyConsentCommand;
}
describe('adult privacy mock contract', () => {
  it('separates representation from forest access and cloud consent, and stops cloud on parental withdrawal', async () => {
    await api.changePrivacyConsent(command('declare_adult', 0));
    memory.seed('coverages', 'adult', currentParentPremium());
    const invitation = await api.createPrivateAdolescentInvitation({
      commandId: 'test-invite',
      expectedRevision: 0,
      language: 'es',
      documentHash: hash,
      ...ADULT_PRIVACY_VERSIONS,
      recipientUsername: 'teen',
      guardianName: 'María Pérez',
      guardianRelationship: 'parent',
      majorityAt: '2029-10-07',
      representsMinor: true,
      authorizesCloud: true,
    });
    const teen: MockUserRow = {
      ...owner,
      userId: 'teen',
      username: 'teen',
      accountInstanceId: 'teen-instance',
    };
    memory.seed('users', teen.userId, teen);
    const teenApi = new MockApi(
      {
        idToken: async () =>
          `mock.${btoa(JSON.stringify({ sub: teen.userId, username: teen.username, accountInstanceId: teen.accountInstanceId, auth_time: Math.floor(Date.now() / 1000), email_verified: true }))}.token`,
      } as unknown as AuthProvider,
      { adultPrivacyMode: 'enforce', privateAdolescentMode: 'enforce' },
    );
    const acceptance = {
      ...command('revoke_cloud', 0),
      action: 'accept_adolescent',
      invitationId: invitation.invitationId,
      acceptTerms: true,
      understandsPrivacy: true,
    } as PrivacyConsentCommand;
    expect(invitation).toMatchObject({
      state: 'authorized',
      authorizationMethod: 'account_attestation',
    });
    const key = mockPrivateInvitationKey(invitation.invitationId);
    const row = memory.rows<{ key: string; value: object }>('kv').find((row) => row.key === key)!;
    expect(row.value).not.toHaveProperty('representationVerifiedAt');
    expect(row.value).not.toHaveProperty('verificationCaseId');
    expect(await teenApi.changePrivacyConsent(acceptance)).toMatchObject({
      privateOnly: true,
      scope: 'adolescent_private',
      canUseCloud: false,
    });
    expect(memory.rows('guardianLinks')).toEqual([]);
    expect(memory.rows('coverages')).toHaveLength(1);
    memory.seed('coverages', 'adult', { ...currentParentPremium(), state: 'revoked' });
    expect(await teenApi.changePrivacyConsent(command('grant_cloud', 1))).toMatchObject({
      canUseCloud: false,
      cloudCoverage: { kind: 'responsible_premium', state: 'unavailable' },
    });
    await expect(teenApi.getSyncChanges()).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    const parentPremium = {
      coverageId: 'adult',
      accountId: 'adult',
      householdId: 'parent-premium-test',
      seatType: null,
      state: 'active',
      source: 'test_seed',
      validUntil: Date.now() + 86_400_000,
      createdAt: Date.now(),
    };
    memory.seed('coverages', 'adult', parentPremium);
    expect(await teenApi.getPrivacyStatus()).toMatchObject({
      canUseCloud: true,
      cloudCoverage: { kind: 'responsible_premium', state: 'active' },
    });
    expect((await teenApi.getAccess()).effectivePlanKey).toBe('free');
    memory.seed('coverages', 'teen', { ...parentPremium, coverageId: 'teen', accountId: 'teen' });
    expect((await teenApi.getAccess()).effectivePlanKey).toBe('free');
    memory.seed('coverages', 'adult', { ...parentPremium, state: 'revoked' });
    await expect(teenApi.getSyncChanges()).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    memory.seed('coverages', 'adult', parentPremium);
    await expect(api.getForest('teen')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(teenApi.getForest('adult')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(teenApi.getFriends()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(teenApi.getHousehold()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(teenApi.getFamilyInbox()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await api.listPrivateAdolescentInvitations())[0]).toMatchObject({
      consentRevision: 2,
      guardianConsent: 'granted',
    });
    await api.changePrivateAdolescentGuardianConsent('teen', {
      ...command('revoke_cloud', 2),
      action: 'revoke_guardian',
    });
    await expect(teenApi.getSyncChanges()).rejects.toMatchObject({
      code: 'CLOUD_CONSENT_REQUIRED',
    });
    expect(await teenApi.changePrivacyConsent(acceptance)).toMatchObject({
      revision: 3,
      canUseCloud: false,
    });
    expect(await teenApi.exportOwnPrivacy()).toMatchObject({ userId: 'teen' });
  });
  it('authorizes a named adolescent invitation by declaration and keeps its retry stable', async () => {
    await api.changePrivacyConsent(command('declare_adult', 0));
    memory.seed('coverages', 'adult', currentParentPremium());
    const request = {
      commandId: 'private-invite',
      expectedRevision: 0,
      language: 'es' as const,
      ...ADULT_PRIVACY_VERSIONS,
      documentHash: hash,
      recipientUsername: 'teen',
      guardianName: 'María Pérez',
      guardianRelationship: 'legal_guardian' as const,
      majorityAt: '2029-10-07',
      representsMinor: true as const,
      authorizesCloud: true as const,
    };
    const invite = await api.createPrivateAdolescentInvitation(request);
    expect(invite).toMatchObject({
      state: 'authorized',
      authorizationMethod: 'account_attestation',
    });
    expect(await api.createPrivateAdolescentInvitation(request)).toEqual(invite);
    expect((await api.listPrivateAdolescentInvitations()).map((row) => row.invitationId)).toEqual([
      invite.invitationId,
    ]);
  });
  it.each([
    {
      email_verified: false,
      auth_time: Math.floor(Date.now() / 1000),
      code: 'EMAIL_VERIFICATION_REQUIRED',
    },
    {
      email_verified: true,
      auth_time: Math.floor(Date.now() / 1000) - 960,
      code: 'REAUTHENTICATION_REQUIRED',
    },
  ])('rejects inadmissible authorization claims: $code', async ({ code, ...claims }) => {
    await api.changePrivacyConsent(command('declare_adult', 0));
    memory.seed('coverages', 'adult', currentParentPremium());
    const denied = new MockApi(
      {
        idToken: async () =>
          `mock.${btoa(
            JSON.stringify({
              sub: owner.userId,
              username: owner.username,
              accountInstanceId: owner.accountInstanceId,
              ...claims,
            }),
          )}.token`,
      } as unknown as AuthProvider,
      { adultPrivacyMode: 'enforce', privateAdolescentMode: 'enforce' },
    );
    await expect(
      denied.createPrivateAdolescentInvitation({
        ...ADULT_PRIVACY_VERSIONS,
        language: 'es',
        documentHash: hash,
        expectedRevision: 0,
        commandId: 'denied-invite',
        recipientUsername: 'teen',
        majorityAt: '2029-10-07',
        guardianName: 'María Pérez',
        guardianRelationship: 'parent',
        representsMinor: true,
        authorizesCloud: true,
      } as any),
    ).rejects.toMatchObject({ code });
    expect(
      memory
        .rows<{ key: string }>('kv')
        .some((row) => row.key.startsWith('private-adolescent-invitation:')),
    ).toBe(false);
  });
  it('separates account declaration and cloud authorization and rejects direct bypasses', async () => {
    expect(await api.getPrivacyStatus()).toMatchObject({
      adultDeclared: false,
      cloudConsent: 'absent',
      revision: 0,
    });
    await expect(api.getSyncChanges()).rejects.toMatchObject({
      code: 'ADULT_DECLARATION_REQUIRED',
    });
    expect(await api.changePrivacyConsent(command('declare_adult', 0))).toMatchObject({
      adultDeclared: true,
      cloudConsent: 'absent',
      revision: 1,
    });
    await expect(
      api.pushSync({ schemaVersion: SCHEMA_VERSION, records: [] }),
    ).rejects.toMatchObject({ code: 'CLOUD_CONSENT_REQUIRED' });
    expect(await api.changePrivacyConsent(command('grant_cloud', 1))).toMatchObject({
      canUseCloud: true,
      revision: 2,
    });
    expect(await api.changePrivacyConsent(command('grant_cloud', 1))).toMatchObject({
      canUseCloud: true,
      revision: 2,
    });
    expect(await api.changePrivacyConsent(command('revoke_cloud', 2))).toMatchObject({
      canUseCloud: false,
      revision: 3,
    });
    await expect(api.getSyncChanges()).rejects.toMatchObject({ code: 'CLOUD_CONSENT_REQUIRED' });
    expect(await api.exportOwnPrivacy()).toMatchObject({ userId: owner.userId });
  });
  it('denies forged subjects, unchecked acceptance and stale revisions', async () => {
    await expect(
      api.changePrivacyConsent({
        ...command('declare_adult', 0),
        declareAdult: false,
      } as unknown as PrivacyConsentCommand),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      api.changePrivacyConsent({
        ...command('declare_adult', 0),
        ownerSub: 'another',
      } as unknown as PrivacyConsentCommand),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await api.changePrivacyConsent(command('declare_adult', 0));
    await expect(api.changePrivacyConsent(command('grant_cloud', 0))).rejects.toMatchObject({
      code: 'PRIVACY_REVISION_CONFLICT',
    });
  });
  it('erases only this remote forest and prevents restored records from the erased epoch resurfacing', async () => {
    await api.changePrivacyConsent(command('declare_adult', 0));
    await api.changePrivacyConsent(command('grant_cloud', 1));
    const old = {
      key: 'adult|checkins|check',
      ownerId: 'adult',
      store: 'checkins',
      record: { id: 'check', note: 'private' },
      seq: 1,
      syncedAt: 1,
      privacyRevision: 2,
    };
    memory.seed('records', old.key, old);
    memory.seed('records', 'other|checkins|check', {
      ...old,
      key: 'other|checkins|check',
      ownerId: 'other',
    });
    const erased = await api.changePrivacyConsent(command('erase_cloud', 2));
    expect(erased.erasure).toBe('completed');
    expect(memory.rows<MockRecordRow>('records').map((row) => row.ownerId)).toEqual(['other']);
    expect(memory.rows<MockUserRow>('users')).toContainEqual(owner);
    await api.changePrivacyConsent(command('grant_cloud', erased.revision));
    memory.seed('records', old.key, old);
    await expect(api.getSyncChanges()).rejects.toMatchObject({ code: 'PRIVACY_ERASURE_PENDING' });
  });
});
