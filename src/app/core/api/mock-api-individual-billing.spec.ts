import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockApi } from './mock-api';
import { MockApiMemoryDb } from './mock-api-test-memory.spec-helper';
import { ADULT_PRIVACY_VERSIONS, CLOSED_INDIVIDUAL_BILLING_CATALOG, type IndividualCheckoutRequest, type PrivacyConsentCommand } from './contracts';
import { privacyDocument } from './privacy-document';
import type { AuthProvider } from '../auth/auth-provider';
import type { MockUserRow } from './mock-cloud';

const memory = new MockApiMemoryDb();
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: memory.indexedDb });
let owner: MockUserRow; let api: MockApi; let verified: boolean;
const evidenceKey = () => `billing.individual.evidence:${owner.userId}:${owner.accountInstanceId}`;
afterEach(() => vi.restoreAllMocks());
function payment(paidThrough = Date.now() + 86400000) {
  memory.seed('kv', evidenceKey(), { key: evidenceKey(), value: { source: 'test_seed', accountId: owner.userId, accountInstanceId: owner.accountInstanceId, invoiceId: 'synthetic-invoice-1', interval: 'month', paidThrough, cancelAtPeriodEnd: false, revision: 2 } });
}
function checkout(): IndividualCheckoutRequest {
  const catalog = CLOSED_INDIVIDUAL_BILLING_CATALOG;
  return { commandId: 'checkout-1', expectedBillingRevision: 0, interval: 'month', catalogVersion: catalog.catalogVersion, country: 'MX', termsAcceptance: { version: catalog.terms.version, hash: catalog.terms.hashes.es, language: 'es', accepted: true } };
}
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  memory.reset(); memory.seed('kv', 'seeded', { key: 'seeded', value: true });
  owner = { userId: 'buyer', username: 'buyer', displayName: 'Buyer', email: 'synthetic@example.invalid', accountType: 'adult', socialEnabled: false, createdAt: 1, accountInstanceId: 'buyer-instance' };
  memory.seed('users', owner.userId, owner); verified = true;
  const auth = { idToken: async () => `mock.${btoa(JSON.stringify({ sub: owner.userId, username: owner.username, accountInstanceId: owner.accountInstanceId, auth_time: Math.floor(Date.now() / 1000), email_verified: verified }))}.token` } as unknown as AuthProvider;
  api = new MockApi(auth, { individualPaymentsEnabled: true, privateAdolescentMode: 'enforce' });
  const doc = await privacyDocument('es');
  await api.changePrivacyConsent({ ...ADULT_PRIVACY_VERSIONS, action: 'declare_adult', commandId: 'adult', expectedRevision: 0, language: 'es', documentHash: doc.hash, declareAdult: true, acceptTerms: true });
});

async function invitePaidAdolescent() {
  const doc = await privacyDocument('es');
  const base = { ...ADULT_PRIVACY_VERSIONS, expectedRevision: 0, language: 'es' as const, documentHash: doc.hash };
  const invitation = await api.createPrivateAdolescentInvitation({ ...base, commandId: 'paid-parent-invite', recipientUsername: 'paidteen', majorityAt: '2029-10-07', guardianName: 'María Pérez', guardianRelationship: 'parent', representsMinor: true, authorizesCloud: true });
  const teen = { ...owner, userId: 'paidteen', username: 'paidteen', accountInstanceId: 'teen-instance' };
  memory.seed('users', teen.userId, teen);
  const teenApi = new MockApi({ idToken: async () => `mock.${btoa(JSON.stringify({ sub: teen.userId, username: teen.username, accountInstanceId: teen.accountInstanceId, auth_time: Math.floor(Date.now() / 1000), email_verified: true }))}.token` } as unknown as AuthProvider, { adultPrivacyMode: 'enforce', privateAdolescentMode: 'enforce' });
  const accept = () => teenApi.changePrivacyConsent({ ...base, action: 'accept_adolescent', commandId: 'paid-teen-accept', invitationId: invitation.invitationId, acceptTerms: true, understandsPrivacy: true } as PrivacyConsentCommand);
  return { teenApi, accept, base };
}
describe('individual mock billing lifecycle', () => {
  it('keeps a checkout return pending and grants only a separately verified paid period, then expires exactly', async () => {
    expect((await api.getAccess()).effectivePlanKey).toBe('free');
    const result = await api.createIndividualCheckout(checkout());
    expect(result.outcome).toBe('redirect');
    expect((await api.getIndividualBillingSummary()).state).toBe('checkout_pending');
    expect((await api.getAccess()).effectivePlanKey).toBe('free');
    payment();
    expect((await api.getIndividualBillingSummary()).state).toBe('active');
    const paid = await api.getAccess();
    expect(paid.activeSources).toMatchObject([{ kind: 'subscription', scope: 'individual', validUntil: Date.now() + 86400000 }]);
    expect(paid.offlineValidUntil).toBeLessThanOrEqual(Date.now() + 86400000);
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 86400000);
    expect((await api.getIndividualBillingSummary()).state).toBe('expired');
    expect((await api.getAccess()).effectivePlanKey).toBe('free');
    expect(memory.rows('households')).toHaveLength(0);
  });
  it('reuses the durable command while rejecting command id reuse with different intent', async () => {
    const first = await api.createIndividualCheckout(checkout());
    const reloaded = await api.createIndividualCheckout(checkout());
    expect(reloaded).toEqual(first);
    await expect(api.createIndividualCheckout({ ...checkout(), interval: 'year' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('allows Portal for an expired subscription even when new purchases are closed', async () => {
    payment(Date.now());
    const summary = await api.getIndividualBillingSummary();
    expect(summary).toMatchObject({ state: 'expired', canOpenPortal: true });
    expect((await api.createIndividualPortalSession({ commandId: 'portal-1', expectedBillingRevision: summary.revision })).outcome).toBe('redirect');
  });
  it('requires adult identity and verified email even when the general privacy mode is off', async () => {
    owner.accountType = 'minor'; memory.seed('users', owner.userId, owner);
    await expect(api.createIndividualCheckout(checkout())).rejects.toMatchObject({ code: 'BILLING_BUYER_INELIGIBLE' });
    owner.accountType = 'adult'; memory.seed('users', owner.userId, owner); verified = false;
    await expect(api.createIndividualCheckout(checkout())).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
  });
  it('does not apply synthetic evidence from another account incarnation', async () => {
    payment();
    const row = memory.rows<{ key: string; value: Record<string, unknown> }>('kv').find((row) => row.key === evidenceKey())!;
    row.value['accountInstanceId'] = 'old-instance';
    expect((await api.getAccess()).effectivePlanKey).toBe('free');
  });
  it('derives private adolescent cloud from the actual individual paid period without granting teen Premium or family access', async () => {
    payment();
    const { teenApi, accept, base } = await invitePaidAdolescent();
    expect(await accept()).toMatchObject({ privateOnly: true, scope: 'adolescent_private', canUseCloud: false });
    expect(await teenApi.changePrivacyConsent({ ...base, action: 'grant_cloud', commandId: 'paid-teen-cloud', expectedRevision: 1, accepted: true })).toMatchObject({ canUseCloud: true, cloudCoverage: { state: 'active', validUntil: Date.now() + 86400000 } });
    expect((await teenApi.getAccess()).effectivePlanKey).toBe('free');
    await expect(teenApi.getSyncChanges()).resolves.toBeDefined();
    await expect(teenApi.getHousehold()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(teenApi.createIndividualCheckout(checkout())).rejects.toMatchObject({ code: 'BILLING_BUYER_INELIGIBLE' });
    expect(memory.rows('coverages')).toHaveLength(0);
    expect(memory.rows('households')).toHaveLength(0);
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 86400000);
    expect(await teenApi.getPrivacyStatus()).toMatchObject({ cloudConsent: 'granted', guardianConsent: 'granted', canUseCloud: false, cloudCoverage: { state: 'unavailable' } });
    await expect(teenApi.getSyncChanges()).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
  });
  it('stops derived cloud on financial review and restores it from current payment while preserving both consents', async () => {
    payment();
    const { teenApi, accept, base } = await invitePaidAdolescent();
    await accept();
    await teenApi.changePrivacyConsent({ ...base, action: 'grant_cloud', commandId: 'paid-teen-cloud', expectedRevision: 1, accepted: true });
    const row = memory.rows<{ key: string; value: Record<string, unknown> }>('kv').find((item) => item.key === evidenceKey())!;
    row.value['review'] = true;
    expect(await teenApi.getPrivacyStatus()).toMatchObject({ cloudConsent: 'granted', guardianConsent: 'granted', canUseCloud: false });
    await expect(teenApi.getSyncChanges()).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    payment();
    expect(await teenApi.getPrivacyStatus()).toMatchObject({ canUseCloud: true });
    expect((await teenApi.getAccess()).effectivePlanKey).toBe('free');
  });
  it('rechecks the same payment at adolescent acceptance and rejects evidence from a different parent incarnation', async () => {
    payment();
    const { accept } = await invitePaidAdolescent();
    const row = memory.rows<{ key: string; value: Record<string, unknown> }>('kv').find((item) => item.key === evidenceKey())!;
    row.value['accountInstanceId'] = 'old-instance';
    await expect(accept()).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
  });
});
