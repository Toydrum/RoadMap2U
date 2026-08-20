import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { API_CLIENT } from '../api/api-client';
import {
  ACCESS_OFFLINE_LEASE_MS,
  ApiError,
  type ApiErrorCode,
  type AccessSource,
  type AccessSummary,
  PREPAYMENT_PLAN_CATALOG,
  createFreeAccessSummary,
} from '../api/contracts';
import { AuthService } from '../auth/auth.service';
import { get, put } from '../db/idb';

export const ACCESS_REFRESH_MS = 15 * 60 * 1000;
const META_ACCESS_PREFIX = 'commercial.access:';

interface AccessCacheRow {
  key: string;
  userId: string;
  summary: AccessSummary;
  cachedAt: number;
}

export interface AccessCachePort {
  read(userId: string): Promise<AccessSummary | null>;
  write(userId: string, summary: AccessSummary): Promise<void>;
}

export const ACCESS_CACHE = new InjectionToken<AccessCachePort>('ACCESS_CACHE', {
  providedIn: 'root',
  factory: () => ({
    async read(userId: string): Promise<AccessSummary | null> {
      const row = await get<AccessCacheRow>('meta', `${META_ACCESS_PREFIX}${userId}`);
      return row?.userId === userId ? row.summary : null;
    },
    async write(userId: string, summary: AccessSummary): Promise<void> {
      await put('meta', {
        key: `${META_ACCESS_PREFIX}${userId}`,
        userId,
        summary,
        cachedAt: Date.now(),
      } satisfies AccessCacheRow);
    },
  }),
});

export interface AccessRuntime {
  now(): number;
  listenOnline(callback: () => void): () => void;
  scheduleEvery(callback: () => void, ms: number): () => void;
  scheduleOnce(callback: () => void, ms: number): () => void;
}

export const ACCESS_RUNTIME = new InjectionToken<AccessRuntime>('ACCESS_RUNTIME', {
  providedIn: 'root',
  factory: () => ({
    now: Date.now,
    listenOnline(callback: () => void): () => void {
      if (typeof window === 'undefined') return () => undefined;
      window.addEventListener('online', callback);
      return () => window.removeEventListener('online', callback);
    },
    scheduleEvery(callback: () => void, ms: number): () => void {
      if (typeof window === 'undefined') return () => undefined;
      const id = window.setInterval(callback, ms);
      return () => window.clearInterval(id);
    },
    scheduleOnce(callback: () => void, ms: number): () => void {
      if (typeof window === 'undefined') return () => undefined;
      const id = window.setTimeout(callback, ms);
      return () => window.clearTimeout(id);
    },
  }),
});

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLimit(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSource(value: unknown, now: number): value is AccessSource {
  if (!isObject(value)) return false;
  return (
    (value['kind'] === 'default' ||
      value['kind'] === 'sponsored' ||
      value['kind'] === 'subscription') &&
    typeof value['sourceId'] === 'string' &&
    value['sourceId'].length > 0 &&
    value['sourceId'].length <= 128 &&
    (value['planKey'] === 'free' || value['planKey'] === 'premium') &&
    (value['validUntil'] === null ||
      (isTimestamp(value['validUntil']) && (value['validUntil'] as number) > now))
  );
}

function normalizeSummary(value: unknown, now: number): AccessSummary {
  if (!isObject(value)) throw new Error('invalid access summary');
  const limits = value['limits'];
  const capabilities = value['capabilities'];
  const usage = value['usage'];
  const branches = isObject(usage) ? usage['visibleBranchesByTree'] : null;
  const sources = value['activeSources'];
  const nextRecomputeAt = value['nextRecomputeAt'];
  const offlineValidUntil = value['offlineValidUntil'];

  const validBranches =
    isObject(branches) &&
    Object.entries(branches).every(
      ([treeId, count]) =>
        treeId.length > 0 &&
        treeId.length <= 128 &&
        typeof count === 'number' &&
        Number.isSafeInteger(count) &&
        count >= 0,
    );
  if (
    (value['effectivePlanKey'] !== 'free' && value['effectivePlanKey'] !== 'premium') ||
    value['catalogVersion'] !== PREPAYMENT_PLAN_CATALOG.version ||
    value['status'] !== 'active' ||
    !Array.isArray(sources) ||
    sources.length < 1 ||
    sources.length > 100 ||
    !sources.every((source) => isSource(source, now)) ||
    !isObject(limits) ||
    !isLimit(limits['maxActiveTrees']) ||
    !isLimit(limits['maxVisibleBranchesPerTree']) ||
    !isObject(capabilities) ||
    typeof capabilities['cloudSync'] !== 'boolean' ||
    typeof capabilities['social'] !== 'boolean' ||
    typeof capabilities['family'] !== 'boolean' ||
    !isObject(usage) ||
    !isLimit(usage['activeTrees']) ||
    usage['activeTrees'] === null ||
    !validBranches ||
    !Number.isSafeInteger(value['revision']) ||
    (value['revision'] as number) < 0 ||
    (nextRecomputeAt !== null && !isTimestamp(nextRecomputeAt)) ||
    !isTimestamp(offlineValidUntil)
  ) {
    throw new Error('invalid access summary');
  }

  const leaseCeiling = Math.min(
    now + ACCESS_OFFLINE_LEASE_MS,
    nextRecomputeAt === null ? Number.POSITIVE_INFINITY : nextRecomputeAt,
  );
  const boundedLease = Math.min(offlineValidUntil, leaseCeiling);
  if (boundedLease <= now) throw new Error('stale access summary');
  const visibleBranchesByTree = Object.fromEntries(
    Object.entries(branches as Record<string, unknown>).map(([treeId, count]) => [
      treeId,
      count as number,
    ]),
  );

  return {
    effectivePlanKey: value['effectivePlanKey'],
    catalogVersion: value['catalogVersion'],
    status: 'active',
    activeSources: sources.map((source) => ({
      kind: source.kind,
      sourceId: source.sourceId,
      planKey: source.planKey,
      validUntil: source.validUntil,
    })),
    limits: {
      maxActiveTrees: limits['maxActiveTrees'],
      maxVisibleBranchesPerTree: limits['maxVisibleBranchesPerTree'],
    },
    capabilities: {
      cloudSync: capabilities['cloudSync'],
      social: capabilities['social'],
      family: capabilities['family'],
    },
    usage: {
      activeTrees: usage['activeTrees'],
      visibleBranchesByTree,
    },
    revision: value['revision'] as number,
    nextRecomputeAt,
    offlineValidUntil: boundedLease,
  };
}

/**
 * Auth-scoped access cache and offline lease. An expired/missing/malformed
 * snapshot always presents Free; the backend remains authoritative for every
 * cloud mutation.
 */
@Injectable({ providedIn: 'root' })
export class AccessService {
  private readonly api = inject(API_CLIENT);
  private readonly auth = inject(AuthService);
  private readonly cache = inject(ACCESS_CACHE);
  private readonly runtime = inject(ACCESS_RUNTIME);

  private readonly nowSignal = signal(this.runtime.now());
  private readonly cachedSignal = signal<{ userId: string; summary: AccessSummary } | null>(null);
  private readonly loadingSignal = signal(false);
  private readonly lastErrorSignal = signal<ApiErrorCode | null>(null);
  private inFlight: { userId: string; promise: Promise<AccessSummary> } | null = null;
  private startPromise: Promise<void> | null = null;
  private cleanup: Array<() => void> = [];
  private stopLeaseTimer: (() => void) | null = null;
  private pendingRequests = 0;

  readonly access = computed(() => {
    const now = this.nowSignal();
    const userId = this.auth.user()?.userId;
    const cached = this.cachedSignal();
    if (userId && cached?.userId === userId && cached.summary.offlineValidUntil > now) {
      return cached.summary;
    }
    return createFreeAccessSummary(now);
  });
  readonly leaseState = computed<'valid' | 'fallback'>(() => {
    const userId = this.auth.user()?.userId;
    const cached = this.cachedSignal();
    return userId &&
      cached?.userId === userId &&
      cached.summary.offlineValidUntil > this.nowSignal()
      ? 'valid'
      : 'fallback';
  });
  readonly loading = this.loadingSignal.asReadonly();
  readonly lastError = this.lastErrorSignal.asReadonly();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      for (const stop of this.cleanup.splice(0)) stop();
      this.stopLeaseTimer?.();
      this.stopLeaseTimer = null;
    });
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.cleanup.push(
      this.runtime.listenOnline(() => void this.refresh()),
      this.runtime.scheduleEvery(() => void this.refresh(), ACCESS_REFRESH_MS),
    );
    this.startPromise = this.hydrate().then(() => {
      // Product startup stays local-first: cached/Free policy is ready before
      // the route opens, while the authoritative refresh continues quietly.
      void this.refresh();
    });
    return this.startPromise;
  }

  async open(): Promise<void> {
    await this.hydrate();
    await this.refresh();
  }

  private async hydrate(): Promise<void> {
    this.tick();
    const userId = this.auth.user()?.userId;
    if (!userId) {
      this.stopLeaseTimer?.();
      this.stopLeaseTimer = null;
      this.cachedSignal.set(null);
      this.lastErrorSignal.set(null);
      return;
    }
    try {
      const cached = await this.cache.read(userId);
      if (this.auth.user()?.userId === userId && cached) {
        try {
          this.setCached(userId, normalizeSummary(cached, this.nowSignal()));
        } catch {
          // Corrupt or expired device state is ignored; the network may repair it.
        }
      }
    } catch {
      // Storage unavailable: continue with a memory-only network session.
    }
  }

  refresh(): Promise<AccessSummary> {
    this.tick();
    const userId = this.auth.user()?.userId;
    if (!userId) {
      this.cachedSignal.set(null);
      this.lastErrorSignal.set(null);
      return Promise.resolve(this.access());
    }
    if (this.inFlight?.userId === userId) return this.inFlight.promise;

    this.beginRequest();
    this.lastErrorSignal.set(null);
    const request = this.api
      .getAccess()
      .then((summary) => this.accept(userId, summary))
      .catch((error: unknown) => {
        if (this.auth.user()?.userId === userId) {
          this.lastErrorSignal.set(error instanceof ApiError ? error.code : 'unknown');
        }
        return this.access();
      })
      .finally(() => {
        if (this.inFlight?.promise === request) this.inFlight = null;
        this.endRequest();
      });
    this.inFlight = { userId, promise: request };
    return request;
  }

  async redeem(code: string): Promise<AccessSummary> {
    this.tick();
    const userId = this.auth.user()?.userId;
    if (!userId) throw new ApiError('UNAUTHENTICATED');
    this.beginRequest();
    this.lastErrorSignal.set(null);
    try {
      return await this.accept(userId, await this.api.redeemAccessCode(code));
    } catch (error) {
      this.lastErrorSignal.set(error instanceof ApiError ? error.code : 'unknown');
      throw error;
    } finally {
      this.endRequest();
    }
  }

  private async accept(userId: string, value: unknown): Promise<AccessSummary> {
    if (this.auth.user()?.userId !== userId) return this.access();
    const summary = normalizeSummary(value, this.nowSignal());
    if (this.auth.user()?.userId !== userId) return this.access();
    this.setCached(userId, summary);
    try {
      await this.cache.write(userId, summary);
    } catch {
      // IndexedDB can be unavailable; the bounded memory lease remains valid.
    }
    return summary;
  }

  private tick(): void {
    this.nowSignal.set(this.runtime.now());
  }

  private setCached(userId: string, summary: AccessSummary): void {
    this.cachedSignal.set({ userId, summary });
    this.stopLeaseTimer?.();
    const expectedRevision = summary.revision;
    this.stopLeaseTimer = this.runtime.scheduleOnce(
      () => {
        this.stopLeaseTimer = null;
        this.tick();
        const current = this.cachedSignal();
        if (
          current?.userId === userId &&
          current.summary.revision === expectedRevision &&
          current.summary.offlineValidUntil <= this.nowSignal()
        ) {
          void this.refresh();
        }
      },
      Math.max(0, summary.offlineValidUntil - this.nowSignal()),
    );
  }

  private beginRequest(): void {
    this.pendingRequests += 1;
    this.loadingSignal.set(true);
  }

  private endRequest(): void {
    this.pendingRequests = Math.max(0, this.pendingRequests - 1);
    this.loadingSignal.set(this.pendingRequests > 0);
  }
}
