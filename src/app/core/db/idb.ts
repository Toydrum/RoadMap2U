import { DB_NAME, DB_VERSION, LEGACY_DB_NAME, SCHEMA_VERSION } from './schema';
import { migrateForestRecords } from './migrations';
import { LocalWritesQuiescedError, runAccountClosureGuardedWrite } from './account-closure-fence';

/**
 * Minimal promise wrapper over IndexedDB — the only six operations this app
 * needs. Each operation runs in its own transaction, which designs out the
 * classic "transaction auto-committed while awaiting a foreign promise" bug:
 * there is simply no API surface to hold a transaction across awaits.
 * `putMany` performs all puts synchronously inside ONE transaction, giving
 * atomic multi-record writes (branch-on-miss depends on this).
 */

export type StoreName =
  'trees' | 'nodes' | 'checkins' | 'sessions' | 'harvests' | 'preserves' | 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;
export const ACCOUNT_CLOSURE_FENCE_KEY = 'account.closure.fence';

export interface AccountClosureFenceRow {
  key: typeof ACCOUNT_CLOSURE_FENCE_KEY;
  generation: number;
  active: boolean;
  receiptKey?: string;
}

export type DurableAccountClosureState =
  | 'requested'
  | 'purging'
  | 'purgeComplete'
  | 'completed';

export interface DurableAccountClosureSnapshot {
  key: string;
  formatVersion: 1;
  receipt: {
    closureId: string;
    state: DurableAccountClosureState;
  };
}

const connectionFenceGeneration = new WeakMap<IDBDatabase, number>();
const SAFE_ACCOUNT_CLOSURE_RECEIPT_KEY = /^account\.closure:[a-z0-9-]{1,160}$/;
const SAFE_ACCOUNT_CLOSURE_ID = /^[A-Za-z0-9:._/-]{1,256}$/;
const ACCOUNT_CLOSURE_STATE_RANK: Readonly<Record<DurableAccountClosureState, number>> =
  Object.freeze({ requested: 0, purging: 1, purgeComplete: 2, completed: 3 });

function assertAccountClosureReceiptKey(key: string): void {
  if (!SAFE_ACCOUNT_CLOSURE_RECEIPT_KEY.test(key)) {
    throw new Error('invalid account closure receipt key');
  }
}

function accountClosureFenceFrom(value: unknown): AccountClosureFenceRow {
  if (!value || typeof value !== 'object') {
    return { key: ACCOUNT_CLOSURE_FENCE_KEY, generation: 0, active: false };
  }
  const candidate = value as Record<string, unknown>;
  const receiptKey = candidate['receiptKey'];
  const active = candidate['active'];
  const canonicalReceiptKey =
    typeof receiptKey === 'string' && SAFE_ACCOUNT_CLOSURE_RECEIPT_KEY.test(receiptKey)
      ? receiptKey
      : undefined;
  return candidate['key'] === ACCOUNT_CLOSURE_FENCE_KEY &&
    Number.isSafeInteger(candidate['generation']) &&
    (candidate['generation'] as number) >= 0 &&
    typeof active === 'boolean' &&
    ((active === true && canonicalReceiptKey !== undefined) ||
      (active === false && receiptKey === undefined))
    ? {
        key: ACCOUNT_CLOSURE_FENCE_KEY,
        generation: candidate['generation'] as number,
        active,
        ...(canonicalReceiptKey ? { receiptKey: canonicalReceiptKey } : {}),
      }
    : { key: ACCOUNT_CLOSURE_FENCE_KEY, generation: 0, active: true };
}

function durableAccountClosureSnapshotFrom(
  value: unknown,
  expectedKey: string,
): DurableAccountClosureSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const receipt = candidate['receipt'];
  if (!receipt || typeof receipt !== 'object') return null;
  const receiptCandidate = receipt as Record<string, unknown>;
  const closureId = receiptCandidate['closureId'];
  const state = receiptCandidate['state'];
  return Object.keys(candidate).length === 3 &&
    candidate['key'] === expectedKey &&
    candidate['formatVersion'] === 1 &&
    Object.keys(receiptCandidate).length === 2 &&
    typeof closureId === 'string' &&
    SAFE_ACCOUNT_CLOSURE_ID.test(closureId) &&
    typeof state === 'string' &&
    Object.hasOwn(ACCOUNT_CLOSURE_STATE_RANK, state)
    ? {
        key: expectedKey,
        formatVersion: 1,
        receipt: { closureId, state: state as DurableAccountClosureState },
      }
    : null;
}

/** @internal Exported for the two-connection serialization test. */
export async function captureAccountClosureFence(db: IDBDatabase): Promise<AccountClosureFenceRow> {
  const row = accountClosureFenceFrom(
    await requestToPromise(
      db.transaction('meta', 'readonly').objectStore('meta').get(ACCOUNT_CLOSURE_FENCE_KEY),
    ),
  );
  connectionFenceGeneration.set(db, row.generation);
  return row;
}

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
      void captureAccountClosureFence(request.result)
        .then(async (fence) => {
          // A completed receipt can resume its terminal cleanup after reload,
          // but no legacy/schema routine may repopulate a fenced account.
          if (fence.active) return;
          await migrateLegacyIfNeeded(request.result);
          await migrateSchemaIfNeeded(request.result);
        })
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

/** @internal Exported for the activation-vs-open migration race test. */
export function sealMigrationInDatabase(db: IDBDatabase, how: string): Promise<void> {
  return accountClosureGuardedWriteInDatabase(db, ['meta'], (tx) => {
    tx.objectStore('meta').put({ key: MIGRATED_KEY, at: Date.now(), how });
  });
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
      await sealMigrationInDatabase(db, 'lived-in');
      return;
    }

    // Never CREATE the legacy DB just to look inside it.
    let probeCreated = false;
    if (typeof indexedDB.databases === 'function') {
      const existing = await indexedDB.databases();
      if (!existing.some((d) => d.name === LEGACY_DB_NAME)) {
        await sealMigrationInDatabase(db, 'no-legacy');
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
      if (probeCreated) await sealMigrationInDatabase(db, 'no-legacy');
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
      await accountClosureGuardedWriteInDatabase(db, ALL_STORES, (tx) => {
        for (const store of ALL_STORES) {
          const target = tx.objectStore(store);
          for (const row of rows[store] ?? []) target.put(row);
        }
        tx.objectStore('meta').put({ key: MIGRATED_KEY, at: Date.now(), how: 'copied' });
      });
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
  const fenceRequest = tx.objectStore('meta').get(ACCOUNT_CLOSURE_FENCE_KEY);
  const expectedFenceGeneration = connectionFenceGeneration.get(db);
  let planned = false;
  let planningError: unknown;

  const planWrites = () => {
    if (
      planned ||
      treesRequest.readyState !== 'done' ||
      nodesRequest.readyState !== 'done' ||
      markerRequest.readyState !== 'done' ||
      fenceRequest.readyState !== 'done'
    ) {
      return;
    }
    planned = true;
    try {
      const fence = accountClosureFenceFrom(fenceRequest.result);
      if (
        fence.active ||
        (expectedFenceGeneration !== undefined && fence.generation !== expectedFenceGeneration)
      ) {
        throw new LocalWritesQuiescedError();
      }
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
  fenceRequest.onsuccess = planWrites;

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

/** @internal Exported for the two-connection serialization test. */
export function accountClosureGuardedWriteInDatabase(
  db: IDBDatabase,
  stores: readonly StoreName[],
  plan: (tx: IDBTransaction) => void,
): Promise<void> {
  const tx = db.transaction([...new Set<StoreName>(['meta', ...stores])], 'readwrite');
  const expectedGeneration = connectionFenceGeneration.get(db);
  const fenceRequest = tx.objectStore('meta').get(ACCOUNT_CLOSURE_FENCE_KEY);
  let planningError: unknown;
  fenceRequest.onsuccess = () => {
    try {
      const fence = accountClosureFenceFrom(fenceRequest.result);
      if (
        expectedGeneration === undefined ||
        fence.active ||
        fence.generation !== expectedGeneration
      ) {
        throw new LocalWritesQuiescedError();
      }
      plan(tx);
    } catch (error) {
      planningError = error;
      tx.abort();
    }
  };
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(planningError ?? tx.error);
    tx.onabort = () =>
      reject(planningError ?? tx.error ?? new Error('account-closure guarded write aborted'));
  });
}

function unguardedDeleteInDatabase(db: IDBDatabase, store: StoreName, key: string): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return txDone(tx);
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

/**
 * Durable cross-tab serialization point for terminal account cleanup. Every
 * normal user write takes a readwrite lock on `meta` and checks this row in
 * the same transaction as its mutation. IndexedDB therefore orders writes
 * which began before the fence ahead of it and rejects every later/stale-tab
 * write before it can touch a data store.
 */
export async function activateAccountClosureFence(receiptKey: string): Promise<void> {
  return activateAccountClosureFenceInDatabase(await openDb(), receiptKey);
}

/**
 * Monotonic receipt CAS. Advancing to `completed` and raising the durable
 * generation fence are the same IndexedDB transaction, so no sibling tab can
 * land a pending response or user write in between those facts.
 */
export async function commitAccountClosureSnapshot(
  snapshot: DurableAccountClosureSnapshot,
): Promise<DurableAccountClosureSnapshot> {
  return commitAccountClosureSnapshotInDatabase(await openDb(), snapshot);
}

/** @internal Exported for deterministic two-connection race tests. */
export function commitAccountClosureSnapshotInDatabase(
  db: IDBDatabase,
  snapshot: DurableAccountClosureSnapshot,
): Promise<DurableAccountClosureSnapshot> {
  assertAccountClosureReceiptKey(snapshot.key);
  const incoming = durableAccountClosureSnapshotFrom(snapshot, snapshot.key);
  if (!incoming) return Promise.reject(new Error('invalid account closure snapshot'));

  const expectedGeneration = connectionFenceGeneration.get(db);
  const tx = db.transaction('meta', 'readwrite');
  const store = tx.objectStore('meta');
  const receiptRequest = store.get(incoming.key);
  const fenceRequest = store.get(ACCOUNT_CLOSURE_FENCE_KEY);
  let canonical: DurableAccountClosureSnapshot | null = null;
  let activatedGeneration: number | null = null;
  let planningError: unknown;
  let planned = false;

  const plan = () => {
    if (
      planned ||
      receiptRequest.readyState !== 'done' ||
      fenceRequest.readyState !== 'done'
    ) {
      return;
    }
    planned = true;
    try {
      const stored = durableAccountClosureSnapshotFrom(receiptRequest.result, incoming.key);
      if (receiptRequest.result !== undefined && !stored) {
        throw new Error('stored account closure snapshot is invalid');
      }
      if (stored && stored.receipt.closureId !== incoming.receipt.closureId) {
        throw new Error('account closure receipt changed identity');
      }
      canonical =
        stored &&
        ACCOUNT_CLOSURE_STATE_RANK[stored.receipt.state] >=
          ACCOUNT_CLOSURE_STATE_RANK[incoming.receipt.state]
          ? stored
          : incoming;

      const fence = accountClosureFenceFrom(fenceRequest.result);
      if (canonical.receipt.state === 'completed') {
        if (fence.active) {
          if (fence.receiptKey !== incoming.key) throw new LocalWritesQuiescedError();
          // Privileged monotonic completion is safe even for a connection
          // whose ordinary write generation is now stale.
          if (!stored || stored.receipt.state !== 'completed') store.put(canonical);
          return;
        }
        if (
          expectedGeneration === undefined ||
          fence.generation !== expectedGeneration
        ) {
          throw new LocalWritesQuiescedError();
        }
        const nextFence: AccountClosureFenceRow = {
          key: ACCOUNT_CLOSURE_FENCE_KEY,
          generation: fence.generation + 1,
          active: true,
          receiptKey: incoming.key,
        };
        store.put(canonical);
        store.put(nextFence);
        activatedGeneration = nextFence.generation;
        return;
      }

      if (
        expectedGeneration === undefined ||
        fence.active ||
        fence.generation !== expectedGeneration
      ) {
        throw new LocalWritesQuiescedError();
      }
      if (
        !stored ||
        ACCOUNT_CLOSURE_STATE_RANK[canonical.receipt.state] >
          ACCOUNT_CLOSURE_STATE_RANK[stored.receipt.state]
      ) {
        store.put(canonical);
      }
    } catch (error) {
      planningError = error;
      tx.abort();
    }
  };

  receiptRequest.onsuccess = plan;
  fenceRequest.onsuccess = plan;
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      if (!canonical) {
        reject(new Error('account closure snapshot was not committed'));
        return;
      }
      if (activatedGeneration !== null) {
        connectionFenceGeneration.set(db, activatedGeneration);
      }
      resolve(structuredClone(canonical));
    };
    tx.onerror = () => reject(planningError ?? tx.error);
    tx.onabort = () =>
      reject(planningError ?? tx.error ?? new Error('account closure snapshot commit aborted'));
  });
}

/** @internal Exported for the two-connection serialization test. */
export async function activateAccountClosureFenceInDatabase(
  db: IDBDatabase,
  receiptKey: string,
): Promise<void> {
  assertAccountClosureReceiptKey(receiptKey);
  const expectedGeneration = connectionFenceGeneration.get(db);
  const tx = db.transaction('meta', 'readwrite');
  const request = tx.objectStore('meta').get(ACCOUNT_CLOSURE_FENCE_KEY);
  let next: AccountClosureFenceRow | null = null;
  let nextGeneration = -1;
  let planningError: unknown;
  request.onsuccess = () => {
    try {
      const current = accountClosureFenceFrom(request.result);
      if (expectedGeneration === undefined || current.generation !== expectedGeneration) {
        throw new LocalWritesQuiescedError();
      }
      next = current.active
        ? current.receiptKey === receiptKey
          ? current
          : (() => {
              throw new LocalWritesQuiescedError();
            })()
        : {
            key: ACCOUNT_CLOSURE_FENCE_KEY,
            generation: current.generation + 1,
            active: true,
            receiptKey,
          };
      tx.objectStore('meta').put(next);
      nextGeneration = next.generation;
    } catch (error) {
      planningError = error;
      tx.abort();
    }
  };
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(planningError ?? tx.error);
    tx.onabort = () =>
      reject(planningError ?? tx.error ?? new Error('account closure fence activation aborted'));
  });
  if (!next || nextGeneration < 0) throw new Error('account closure fence was not activated');
  connectionFenceGeneration.set(db, nextGeneration);
}

export async function activeAccountClosureReceiptKey(): Promise<string | null> {
  const fence = accountClosureFenceFrom(await get<unknown>('meta', ACCOUNT_CLOSURE_FENCE_KEY));
  return fence.active && fence.receiptKey ? fence.receiptKey : null;
}

/** Exact privileged delete used by AuthService.signOut while the fence is active. */
export async function deleteAuthIdentitySnapshot(): Promise<void> {
  return deleteAuthIdentitySnapshotInDatabase(await openDb());
}

/** @internal Exact privileged seam for terminal-finalization tests. */
export async function deleteAuthIdentitySnapshotInDatabase(db: IDBDatabase): Promise<void> {
  return unguardedDeleteInDatabase(db, 'meta', 'auth.identity');
}

/** Receipt delete + fence release are one final transaction after sign-out. */
export async function finalizeAccountClosureFence(receiptKey: string): Promise<void> {
  return finalizeAccountClosureFenceInDatabase(await openDb(), receiptKey);
}

/** @internal Exported for the two-connection serialization test. */
export async function finalizeAccountClosureFenceInDatabase(
  db: IDBDatabase,
  receiptKey: string,
): Promise<void> {
  assertAccountClosureReceiptKey(receiptKey);
  const expectedGeneration = connectionFenceGeneration.get(db);
  const tx = db.transaction('meta', 'readwrite');
  const request = tx.objectStore('meta').get(ACCOUNT_CLOSURE_FENCE_KEY);
  const identityRequest = tx.objectStore('meta').get('auth.identity');
  let released: AccountClosureFenceRow | null = null;
  let releasedGeneration = -1;
  let planningError: unknown;
  let planned = false;
  const plan = () => {
    if (planned || request.readyState !== 'done' || identityRequest.readyState !== 'done') {
      return;
    }
    planned = true;
    try {
      const current = accountClosureFenceFrom(request.result);
      if (expectedGeneration === undefined || current.generation !== expectedGeneration) {
        throw new LocalWritesQuiescedError();
      }
      if (!current.active || current.receiptKey !== receiptKey) {
        throw new LocalWritesQuiescedError();
      }
      if (identityRequest.result !== undefined) {
        throw new Error('account identity remains after sign-out');
      }
      released = {
        key: ACCOUNT_CLOSURE_FENCE_KEY,
        generation: current.generation + 1,
        active: false,
      };
      tx.objectStore('meta').delete(receiptKey);
      tx.objectStore('meta').put(released);
      releasedGeneration = released.generation;
    } catch (error) {
      planningError = error;
      tx.abort();
    }
  };
  request.onsuccess = plan;
  identityRequest.onsuccess = plan;
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(planningError ?? tx.error);
    tx.onabort = () =>
      reject(planningError ?? tx.error ?? new Error('account closure finalization aborted'));
  });
  if (!released || releasedGeneration < 0)
    throw new Error('account closure fence was not released');
  connectionFenceGeneration.set(db, releasedGeneration);
}

export async function put<T>(store: StoreName, value: T): Promise<void> {
  return runAccountClosureGuardedWrite([{ store, value }], async () => {
    const db = await openDb();
    return accountClosureGuardedWriteInDatabase(db, [store], (tx) => {
      tx.objectStore(store).put(value);
    });
  });
}

/** All puts issued synchronously inside one transaction — atomic. */
export async function putMany<T>(store: StoreName, values: T[]): Promise<void> {
  if (!values.length) return;
  return runAccountClosureGuardedWrite(
    values.map((value) => ({ store, value })),
    async () => {
      const db = await openDb();
      return accountClosureGuardedWriteInDatabase(db, [store], (tx) => {
        const objectStore = tx.objectStore(store);
        for (const value of values) objectStore.put(value);
      });
    },
  );
}

/** Atomic writes ACROSS stores in ONE transaction — the conservería seal
 *  (a batch row + its members' home-stamps must land together or not at
 *  all). The multi-store transaction precedent is the legacy-copy loop. */
/** «El reemplazo» (0.0.115 audit M1): wipe + rewrite several stores in ONE
 *  readwrite transaction — an import must never be able to die between the
 *  clear and the puts (separate transactions left an EMPTY disk if a later
 *  putMany failed: quota, closed DB, tab crash). */
export async function replaceAll(entries: { store: StoreName; rows: unknown[] }[]): Promise<void> {
  if (!entries.length) return;
  return runAccountClosureGuardedWrite(
    entries.flatMap((entry) =>
      entry.rows.length
        ? entry.rows.map((value) => ({ store: entry.store, value }))
        : [{ store: entry.store, value: { operation: 'clear' } }],
    ),
    async () => {
      const db = await openDb();
      return accountClosureGuardedWriteInDatabase(
        db,
        entries.map((entry) => entry.store),
        (tx) => planReplaceAll(tx, entries),
      );
    },
  );
}

/** Terminal account cleanup only: the caller established/drained the fence. */
export async function replaceAllForAccountClosure(
  entries: { store: StoreName; rows: unknown[] }[],
): Promise<void> {
  if (!entries.length) return;
  const db = await openDb();
  const expectedGeneration = connectionFenceGeneration.get(db);
  const stores = [...new Set<StoreName>(['meta', ...entries.map((entry) => entry.store)])];
  const tx = db.transaction(stores, 'readwrite');
  const fenceRequest = tx.objectStore('meta').get(ACCOUNT_CLOSURE_FENCE_KEY);
  let planningError: unknown;
  fenceRequest.onsuccess = () => {
    try {
      const fence = accountClosureFenceFrom(fenceRequest.result);
      if (
        !fence.active ||
        expectedGeneration === undefined ||
        fence.generation !== expectedGeneration
      ) {
        throw new LocalWritesQuiescedError();
      }
      const normalized = entries.map((entry) =>
        entry.store === 'meta'
          ? {
              ...entry,
              rows: [
                ...entry.rows.filter(
                  (row) =>
                    !row ||
                    typeof row !== 'object' ||
                    (row as Record<string, unknown>)['key'] !== ACCOUNT_CLOSURE_FENCE_KEY,
                ),
                fence,
              ],
            }
          : entry,
      );
      if (!normalized.some((entry) => entry.store === 'meta')) {
        normalized.push({ store: 'meta', rows: [fence] });
      }
      planReplaceAll(tx, normalized);
    } catch (error) {
      planningError = error;
      tx.abort();
    }
  };
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(planningError ?? tx.error);
    tx.onabort = () =>
      reject(planningError ?? tx.error ?? new Error('account closure replacement aborted'));
  });
}

/** @internal The import transaction seam, exported for atomic-failure tests. */
export function replaceAllInDatabase(
  db: IDBDatabase,
  entries: { store: StoreName; rows: unknown[] }[],
): Promise<void> {
  if (!entries.length) return Promise.resolve();
  const tx = db.transaction([...new Set(entries.map((e) => e.store))], 'readwrite');
  try {
    planReplaceAll(tx, entries);
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

function planReplaceAll(
  tx: IDBTransaction,
  entries: readonly { store: StoreName; rows: readonly unknown[] }[],
): void {
  for (const entry of entries) {
    const os = tx.objectStore(entry.store);
    os.clear();
    for (const row of entry.rows) os.put(row);
  }
}

/** Demo-only conditional replacement. The emptiness check and every write
 * share one transaction, so another tab cannot slip real data between a
 * preflight and the showcase commit. `false` means a lived-in store won. */
export async function replaceAllIfEmpty(
  entries: { store: StoreName; rows: unknown[] }[],
): Promise<boolean> {
  if (!entries.length) return true;
  return runAccountClosureGuardedWrite(
    entries.flatMap((entry) =>
      entry.rows.length
        ? entry.rows.map((value) => ({ store: entry.store, value }))
        : [{ store: entry.store, value: { operation: 'clear-if-empty' } }],
    ),
    async () => replaceAllIfEmptyGuardedInDatabase(await openDb(), entries),
  );
}

function replaceAllIfEmptyGuardedInDatabase(
  db: IDBDatabase,
  entries: { store: StoreName; rows: unknown[] }[],
): Promise<boolean> {
  const stores = [...new Set<StoreName>(['meta', ...entries.map((entry) => entry.store)])];
  const tx = db.transaction(stores, 'readwrite');
  const expectedGeneration = connectionFenceGeneration.get(db);
  const fenceRequest = tx.objectStore('meta').get(ACCOUNT_CLOSURE_FENCE_KEY);
  const counts = [...new Set(entries.map((entry) => entry.store))].map((store) =>
    tx.objectStore(store).count(),
  );
  let planned = false;
  let occupied = false;
  let planningError: unknown;
  const plan = () => {
    if (
      planned ||
      fenceRequest.readyState !== 'done' ||
      counts.some((request) => request.readyState !== 'done')
    ) {
      return;
    }
    planned = true;
    try {
      const fence = accountClosureFenceFrom(fenceRequest.result);
      if (
        expectedGeneration === undefined ||
        fence.active ||
        fence.generation !== expectedGeneration
      ) {
        throw new LocalWritesQuiescedError();
      }
      occupied = counts.some((request) => request.result > 0);
      if (!occupied) planReplaceAll(tx, entries);
    } catch (error) {
      planningError = error;
      tx.abort();
    }
  };
  fenceRequest.onsuccess = plan;
  for (const request of counts) request.onsuccess = plan;
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(!occupied);
    tx.onerror = () => reject(planningError ?? tx.error);
    tx.onabort = () =>
      reject(planningError ?? tx.error ?? new Error('conditional replacement aborted'));
  });
}

/** @internal IndexedDB transaction seam for the concurrent-empty test. */
export function replaceAllIfEmptyInDatabase(
  db: IDBDatabase,
  entries: { store: StoreName; rows: unknown[] }[],
): Promise<boolean> {
  if (!entries.length) return Promise.resolve(true);
  const stores = [...new Set(entries.map((entry) => entry.store))];
  const tx = db.transaction(stores, 'readwrite');
  const counts = stores.map((store) => tx.objectStore(store).count());
  let planned = false;
  let occupied = false;
  let planningError: unknown;

  const planWrites = () => {
    if (planned || counts.some((request) => request.readyState !== 'done')) return;
    planned = true;
    occupied = counts.some((request) => request.result > 0);
    if (occupied) return;
    try {
      for (const entry of entries) {
        const objectStore = tx.objectStore(entry.store);
        objectStore.clear();
        for (const row of entry.rows) objectStore.put(row);
      }
    } catch (error) {
      planningError = error;
      tx.abort();
    }
  };

  for (const request of counts) request.onsuccess = planWrites;
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(!occupied);
    tx.onerror = () => reject(planningError ?? tx.error);
    tx.onabort = () =>
      reject(planningError ?? tx.error ?? new Error('conditional replacement aborted'));
  });
}

export async function putAcross(entries: { store: StoreName; rows: unknown[] }[]): Promise<void> {
  const nonEmpty = entries.filter((e) => e.rows.length);
  if (!nonEmpty.length) return;
  return runAccountClosureGuardedWrite(
    nonEmpty.flatMap((entry) => entry.rows.map((value) => ({ store: entry.store, value }))),
    async () => {
      const db = await openDb();
      return accountClosureGuardedWriteInDatabase(
        db,
        nonEmpty.map((entry) => entry.store),
        (tx) => planPutAcross(tx, nonEmpty),
      );
    },
  );
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
    planPutAcross(tx, nonEmpty);
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

function planPutAcross(
  tx: IDBTransaction,
  entries: readonly { store: StoreName; rows: readonly unknown[] }[],
): void {
  for (const entry of entries) {
    const objectStore = tx.objectStore(entry.store);
    for (const row of entry.rows) objectStore.put(row);
  }
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
  return runAccountClosureGuardedWrite([{ store, value: { key } }], async () => {
    const db = await openDb();
    return accountClosureGuardedWriteInDatabase(db, [store], (tx) => {
      tx.objectStore(store).delete(key);
    });
  });
}

/** Import-replace only. */
export async function clear(store: StoreName): Promise<void> {
  return runAccountClosureGuardedWrite([{ store, value: { operation: 'clear' } }], async () => {
    const db = await openDb();
    return accountClosureGuardedWriteInDatabase(db, [store], (tx) => {
      tx.objectStore(store).clear();
    });
  });
}
