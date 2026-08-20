import { CheckIn, Harvest, Preserve, Tree, TreeNode, TimerSession } from '../db/schema';
import { GuardianLinkKind, SyncRecord, SyncStore, UserProfile, lwwBeats } from './contracts';

/**
 * The simulated cloud — a SEPARATE IndexedDB database standing in for
 * Cognito + DynamoDB until AWS exists. Deliberately not the app DB: no
 * DB_VERSION coupling, invisible to backups, and "Restablecer la nube de
 * prueba" can wipe it without touching anyone's forest. Seeded on first open
 * with the demo family (mock-seed.ts). Everything in here is device-local;
 * the app treats it exactly like a remote backend behind the seams.
 */

// Renamed with the app (2026-07-06) WITHOUT migration by design: this is the
// practice cloud — it reseeds the demo family on first open, and Settings has
// a reset button for exactly this kind of fresh start.
export const MOCK_DB_NAME = 'roadmap2u-mockcloud';
const MOCK_DB_VERSION = 1;

export type MockStore =
  | 'users'
  | 'credentials'
  | 'guardianLinks'
  | 'friendships'
  | 'friendRequests'
  | 'codes'
  | 'records'
  | 'kv';

/** Cloud-side user row — profile plus the private email attribute. */
export interface MockUserRow extends UserProfile {
  email: string | null;
}

export interface MockCredentialRow {
  username: string;
  userId: string;
  password: string;
  /** Guardian-created minors sign in with a temp password first. */
  mustChangePassword: boolean;
  /** Self-signup not yet confirmed with the (always-123456) code. */
  pendingConfirm: boolean;
}

export interface MockGuardianLinkRow {
  linkId: string;
  guardianId: string;
  minorId: string;
  kind: GuardianLinkKind;
  createdAt: number;
}

export interface MockFriendshipRow {
  friendshipId: string;
  userA: string;
  userB: string;
  createdAt: number;
}

export interface MockFriendRequestRow {
  requestId: string;
  fromId: string;
  toId: string;
  createdAt: number;
  expiresAt: number;
}

export interface MockCodeRow {
  code: string;
  kind: 'friend' | 'coGuardian' | 'linkExisting';
  userId: string;
  minorId: string | null;
  expiresAt: number;
}

/** A user's cloud copy of one record — the DynamoDB REC# item, simulated. */
export interface MockRecordRow {
  /** `${ownerId}|${store}|${record.id}` — IDB wants one key path. */
  key: string;
  ownerId: string;
  store: SyncStore;
  record: Tree | TreeNode | CheckIn | TimerSession | Harvest | Preserve;
  /** Server receive order — the change-feed cursor (kv 'changeSeq'). */
  seq: number;
  syncedAt: number;
}

export function recordKey(ownerId: string, store: SyncStore, id: string): string {
  return `${ownerId}|${store}|${id}`;
}

const KEY_PATH: Record<MockStore, string> = {
  users: 'userId',
  credentials: 'username',
  guardianLinks: 'linkId',
  friendships: 'friendshipId',
  friendRequests: 'requestId',
  codes: 'code',
  records: 'key',
  kv: 'key',
};

let mockDbPromise: Promise<IDBDatabase> | null = null;

function openMockDb(): Promise<IDBDatabase> {
  if (mockDbPromise) return mockDbPromise;
  mockDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(MOCK_DB_NAME, MOCK_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of Object.keys(KEY_PATH) as MockStore[]) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: KEY_PATH[store] });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('mock cloud blocked by another tab'));
  });
  return mockDbPromise;
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

/** Seeds exactly once (kv 'seeded'), so demo logins work on a fresh device. */
async function ready(): Promise<IDBDatabase> {
  const db = await openMockDb();
  const seeded = await requestToPromise(
    db.transaction('kv', 'readonly').objectStore('kv').get('seeded'),
  );
  if (!seeded) {
    const seed = await import('./mock-seed');
    await seed.plantMockSeed();
  }
  return db;
}

export async function mockGet<T>(store: MockStore, key: string): Promise<T | undefined> {
  const db = await ready();
  return requestToPromise(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function mockGetAll<T>(store: MockStore): Promise<T[]> {
  const db = await ready();
  return requestToPromise(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function mockPut<T>(store: MockStore, value: T): Promise<void> {
  const db = await ready();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return txDone(tx);
}

export interface MockRecordGroupResult {
  applied: MockRecordRow[];
  stale: MockRecordRow[];
}

/**
 * Applies one sync mutation group under a single IndexedDB read/write
 * transaction. The records store and its change-feed counter commit together;
 * if any member loses LWW, the transaction performs no writes and returns
 * every stored winner needed by the caller.
 */
export async function mockApplyRecordGroup(
  ownerId: string,
  entries: readonly SyncRecord[],
  syncedAt: number,
): Promise<MockRecordGroupResult> {
  if (!entries.length) return { applied: [], stale: [] };

  const db = await ready();
  const tx = db.transaction(['records', 'kv'], 'readwrite');
  const records = tx.objectStore('records');
  const kv = tx.objectStore('kv');
  const keys = entries.map((entry) => recordKey(ownerId, entry.store, entry.record.id));
  const stored = await Promise.all(
    keys.map((key) => requestToPromise<MockRecordRow | undefined>(records.get(key))),
  );
  const stale = stored.filter(
    (row, index): row is MockRecordRow =>
      row !== undefined && !lwwBeats(entries[index].record, row.record),
  );

  if (stale.length) {
    await txDone(tx);
    return { applied: [], stale };
  }

  const counter = await requestToPromise<{ key: string; value: number } | undefined>(
    kv.get('changeSeq'),
  );
  const firstSeq = (counter?.value ?? 0) + 1;
  const applied = entries.map(
    (entry, index) =>
      ({
        key: keys[index],
        ownerId,
        store: entry.store,
        record: entry.record,
        seq: firstSeq + index,
        syncedAt,
      }) satisfies MockRecordRow,
  );

  for (const row of applied) records.put(row);
  kv.put({ key: 'changeSeq', value: firstSeq + applied.length - 1 });
  await txDone(tx);
  return { applied, stale: [] };
}

export async function mockDelete(store: MockStore, key: string): Promise<void> {
  const db = await ready();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return txDone(tx);
}

export interface MockReplacementEntry {
  readonly store: MockStore;
  readonly rows: readonly unknown[];
}

/** Seeder-only whole-cloud transaction. The seeded sentinel cannot land
 * unless every identity, relationship and forest row lands with it. */
export async function mockReplaceAllRaw(
  entries: readonly MockReplacementEntry[],
): Promise<void> {
  if (!entries.length) return;
  const db = await openMockDb();
  const tx = db.transaction([...new Set(entries.map((entry) => entry.store))], 'readwrite');
  try {
    for (const entry of entries) {
      const objectStore = tx.objectStore(entry.store);
      objectStore.clear();
      for (const row of entry.rows) objectStore.put(row);
    }
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The original synchronous write error remains authoritative.
    }
    return Promise.reject(error);
  }
  return txDone(tx);
}

/** Monotonic counter (change-feed seq, rate-limit windows). */
export async function mockNextSeq(counter: string): Promise<number> {
  const db = await ready();
  const tx = db.transaction('kv', 'readwrite');
  const kv = tx.objectStore('kv');
  const row = await requestToPromise<{ key: string; value: number } | undefined>(kv.get(counter));
  const next = (row?.value ?? 0) + 1;
  kv.put({ key: counter, value: next });
  await txDone(tx);
  return next;
}

/** "Restablecer la nube de prueba" — wipe and reseed on next use.
 *  'blocked' = another tab still holds the DB open; the delete happens once
 *  it lets go — the caller must say so instead of pretending it already did. */
export async function resetMockCloud(): Promise<'done' | 'blocked'> {
  if (mockDbPromise) {
    try {
      (await mockDbPromise).close();
    } catch {
      /* already closed */
    }
    mockDbPromise = null;
  }
  return new Promise<'done' | 'blocked'>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(MOCK_DB_NAME);
    request.onsuccess = () => resolve('done');
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve('blocked');
  });
}

// ── Deterministic texture (rule 4 — never Math.random) ─────────────────────

/** FNV-1a — local copy so core never imports from features. */
export function mockHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Reproducible per-endpoint latency, 250–400 ms — feels remote, tests stay stable. */
export function simLatency(endpoint: string): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250 + (mockHash(endpoint) % 150)));
}
