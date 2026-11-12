import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessService } from '../access/access.service';
import { createFreeAccessSummary } from '../api/contracts';
import { IndividualBillingService } from '../api/individual-billing.service';
import { AuthService } from '../auth/auth.service';
import { PrivacyService } from '../privacy.service';
import { PremiumCloudActivation } from './premium-cloud-activation';
import {
  cloudAccessAllowed,
  PremiumCloudIntentService,
  type PremiumCloudIntent,
} from './premium-cloud-intent';
import { SyncService } from './sync.service';

const owner = { userId: 'buyer', username: 'buyer' };
const valid = {
  scope: 'adult',
  accountAdmission: 'standard',
  commonDocumentHash: 'displayed-hash',
  canUseCloud: true,
  revision: 4,
} as const;
const intent: PremiumCloudIntent = {
  key: 'premium.cloud.pending',
  ownerId: 'buyer',
  session: 'same-device-session',
  id: 'intent-1',
  language: 'es',
  revision: 4,
  allowLocalUpload: false,
  expiresAt: Date.now() + 10_000,
  source: { kind: 'checkout', afterRevision: 1 },
};

afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
});

describe('automatic Premium cloud authorization', () => {
  it('reuses existing consent only when the exact displayed document is current', async () => {
    const refresh = vi.fn(async () => valid);
    const grantCloud = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: {
            user: signal(owner), sessionStale: signal(false), deviceSession: signal(intent.session),
          },
        },
        { provide: PrivacyService, useValue: { refresh, grantCloud, cloudBlocked: () => false } },
        { provide: AccessService, useValue: {} },
        { provide: IndividualBillingService, useValue: {} },
      ],
    });
    const service = TestBed.inject(PremiumCloudIntentService);
    await expect(service.choose('es', valid.commonDocumentHash, true, true)).resolves.toMatchObject({
      owner,
      revision: valid.revision,
      session: intent.session,
      allowLocalUpload: true,
    });
    await expect(service.choose('es', 'stale-document', false, false)).resolves.toBeNull();
    expect(grantCloud).not.toHaveBeenCalled();
  });

  it('requires the live gate and the source corresponding to the activation', () => {
    const now = Date.now();
    const access = {
      ...createFreeAccessSummary(now),
      effectivePlanKey: 'premium' as const,
      cloudAutoStartEnabled: true,
      capabilities: { cloudSync: true, social: true, family: false },
      activeSources: [{ kind: 'sponsored' as const, sourceId: 'grant-1', planKey: 'premium' as const, validUntil: null }],
    };
    expect(cloudAccessAllowed(access, intent.source, now)).toBe(false);
    expect(cloudAccessAllowed(access, { kind: 'sponsored', sourceId: 'grant-2' }, now)).toBe(false);
    expect(cloudAccessAllowed(
      { ...access, cloudAutoStartEnabled: false }, { kind: 'sponsored', sourceId: 'grant-1' }, now,
    )).toBe(false);
    expect(cloudAccessAllowed(access, { kind: 'sponsored', sourceId: 'grant-1' }, now)).toBe(true);
  });

  it('resumes a pending intent only after verified access and privacy, once per attempt', async () => {
    const activatePremiumCloud = vi.fn(async () => true);
    const clear = vi.fn(async () => undefined);
    const verified = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(createFreeAccessSummary());
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { user: signal(owner), sessionStale: signal(false) } },
        { provide: PrivacyService, useValue: { cloudBlocked: () => false, refresh: async () => valid } },
        { provide: PremiumCloudIntentService, useValue: { pending: async () => intent, verified, clear } },
        { provide: SyncService, useValue: { activatePremiumCloud } },
      ],
    });
    const service = TestBed.inject(PremiumCloudActivation);
    service.start();
    await vi.waitFor(() => expect(verified).toHaveBeenCalledOnce());
    expect(activatePremiumCloud).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.start();
    service.start();
    await vi.waitFor(() => expect(service.status()).toBe('current'));
    expect(activatePremiumCloud).toHaveBeenCalledOnce();
    expect(activatePremiumCloud).toHaveBeenCalledWith(expect.objectContaining({
      privacyRevision: valid.revision,
      session: intent.session,
      allowLocalUpload: false,
    }));
    expect(clear).toHaveBeenCalledWith(intent.id);
  });

  it('offers a retry after confirmation stays pending, then checks access and consent again', async () => {
    vi.useFakeTimers();
    const activatePremiumCloud = vi.fn(async () => true);
    const refresh = vi.fn(async () => valid);
    const verified = vi.fn<() => Promise<ReturnType<typeof createFreeAccessSummary> | null>>()
      .mockResolvedValue(null);
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { user: signal(owner), sessionStale: signal(false) } },
        { provide: PrivacyService, useValue: { cloudBlocked: () => false, refresh } },
        {
          provide: PremiumCloudIntentService,
          useValue: { pending: async () => intent, verified, clear: async () => undefined },
        },
        { provide: SyncService, useValue: { activatePremiumCloud } },
      ],
    });
    const service = TestBed.inject(PremiumCloudActivation);

    service.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(verified).toHaveBeenCalledTimes(6);
    expect(service.status()).toBe('retry');
    expect(refresh).not.toHaveBeenCalled();
    expect(activatePremiumCloud).not.toHaveBeenCalled();

    verified.mockResolvedValue(createFreeAccessSummary());
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(verified).toHaveBeenCalledTimes(7);
    expect(refresh).toHaveBeenCalledWith(intent.language);
    expect(activatePremiumCloud).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      privacyRevision: intent.revision,
      session: intent.session,
      allowLocalUpload: false,
    }));
    expect(service.status()).toBe('current');
  });
});
