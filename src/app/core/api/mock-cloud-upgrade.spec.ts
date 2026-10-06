import { beforeEach, describe, expect, it, vi } from 'vitest';

const LEGACY_STORES = [
  'users',
  'credentials',
  'guardianLinks',
  'friendships',
  'friendRequests',
  'codes',
  'records',
  'kv',
] as const;

const FAMILY_STORES = [
  'households',
  'supervisionLinks',
  'seatAssignments',
  'coverages',
  'minorFriendRequests',
  'consents',
  'subscriptionProjections',
  'checkoutReservations',
  'accountNotices',
] as const;

class MemoryRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  resolve(result: T): void {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.(new Event('success')));
  }
}

class MemoryOpenRequest extends MemoryRequest<IDBDatabase> {
  onupgradeneeded: ((event: Event) => void) | null = null;
  onblocked: ((event: Event) => void) | null = null;
}

class VersionedMemoryIndexedDb {
  readonly stores = new Map<string, Map<string, unknown>>();
  openedVersion: number | undefined;
  private currentVersion = 1;
  private readonly database = new MemoryDatabase(this);

  constructor() {
    for (const store of LEGACY_STORES) this.store(store);
    this.store('kv').set('seeded', { key: 'seeded', value: true });
    this.store('users').set('legacy-adult', {
      userId: 'legacy-adult',
      username: 'legacy',
      displayName: 'Cuenta existente',
      accountType: 'adult',
      socialEnabled: true,
      createdAt: 1,
      email: 'legacy@example.com',
    });
  }

  store(name: string): Map<string, unknown> {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map<string, unknown>();
      this.stores.set(name, store);
    }
    return store;
  }

  open(_name: string, version?: number): IDBOpenDBRequest {
    const request = new MemoryOpenRequest();
    this.openedVersion = version;
    queueMicrotask(() => {
      request.result = this.database as unknown as IDBDatabase;
      if ((version ?? this.currentVersion) > this.currentVersion) {
        request.onupgradeneeded?.(new Event('upgradeneeded'));
        this.currentVersion = version ?? this.currentVersion;
      }
      queueMicrotask(() => request.onsuccess?.(new Event('success')));
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

class MemoryDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.memory.stores.has(name),
  } as DOMStringList;

  constructor(private readonly memory: VersionedMemoryIndexedDb) {}

  createObjectStore(name: string): IDBObjectStore {
    this.memory.store(name);
    return {} as IDBObjectStore;
  }

  transaction(storeName: string): IDBTransaction {
    return {
      objectStore: (name: string) => ({
        get: (key: IDBValidKey) => {
          const request = new MemoryRequest<unknown>();
          request.resolve(this.memory.store(name).get(String(key)));
          return request as unknown as IDBRequest;
        },
      }),
    } as unknown as IDBTransaction;
  }

  close(): void {}
}

describe('mock cloud schema upgrade', () => {
  let memory: VersionedMemoryIndexedDb;

  beforeEach(() => {
    vi.resetModules();
    memory = new VersionedMemoryIndexedDb();
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: { open: memory.open.bind(memory) } as unknown as IDBFactory,
    });
  });

  it('upgrades a version 1 cloud additively and preserves every legacy row', async () => {
    const { mockGet } = await import('./mock-cloud');

    await expect(mockGet('users', 'legacy-adult')).resolves.toMatchObject({
      userId: 'legacy-adult',
      displayName: 'Cuenta existente',
    });

    expect(memory.openedVersion).toBe(2);
    expect(LEGACY_STORES.every((store) => memory.stores.has(store))).toBe(true);
    expect(FAMILY_STORES.every((store) => memory.stores.has(store))).toBe(true);
    expect(memory.store('users').get('legacy-adult')).toMatchObject({
      userId: 'legacy-adult',
      displayName: 'Cuenta existente',
    });
    expect(memory.store('kv').get('seeded')).toEqual({ key: 'seeded', value: true });
  });
});
