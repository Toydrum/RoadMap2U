import { beforeEach, describe, expect, it } from 'vitest';
import { MockApiMemoryDb } from './mock-api-test-memory.spec-helper';
import { MockAdultPrivacy } from './mock-privacy';
import { commonAccountDocument, privacyDocument } from './privacy-document';
import { COMMON_ACCOUNT_VERSIONS, ADULT_PRIVACY_VERSIONS, type PrivacyConsentCommand } from './contracts';
import type { MockUserRow } from './mock-cloud';

const memory = new MockApiMemoryDb();
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: memory.indexedDb });
let user: MockUserRow;
let privacy: MockAdultPrivacy;
let command: PrivacyConsentCommand;
beforeEach(async () => {
  memory.reset();
  user = { userId: 'common', username: 'common', displayName: 'Common', email: 'common@example.test', accountType: 'adult', socialEnabled: false, createdAt: 1, accountInstanceId: 'common-instance' };
  memory.seed('users', user.userId, user);
  privacy = new MockAdultPrivacy('enforce', 'enforce');
  command = { ...COMMON_ACCOUNT_VERSIONS, commandId: 'terms', expectedRevision: 0, language: 'es', documentFamily: 'common', documentHash: (await commonAccountDocument('es')).hash, action: 'accept_account_terms', acceptTerms: true };
});
describe('common account privacy evidence', () => {
  it('records own-account terms without declaring age or authorizing cloud', async () => {
    expect(await privacy.change(user, command)).toMatchObject({ accountAdmission: 'standard', accountTermsAccepted: true, adultDeclared: false, cloudConsent: 'absent', canUseCloud: false, revision: 1 });
    expect(await privacy.change(user, command)).toMatchObject({ revision: 1 });
    await expect(privacy.requireCloud(user)).rejects.toMatchObject({ code: 'CLOUD_CONSENT_REQUIRED' });
  });
  it('admits ordinary own-account operations without conferring historical authority', async () => {
    const own = privacy as MockAdultPrivacy & { admitOwn(user: MockUserRow): Promise<void> };
    expect(own.admitOwn).toBeTypeOf('function');
    await expect(own.admitOwn(user)).rejects.toMatchObject({ code: 'ACCOUNT_TERMS_REQUIRED' });
    await privacy.change(user, command);
    await expect(own.admitOwn(user)).resolves.toBeUndefined();
    await expect(privacy.admit(user)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('requires explicit acceptance, exact common documents and current revision', async () => {
    await expect(privacy.change(user, { ...command, acceptTerms: false } as unknown as PrivacyConsentCommand)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(privacy.change(user, { ...command, documentHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'VALIDATION' });
    await privacy.change(user, command);
    await expect(privacy.change(user, { ...command, commandId: 'other', expectedRevision: 0 })).rejects.toMatchObject({ code: 'PRIVACY_REVISION_CONFLICT' });
    await expect(privacy.change(user, { ...command, language: 'en' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('uses an independent explicit common cloud decision and supports withdrawal', async () => {
    await privacy.change(user, command);
    const cloud: PrivacyConsentCommand = { ...command, action: 'grant_cloud', accepted: true, commandId: 'cloud', expectedRevision: 1 };
    delete (cloud as unknown as Record<string, unknown>)['acceptTerms'];
    expect(await privacy.change(user, cloud)).toMatchObject({ adultDeclared: false, canUseCloud: true, cloudConsent: 'granted' });
    await expect(privacy.requireCloud(user)).resolves.toBeDefined();
    const revoke = { ...cloud, action: 'revoke_cloud', commandId: 'withdraw', expectedRevision: 2 } as PrivacyConsentCommand;
    delete (revoke as unknown as Record<string, unknown>)['accepted'];
    expect(await privacy.change(user, revoke)).toMatchObject({ canUseCloud: false, cloudConsent: 'revoked' });
  });
  for (const mode of ['off', 'enforce'] as const) it(`does not confer historical family/social authority in ${mode}`, async () => {
    privacy = new MockAdultPrivacy(mode, 'enforce');
    await privacy.change(user, command);
    await expect(privacy.admit(user)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('does not enroll an existing private account as common', async () => {
    user = { ...user, accountType: 'minor', privacyMode: 'adolescent_private', majorityAt: '2030-01-01' };
    memory.seed('users', user.userId, user);
    await expect(privacy.change(user, command)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('never applies common documents to historical adolescent or guardian decisions', async () => {
    const adolescent = { ...command, action: 'accept_adolescent', invitationId: 'a'.repeat(64), understandsPrivacy: true } as PrivacyConsentCommand;
    await expect(privacy.change(user, adolescent)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('preserves historical private majority review without converting the account to common', async () => {
    user = { ...user, accountType: 'minor', privacyMode: 'adolescent_private', majorityAt: '2026-01-01' };
    memory.seed('users', user.userId, user);
    const legacy = { ...ADULT_PRIVACY_VERSIONS, language: 'es' as const, documentHash: (await privacyDocument('es')).hash };
    expect(await privacy.change(user, { ...legacy, action: 'declare_adult', declareAdult: true, acceptTerms: true, commandId: 'legacy-majority', expectedRevision: 0 })).toMatchObject({ adultDeclared: true, accountAdmission: 'absent', privateOnly: true });
    expect(await privacy.change(user, { ...legacy, action: 'grant_cloud', accepted: true, commandId: 'legacy-own-cloud', expectedRevision: 1 })).toMatchObject({ canUseCloud: true, privateOnly: true });
    await expect(privacy.requireCloud(user)).resolves.toBeDefined();
    await expect(privacy.admitOwn(user)).resolves.toBeUndefined();
    await expect(privacy.change(user, { ...command, commandId: 'private-common', expectedRevision: 2 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
