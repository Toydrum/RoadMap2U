import { beforeEach, describe, expect, it } from 'vitest';

import { AuthProvider } from '../auth/auth-provider';
import { MockCodeRow, MockGuardianLinkRow, MockStore, MockUserRow } from './mock-cloud';
import { MockApi } from './mock-api';

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

class MemoryTransaction {
  error: DOMException | null = null;
  onerror: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  private completion: ((event: Event) => void) | null = null;

  constructor(private readonly memory: MemoryIndexedDb) {}

  set oncomplete(handler: ((event: Event) => void) | null) {
    this.completion = handler;
    if (handler) queueMicrotask(() => this.completion?.(new Event('complete')));
  }

  get oncomplete(): ((event: Event) => void) | null {
    return this.completion;
  }

  objectStore(name: string): IDBObjectStore {
    return new MemoryObjectStore(this.memory, name) as unknown as IDBObjectStore;
  }
}

class MemoryObjectStore {
  constructor(
    private readonly memory: MemoryIndexedDb,
    private readonly name: string,
  ) {}

  get(key: IDBValidKey): IDBRequest {
    const request = new MemoryRequest<unknown>();
    request.resolve(this.memory.store(this.name).get(String(key)));
    return request as unknown as IDBRequest;
  }

  getAll(): IDBRequest {
    const request = new MemoryRequest<unknown[]>();
    request.resolve([...this.memory.store(this.name).values()]);
    return request as unknown as IDBRequest;
  }

  put(value: unknown): IDBRequest {
    const path = KEY_PATH[this.name as MockStore];
    const key = (value as Record<string, unknown>)[path];
    if (typeof key !== 'string') throw new Error(`missing key for ${this.name}`);
    this.memory.store(this.name).set(key, value);
    const request = new MemoryRequest<IDBValidKey>();
    request.resolve(key);
    return request as unknown as IDBRequest;
  }

  delete(key: IDBValidKey): IDBRequest {
    this.memory.store(this.name).delete(String(key));
    const request = new MemoryRequest<undefined>();
    request.resolve(undefined);
    return request as unknown as IDBRequest;
  }
}

class MemoryDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.memory.hasStore(name),
  } as DOMStringList;

  constructor(private readonly memory: MemoryIndexedDb) {}

  createObjectStore(name: string): IDBObjectStore {
    this.memory.store(name);
    return new MemoryObjectStore(this.memory, name) as unknown as IDBObjectStore;
  }

  transaction(): IDBTransaction {
    return new MemoryTransaction(this.memory) as unknown as IDBTransaction;
  }

  close(): void {}
}

class MemoryIndexedDb {
  private readonly stores = new Map<string, Map<string, unknown>>();
  private opened = false;
  private readonly database = new MemoryDatabase(this);

  reset(): void {
    this.stores.clear();
    for (const store of Object.keys(KEY_PATH)) this.store(store);
    this.seed('kv', 'seeded', { key: 'seeded', value: 1 });
  }

  hasStore(name: string): boolean {
    return this.stores.has(name);
  }

  store(name: string): Map<string, unknown> {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map<string, unknown>();
      this.stores.set(name, store);
    }
    return store;
  }

  seed(store: MockStore, key: string, value: unknown): void {
    this.store(store).set(key, value);
  }

  rows(store: MockStore): unknown[] {
    return [...this.store(store).values()];
  }

  open(): IDBOpenDBRequest {
    const request = new MemoryOpenRequest();
    queueMicrotask(() => {
      request.result = this.database as unknown as IDBDatabase;
      if (!this.opened) {
        this.opened = true;
        request.onupgradeneeded?.(new Event('upgradeneeded'));
      }
      queueMicrotask(() => request.onsuccess?.(new Event('success')));
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

const memoryIndexedDb = new MemoryIndexedDb();
Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  value: { open: () => memoryIndexedDb.open() } as unknown as IDBFactory,
});

const NOW = 1_800_000_000_000;

function user(userId: string, accountType: MockUserRow['accountType']): MockUserRow {
  return {
    userId,
    username: userId,
    displayName: userId,
    accountType,
    socialEnabled: accountType === 'adult',
    createdAt: NOW,
    email: accountType === 'adult' ? `${userId}@example.com` : null,
    accountInstanceId: `instance:${userId}:1`,
  };
}

function tokenFor(caller: MockUserRow): string {
  const encoded = btoa(
    JSON.stringify({
      sub: caller.userId,
      username: caller.username,
      accountInstanceId: caller.accountInstanceId,
    }),
  );
  return `mock.${encoded}.token`;
}

function apiFor(caller: MockUserRow): MockApi {
  const auth = { idToken: async () => tokenFor(caller) } as unknown as AuthProvider;
  return new MockApi(auth);
}

beforeEach(() => memoryIndexedDb.reset());

describe('MockApi family authorization', () => {
  it('does not let an invited guardian promote another adult to created', async () => {
    const rocio = user('rocio', 'adult');
    const nico = user('nico', 'minor');
    const invitedLink: MockGuardianLinkRow = {
      linkId: 'rocio~nico',
      guardianId: rocio.userId,
      minorId: nico.userId,
      kind: 'invited',
      createdAt: NOW,
    };
    memoryIndexedDb.seed('users', rocio.userId, rocio);
    memoryIndexedDb.seed('users', nico.userId, nico);
    memoryIndexedDb.seed('guardianLinks', invitedLink.linkId, invitedLink);

    await expect(
      apiFor(rocio).createFamilyInvite({ kind: 'coGuardian', minorId: nico.userId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(memoryIndexedDb.rows('codes')).toHaveLength(0);
  });

  it('rejects a co-guardian code after its issuer loses the created link', async () => {
    const abuela = user('abuela', 'adult');
    const nico = user('nico', 'minor');
    const invite: MockCodeRow = {
      code: 'FAMILY12',
      kind: 'coGuardian',
      userId: 'rocio',
      minorId: nico.userId,
      expiresAt: Date.now() + 60_000,
    };
    memoryIndexedDb.seed('users', abuela.userId, abuela);
    memoryIndexedDb.seed('users', nico.userId, nico);
    memoryIndexedDb.seed('codes', invite.code, invite);

    await expect(apiFor(abuela).acceptFamilyInvite(invite.code)).rejects.toMatchObject({
      code: 'CODE_INVALID',
    });
    expect(memoryIndexedDb.rows('guardianLinks')).toHaveLength(0);
  });
});
