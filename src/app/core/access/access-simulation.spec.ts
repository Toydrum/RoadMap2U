import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_CLIENT } from '../api/api-client';
import { ApiError, PREPAYMENT_PLAN_CATALOG, type AccessSummary } from '../api/contracts';
import { AuthService } from '../auth/auth.service';
import { ACCESS_CACHE, ACCESS_RUNTIME, AccessService } from './access.service';
import { BILLING_SIMULATION_STAGE } from '../api/billing-simulation';

const NOW = 1_800_000_000_000,
  FROZEN = NOW - 86400000;
function temporal(): AccessSummary {
  return {
    effectivePlanKey: 'premium',
    catalogVersion: PREPAYMENT_PLAN_CATALOG.version,
    status: 'active',
    activeSources: [
      {
        kind: 'subscription',
        scope: 'individual',
        sourceId: 'individual:synthetic',
        planKey: 'premium',
        validUntil: FROZEN + 3600000,
      },
    ],
    limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
    capabilities: { cloudSync: true, social: true, family: false },
    usage: { activeTrees: 1, visibleBranchesByTree: {} },
    revision: 8,
    nextRecomputeAt: NOW + 30000,
    offlineValidUntil: NOW,
    simulation: {
      stage: 'dev',
      mode: 'ready',
      frozenAt: FROZEN,
      clockRevision: 2,
      observedAt: NOW,
      evidenceValidUntil: NOW + 30000,
    },
  };
}
function setup(stage = 'dev', response = temporal(), cached: AccessSummary | null = null) {
  let now = NOW,
    online = true,
    offline: (() => void) | undefined;
  const timers = new Map<() => void, number>(),
    user = signal<{ userId: string } | null>({ userId: 'qa' });
  const api = { getAccess: vi.fn(async () => structuredClone(response)) };
  const cache = {
    read: vi.fn(async () => cached),
    write: vi.fn(async (_id: string, value: AccessSummary) => {
      cached = structuredClone(value);
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: BILLING_SIMULATION_STAGE, useValue: stage },
      { provide: API_CLIENT, useValue: api },
      { provide: AuthService, useValue: { user } },
      { provide: ACCESS_CACHE, useValue: cache },
      {
        provide: ACCESS_RUNTIME,
        useValue: {
          now: () => now,
          isOnline: () => online,
          listenOnline: () => () => {},
          listenOffline: (cb: () => void) => {
            offline = cb;
            return () => {};
          },
          scheduleEvery: () => () => {},
          scheduleOnce: (cb: () => void, ms: number) => {
            timers.set(cb, ms);
            return () => timers.delete(cb);
          },
        },
      },
    ],
  });
  const service = TestBed.inject(AccessService);
  return {
    service,
    api,
    cache,
    user,
    cached: () => cached,
    setNow: (value: number) => {
      now = value;
    },
    disconnect: () => {
      online = false;
      offline?.();
    },
    expire: () => {
      now += 15000;
      for (const [cb, ms] of [...timers])
        if (ms === 15000) {
          timers.delete(cb);
          cb();
        }
    },
  };
}
afterEach(() => TestBed.resetTestingModule());
describe('synthetic online access in the real PWA service', () => {
  it('accepts server-scoped financial time online without persisting Premium or changing Date', async () => {
    const f = setup(),
      wall = Date.now();
    await f.service.start();
    expect(f.service.access().effectivePlanKey).toBe('premium');
    expect(f.service.access().offlineValidUntil).toBe(NOW);
    expect(f.service.leaseState()).toBe('valid');
    expect(f.cached()?.effectivePlanKey).toBe('free');
    expect(f.cached()?.simulation).toBeUndefined();
    expect(Date.now()).toBeGreaterThanOrEqual(wall);
    expect(Date.now()).not.toBe(FROZEN);
  });
  it('drops the online-only snapshot immediately on connection loss', async () => {
    const f = setup();
    await f.service.start();
    f.disconnect();
    expect(f.service.access().effectivePlanKey).toBe('free');
    expect(f.service.leaseState()).toBe('fallback');
  });
  it('never hydrates a simulated Premium response from the device cache', async () => {
    const f = setup('dev', temporal(), temporal());
    f.api.getAccess.mockRejectedValue(new ApiError('offline'));
    await f.service.start();
    expect(f.service.access().effectivePlanKey).toBe('free');
  });
  it('clears a previous real Premium cache when the owner enters simulation', async () => {
    const old = temporal();
    delete old.simulation;
    old.activeSources[0].validUntil = NOW + 86400000;
    old.offlineValidUntil = NOW + 86400000;
    old.nextRecomputeAt = NOW + 86400000;
    const f = setup('dev', temporal(), old);
    await f.service.start();
    await vi.waitFor(() => expect(f.cached()?.effectivePlanKey).toBe('free'));
  });
  it('discards the snapshot after a rejected read instead of extending it', async () => {
    const f = setup();
    await f.service.start();
    f.api.getAccess.mockRejectedValue(new ApiError('offline'));
    await f.service.refresh();
    expect(f.service.access().effectivePlanKey).toBe('free');
  });
  it('expires the in-memory response after fifteen real seconds while a new read stalls', async () => {
    const f = setup();
    await f.service.start();
    f.api.getAccess.mockImplementation(() => new Promise(() => {}));
    f.expire();
    expect(f.service.access().effectivePlanKey).toBe('free');
    expect(f.service.leaseState()).toBe('fallback');
  });
  it.each(['prod', 'local', 'test'])('rejects a DEV response in %s', async (stage) => {
    const f = setup(stage);
    await f.service.start();
    expect(f.service.access().effectivePlanKey).toBe('free');
  });
  it('accepts an independent TEST response only in TEST', async () => {
    const response = temporal();
    response.simulation!.stage = 'test';
    const f = setup('test', response);
    await f.service.start();
    expect(f.service.access().effectivePlanKey).toBe('premium');
  });
  it('does not keep a paid source past the server financial boundary', async () => {
    const response = temporal();
    response.simulation!.frozenAt = response.activeSources[0].validUntil!;
    const f = setup('dev', response);
    await f.service.start();
    expect(f.service.access().effectivePlanKey).toBe('free');
  });
  it('does not carry the snapshot across identity changes', async () => {
    const f = setup();
    await f.service.start();
    f.user.set(null);
    TestBed.tick();
    expect(f.service.access().effectivePlanKey).toBe('free');
  });
  it('replaces old real Premium when the server reports unavailable temporal evidence', async () => {
    const old = temporal();
    delete old.simulation;
    old.activeSources[0].validUntil = NOW + 86400000;
    old.offlineValidUntil = NOW + 86400000;
    old.nextRecomputeAt = NOW + 86400000;
    const unavailable = temporal();
    unavailable.simulation = {
      ...unavailable.simulation!,
      mode: 'unavailable',
      frozenAt: null,
      evidenceValidUntil: null,
    };
    const f = setup('dev', unavailable, old);
    await f.service.start();
    await f.service.refresh();
    expect(f.service.access().effectivePlanKey).toBe('free');
    expect(f.cached()?.effectivePlanKey).toBe('free');
  });
  it('does not renew the age of evidence delayed in transit', async () => {
    const response = temporal();
    response.simulation!.observedAt = NOW - 14000;
    const f = setup('dev', response);
    await f.service.start();
    expect(f.service.access().effectivePlanKey).toBe('premium');
    f.setNow(NOW + 1001);
    await f.service.refresh();
    expect(f.service.access().effectivePlanKey).toBe('free');
  });
  it('validates server time against response arrival, after the request has started', async () => {
    const f = setup();
    f.api.getAccess.mockImplementation(async () => {
      f.setNow(NOW + 200);
      const response = temporal();
      response.simulation!.observedAt = NOW + 100;
      return response;
    });
    await f.service.start();
    expect(f.service.access().effectivePlanKey).toBe('premium');
  });
});
