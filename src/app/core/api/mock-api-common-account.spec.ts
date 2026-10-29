import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { MockApi } from './mock-api';
import { MockApiMemoryDb } from './mock-api-test-memory.spec-helper';
import { commonAccountDocument } from './privacy-document';
import { CLOSED_INDIVIDUAL_BILLING_CATALOG, type IndividualCheckoutRequest } from './contracts';
import type { AuthProvider } from '../auth/auth-provider';
import type { MockUserRow } from './mock-cloud';
import { SCHEMA_VERSION } from '../db/schema';

const memory = new MockApiMemoryDb();
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: memory.indexedDb });
let verified: boolean;
let owner: MockUserRow;
beforeEach(() => {
  memory.reset();
  memory.seed('kv', 'seeded', { key: 'seeded', value: true });
  verified = true;
  owner = { userId: 'common', username: 'common', displayName: 'Common', email: 'common@example.invalid', accountType: 'adult', socialEnabled: true, accountInstanceId: 'common-instance', createdAt: 1 };
  memory.seed('users', owner.userId, owner);
});
afterEach(() => localStorage.removeItem('rm2u.mock.idToken'));
async function enrolled(mode: 'off' | 'enforce') {
  const auth = { idToken: async () => `mock.${btoa(JSON.stringify({ sub: owner.userId, username: owner.username, accountInstanceId: owner.accountInstanceId, auth_time: Math.floor(Date.now() / 1000), email_verified: verified }))}.token` } as unknown as AuthProvider;
  const api = new MockApi(auth, { individualPaymentsEnabled: true, adultPrivacyMode: mode, privateAdolescentMode: 'enforce' });
  const document = await commonAccountDocument('es');
  const base = { ...document.document.versions, language: 'es' as const, documentFamily: 'common' as const, documentHash: document.hash };
  await api.changePrivacyConsent({ ...base, commandId: 'common-terms', expectedRevision: 0, action: 'accept_account_terms', acceptTerms: true });
  return { api, base };
}
function checkout(): IndividualCheckoutRequest {
  const catalog = CLOSED_INDIVIDUAL_BILLING_CATALOG;
  return { commandId: 'common-checkout', expectedBillingRevision: 0, interval: 'month', country: 'MX', catalogVersion: catalog.catalogVersion, termsAcceptance: { version: catalog.terms.version, hash: catalog.terms.hashes.es, language: 'es', accepted: true } };
}
function payment() {
  const key = `billing.individual.evidence:${owner.userId}:${owner.accountInstanceId}`;
  memory.seed('kv', key, { key, value: { source: 'test_seed', accountId: owner.userId, accountInstanceId: owner.accountInstanceId, invoiceId: 'synthetic-common-invoice', interval: 'month', paidThrough: Date.now() + 86_400_000, cancelAtPeriodEnd: false, revision: 2 } });
}

describe.each(['off', 'enforce'] as const)('common own-account API with privacy %s', (mode) => {
  it('keeps Free after signup and checkout until a paid source is confirmed', async () => {
    const { api } = await enrolled(mode);
    expect(await api.getPrivacyStatus()).toMatchObject({ accountAdmission: 'standard', adultDeclared: false, cloudConsent: 'absent', canUseCloud: false });
    expect((await api.getAccess()).effectivePlanKey).toBe('free');
    expect((await api.getIndividualBillingSummary()).canCheckout).toBe(true);
    expect((await api.createIndividualCheckout(checkout())).outcome).toBe('redirect');
    expect((await api.getAccess()).effectivePlanKey).toBe('free');
    payment();
    expect((await api.getAccess()).effectivePlanKey).toBe('premium');
    expect(await api.getPrivacyStatus()).toMatchObject({ adultDeclared: false, cloudConsent: 'absent', canUseCloud: false });
  });
  it('retains verified email as a purchase requirement', async () => {
    const { api } = await enrolled(mode);
    verified = false;
    expect((await api.getIndividualBillingSummary()).canCheckout).toBe(false);
    await expect(api.createIndividualCheckout(checkout())).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
  });
  it('retains verified email for sponsored redemption without accepting arbitrary strings', async () => {
    const { api } = await enrolled(mode);
    verified = false;
    await expect(api.redeemAccessCode('synthetic-invalid')).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
    verified = true;
    await expect(api.redeemAccessCode('synthetic-invalid')).rejects.toMatchObject({ code: 'ACCESS_CODE_INVALID' });
  });
  it('allows own profile and explicitly authorized sync while denying family and social authority', async () => {
    const { api, base } = await enrolled(mode);
    await expect(api.patchMe({ displayName: 'My forest' })).resolves.toMatchObject({ displayName: 'My forest' });
    await expect(api.getSyncChanges()).rejects.toMatchObject({ code: 'CLOUD_CONSENT_REQUIRED' });
    payment();
    await api.changePrivacyConsent({ ...base, commandId: 'common-cloud', expectedRevision: 1, action: 'grant_cloud', accepted: true });
    await expect(api.getSyncChanges()).resolves.toMatchObject({ changes: [] });
    await expect(api.pushSync({ schemaVersion: SCHEMA_VERSION, records: [] })).resolves.toMatchObject({ applied: [] });
    await expect(api.getForest(owner.userId)).resolves.toMatchObject({ detail: 'full' });
    await expect(api.getFriends()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.getHousehold()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('preserves paid access and Portal when terms need review while closing new purchases', async () => {
    const { api } = await enrolled(mode);
    payment();
    const state = memory.rows<{ key: string; value: Record<string, unknown> }>('kv').find(row => row.key === 'privacy:common:common-instance')!;
    state.value['accountTermsDocumentHash'] = '0'.repeat(64);
    expect((await api.getPrivacyStatus()).accountAdmission).toBe('absent');
    expect((await api.getAccess()).effectivePlanKey).toBe('premium');
    const summary = await api.getIndividualBillingSummary();
    expect(summary).toMatchObject({ canCheckout: false, canOpenPortal: true });
    await expect(api.createIndividualPortalSession({ commandId: 'common-portal', expectedBillingRevision: summary.revision })).resolves.toMatchObject({ outcome: 'redirect' });
    await expect(api.createIndividualCheckout(checkout())).rejects.toMatchObject({ code: 'ACCOUNT_TERMS_REQUIRED' });
  });
});
