import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../auth/auth.service';
import {
  ACCESS_CACHE,
  ACCESS_RUNTIME,
  AccessService,
  type AccessRuntime,
} from '../access/access.service';
import { resumeAccountClosureWritesLocally } from '../db/account-closure-fence';
import { API_CLIENT } from './api-client';
import { ApiError, PREPAYMENT_PLAN_CATALOG, createFreeAccessSummary, type AccessSummary } from './contracts';
import { IndividualBillingService } from './individual-billing.service';

const NOW = 1_800_000_000_000;
function cachedPremium(): AccessSummary {
  return {
    effectivePlanKey: 'premium', catalogVersion: PREPAYMENT_PLAN_CATALOG.version,
    status: 'active', activeSources: [{ kind: 'subscription', sourceId: 'synthetic-paid',
      scope: 'individual', planKey: 'premium', validUntil: NOW + 3_600_000 }],
    limits: PREPAYMENT_PLAN_CATALOG.plans.premium.limits,
    capabilities: PREPAYMENT_PLAN_CATALOG.plans.premium.capabilities,
    usage: { activeTrees: 3, visibleBranchesByTree: {} }, revision: 4,
    nextRecomputeAt: NOW + 3_600_000, offlineValidUntil: NOW + 3_600_000,
  };
}
function coldBilling(summary = cachedPremium()) {
  const clock = { now: NOW, online: false, onOnline: null as (() => void) | null,
    timers: new Map<() => void, number>() };
  const runtime: AccessRuntime = {
    now: () => clock.now, isOnline: () => clock.online,
    listenOnline: callback => { clock.onOnline = callback; return () => { clock.onOnline = null; }; },
    scheduleEvery: () => () => undefined,
    scheduleOnce: (callback, ms) => { clock.timers.set(callback, ms); return () => { clock.timers.delete(callback); }; },
  };
  const cache = { read: vi.fn(async (userId: string) => userId === 'synthetic-buyer' ? summary : null), write: vi.fn(async () => undefined) };
  const api = {
    getIndividualBillingSummary: vi.fn(async () => { throw new ApiError('offline'); }),
    getAccess: vi.fn(async () => { if (!clock.online) throw new ApiError('offline'); return createFreeAccessSummary(clock.now); }),
  };
  TestBed.configureTestingModule({ providers: [
    { provide: API_CLIENT, useValue: api },
    { provide: AuthService, useValue: { user: signal({ userId: 'synthetic-buyer' }) } },
    { provide: ACCESS_CACHE, useValue: cache }, { provide: ACCESS_RUNTIME, useValue: runtime },
  ] });
  return { billing: TestBed.inject(IndividualBillingService), access: TestBed.inject(AccessService), api, cache, clock };
}
describe('cold subscription access without the product shell', () => {
  beforeEach(() => { TestBed.resetTestingModule(); resumeAccountClosureWritesLocally(); });
  afterEach(() => { TestBed.resetTestingModule(); resumeAccountClosureWritesLocally(); });
  it('hydrates a valid paid lease when financial reads are offline, then expires at its paid boundary', async () => {
    const { billing, access, cache, clock } = coldBilling();
    await billing.refresh();
    expect(access.access().effectivePlanKey).toBe('premium');
    expect(cache.read).toHaveBeenCalledWith('synthetic-buyer');
    clock.now = NOW + 3_600_000;
    const expiry = [...clock.timers].find(([, ms]) => ms === 3_600_000)?.[0];
    expect(expiry).toBeDefined(); expiry?.();
    await vi.waitFor(() => expect(access.access().effectivePlanKey).toBe('free'));
    expect(cache.write).not.toHaveBeenCalled();
  });
  it('reconciles a remote revocation on reconnect while the cached lease is still valid', async () => {
    const { billing, access, api, clock } = coldBilling();
    await billing.refresh();
    expect(access.access().effectivePlanKey).toBe('premium');
    expect(clock.onOnline).not.toBeNull();
    clock.online = true; clock.onOnline?.();
    await vi.waitFor(() => expect(access.access().effectivePlanKey).toBe('free'));
    expect(api.getAccess).toHaveBeenCalled();
  });
  it('does not revive an expired paid cache when financial reads remain offline', async () => {
    const expired = cachedPremium();
    expired.offlineValidUntil = NOW; expired.nextRecomputeAt = NOW;
    const { billing, access, cache } = coldBilling(expired);
    await billing.refresh();
    expect(cache.read).toHaveBeenCalledWith('synthetic-buyer');
    expect(access.access().effectivePlanKey).toBe('free');
    expect(cache.write).not.toHaveBeenCalled();
  });
  it('keeps a valid individual lease when a malformed legacy family response cannot be accepted', async () => {
    const { billing, access, cache, api, clock } = coldBilling();
    clock.online = true;
    api.getAccess.mockResolvedValue({
      ...cachedPremium(),
      activeSources: [{ kind: 'subscription', sourceId: 'legacy-family', planKey: 'premium',
        scope: 'family_member', householdId: 'legacy-household', validUntil: NOW + 3_600_000 }],
      capabilities: { cloudSync: true, social: true, family: true },
    } as unknown as AccessSummary);
    await billing.refresh();
    expect(access.access().effectivePlanKey).toBe('premium');
    expect(access.access().activeSources[0]?.scope).toBe('individual');
    expect(access.access().offlineValidUntil).toBe(NOW + 3_600_000);
    expect(cache.write).not.toHaveBeenCalled();
  });
});
