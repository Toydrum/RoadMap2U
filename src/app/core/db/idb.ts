import { DB_NAME, DB_VERSION, LEGACY_DB_NAME, SCHEMA_VERSION } from './schema';
import { migrateForestRecords } from './migrations';

/**
 * Minimal promise wrapper over IndexedDB — the only six operations this app
 * needs. Each operation runs in its own transaction, which designs out the
 * classic "transaction auto-committed while awaiting a foreign promise" bug:
 * there is simply no API surface to hold a transaction across awaits.
 * `putMany` performs all puts synchronously inside ONE transaction, giving
 * atomic multi-record writes (branch-on-miss depends on this).
 */

export type StoreName =
  | 'trees'
  | 'nodes'
  | 'checkins'
  | 'sessions'
  | 'harvests'
  | 'preserves'
  | 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * If IndexedDB never answers (restricted/private contexts), we refuse to hang
 * the whole app: openDb rejects after a short grace period and the app runs
 * in memory-only mode for the session (repos catch and degrade gracefully).
 */
const OPEN_TIMEOUT_MS = 3000;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const giveUp = setTimeout(
      () => reject(new Error('IndexedDB unavailable (open timed out)')),
      OPEN_TIMEOUT_MS,
    );
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener('success', () => clearTimeout(giveUp));
    request.addEventListener('error', () => clearTimeout(giveUp));

    request.onupgradeneeded = () => {
      // Structural upgrades ONLY (stores/indexes). Data-shape migrations run
      // after open, driven by meta.schemaVersion — see migrations.ts.
      const db = request.result;
      if (!db.objectStoreNames.contains('trees')) {
        db.createObjectStore('trees', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('nodes')) {
        const nodes = db.createObjectStore('nodes', { keyPath: 'id' });
        nodes.createIndex('byTree', 'treeId');
      }
      if (!db.objectStoreNames.contains('checkins')) {
        const checkins = db.createObjectStore('checkins', { keyPath: 'id' });
        checkins.createIndex('byCreatedAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('byCreatedAt', 'createdAt');
      }
      // v2 (DB_VERSION): «la cosecha» — the contains() guards make this a
      // pure add on lived-in devices.
      if (!db.objectStoreNames.contains('harvests')) {
        const harvests = db.createObjectStore('harvests', { keyPath: 'id' });
        harvests.createIndex('byHarvestedAt', 'harvestedAt');
      }
      // v3: «la conservería» — sealed jam batches.
      if (!db.objectStoreNames.contains('preserves')) {
        const preserves = db.createObjectStore('preserves', { keyPath: 'id' });
        preserves.createIndex('byMadeAt', 'madeAt');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      // One-time adoption of the pre-rename database (see schema.ts naming
      // note): copy, never move — the legacy DB stays as a safety net.
      void migrateLegacyIfNeeded(request.result)
        .then(() => migrateSchemaIfNeeded(request.result))
        .then(
          () => resolve(request.result),
          (error: unknown) => {
            request.result.close();
            reject(error);
          },
        );
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  });
  return dbPromise;
}

const ALL_STORES: StoreName[] = [
  'trees',
  'nodes',
  'checkins',
  'sessions',
  'harvests',
  'preserves',
  'meta',
];

/** Meta sentinel: present ⇔ the legacy question is settled for this device. */
const MIGRATED_KEY = 'legacy.migratedAt';
/** Data-shape marker; independent from IndexedDB's structural version. */
const SCHEMA_VERSION_KEY = 'schema.version';

function sealMigration(db: IDBDatabase, how: string): Promise<void> {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key: MIGRATED_KEY, at: Date.now(), how });
  return txDone(tx);
}

/**
 * If this (new-name) DB is empty and the pre-rename DB exists with data,
 * copy every store across once. Copied rows and the sentinel land in ONE
 * transaction, so a partial migration cannot exist: either everything landed
 * (sentinel present) or nothing did and the copy retries next boot.
 * Fail-open: any hiccup leaves the app running on the new DB, and the
 * untouched legacy DB stays as the safety net.
 */
async function migrateLegacyIfNeeded(db: IDBDatabase): Promise<void> {
  try {
    const marker = await requestToPromise(
      db.transaction('meta', 'readonly').objectStore('meta').get(MIGRATED_KEY),
    );
    if (marker) return;

    const treeCount = await requestToPromise(
      db.transaction('trees', 'readonly').objectStore('trees').count(),
    );
    const metaCount = await requestToPromise(
      db.transaction('meta', 'readonly').objectStore('meta').count(),
    );
    if (treeCount > 0 || metaCount > 0) {
      // Lived-in from before the sentinel existed (or simply a fresh device
      // that already wrote data) — never copy OVER it; just settle the question.
      await sealMigration(db, 'lived-in');
      return;
    }

    // Never CREATE the legacy DB just to look inside it.
    let probeCreated = false;
    if (typeof indexedDB.databases === 'function') {
      const existing = await indexedDB.databases();
      if (!existing.some((d) => d.name === LEGACY_DB_NAME)) {
        await sealMigration(db, 'no-legacy');
        return;
      }
    }
    const legacy = await new Promise<IDBDatabase | null>((resolve) => {
      const open = indexedDB.open(LEGACY_DB_NAME);
      open.onupgradeneeded = () => {
        // Firing means the DB did not exist (browsers without databases(),
        // e.g. Firefox) — abort the versionchange so no phantom DB is left.
        probeCreated = true;
        open.transaction?.abort();
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
    });
    if (!legacy) {
      // Settled only when we KNOW there is nothing to migrate; a transient
      // open error on a real legacy DB must retry next boot.
      if (probeCreated) await sealMigration(db, 'no-legacy');
      return;
    }
    try {
      const rows: Partial<Record<StoreName, unknown[]>> = {};
      for (const store of ALL_STORES) {
        if (!legacy.objectStoreNames.contains(store)) continue;
        rows[store] = await requestToPromise<unknown[]>(
          legacy.transaction(store, 'readonly').objectStore(store).getAll(),
        );
      }
      const tx = db.transaction(ALL_STORES, 'readwrite');
      for (const store of ALL_STORES) {
        const target = tx.objectStore(store);
        for (const row of rows[store] ?? []) target.put(row);
      }
      tx.objectStore('meta').put({ key: MIGRATED_KEY, at: Date.now(), how: 'copied' });
      await txDone(tx);
    } finally {
      legacy.close();
    }
  } catch {
    // Empty start beats a blocked boot; the legacy copy is still intact.
  }
}

/**
 * Upgrade lived-in data after the database is open. Reads, deterministic
 * v12->v13 heart assignment, tree writes and the version marker share ONE
 * readwrite transaction; a tab crash can leave neither a partial forest nor
 * a falsely-advanced marker. Nodes are read for selection and never rewritten.
 *
 * A missing marker means v12: all earlier schema changes were additive and
 * existing databases predate this first data-migration marker. A future or
 * malformed marker aborts the transaction and fails closed.
 */
/** @internal Exported for deterministic transaction-boundary tests. */
export function migrateSchemaIfNeeded(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(['trees', 'nodes', 'meta'], 'readwrite');
  const treesRequest = tx.objectStore('trees').getAll();
  const nodesRequest = tx.objectStore('nodes').getAll();
  const markerRequest = tx.objectStore('meta').get(SCHEMA_VERSION_KEY);
  let planned = false;
  let planningError: unknown;

  const planWrites = () => {
    if (
      planned ||
      treesRequest.readyState !== 'done' ||
      nodesRequest.readyState !== 'done' ||
      markerRequest.readyState !== 'done'
    ) {
      return;
    }
    planned = true;
    try {
      const marker = markerRequest.result as { version?: unknown } | undefined;
      const fromVersion = marker === undefined ? 12 : marker.version;
      const migrated = migrateForestRecords(
        { trees: treesRequest.result, nodes: nodesRequest.result },
        fromVersion,
      );
      if (fromVersion !== SCHEMA_VERSION) {
        const trees = tx.objectStore('trees');
        for (const tree of migrated.trees) trees.put(tree);
      }
      tx.objectStore('meta').put({ key: SCHEMA_VERSION_KEY, version: SCHEMA_VERSION });
    } catch (error) {
      planningError = error;
      tx.abort();
    }
  };

  treesRequest.onsuccess = planWrites;
  nodesRequest.onsuccess = planWrites;
  markerRequest.onsuccess = planWrites;

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(planningError ?? tx.error);
    tx.onabort = () => reject(planningError ?? tx.error ?? new Error('schema migration aborted'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

/** True once openDb has definitively failed — the session is memory-only. */
export async function storageAvailable(): Promise<boolean> {
  try {
    await openDb();
    return true;
  } catch {
    return false;
  }
}

export async function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openDb();
  return requestToPromise(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return requestToPromise(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function put<T>(store: StoreName, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return txDone(tx);
}

/** All puts issued synchronously inside one transaction — atomic. */
export async function putMany<T>(store: StoreName, values: T[]): Promise<void> {
  if (!values.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const objectStore = tx.objectStore(store);
  for (const value of values) objectStore.put(value);
  return txDone(tx);
}

/** Atomic writes ACROSS stores in ONE transaction — the conservería seal
 *  (a batch row + its members' home-stamps must land together or not at
 *  all). The multi-store transaction precedent is the legacy-copy loop. */
/** «El reemplazo» (0.0.115 audit M1): wipe + rewrite several stores in ONE
 *  readwrite transaction — an import must never be able to die between the
 *  clear and the puts (separate transactions left an EMPTY disk if a later
 *  putMany failed: quota, closed DB, tab crash). */
export async function replaceAll(
  entries: { store: StoreName; rows: unknown[] }[],
): Promise<void> {
  if (!entries.length) return;
  const db = await openDb();
  return replaceAllInDatabase(db, entries);
}

/** @internal The import transaction seam, exported for atomic-failure tests. */
export function replaceAllInDatabase(
  db: IDBDatabase,
  entries: { store: StoreName; rows: unknown[] }[],
): Promise<void> {
  if (!entries.length) return Promise.resolve();
  const tx = db.transaction([...new Set(entries.map((e) => e.store))], 'readwrite');
  try {
    for (const entry of entries) {
      const os = tx.objectStore(entry.store);
      os.clear();
      for (const row of entry.rows) os.put(row);
    }
  } catch (error) {
    // A synchronous key/clone error does not automatically abort IndexedDB;
    // without this, earlier clears in the same call could still commit.
    try {
      tx.abort();
    } catch {
      // Already inactive/aborted: the original write error is authoritative.
    }
    return Promise.reject(error);
  }
  return txDone(tx);
}

export async function putAcross(
  entries: { store: StoreName; rows: unknown[] }[],
): Promise<void> {
  const nonEmpty = entries.filter((e) => e.rows.length);
  if (!nonEmpty.length) return;
  const db = await openDb();
  return putAcrossInDatabase(db, nonEmpty);
}

/** @internal Cross-store transaction seam, exported for atomic-failure tests. */
export function putAcrossInDatabase(
  db: IDBDatabase,
  entries: { store: StoreName; rows: unknown[] }[],
): Promise<void> {
  const nonEmpty = entries.filter((entry) => entry.rows.length);
  if (!nonEmpty.length) return Promise.resolve();
  const tx = db.transaction([...new Set(nonEmpty.map((entry) => entry.store))], 'readwrite');
  try {
    for (const entry of nonEmpty) {
      const objectStore = tx.objectStore(entry.store);
      for (const row of entry.rows) objectStore.put(row);
    }
  } catch (error) {
    // A synchronous key/clone error does not promise to abort the rest of
    // the transaction. Explicitly abort so an earlier store can never land
    // without the later one (tree + technical heart depend on this).
    try {
      tx.abort();
    } catch {
      // Already inactive/aborted: the original write error is authoritative.
    }
    return Promise.reject(error);
  }
  return txDone(tx);
}

/**
 * Local-first cross-store commit. A database that never opened means this
 * session is deliberately memory-only, so callers may still publish their
 * in-memory state. Once IndexedDB is open, any transaction failure remains
 * authoritative and must be surfaced — it is never mistaken for a commit.
 */
export async function putAcrossOrMemory(
  entries: { store: StoreName; rows: unknown[] }[],
): Promise<void> {
  try {
    await putAcross(entries);
  } catch (error) {
    if (await storageAvailable()) throw error;
  }
}

/** Remove one row (meta cleanup: cache invalidation, practice-cloud reset). */
export async function del(store: StoreName, key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return txDone(tx);
}

/** Import-replace only. */
export async function clear(store: StoreName): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  return txDone(tx);
}
