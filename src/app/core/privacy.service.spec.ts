import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PrivacyService } from './privacy.service';
import { API_CLIENT } from './api/api-client';
import { ApiError, ADULT_PRIVACY_VERSIONS, type PrivacyStatus } from './api/contracts';
import { AuthService } from './auth/auth.service';
import type { AuthUser } from './auth/auth-types';
import { privacyDocument, commonAccountDocument } from './api/privacy-document';
let subject: ReturnType<typeof signal<AuthUser | null>>;
let status: PrivacyStatus;
let api: {
  getPrivacyStatus: ReturnType<typeof vi.fn>;
  changePrivacyConsent: ReturnType<typeof vi.fn>;
  exportOwnPrivacy: ReturnType<typeof vi.fn>;
};
let service: PrivacyService;
beforeEach(async () => {
  localStorage.removeItem('roadmap2u-privacy-withdraw-intents-v1');
  subject = signal({
    userId: 'owner',
    username: 'owner',
    displayName: 'Owner',
    accountType: 'adult',
  } as AuthUser);
  status = {
    userId: 'owner',
    scope: 'adult',
    enforcement: 'enforce',
    revision: 1,
    adultDeclared: true,
    cloudConsent: 'absent',
    canUseCloud: false,
    erasure: 'none',
    versions: ADULT_PRIVACY_VERSIONS,
    documentHash: (await privacyDocument('es')).hash,
    updatedAt: 1,
    commonVersions: (await commonAccountDocument('es')).document.versions,
    commonDocumentHash: (await commonAccountDocument('es')).hash,
  };
  api = {
    getPrivacyStatus: vi.fn(async () => status),
    changePrivacyConsent: vi.fn(async () => ({ ...status, accountAdmission: 'standard' })),
    exportOwnPrivacy: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: API_CLIENT, useValue: api },
      { provide: AuthService, useValue: { user: subject, sessionStale: signal(false) } },
    ],
  });
  service = TestBed.inject(PrivacyService);
});
afterEach(() => {
  TestBed.resetTestingModule();
  localStorage.removeItem('roadmap2u-privacy-withdraw-intents-v1');
});
describe('privacy decisions and cloud leases', () => {
  it('records common terms independently of adulthood and optional cloud', async () => {
    const common = await commonAccountDocument('es');
    status = { ...status, adultDeclared: false, accountAdmission: 'absent', commonVersions: common.document.versions, commonDocumentHash: common.hash };
    await expect((service as any).acceptAccountTerms('es', false)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(api.changePrivacyConsent).not.toHaveBeenCalled();
    await (service as any).acceptAccountTerms('es', true);
    expect(api.changePrivacyConsent).toHaveBeenCalledWith(expect.objectContaining({
      ...common.document.versions, documentFamily: 'common', action: 'accept_account_terms',
      acceptTerms: true, documentHash: common.hash,
    }));
    expect(api.changePrivacyConsent.mock.calls[0][0]).not.toHaveProperty('declareAdult');
    expect(api.changePrivacyConsent.mock.calls[0][0]).not.toHaveProperty('accepted');
  });
  it('rejects common document mismatches without writing consent', async () => {
    const common = await commonAccountDocument('es');
    status = { ...status, accountAdmission: 'absent', commonVersions: common.document.versions, commonDocumentHash: '0'.repeat(64) };
    await expect((service as any).acceptAccountTerms('es', true)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(api.changePrivacyConsent).not.toHaveBeenCalled();
  });
  it('keeps an ambiguous common terms retry identical', async () => {
    api.changePrivacyConsent.mockRejectedValueOnce(new ApiError('offline'));
    await expect((service as any).acceptAccountTerms('es', true)).rejects.toMatchObject({ code: 'offline' });
    await (service as any).acceptAccountTerms('es', true);
    expect(api.changePrivacyConsent.mock.calls[1][0]).toEqual(api.changePrivacyConsent.mock.calls[0][0]);
  });
  it('rejects a substituted common document in a consent response', async () => {
    api.changePrivacyConsent.mockResolvedValueOnce({ ...status, accountAdmission: 'standard', commonDocumentHash: '0'.repeat(64) });
    await expect(service.acceptAccountTerms('es', true)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('does not move a cloud choice to an account signed in during the initial refresh', async () => {
    const initial = status;
    vi.spyOn(service, 'refresh').mockImplementationOnce(async () => {
      subject.set({ ...subject()!, userId: 'replacement' });
      status = { ...initial, userId: 'replacement' };
      return initial;
    });
    await expect(service.grantCloud('es', true)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(api.changePrivacyConsent).not.toHaveBeenCalled();
  });
  it.each(['revoke_cloud', 'erase_cloud'] as const)('uses common evidence and the same command when retrying %s for a standard account', async (action) => {
    const document = await commonAccountDocument('es');
    api.changePrivacyConsent.mockRejectedValueOnce(new ApiError('offline'));
    const decide = () => action === 'revoke_cloud' ? service.revokeCloud('es') : service.eraseCloud('es');
    await expect(decide()).rejects.toMatchObject({ code: 'offline' });
    expect(api.changePrivacyConsent.mock.calls[0][0]).toMatchObject({ action, documentFamily: 'common', documentHash: document.hash, ...document.document.versions });
    await decide();
    expect(api.changePrivacyConsent.mock.calls[1][0]).toEqual(api.changePrivacyConsent.mock.calls[0][0]);
  });
  it.each(['revoke_cloud', 'erase_cloud'] as const)('keeps %s withdrawal attached to the original account during a refresh switch', async (action) => {
    const initial = status;
    vi.spyOn(service, 'refresh').mockImplementationOnce(async () => {
      subject.set({ ...subject()!, userId: 'replacement' });
      status = { ...initial, userId: 'replacement' };
      return initial;
    });
    const decision = action === 'revoke_cloud' ? service.revokeCloud('es') : service.eraseCloud('es');
    await expect(decision).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(api.changePrivacyConsent).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('roadmap2u-privacy-withdraw-intents-v1')!)).toEqual(['owner']);
  });
  it.each(['revoke_cloud', 'erase_cloud'] as const)('preserves historical private document evidence for %s', async (action) => {
    status = { ...status, scope: 'adolescent_private', privateOnly: true, adultDeclared: false, accountAdmission: 'absent' };
    if (action === 'revoke_cloud') await service.revokeCloud('es');
    else await service.eraseCloud('es');
    expect(api.changePrivacyConsent.mock.calls[0][0]).toMatchObject({ action, documentHash: (await privacyDocument('es')).hash, ...ADULT_PRIVACY_VERSIONS });
    expect(api.changePrivacyConsent.mock.calls[0][0]).not.toHaveProperty('documentFamily');
  });
  it('does not call or authorize cloud merely by constructing the account service', async () => {
    expect(api.getPrivacyStatus).not.toHaveBeenCalled();
    expect(service.status()).toBeNull();
    await expect(service.grantCloud('es', false)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(api.changePrivacyConsent).not.toHaveBeenCalled();
    await expect(service.requireCloud('es')).rejects.toMatchObject({
      code: 'CLOUD_CONSENT_REQUIRED',
    });
  });
  it('rejects a document mismatch before recording an acceptance', async () => {
    status = { ...status, documentHash: '0'.repeat(64) };
    await expect(service.grantCloud('es', true)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(api.changePrivacyConsent).not.toHaveBeenCalled();
  });
  it('invalidates an in-flight lease immediately when withdrawal is requested, even if the network fails', async () => {
    status = { ...status, cloudConsent: 'granted', canUseCloud: true };
    const lease = await service.requireCloud('es');
    api.changePrivacyConsent.mockRejectedValueOnce(new ApiError('offline'));
    await expect(service.revokeCloud('es')).rejects.toMatchObject({ code: 'offline' });
    expect(JSON.parse(localStorage.getItem('roadmap2u-privacy-withdraw-intents-v1')!)).toEqual([
      'owner',
    ]);
    expect(() => service.assertLease(lease)).toThrow();
    await expect(service.requireCloud('es')).rejects.toMatchObject({
      code: 'CLOUD_CONSENT_REQUIRED',
    });
    await service.revokeCloud('es');
    expect(api.changePrivacyConsent.mock.calls[1][0]).toEqual(
      api.changePrivacyConsent.mock.calls[0][0],
    );
  });
  it('retains a failed withdrawal across service recreation until an explicit cloud grant succeeds', async () => {
    status = { ...status, cloudConsent: 'granted', canUseCloud: true };
    api.changePrivacyConsent.mockRejectedValueOnce(new ApiError('offline'));
    await expect(service.revokeCloud('es')).rejects.toMatchObject({ code: 'offline' });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: API_CLIENT, useValue: api },
        { provide: AuthService, useValue: { user: subject, sessionStale: signal(false) } },
      ],
    });
    service = TestBed.inject(PrivacyService);
    await expect(service.requireCloud('es')).rejects.toMatchObject({
      code: 'CLOUD_CONSENT_REQUIRED',
    });
    await service.grantCloud('es', true);
    await expect(service.requireCloud('es')).resolves.toMatchObject({ revision: 1 });
    expect(JSON.parse(localStorage.getItem('roadmap2u-privacy-withdraw-intents-v1')!)).toEqual([]);
  });
  it('discards a response from an account that was signed out while awaiting metadata', async () => {
    let resolve!: (value: PrivacyStatus) => void;
    api.getPrivacyStatus.mockImplementation(
      () =>
        new Promise<PrivacyStatus>((done) => {
          resolve = done;
        }),
    );
    const pending = service.refresh('es');
    subject.set(null);
    resolve(status);
    await expect(pending).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(service.status()).toBeNull();
  });
});
