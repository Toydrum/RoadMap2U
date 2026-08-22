import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import type { ApiErrorCode, SyncStore } from '../api/contracts';
import { createMutationGroupId } from '../db/broadcast';
import { get, put } from '../db/idb';
import { hash } from '../hash';

const META_SYNC_CONFLICT_PREFIX = 'sync.conflicts:';
const CONFLICT_FORMAT_VERSION = 1 as const;
const SAFE_TOKEN = /^[A-Za-z0-9:._/-]{1,160}$/;

export const SYNC_CONFLICT_CODES = Object.freeze([
  'QUOTA_EXCEEDED',
  'CAPABILITY_REQUIRED',
  'SYNC_CLIENT_UPGRADE_REQUIRED',
  'COMMERCIAL_CONFIGURATION_UNAVAILABLE',
  'SYNC_SCHEMA_INVALID',
  'MUTATION_GROUP_INVALID',
  'SYNC_TOO_OLD',
  'USAGE_MIGRATION_IN_PROGRESS',
] as const satisfies readonly ApiErrorCode[]);

export type SyncConflictCode = (typeof SYNC_CONFLICT_CODES)[number];
export type SyncConflictState = 'pending' | 'local-only';
export type SyncConflictAction = 'retry' | 'archive-delete' | 'local-only';

export interface SyncConflictRecordRef {
  store: SyncStore;
  id: string;
  /** Structural identity of the rejected local snapshot. Keeping this here
   * makes `local-only` a version-scoped transport decision instead of a
   * permanent ban on every future edit of the same record. */
  rev: number;
  updatedAt: number;
}

export interface SyncConflict {
  id: string;
  mutationGroupId: string;
  code: SyncConflictCode;
  recordRefs: SyncConflictRecordRef[];
  state: SyncConflictState;
  createdAt: number;
  updatedAt: number;
  /** UI affordances only. `force-win` is deliberately not in this union. */
  actions: readonly SyncConflictAction[];
}

interface PersistedSyncConflict extends Omit<SyncConflict, 'actions'> {}

interface SyncConflictEnvelope {
  key: string;
  formatVersion: typeof CONFLICT_FORMAT_VERSION;
  conflicts: PersistedSyncConflict[];
}

export interface SyncConflictStorage {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
}

export const SYNC_CONFLICT_STORAGE = new InjectionToken<SyncConflictStorage>(
  'SYNC_CONFLICT_STORAGE',
  {
    providedIn: 'root',
    factory: () => ({
      read: (key) => get<unknown>('meta', key),
      write: (key, value) => put('meta', value),
    }),
  },
);

export interface SyncConflictRuntime {
  now(): number;
}

export const SYNC_CONFLICT_RUNTIME = new InjectionToken<SyncConflictRuntime>(
  'SYNC_CONFLICT_RUNTIME',
  { providedIn: 'root', factory: () => ({ now: Date.now }) },
);

const ACTIONS = Object.freeze([
  'retry',
  'archive-delete',
  'local-only',
] as const satisfies readonly SyncConflictAction[]);

const SYNC_STORES: ReadonlySet<string> = new Set<SyncStore>([
  'trees',
  'nodes',
  'checkins',
  'sessions',
  'harvests',
  'preserves',
]);

export function isSyncConflictCode(code: ApiErrorCode): code is SyncConflictCode {
  return (SYNC_CONFLICT_CODES as readonly ApiErrorCode[]).includes(code);
}

/** Restore-wins is an LWW repair, never a commercial-policy bypass. */
export function canForceWin(reason: string): reason is 'STALE_REV' {
  return reason === 'STALE_REV';
}

function opaqueOwnerScope(ownerId: string): string {
  return `${hash(`scope-a:${ownerId}`).toString(36)}-${hash(`scope-b:${ownerId}`).toString(36)}-${ownerId.length}`;
}

function scopeKey(ownerId: string): string {
  return `${META_SYNC_CONFLICT_PREFIX}${opaqueOwnerScope(ownerId)}`;
}

function sanitizeRefs(value: unknown): SyncConflictRecordRef[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, SyncConflictRecordRef>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const store = (candidate as Record<string, unknown>)['store'];
    const id = (candidate as Record<string, unknown>)['id'];
    const rev = (candidate as Record<string, unknown>)['rev'];
    const updatedAt = (candidate as Record<string, unknown>)['updatedAt'];
    if (typeof store !== 'string' || !SYNC_STORES.has(store)) continue;
    if (typeof id !== 'string' || !SAFE_TOKEN.test(id)) continue;
    if (!Number.isSafeInteger(rev) || (rev as number) < 0) continue;
    if (!Number.isSafeInteger(updatedAt) || (updatedAt as number) < 0) continue;
    unique.set(`${store}:${id}`, {
      store: store as SyncStore,
      id,
      rev: rev as number,
      updatedAt: updatedAt as number,
    });
  }
  return [...unique.values()].sort(
    (a, b) => a.store.localeCompare(b.store) || a.id.localeCompare(b.id),
  );
}

function safeGroupId(value: unknown): string {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : createMutationGroupId();
}

function toPublic(conflict: PersistedSyncConflict): SyncConflict {
  return {
    ...conflict,
    recordRefs: conflict.recordRefs.map((ref) => ({ ...ref })),
    actions: ACTIONS,
  };
}

function normalizeEnvelope(value: unknown, expectedKey: string): PersistedSyncConflict[] {
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  if (
    row['key'] !== expectedKey ||
    row['formatVersion'] !== CONFLICT_FORMAT_VERSION ||
    !Array.isArray(row['conflicts'])
  ) {
    return [];
  }
  const normalized: PersistedSyncConflict[] = [];
  for (const candidate of row['conflicts']) {
    if (!candidate || typeof candidate !== 'object') continue;
    const conflict = candidate as Record<string, unknown>;
    const code = conflict['code'];
    const refs = sanitizeRefs(conflict['recordRefs']);
    if (
      typeof conflict['id'] !== 'string' ||
      !SAFE_TOKEN.test(conflict['id']) ||
      typeof conflict['mutationGroupId'] !== 'string' ||
      !SAFE_TOKEN.test(conflict['mutationGroupId']) ||
      typeof code !== 'string' ||
      !isSyncConflictCode(code as ApiErrorCode) ||
      (conflict['state'] !== 'pending' && conflict['state'] !== 'local-only') ||
      !Number.isSafeInteger(conflict['createdAt']) ||
      !Number.isSafeInteger(conflict['updatedAt']) ||
      !refs.length
    ) {
      continue;
    }
    normalized.push({
      id: conflict['id'],
      mutationGroupId: conflict['mutationGroupId'],
      code: code as SyncConflictCode,
      recordRefs: refs,
      state: conflict['state'],
      createdAt: conflict['createdAt'] as number,
      updatedAt: conflict['updatedAt'] as number,
    });
  }
  return normalized.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

@Injectable({ providedIn: 'root' })
export class SyncConflictStore {
  private readonly storage = inject(SYNC_CONFLICT_STORAGE);
  private readonly runtime = inject(SYNC_CONFLICT_RUNTIME);
  private readonly conflictsSignal = signal<SyncConflict[]>([]);
  private activeKey: string | null = null;
  private generation = 0;
  private openInFlight: { key: string; promise: Promise<void> } | null = null;
  /** Per-owner write queues. IndexedDB normally serializes transactions, but
   * the injectable storage seam (and real async failures) may complete out of
   * order. A later envelope must always be the last write for its scope. */
  private readonly persistTails = new Map<string, Promise<void>>();

  readonly conflicts = this.conflictsSignal.asReadonly();

  async open(ownerId: string | null): Promise<void> {
    if (!ownerId) {
      if (this.activeKey === null && this.conflictsSignal().length === 0) return;
      ++this.generation;
      this.openInFlight = null;
      this.activeKey = null;
      this.conflictsSignal.set([]);
      return;
    }
    const key = scopeKey(ownerId);
    if (this.openInFlight?.key === key) return this.openInFlight.promise;
    if (this.activeKey === key) return;
    const generation = ++this.generation;
    this.activeKey = key;
    const promise = (async () => {
      let stored: unknown = null;
      try {
        await this.persistTails.get(key);
        stored = await this.storage.read(key);
      } catch {
        // IndexedDB unavailable: this scope continues in memory only.
      }
      if (generation !== this.generation || this.activeKey !== key) return;
      this.conflictsSignal.set(normalizeEnvelope(stored, key).map(toPublic));
    })().finally(() => {
      if (this.openInFlight?.promise === promise) this.openInFlight = null;
    });
    this.openInFlight = { key, promise };
    return promise;
  }

  async record(
    ownerId: string,
    input: {
      mutationGroupId: string;
      code: SyncConflictCode;
      recordRefs: readonly SyncConflictRecordRef[];
    },
  ): Promise<SyncConflict> {
    const scope = await this.ensureScope(ownerId);
    this.assertActiveScope(scope);
    const { key } = scope;
    const refs = sanitizeRefs(input.recordRefs);
    if (!refs.length) throw new Error('sync conflict requires safe record refs');
    const mutationGroupId = safeGroupId(input.mutationGroupId);
    const id = `sc-${hash(`${key}:a:${mutationGroupId}:${input.code}`).toString(36)}-${hash(`${key}:b:${mutationGroupId}:${input.code}`).toString(36)}`;
    const now = this.runtime.now();
    const previous = this.conflictsSignal().find((conflict) => conflict.id === id);
    const next: SyncConflict = {
      id,
      mutationGroupId,
      code: input.code,
      recordRefs: refs,
      state: previous?.state ?? 'pending',
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      actions: ACTIONS,
    };
    this.conflictsSignal.update((current) =>
      [...current.filter((conflict) => conflict.id !== id), next].sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      ),
    );
    await this.persist(scope);
    return next;
  }

  async resolve(
    ownerId: string,
    conflictId: string,
    resolution: 'retry' | 'local-only',
  ): Promise<SyncConflict | null> {
    const scope = await this.ensureScope(ownerId);
    this.assertActiveScope(scope);
    let resolved: SyncConflict | null = null;
    this.conflictsSignal.update((current) =>
      current.map((conflict) => {
        if (conflict.id !== conflictId) return conflict;
        resolved = {
          ...conflict,
          state: resolution === 'local-only' ? 'local-only' : 'pending',
          updatedAt: this.runtime.now(),
        };
        return resolved;
      }),
    );
    if (resolved) await this.persist(scope);
    return resolved;
  }

  isLocalOnly(store: SyncStore, id: string, rev: number, updatedAt: number): boolean {
    return this.conflictsSignal().some(
      (conflict) =>
        conflict.state === 'local-only' &&
        conflict.recordRefs.some(
          (ref) =>
            ref.store === store && ref.id === id && ref.rev === rev && ref.updatedAt === updatedAt,
        ),
    );
  }

  async clearPendingGroup(ownerId: string, mutationGroupId: string): Promise<void> {
    const scope = await this.ensureScope(ownerId);
    this.assertActiveScope(scope);
    const before = this.conflictsSignal();
    const next = before.filter(
      (conflict) => conflict.mutationGroupId !== mutationGroupId || conflict.state === 'local-only',
    );
    if (next.length === before.length) return;
    this.conflictsSignal.set(next);
    await this.persist(scope);
  }

  /** Terminal account closure only. Invalidate new work, then wait for every
   * older per-scope write to finish before LocalAccountDataService wipes meta;
   * otherwise a delayed conflict envelope could resurrect after the wipe. */
  async resetAfterAccountClosure(): Promise<void> {
    ++this.generation;
    this.openInFlight = null;
    this.activeKey = null;
    this.conflictsSignal.set([]);
    await Promise.allSettled([...this.persistTails.values()]);
    this.persistTails.clear();
  }

  private async ensureScope(ownerId: string): Promise<{ key: string; generation: number }> {
    const key = scopeKey(ownerId);
    if (this.activeKey !== key) await this.open(ownerId);
    if (this.activeKey !== key) throw new Error('sync conflict auth scope changed');
    return { key, generation: this.generation };
  }

  private assertActiveScope(scope: { key: string; generation: number }): void {
    if (this.activeKey !== scope.key || this.generation !== scope.generation) {
      throw new Error('sync conflict auth scope changed');
    }
  }

  private persist(scope: { key: string; generation: number }): Promise<void> {
    this.assertActiveScope(scope);
    const { key } = scope;
    const envelope: SyncConflictEnvelope = {
      key,
      formatVersion: CONFLICT_FORMAT_VERSION,
      conflicts: this.conflictsSignal().map(({ actions: _actions, ...conflict }) => ({
        ...conflict,
        recordRefs: conflict.recordRefs.map((ref) => ({ ...ref })),
      })),
    };
    const previous = this.persistTails.get(key) ?? Promise.resolve();
    let queued!: Promise<void>;
    queued = previous
      .then(async () => {
        try {
          await this.storage.write(key, envelope);
        } catch {
          // Memory-only sessions keep the conflict explainable until this tab closes.
        }
      })
      .finally(() => {
        if (this.persistTails.get(key) === queued) this.persistTails.delete(key);
      });
    this.persistTails.set(key, queued);
    return queued;
  }
}
