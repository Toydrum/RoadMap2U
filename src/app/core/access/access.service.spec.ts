import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_CLIENT, type ApiClient } from '../api/api-client';
import {
  ACCESS_OFFLINE_LEASE_MS,
  ApiError,
  PREPAYMENT_PLAN_CATALOG,
  createFreeAccessSummary,
  type AccessSummary,
  type PlanCatalog,
} from '../api/contracts';
import { AuthService } from '../auth/auth.service';
import {
  ACCESS_CACHE,
  ACCESS_REFRESH_MS,
  ACCESS_RUNTIME,
  AccessService,
  type AccessCachePort,
  type AccessRuntime,
} from './access.service';
import { PlanCatalogService } from './plan-catalog.service';

const NOW = 1_800_000_000_000;

function premium(overrides: Partial<AccessSummary> = {}): AccessSummary {
  return {
    effectivePlanKey: 'premium',
    catalogVersion: PREPAYMENT_PLAN_CATALOG.version,
    status: 'active',
    activeSources: [
      {
        kind: 'sponsored',
        sourceId: 'grant-demo',
        planKey: 'premium',
        validUntil: NOW + 12 * 60 * 60 * 1000,
      },
    ],
    limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
    capabilities: { cloudSync: true, social: true, family: false },
    usage: { activeTrees: 2, visibleBranchesByTree: { treeA: 10 } },
    revision: 4,
    nextRecomputeAt: NOW + 12 * 60 * 60 * 1000,
    offlineValidUntil: NOW + 12 * 60 * 60 * 1000,
    ...overrides,
  };
}

function apiWith(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getPlans: vi.fn(async () => PREPAYMENT_PLAN_CATALOG),
    getAccess: vi.fn(async () => createFreeAccessSummary(NOW)),
    redeemAccessCode: vi.fn(async () => createFreeAccessSummary(NOW)),
    ...overrides,
  } as ApiClient;
}

function cachePort(): AccessCachePort & {
  rows: Map<string, AccessSummary>;
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
} {
  const rows = new Map<string, AccessSummary>();
  return {
    rows,
    read: vi.fn(async (userId: string) => rows.get(userId) ?? null),
    write: vi.fn(async (userId: string, summary: AccessSummary) => {
      rows.set(userId, summary);
    }),
  };
}

function runtime(): AccessRuntime & {
  nowValue: number;
  online: (() => void) | null;
  interval: (() => void) | null;
  intervalMs: number | null;
  timeout: (() => void) | null;
  timeoutMs: number | null;
} {
  const value = {
    nowValue: NOW,
    online: null as (() => void) | null,
    interval: null as (() => void) | null,
    intervalMs: null as number | null,
    timeout: null as (() => void) | null,
    timeoutMs: null as number | null,
    now: () => value.nowValue,
    listenOnline: (callback: () => void) => {
      value.online = callback;
      return () => {
        value.online = null;
      };
    },
    scheduleEvery: (callback: () => void, ms: number) => {
      value.interval = callback;
      value.intervalMs = ms;
      return () => {
        value.interval = null;
      };
    },
    scheduleOnce: (callback: () => void, ms: number) => {
      value.timeout = callback;
      value.timeoutMs = ms;
      return () => {
        value.timeout = null;
      };
    },
  };
  return value;
}

function configure(
  input: {
    api?: ApiClient;
    cache?: AccessCachePort;
    runtime?: AccessRuntime;
    userId?: string | null;
  } = {},
): AccessService {
  const user = signal(
    input.userId === undefined || input.userId === null
      ? input.userId === undefined
        ? { userId: 'rocio' }
        : null
      : { userId: input.userId },
  );
  TestBed.configureTestingModule({
    providers: [
      AccessService,
      { provide: API_CLIENT, useValue: input.api ?? apiWith() },
      { provide: ACCESS_CACHE, useValue: input.cache ?? cachePort() },
      { provide: ACCESS_RUNTIME, useValue: input.runtime ?? runtime() },
      { provide: AuthService, useValue: { user } },
    ],
  });
  return TestBed.inject(AccessService);
}

describe('PlanCatalogService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('keeps the catalog in memory and never enables payment data from a malformed response', async () => {
    const getPlans = vi
      .fn<() => Promise<PlanCatalog>>()
      .mockResolvedValueOnce(PREPAYMENT_PLAN_CATALOG)
      .mockResolvedValueOnce({
        ...PREPAYMENT_PLAN_CATALOG,
        paymentsEnabled: true,
      } as unknown as PlanCatalog);
    TestBed.configureTestingModule({
      providers: [PlanCatalogService, { provide: API_CLIENT, useValue: apiWith({ getPlans }) }],
    });
    const service = TestBed.inject(PlanCatalogService);

    await expect(service.load()).resolves.toBe(PREPAYMENT_PLAN_CATALOG);
    await expect(service.load()).resolves.toBe(PREPAYMENT_PLAN_CATALOG);
    expect(getPlans).toHaveBeenCalledTimes(1);

    await expect(service.refresh()).rejects.toThrow('invalid plan catalog');
    expect(service.catalog()).toBe(PREPAYMENT_PLAN_CATALOG);
  });
});

describe('AccessService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('paints a valid user-scoped cache first and preserves it when refresh fails', async () => {
    const cache = cachePort();
    cache.rows.set('rocio', premium());
    const api = apiWith({ getAccess: vi.fn(async () => Promise.reject(new Error('offline'))) });
    const service = configure({ api, cache });

    await service.open();

    expect(service.access().effectivePlanKey).toBe('premium');
    expect(service.lastError()).toBe('unknown');
  });

  it('never applies another user cache and falls back to Free when no valid lease exists', async () => {
    const cache = cachePort();
    cache.rows.set('someone-else', premium());
    cache.rows.set('rocio', premium({ offlineValidUntil: NOW }));
    const service = configure({
      cache,
      api: apiWith({ getAccess: vi.fn(async () => Promise.reject(new Error('offline'))) }),
    });

    await service.open();

    expect(cache.read).toHaveBeenCalledWith('rocio');
    expect(service.access().effectivePlanKey).toBe('free');
    expect(service.leaseState()).toBe('fallback');
  });

  it('bounds a server lease by 24 hours and nextRecomputeAt before caching it', async () => {
    const cache = cachePort();
    const summary = premium({
      nextRecomputeAt: NOW + 60 * 60 * 1000,
      offlineValidUntil: NOW + 10 * ACCESS_OFFLINE_LEASE_MS,
    });
    const service = configure({ cache, api: apiWith({ getAccess: vi.fn(async () => summary) }) });

    await service.refresh();

    expect(service.access().offlineValidUntil).toBe(NOW + 60 * 60 * 1000);
    expect(cache.write).toHaveBeenCalledWith(
      'rocio',
      expect.objectContaining({ offlineValidUntil: NOW + 60 * 60 * 1000 }),
    );
  });

  it('coalesces concurrent refreshes and discards a response after the user changes', async () => {
    let resolve!: (summary: AccessSummary) => void;
    const response = new Promise<AccessSummary>((done) => (resolve = done));
    const getAccess = vi.fn(() => response);
    const cache = cachePort();
    const user = signal<{ userId: string } | null>({ userId: 'rocio' });
    TestBed.configureTestingModule({
      providers: [
        AccessService,
        { provide: API_CLIENT, useValue: apiWith({ getAccess }) },
        { provide: ACCESS_CACHE, useValue: cache },
        { provide: ACCESS_RUNTIME, useValue: runtime() },
        { provide: AuthService, useValue: { user } },
      ],
    });
    const service = TestBed.inject(AccessService);

    const first = service.refresh();
    const second = service.refresh();
    expect(first).toBe(second);
    expect(getAccess).toHaveBeenCalledTimes(1);

    user.set({ userId: 'otro' });
    resolve(premium());
    await first;

    expect(cache.write).not.toHaveBeenCalled();
    expect(service.access().effectivePlanKey).toBe('free');
  });

  it('starts one online listener and one 15-minute refresh loop', async () => {
    const clock = runtime();
    const getAccess = vi.fn(async () => createFreeAccessSummary(clock.nowValue));
    const service = configure({ runtime: clock, api: apiWith({ getAccess }) });

    const first = service.start();
    const second = service.start();
    expect(first).toBe(second);
    await first;

    expect(clock.intervalMs).toBe(ACCESS_REFRESH_MS);
    expect(getAccess).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(service.loading()).toBe(false));

    clock.online?.();
    await vi.waitFor(() => expect(getAccess).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(service.loading()).toBe(false));
    clock.interval?.();
    await vi.waitFor(() => expect(getAccess).toHaveBeenCalledTimes(3));
  });

  it('persists a redeemed access result and rejects a stale result fail-closed', async () => {
    const cache = cachePort();
    const good = premium();
    const redeemAccessCode = vi
      .fn<(code: string) => Promise<AccessSummary>>()
      .mockResolvedValueOnce(good)
      .mockResolvedValueOnce(premium({ nextRecomputeAt: NOW, offlineValidUntil: NOW }));
    const service = configure({ cache, api: apiWith({ redeemAccessCode }) });

    await expect(service.redeem('RM2U-DEMO')).resolves.toMatchObject({
      effectivePlanKey: 'premium',
    });
    expect(cache.write).toHaveBeenCalledWith('rocio', expect.objectContaining({ revision: 4 }));

    await expect(service.redeem('RM2U-STALE')).rejects.toThrow('stale access summary');
    expect(service.access().effectivePlanKey).toBe('premium');
  });

  it('expires a short lease at its exact boundary instead of waiting for the 15-minute loop', async () => {
    const clock = runtime();
    const short = premium({
      nextRecomputeAt: NOW + 1_000,
      offlineValidUntil: NOW + 1_000,
    });
    const getAccess = vi
      .fn()
      .mockResolvedValueOnce(short)
      .mockRejectedValueOnce(new Error('offline'));
    const service = configure({ runtime: clock, api: apiWith({ getAccess }) });

    await service.refresh();
    expect(clock.timeoutMs).toBe(1_000);
    expect(service.access().effectivePlanKey).toBe('premium');

    clock.nowValue = NOW + 1_000;
    clock.timeout?.();

    expect(service.leaseState()).toBe('fallback');
    expect(service.access().effectivePlanKey).toBe('free');
    await vi.waitFor(() => expect(getAccess).toHaveBeenCalledTimes(2));
  });

  it('stays Free and makes no authenticated request for a guest', async () => {
    const getAccess = vi.fn(async () => premium());
    const service = configure({ userId: null, api: apiWith({ getAccess }) });

    await service.open();

    expect(getAccess).not.toHaveBeenCalled();
    expect(service.access().effectivePlanKey).toBe('free');
  });
});
