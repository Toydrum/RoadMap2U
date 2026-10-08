import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PrivacyService } from './privacy.service';
import { API_CLIENT } from './api/api-client';
import { ApiError, ADULT_PRIVACY_VERSIONS, type PrivacyStatus } from './api/contracts';
import { AuthService } from './auth/auth.service';
import type { AuthUser } from './auth/auth-types';
import { privacyDocument } from './api/privacy-document';
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
  };
  api = {
    getPrivacyStatus: vi.fn(async () => status),
    changePrivacyConsent: vi.fn(async () => status),
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
