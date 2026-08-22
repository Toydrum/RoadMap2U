import { InjectionToken, computed, inject, signal } from '@angular/core';
import { lwwBeats } from '../api/contracts';
import { SyncBase, stamp } from '../db/schema';
import { StoreName, get, getAll, put, putMany } from '../db/idb';
import { broadcastChange } from '../db/broadcast';
import { LocalWritesQuiescedError } from '../db/account-closure-fence';
import {
  canPublishAccountClosureRead,
  captureAccountClosureReadEpoch,
} from '../db/account-closure-fence';

export interface RecordsStorage {
  read(store: StoreName, id: string): Promise<unknown>;
  readAll(store: StoreName): Promise<unknown[]>;
  write(store: StoreName, value: unknown): Promise<void>;
  writeMany(store: StoreName, values: unknown[]): Promise<void>;
}

export const RECORDS_STORAGE = new InjectionToken<RecordsStorage>('RECORDS_STORAGE', {
  providedIn: 'root',
  factory: () => ({
    read: (store, id) => get(store, id),
    readAll: (store) => getAll(store),
    write: (store, value) => put(store, value),
    writeMany: (store, values) => putMany(store, values),
  }),
});

/**
 * Base signal repository: load-once into a Map signal, write-through on
 * mutation (disk first, then memory — IDB puts are ~1 ms, and the ordering
 * removes the "memory says X, disk says Y" bug class entirely).
 */
export abstract class RecordsRepo<T extends SyncBase> {
  protected abstract readonly store: StoreName;
  private readonly storage = inject(RECORDS_STORAGE);

  private readonly records = signal<ReadonlyMap<string, T>>(new Map());

  /** Live records — tombstones filtered here and nowhere else. */
  readonly all = computed(() => [...this.records().values()].filter((r) => !r.deletedAt));

  readonly byId = computed(() => this.records());

  async load(): Promise<void> {
    const readEpoch = captureAccountClosureReadEpoch();
    try {
      const rows = (await this.storage.readAll(this.store)) as T[];
      if (!canPublishAccountClosureRead(readEpoch)) return;
      this.records.set(new Map(rows.map((r) => [r.id, r])));
    } catch {
      if (!canPublishAccountClosureRead(readEpoch)) return;
      // Storage unavailable — start empty, run the session in memory.
      this.records.set(new Map());
    }
  }

  /** Persist a new or updated record (stamps rev/updatedAt). */
  async save(record: T): Promise<T> {
    const stamped = stamp(record);
    await this.persist(() => this.storage.write(this.store, stamped));
    this.applyLocal(stamped);
    broadcastChange({ store: this.store, ids: [stamped.id] });
    return stamped;
  }

  /** Persist a brand-new record as-is (already carries rev 1). */
  async insert(record: T): Promise<T> {
    await this.persist(() => this.storage.write(this.store, record));
    this.applyLocal(record);
    broadcastChange({ store: this.store, ids: [record.id] });
    return record;
  }

  /** Atomic multi-record write (single IDB transaction). */
  async saveMany(records: T[]): Promise<void> {
    await this.persist(() => this.storage.writeMany(this.store, records));
    for (const record of records) this.applyLocal(record);
    broadcastChange({ store: this.store, ids: records.map((r) => r.id) });
  }

  /** Disk first; if storage is unavailable, keep working in memory. */
  private async persist(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      if (error instanceof LocalWritesQuiescedError) throw error;
      /* memory-only session */
    }
  }

  /** Sync tombstone — the record stays forever, filtered from `all`. */
  async tombstone(record: T): Promise<void> {
    await this.save({ ...record, deletedAt: Date.now() });
  }

  /** Undo of a user "let go" — lifts the tombstone with a fresh stamp.
   *  Re-reads the live record so the restore's rev moves PAST the tombstone
   *  write (never re-save a captured pre-action record: stale rev loses LWW). */
  async revive(record: T): Promise<void> {
    const current = this.records().get(record.id) ?? record;
    if (current.deletedAt === null) return;
    await this.save({ ...current, deletedAt: null });
  }

  /** Re-read specific ids from disk and apply if newer (cross-tab / future sync). */
  async refreshFromDisk(ids: string[]): Promise<void> {
    const readEpoch = captureAccountClosureReadEpoch();
    for (const id of ids) {
      const fresh = (await this.storage.read(this.store, id)) as T | undefined;
      if (!canPublishAccountClosureRead(readEpoch)) return;
      if (fresh) {
        this.applyExternal(fresh);
      } else {
        // Gone from disk (an import-replace dropped it): a copy kept in
        // this tab's memory would resurrect it on the next save.
        this.records.update((map) => {
          if (!map.has(id)) return map;
          const next = new Map(map);
          next.delete(id);
          return next;
        });
      }
    }
  }

  /** Accept an externally-produced record unless ours strictly beats it
   *  (shared LWW law). Exact ties land the incoming copy: external records
   *  are server/disk truth, and the contract gives ties to the server. */
  applyExternal(record: T): void {
    const current = this.records().get(record.id);
    if (current && lwwBeats(current, record)) return;
    this.applyLocal(record);
  }

  /** Replace the whole in-memory set (import-replace path). */
  resetTo(records: T[]): void {
    this.records.set(new Map(records.map((r) => [r.id, r])));
  }

  protected applyLocal(record: T): void {
    this.records.update((map) => {
      const next = new Map(map);
      next.set(record.id, record);
      return next;
    });
  }
}
