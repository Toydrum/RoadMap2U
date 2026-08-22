import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { API_CLIENT } from '../api/api-client';
import {
  ApiError,
  ApiErrorCode,
  CONTRACT_VERSION,
  SyncMutationGroup,
  SyncRecord,
  SyncStore,
  lwwBeats,
} from '../api/contracts';
import {
  CheckIn,
  Harvest,
  Preserve,
  SCHEMA_VERSION,
  SyncBase,
  TimerSession,
  Tree,
  TreeNode,
} from '../db/schema';
import { get, put } from '../db/idb';
import { LocalWritesQuiescedError, onAccountClosureQuiesce } from '../db/account-closure-fence';
import { broadcastRemote, createMutationGroupId, onLocalWrite } from '../db/broadcast';
import { AuthService } from '../auth/auth.service';
import { AccountLinkSnapshot, META_ACCOUNT_LINK } from '../auth/auth-types';
import { RecordsRepo } from '../repos/records.repo';
import { TreesRepo } from '../repos/trees.repo';
import { NodesRepo } from '../repos/nodes.repo';
import { CheckinsRepo } from '../repos/checkins.repo';
import { SessionsRepo } from '../repos/sessions.repo';
import { HarvestsRepo } from '../repos/harvests.repo';
import { PreservesRepo } from '../repos/preserves.repo';
import { SyncConflictStore, canForceWin, isSyncConflictCode } from './sync-conflict.store';
import {
  buildSyncMutationGroups,
  chunkMutationGroups,
  syncRecordKey,
  type MutationMembership,
  type MutationRecordRef,
} from './mutation-groups';

/**
 * «Conectar mi bosque» — the sync engine. Strictly OPT-IN: nothing leaves the
 * device until the user explicitly connects, and the connection is remembered
 * per-device in the `account.link` meta key.
 *
 * Rails (designed since 0.0.48): outbound rides `onLocalWrite` (debounced) +
 * a watermark scan that catches anything a crash left behind; inbound walks
 * the server's cursor feed into `RecordsRepo.applyExternal` (rev-LWW) with a
 * disk write guarded by the same law. Re-pushing is idempotent by contract
 * (the server rejects `rev <= stored` as STALE_REV and hands back its winner),
 * so every edge self-heals on the next pass.
 *
 * Boot stays network-free: `init()` reads two meta keys; the first pull fires
 * a few seconds later, only when online, signed in and this device's link
 * matches the signed-in account.
 */

const META_SYNC_STATE = 'sync.state';
const PUSH_DEBOUNCE_MS = 1500;
const BOOT_PULL_DELAY_MS = 3000;
const MAX_PULL_PAGES = 50;
const SAFE_MUTATION_GROUP_ID = /^[A-Za-z0-9:._/-]{1,160}$/;
const SYNC_STORE_NAMES: ReadonlySet<string> = new Set<SyncStore>([
  'trees',
  'nodes',
  'checkins',
  'sessions',
  'harvests',
  'preserves',
]);

interface SyncStateSnapshot {
  key: typeof META_SYNC_STATE;
  /** Everything with updatedAt beyond this has not been pushed yet. */
  watermark: number;
  /** Opaque server cursor — the change feed resumes after it. */
  cursor: string;
  lastSyncAt: number | null;
  /** A backup was restored: the next sync must run the restore-wins pass. */
  forcePending?: boolean;
  /** Ids written since the last settled push — the clock-proof half of the
   *  outbound scan (a backward clock jump makes updatedAt lie to the
   *  watermark; explicit bookkeeping cannot be lied to). */
  dirty?: Partial<Record<SyncStore, string[]>>;
  /** Logical writes pending cloud validation. Contains only store/id refs —
   *  never record payload, title, note or owner identity. */
  mutationGroups?: MutationMembership[];
}

export interface SyncMetaStorage {
  read(key: string): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

export const SYNC_META_STORAGE = new InjectionToken<SyncMetaStorage>('SYNC_META_STORAGE', {
  providedIn: 'root',
  factory: () => ({
    read: (key) => get<unknown>('meta', key),
    write: (value) => put('meta', value),
  }),
});

export type SyncPhase = 'off' | 'mismatch' | 'idle' | 'syncing' | 'offline' | 'error';

@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly api = inject(API_CLIENT);
  private readonly auth = inject(AuthService);
  private readonly trees = inject(TreesRepo);
  private readonly nodes = inject(NodesRepo);
  private readonly checkins = inject(CheckinsRepo);
  private readonly sessions = inject(SessionsRepo);
  private readonly harvests = inject(HarvestsRepo);
  private readonly preserves = inject(PreservesRepo);
  private readonly conflicts = inject(SyncConflictStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly metaStorage = inject(SYNC_META_STORAGE);

  private readonly linkSignal = signal<AccountLinkSnapshot | null>(null);
  private readonly busySignal = signal(false);
  private readonly lastSyncAtSignal = signal<number | null>(null);
  private readonly lastErrorSignal = signal<ApiErrorCode | null>(null);

  readonly link = this.linkSignal.asReadonly();
  readonly lastSyncAt = this.lastSyncAtSignal.asReadonly();
  readonly lastError = this.lastErrorSignal.asReadonly();

  /** The single state the UI paints from. */
  readonly phase = computed<SyncPhase>(() => {
    const link = this.linkSignal();
    if (!link?.accountId) return 'off';
    const user = this.auth.user();
    if (!user) return 'off';
    if (link.accountId !== user.userId) return 'mismatch';
    if (this.busySignal()) return 'syncing';
    if (this.lastErrorSignal() === 'offline') return 'offline';
    if (this.lastErrorSignal()) return 'error';
    return 'idle';
  });

  private watermark = 0;
  private cursor = '0';
  private forcePending = false;
  /** Per-store ids awaiting a settled push — see SyncStateSnapshot.dirty. */
  private readonly dirtyIds = new Map<SyncStore, Set<string>>();
  /** Group id -> content-free refs. Overlapping pending writes are merged
   *  into the newest operation id so a marker is never replayed with a
   *  different payload. */
  private readonly pendingGroups = new Map<string, Map<string, MutationRecordRef>>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Suppresses the local-write echo while a pull applies remote records. */
  /** Debounce for persisting dirty marks outside a sync pass. */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by forgetEverything so an in-flight sync can't re-persist stale
   *  cursor/watermark over a reset. */
  private epoch = 0;
  private initialized = false;
  private accountClosureQuiesced = false;
  private readonly pendingMetaWrites = new Set<Promise<void>>();
  private readonly activeSyncPasses = new Set<Promise<boolean>>();

  constructor() {
    this.destroyRef.onDestroy(onAccountClosureQuiesce(() => this.beginAccountClosureReset()));
    let conflictOwner: string | null | undefined;
    effect(() => {
      const ownerId = this.auth.user()?.userId ?? null;
      if (ownerId === conflictOwner) return;
      conflictOwner = ownerId;
      void this.conflicts.open(ownerId);
    });

    // Signing in AFTER boot (the boot timer has long fired by then) must
    // resume syncing on its own — otherwise the ✅ card lies until the next
    // local write. Same for clearing a mismatch by switching accounts.
    let prev: SyncPhase | null = null;
    effect(() => {
      const phase = this.phase();
      const was = prev;
      prev = phase;
      if (phase === 'idle' && (was === 'off' || was === 'mismatch')) this.schedulePush();
    });
  }

  /** App initializer — meta reads only, zero network, fail-open. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const [link, state] = await Promise.all([
        this.metaStorage.read(META_ACCOUNT_LINK),
        this.metaStorage.read(META_SYNC_STATE),
      ]);
      if (link) this.linkSignal.set(link as AccountLinkSnapshot);
      if (state) {
        const snapshot = state as SyncStateSnapshot;
        this.watermark = snapshot.watermark ?? 0;
        this.cursor = snapshot.cursor ?? '0';
        this.forcePending = snapshot.forcePending ?? false;
        this.lastSyncAtSignal.set(snapshot.lastSyncAt ?? null);
        for (const [store, ids] of Object.entries(snapshot.dirty ?? {})) {
          this.dirtyIds.set(store as SyncStore, new Set(ids));
        }
        for (const membership of snapshot.mutationGroups ?? []) {
          this.restoreMembership(membership);
        }
      }
    } catch {
      /* memory-only session — sync stays off */
    }

    await this.conflicts.open(this.auth.user()?.userId ?? null);

    const stopLocalWrites = onLocalWrite((message) => {
      if (this.accountClosureQuiesced) return;
      // No applyingRemote gate here: pulls broadcast via broadcastRemote
      // (cross-tab only), so everything that reaches this handler is a
      // GENUINE local write — the old gate silently dropped user writes
      // that interleaved with a pull being applied.
      // Mark ALWAYS (even signed out): if the clock jumped backward these
      // writes are invisible to the watermark, and the dirty set is what
      // still gets them pushed after the next sign-in.
      if (message.store !== 'meta') {
        const store = message.store as SyncStore;
        const ids = message.ids.filter((id) => {
          const record = this.repoOf(store).byId().get(id);
          return !record || !this.isLocalOnlyVersion(store, record);
        });
        if (!ids.length) return;
        const set = this.dirtyIds.get(message.store) ?? new Set<string>();
        for (const id of ids) set.add(id);
        this.dirtyIds.set(message.store, set);
        this.rememberMutation(
          message.mutationGroupId ?? createMutationGroupId(),
          ids.map((id) => ({ store: message.store as SyncStore, id })),
        );
        // …and marks must reach DISK even without a successful sync (the
        // in-memory set dies with the tab; the watermark scan can't cover a
        // backward clock — the exact case the persisted set exists for).
        this.schedulePersistState();
      }
      if (this.phase() === 'off' || this.phase() === 'mismatch') return;
      this.schedulePush();
    });
    this.destroyRef.onDestroy(stopLocalWrites);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => void this.syncNow());
    }
    setTimeout(() => {
      if (this.phase() === 'idle') void this.syncNow();
    }, BOOT_PULL_DELAY_MS);
  }

  /** The explicit opt-in: full push of this device's forest, then adoption of
   *  whatever the account's cloud already holds (LWW merges both ways). */
  async connect(): Promise<boolean> {
    if (this.accountClosureQuiesced) return false;
    const user = this.auth.user();
    if (!user) return false;
    const link: AccountLinkSnapshot = {
      key: META_ACCOUNT_LINK,
      accountId: user.userId,
      linkedAt: Date.now(),
      uploadedAt: null,
    };
    this.watermark = 0; // everything this device holds goes up
    this.cursor = '0'; // and everything the account holds comes down
    await this.persistLink(link);
    await this.persistState();
    const ok = await this.syncNow();
    if (ok) {
      await this.persistLink({ ...link, uploadedAt: Date.now() });
    }
    return ok;
  }

  /** Lets go of the device↔account link. Local data is untouched. */
  async disconnect(): Promise<void> {
    if (this.accountClosureQuiesced) return;
    const current = this.linkSignal();
    await this.persistLink({
      key: META_ACCOUNT_LINK,
      accountId: null,
      linkedAt: current?.linkedAt ?? Date.now(),
      uploadedAt: null,
    });
    this.lastErrorSignal.set(null);
  }

  syncNow(): Promise<boolean> {
    if (
      this.accountClosureQuiesced ||
      this.phase() === 'off' ||
      this.phase() === 'mismatch' ||
      this.busySignal()
    ) {
      return Promise.resolve(false);
    }
    const ownerId = this.auth.user()?.userId;
    if (!ownerId) return Promise.resolve(false);
    const pass = this.runSyncPass(ownerId);
    this.activeSyncPasses.add(pass);
    void pass.then(
      () => this.activeSyncPasses.delete(pass),
      () => this.activeSyncPasses.delete(pass),
    );
    return pass;
  }

  private async runSyncPass(ownerId: string): Promise<boolean> {
    await this.conflicts.open(ownerId);
    if (this.accountClosureQuiesced) return false;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.lastErrorSignal.set('offline');
      return false;
    }
    this.busySignal.set(true);
    this.lastErrorSignal.set(null);
    const epoch = this.epoch;
    try {
      if (this.forcePending) {
        this.watermark = 0; // a restore pushes EVERYTHING, and it wins
        await this.pushForceWins();
        this.forcePending = false;
      } else {
        await this.pushDirty();
      }
      await this.pullChanges();
      // A reset (forgetEverything) mid-pass: our watermark/cursor belong to
      // the OLD cloud — persisting them would make the fresh cursor silently
      // skip records, the exact failure the reset guards against.
      if (epoch !== this.epoch) return false;
      this.lastSyncAtSignal.set(Date.now());
      await this.persistState();
      return true;
    } catch (error) {
      if (epoch !== this.epoch || this.accountClosureQuiesced) return false;
      this.lastErrorSignal.set(error instanceof ApiError ? error.code : 'unknown');
      if (epoch === this.epoch) await this.persistState();
      return false;
    } finally {
      if (!this.accountClosureQuiesced) this.busySignal.set(false);
    }
  }

  /** Dirty marks reach disk shortly after they're made — not only after a
   *  successful sync (a tab closed offline used to lose them all). */
  private schedulePersistState(): void {
    if (this.accountClosureQuiesced) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistState();
    }, 2000);
  }

  /** Called by BackupService after an import-replace. An EXPLICIT restore
   *  must prevail over the cloud — otherwise the next pull silently undoes it
   *  (the cloud's higher revs win LWW). The flag persists, so an offline (or
   *  not-yet-connected) import still gets its restore-wins pass on the next
   *  successful sync or connect. */
  async noteRestore(): Promise<void> {
    if (this.accountClosureQuiesced) return;
    this.forcePending = true;
    this.watermark = 0;
    await this.persistState();
    void this.syncNow(); // guards inside handle off/mismatch/offline
  }

  // ── outbound ──────────────────────────────────────────────────────────────

  private schedulePush(): void {
    if (this.accountClosureQuiesced) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.syncNow();
    }, PUSH_DEBOUNCE_MS);
  }

  /** Watermark scan + dirty set: everything written after the last successful
   *  push — including tombstones and archived records (a backup-grade copy). */
  private async pushDirty(): Promise<void> {
    const captureAt = Date.now();
    const groups = buildSyncMutationGroups(this.gatherAll(), this.memberships());
    // Preserve every captured row explicitly before the first request. If a
    // later batch fails, advancing the watermark cannot hide an untried row.
    this.markDirty(groups.flatMap((group) => group.records));
    for (const batch of chunkMutationGroups(groups)) {
      let result;
      try {
        result = await this.api.pushSync({
          schemaVersion: SCHEMA_VERSION,
          contractVersion: CONTRACT_VERSION,
          mutationGroups: batch,
        });
      } catch (error) {
        await this.recordBlockedGroups(error, batch);
        throw error;
      }
      const rejectionReasons = new Map(
        result.rejected.map((entry) => [entry.id, entry.reason as string]),
      );
      const rejected = new Set(rejectionReasons.keys());
      const applied = new Set(result.applied);
      const winners = new Map(
        result.serverRecords.map((entry) => [syncRecordKey(entry.store, entry.record.id), entry]),
      );
      let unresolvedAtomicGroup = false;
      let firstBlockingReason: ApiErrorCode | null = null;

      for (const group of batch) {
        const blockingReason = group.records
          .map((entry) => rejectionReasons.get(entry.record.id))
          .find((reason) => reason !== undefined && !canForceWin(reason));
        if (blockingReason) {
          if (isSyncConflictCode(blockingReason as ApiErrorCode)) {
            const code = blockingReason as ApiErrorCode;
            await this.recordConflict(code, group);
            firstBlockingReason ??= code;
          }
          unresolvedAtomicGroup = true;
          continue;
        }

        const hasRejection = group.records.some((entry) => rejected.has(entry.record.id));
        const fullyApplied = group.records.every((entry) => applied.has(entry.record.id));
        if (!hasRejection && fullyApplied) {
          this.settleDirty(group.records);
          await this.conflicts.clearPendingGroup(this.ownerIdOrThrow(), group.id);
          continue;
        }

        // A group-level rejection may converge from cloud winners only when
        // the response supplies a winner for EVERY member. Applying one
        // winner would shrink the pending membership and later replay the
        // same marker with a different expectedCount/payload.
        const completeWinners = group.records.map((entry) =>
          winners.get(syncRecordKey(entry.store, entry.record.id)),
        );
        if (completeWinners.every((entry): entry is SyncRecord => Boolean(entry))) {
          for (const winner of completeWinners) await this.acceptRemote(winner);
          await this.conflicts.clearPendingGroup(this.ownerIdOrThrow(), group.id);
          continue;
        }

        unresolvedAtomicGroup = true;
      }

      if (unresolvedAtomicGroup) {
        // All gathered rows are dirty, so this watermark only suppresses
        // already-settled groups; it cannot lose this or a later batch.
        this.watermark = captureAt;
        throw new ApiError(firstBlockingReason ?? 'CONFLICT');
      }
    }
    this.watermark = captureAt;
  }

  /** The restore-wins pass: push everything; when the cloud out-revs a record
   *  (STALE_REV), re-stamp the local copy just PAST the cloud winner and push
   *  again — per-record restore-wins. Records the backup never knew (created
   *  elsewhere after the export) still flow back in on the pull: LWW is
   *  per-record, a restore is not a cloud wipe. */
  private async pushForceWins(): Promise<void> {
    const captureAt = Date.now();
    const groups = buildSyncMutationGroups(this.gatherAll(), this.memberships());
    for (const batch of chunkMutationGroups(groups)) {
      const records = batch.flatMap((group) => group.records);
      this.markDirty(records);
      let result;
      try {
        result = await this.api.pushSync({
          schemaVersion: SCHEMA_VERSION,
          contractVersion: CONTRACT_VERSION,
          mutationGroups: batch,
        });
      } catch (error) {
        await this.recordBlockedGroups(error, batch);
        throw error;
      }

      const rejectedById = new Map(
        result.rejected.map((rejection) => [rejection.id, rejection.reason as string]),
      );
      const appliedById = new Set(result.applied);
      const blocked = batch.filter((group) =>
        group.records.some((entry) => {
          const reason = rejectedById.get(entry.record.id);
          return reason !== undefined && !canForceWin(reason);
        }),
      );
      if (blocked.length) {
        for (const group of blocked) {
          const reason = group.records
            .map((entry) => rejectedById.get(entry.record.id))
            .find((candidate) => candidate !== undefined && !canForceWin(candidate));
          if (reason && isSyncConflictCode(reason as ApiErrorCode)) {
            await this.recordConflict(reason as ApiErrorCode, group);
          }
        }
        const firstReason = blocked
          .flatMap((group) => group.records)
          .map((entry) => rejectedById.get(entry.record.id))
          .find((candidate) => candidate !== undefined && !canForceWin(candidate));
        throw new ApiError(
          firstReason && isSyncConflictCode(firstReason as ApiErrorCode)
            ? (firstReason as ApiErrorCode)
            : 'CONFLICT',
        );
      }

      const winnerRevs = new Map(
        result.serverRecords.map((winner) => [winner.record.id, winner.record.rev]),
      );
      const retryGroups: SyncMutationGroup[] = [];
      let unresolvedAtomicGroup = false;
      for (const group of batch) {
        const staleIds = new Set(
          group.records
            .filter((entry) => canForceWin(rejectedById.get(entry.record.id) ?? ''))
            .map((entry) => entry.record.id),
        );
        if (!staleIds.size) {
          if (group.records.every((entry) => appliedById.has(entry.record.id))) {
            this.settleDirty(group.records);
            await this.conflicts.clearPendingGroup(this.ownerIdOrThrow(), group.id);
          } else {
            this.markDirty(group.records);
            unresolvedAtomicGroup = true;
          }
          continue;
        }

        const retryRecords: SyncRecord[] = [];
        for (const entry of group.records) {
          if (!staleIds.has(entry.record.id)) {
            retryRecords.push(entry);
            continue;
          }
          const cloudRev = winnerRevs.get(entry.record.id) ?? entry.record.rev;
          const stamped = {
            ...entry.record,
            rev: Math.max(entry.record.rev, cloudRev) + 1,
            updatedAt: Date.now(),
          };
          try {
            await put(entry.store, stamped);
          } catch (error) {
            if (error instanceof LocalWritesQuiescedError || this.accountClosureQuiesced) return;
            /* memory-only session */
          }
          if (this.accountClosureQuiesced) return;
          this.repoOf(entry.store).applyExternal(stamped as never);
          retryRecords.push({ store: entry.store, record: stamped });
        }
        retryGroups.push({ ...group, expectedCount: retryRecords.length, records: retryRecords });
      }

      if (!retryGroups.length) {
        if (unresolvedAtomicGroup) throw new ApiError('CONFLICT');
        continue;
      }
      let second;
      try {
        second = await this.api.pushSync({
          schemaVersion: SCHEMA_VERSION,
          contractVersion: CONTRACT_VERSION,
          mutationGroups: retryGroups,
        });
      } catch (error) {
        await this.recordBlockedGroups(error, retryGroups);
        throw error;
      }
      const secondReasons = new Map(
        second.rejected.map((rejection) => [rejection.id, rejection.reason as string]),
      );
      const stillRejected = new Set(secondReasons.keys());
      const secondApplied = new Set(second.applied);
      let retryBlockingReason: ApiErrorCode | null = null;
      for (const group of retryGroups) {
        if (group.records.some((entry) => stillRejected.has(entry.record.id))) {
          // The retry is also atomic: one rejection means NONE of the group
          // settled. In particular, never shrink this marker to the records
          // absent from `rejected`; the server did not apply those either.
          this.markDirty(group.records);
          const blockingReason = group.records
            .map((entry) => secondReasons.get(entry.record.id))
            .find((reason) => reason !== undefined && !canForceWin(reason));
          if (blockingReason && isSyncConflictCode(blockingReason as ApiErrorCode)) {
            const code = blockingReason as ApiErrorCode;
            await this.recordConflict(code, group);
            retryBlockingReason ??= code;
          }
          continue;
        }
        if (group.records.every((entry) => secondApplied.has(entry.record.id))) {
          this.settleDirty(group.records);
          await this.conflicts.clearPendingGroup(this.ownerIdOrThrow(), group.id);
        } else {
          this.markDirty(group.records);
          unresolvedAtomicGroup = true;
        }
      }
      if (stillRejected.size || unresolvedAtomicGroup) {
        // Keep forcePending=true by failing this pass. The next pass re-reads
        // the newer winner and advances again; quota/capability/schema never
        // enter this branch because only STALE_REV is force-winnable.
        throw new ApiError(retryBlockingReason ?? 'CONFLICT');
      }
    }
    this.watermark = captureAt;
  }

  /** Resolve is explicit because `local-only` changes transport bookkeeping,
   * not the forest row. Other dirty refs and every local record stay intact. */
  async resolveConflict(conflictId: string, resolution: 'retry' | 'local-only'): Promise<boolean> {
    const ownerId = this.auth.user()?.userId;
    if (!ownerId) return false;
    const conflict = await this.conflicts.resolve(ownerId, conflictId, resolution);
    if (!conflict) return false;
    if (resolution === 'local-only') {
      for (const ref of conflict.recordRefs) {
        const current = this.repoOf(ref.store).byId().get(ref.id);
        if (!current || !this.matchesConflictVersion(current, ref)) continue;
        this.dirtyIds.get(ref.store)?.delete(ref.id);
        this.removePendingRef(ref.store, ref.id);
      }
    } else {
      const currentRefs: MutationRecordRef[] = [];
      let canReuseGroupId = true;
      for (const ref of conflict.recordRefs) {
        const current = this.repoOf(ref.store).byId().get(ref.id);
        if (!current) continue;
        if (!this.matchesConflictVersion(current, ref)) canReuseGroupId = false;
        const dirty = this.dirtyIds.get(ref.store) ?? new Set<string>();
        dirty.add(ref.id);
        this.dirtyIds.set(ref.store, dirty);
        currentRefs.push({ store: ref.store, id: ref.id });
      }
      if (currentRefs.length) {
        this.rememberMutation(
          canReuseGroupId && currentRefs.length === conflict.recordRefs.length
            ? conflict.mutationGroupId
            : createMutationGroupId(),
          currentRefs,
        );
      }
      this.schedulePush();
    }
    await this.persistState();
    return true;
  }

  private ownerIdOrThrow(): string {
    const ownerId = this.auth.user()?.userId;
    if (!ownerId) throw new ApiError('UNAUTHENTICATED');
    return ownerId;
  }

  private memberships(): MutationMembership[] {
    return [...this.pendingGroups]
      .map(([id, refs]) => ({
        id,
        recordRefs: [...refs.values()].sort(
          (a, b) => a.store.localeCompare(b.store) || a.id.localeCompare(b.id),
        ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private restoreMembership(value: MutationMembership): void {
    if (!value || typeof value !== 'object' || !SAFE_MUTATION_GROUP_ID.test(value.id)) return;
    if (!Array.isArray(value.recordRefs)) return;
    const refs = value.recordRefs.filter(
      (ref): ref is MutationRecordRef =>
        Boolean(ref) &&
        typeof ref.store === 'string' &&
        SYNC_STORE_NAMES.has(ref.store) &&
        typeof ref.id === 'string' &&
        SAFE_MUTATION_GROUP_ID.test(ref.id) &&
        this.dirtyIds.get(ref.store)?.has(ref.id) === true,
    );
    if (refs.length) this.rememberMutation(value.id, refs);
  }

  /** Merge overlapping not-yet-settled writes into the NEW operation id.
   * Keeping the old id with a changed record version would replay a DynamoDB
   * mutation marker with a different payload. */
  private rememberMutation(groupId: string, refs: readonly MutationRecordRef[]): void {
    const safeId = SAFE_MUTATION_GROUP_ID.test(groupId) ? groupId : createMutationGroupId();
    const merged = new Map<string, MutationRecordRef>();
    const touched = new Set(refs.map((ref) => syncRecordKey(ref.store, ref.id)));
    for (const ref of refs) merged.set(syncRecordKey(ref.store, ref.id), ref);
    let absorbed: boolean;
    do {
      absorbed = false;
      for (const [existingId, existingRefs] of [...this.pendingGroups]) {
        if (existingId !== safeId && ![...existingRefs.keys()].some((key) => touched.has(key))) {
          continue;
        }
        for (const [key, ref] of existingRefs) {
          merged.set(key, ref);
          touched.add(key);
        }
        this.pendingGroups.delete(existingId);
        absorbed = true;
      }
    } while (absorbed);
    if (merged.size) this.pendingGroups.set(safeId, merged);
  }

  private removePendingRef(store: SyncStore, id: string): void {
    const key = syncRecordKey(store, id);
    for (const [groupId, refs] of [...this.pendingGroups]) {
      refs.delete(key);
      if (!refs.size) this.pendingGroups.delete(groupId);
    }
  }

  private markDirty(records: readonly SyncRecord[]): void {
    for (const entry of records) {
      const dirty = this.dirtyIds.get(entry.store) ?? new Set<string>();
      dirty.add(entry.record.id);
      this.dirtyIds.set(entry.store, dirty);
    }
  }

  private async recordBlockedGroups(
    error: unknown,
    groups: readonly SyncMutationGroup[],
  ): Promise<void> {
    if (!(error instanceof ApiError) || !isSyncConflictCode(error.code)) return;
    for (const group of groups) await this.recordConflict(error.code, group);
  }

  private async recordConflict(code: ApiErrorCode, group: SyncMutationGroup): Promise<void> {
    if (this.accountClosureQuiesced) return;
    if (!isSyncConflictCode(code)) return;
    await this.conflicts.record(this.ownerIdOrThrow(), {
      mutationGroupId: group.id,
      code,
      recordRefs: group.records.map((entry) => ({
        store: entry.store,
        id: entry.record.id,
        rev: entry.record.rev,
        updatedAt: entry.record.updatedAt,
      })),
    });
  }

  private gatherAll(): SyncRecord[] {
    return [
      ...this.gather('trees', this.trees),
      ...this.gather('nodes', this.nodes),
      ...this.gather('checkins', this.checkins),
      ...this.gather('sessions', this.sessions),
      ...this.gather('harvests', this.harvests),
      ...this.gather('preserves', this.preserves),
    ];
  }

  private gather<T extends SyncBase>(store: SyncStore, repo: RecordsRepo<T>): SyncRecord[] {
    const out: SyncRecord[] = [];
    const dirty = this.dirtyIds.get(store);
    // Dirty ids with no record left (an import-replace removed them) can
    // never be pushed and never settle — drop them here (0.0.115 B4: they
    // accumulated in sync.state forever, one batch per import).
    if (dirty) {
      for (const id of [...dirty]) {
        const record = repo.byId().get(id);
        if (!record || this.isLocalOnlyVersion(store, record)) {
          dirty.delete(id);
          this.removePendingRef(store, id);
        }
      }
    }
    for (const record of repo.byId().values()) {
      if (
        !this.isLocalOnlyVersion(store, record) &&
        (record.updatedAt > this.watermark || dirty?.has(record.id))
      ) {
        out.push({
          store,
          record: record as unknown as
            Tree | TreeNode | CheckIn | TimerSession | Harvest | Preserve,
        });
      }
    }
    return out;
  }

  private isLocalOnlyVersion(store: SyncStore, record: SyncBase): boolean {
    return this.conflicts.isLocalOnly(store, record.id, record.rev, record.updatedAt);
  }

  private matchesConflictVersion(
    record: SyncBase,
    ref: { rev: number; updatedAt: number },
  ): boolean {
    return record.rev === ref.rev && record.updatedAt === ref.updatedAt;
  }

  /** Un-mark what a push settled. A record re-written DURING the push has a
   *  higher rev than the copy we sent — it stays marked for the next pass. */
  private settleDirty(pushed: SyncRecord[]): void {
    for (const entry of pushed) {
      const set = this.dirtyIds.get(entry.store);
      if (!set?.has(entry.record.id)) continue;
      const current = this.repoOf(entry.store).byId().get(entry.record.id);
      if (!current || current.rev === entry.record.rev) {
        set.delete(entry.record.id);
        this.removePendingRef(entry.store, entry.record.id);
      }
    }
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  private async pullChanges(): Promise<void> {
    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const batch = await this.api.getSyncChanges(this.cursor === '0' ? undefined : this.cursor);
      const touched = new Map<SyncStore, string[]>();
      for (const change of batch.changes) {
        if (await this.acceptRemote(change)) {
          const ids = touched.get(change.store) ?? [];
          ids.push(change.record.id);
          touched.set(change.store, ids);
        }
      }
      // Other tabs learn the same way they always have — but NOT this tab's
      // own sync handler (these records came FROM the server; re-marking
      // them dirty echoed a pointless full re-push after every pull).
      for (const [store, ids] of touched) broadcastRemote({ store, ids });
      this.cursor = batch.cursor;
      if (!batch.more) break;
    }
  }

  /** LWW-guarded landing: disk first, then memory — returns true if applied.
   *  Shared law (contracts.lwwBeats): exact ties go to the server's copy, so
   *  two replicas that stamped the same rev converge instead of diverging. */
  private async acceptRemote(change: SyncRecord): Promise<boolean> {
    if (this.accountClosureQuiesced) return false;
    const repo = this.repoOf(change.store);
    const incoming = change.record;
    const current = repo.byId().get(incoming.id);
    if (current && lwwBeats(current, incoming)) return false;
    try {
      await put(change.store, incoming);
    } catch (error) {
      if (error instanceof LocalWritesQuiescedError || this.accountClosureQuiesced) return false;
      /* memory-only session still benefits from the in-memory apply */
    }
    if (this.accountClosureQuiesced) return false;
    repo.applyExternal(incoming as never);
    // The server's copy IS our copy now — nothing left to push for this id.
    this.dirtyIds.get(change.store)?.delete(incoming.id);
    this.removePendingRef(change.store, incoming.id);
    return true;
  }

  private repoOf(store: SyncStore): RecordsRepo<SyncBase> {
    switch (store) {
      case 'trees':
        return this.trees as unknown as RecordsRepo<SyncBase>;
      case 'nodes':
        return this.nodes as unknown as RecordsRepo<SyncBase>;
      case 'checkins':
        return this.checkins as unknown as RecordsRepo<SyncBase>;
      case 'sessions':
        return this.sessions as unknown as RecordsRepo<SyncBase>;
      case 'harvests':
        return this.harvests as unknown as RecordsRepo<SyncBase>;
      case 'preserves':
        return this.preserves as unknown as RecordsRepo<SyncBase>;
    }
  }

  // ── persistence ───────────────────────────────────────────────────────────

  private async persistLink(link: AccountLinkSnapshot): Promise<void> {
    if (this.accountClosureQuiesced) return;
    this.linkSignal.set(link);
    try {
      await this.writeMeta(link);
    } catch {
      /* memory-only session */
    }
  }

  private async persistState(): Promise<void> {
    if (this.accountClosureQuiesced) return;
    try {
      await this.writeMeta({
        key: META_SYNC_STATE,
        watermark: this.watermark,
        cursor: this.cursor,
        lastSyncAt: this.lastSyncAtSignal(),
        forcePending: this.forcePending,
        dirty: Object.fromEntries(
          [...this.dirtyIds].filter(([, ids]) => ids.size).map(([store, ids]) => [store, [...ids]]),
        ),
        mutationGroups: this.memberships(),
      } satisfies SyncStateSnapshot);
    } catch {
      /* memory-only session */
    }
  }

  private async writeMeta(value: unknown): Promise<void> {
    const write = this.metaStorage.write(value);
    this.pendingMetaWrites.add(write);
    try {
      await write;
    } finally {
      this.pendingMetaWrites.delete(write);
    }
  }

  /** Practice-cloud reset (Settings): the device bookkeeping must reset WITH
   *  the cloud — a kept cursor against a reseeded feed silently skips records,
   *  and a kept link points at an account that no longer exists. */
  async forgetEverything(): Promise<void> {
    this.epoch++; // an in-flight sync must not re-persist the old cloud's cursor
    await this.disconnect();
    this.watermark = 0;
    this.cursor = '0';
    this.forcePending = false;
    this.dirtyIds.clear();
    this.pendingGroups.clear();
    this.lastSyncAtSignal.set(null);
    await this.persistState();
  }

  /** Terminal account closure only. Unlike the practice-cloud reset this must
   * not persist anything: LocalAccountDataService clears user meta atomically
   * immediately afterwards. The epoch/timers prevent an older pass from
   * recreating sync.state after that wipe. */
  async resetAfterAccountClosure(): Promise<void> {
    this.beginAccountClosureReset();
    while (this.activeSyncPasses.size || this.pendingMetaWrites.size) {
      await Promise.allSettled([...this.activeSyncPasses, ...this.pendingMetaWrites]);
    }
    this.beginAccountClosureReset();
  }

  private beginAccountClosureReset(): void {
    this.accountClosureQuiesced = true;
    this.epoch += 1;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.pushTimer = null;
    this.persistTimer = null;
    this.linkSignal.set(null);
    this.busySignal.set(false);
    this.lastErrorSignal.set(null);
    this.lastSyncAtSignal.set(null);
    this.watermark = 0;
    this.cursor = '0';
    this.forcePending = false;
    this.dirtyIds.clear();
    this.pendingGroups.clear();
  }
}
