import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/auth-provider';
import { AuthError } from '../auth/auth-types';
import { MockAuthProvider, parseMockToken } from '../auth/mock-auth.provider';
import { APP_CONFIG } from '../config';
import { Tree } from '../db/schema';
import { EN } from '../i18n/en';
import { ES } from '../i18n/es';
import {
  API_PATHS,
  AccessSummary,
  AccountClosureReceipt,
  ApiError,
  ApiErrorCode,
  CONTRACT_VERSION,
  LIMITS,
  PlanCatalog,
  PREPAYMENT_PLAN_CATALOG,
  SERVER_API_ERROR_CODES,
  SyncPushRequest,
  SyncPushV2Request,
  isRetryableApiErrorCode,
} from './contracts';
import { HttpApi } from './http-api';
import { MockRecordRow, MockStore, mockAccountClosureKey } from './mock-cloud';
import { MockApi } from './mock-api';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const expectedHttpUrl = (path: string): string => `${APP_CONFIG.aws.apiBaseUrl}/v1${path}`;

const EXPECTED_CATALOG = {
  version: '2026-08-prepayment-v1',
  pricingVersion: 'launch-2026',
  currency: 'MXN',
  taxInclusive: true,
  paymentsEnabled: false,
  plans: {
    free: {
      limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
      capabilities: { cloudSync: false, social: false, family: false },
    },
    premium: {
      limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
      capabilities: { cloudSync: true, social: true, family: false },
      prices: {
        month: { amountMinor: 9900 },
        year: { amountMinor: 94900 },
      },
    },
  },
} as const satisfies PlanCatalog;

const EXPECTED_FREE_ACCESS: AccessSummary = {
  effectivePlanKey: 'free',
  catalogVersion: '2026-08-prepayment-v1',
  status: 'active',
  activeSources: [{ kind: 'default', sourceId: 'default', planKey: 'free', validUntil: null }],
  limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
  capabilities: { cloudSync: false, social: false, family: false },
  usage: { activeTrees: 0, visibleBranchesByTree: {} },
  revision: 0,
  nextRecomputeAt: null,
  offlineValidUntil: NOW + DAY_MS,
};

const COMMERCIAL_CODES = [
  'QUOTA_EXCEEDED',
  'CAPABILITY_REQUIRED',
  'MUTATION_GROUP_INVALID',
  'ACCESS_REVISION_CONFLICT',
  'ACCESS_CODE_INVALID',
  'ACCESS_CODE_RATE_LIMITED',
  'ACCESS_CODE_ALREADY_REDEEMED',
  'SYNC_SCHEMA_INVALID',
  'SYNC_CLIENT_UPGRADE_REQUIRED',
  'USAGE_MIGRATION_IN_PROGRESS',
  'COMMERCIAL_CONFIGURATION_UNAVAILABLE',
] as const satisfies readonly ApiErrorCode[];

const ALL_API_ERROR_CODES = [
  ...SERVER_API_ERROR_CODES,
  'offline',
  'server',
  'unknown',
] as const satisfies readonly ApiErrorCode[];

const SYNC_RECORD = {
  store: 'trees',
  record: {
    id: 'tree-1',
    createdAt: NOW,
    updatedAt: NOW,
    rev: 1,
    deletedAt: null,
  } as Tree,
} as const;

const MOCK_KEY_PATH: Record<MockStore, string> = {
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
  private readonly pendingWrites: Promise<void>[] = [];

  constructor(private readonly cloud: MemoryMockCloud) {}

  set oncomplete(handler: ((event: Event) => void) | null) {
    this.completion = handler;
    if (handler) {
      void Promise.all(this.pendingWrites).then(() =>
        queueMicrotask(() => this.completion?.(new Event('complete'))),
      );
    }
  }

  get oncomplete(): ((event: Event) => void) | null {
    return this.completion;
  }

  objectStore(name: string): IDBObjectStore {
    return new MemoryObjectStore(this.cloud, name, this) as unknown as IDBObjectStore;
  }

  trackWrite(write: Promise<void>): void {
    this.pendingWrites.push(write);
  }
}

class MemoryObjectStore {
  constructor(
    private readonly cloud: MemoryMockCloud,
    private readonly name: string,
    private readonly transaction?: MemoryTransaction,
  ) {}

  get(key: IDBValidKey): IDBRequest {
    const request = new MemoryRequest<unknown>();
    const value = this.cloud.store(this.name).get(String(key));
    const held = this.cloud.takeReadHold(this.name);
    if (held) void held.then(() => request.resolve(value));
    else request.resolve(value);
    return request as unknown as IDBRequest;
  }

  getAll(): IDBRequest {
    const request = new MemoryRequest<unknown[]>();
    request.resolve([...this.cloud.store(this.name).values()]);
    return request as unknown as IDBRequest;
  }

  put(value: unknown): IDBRequest {
    const path = MOCK_KEY_PATH[this.name as MockStore];
    const key = (value as Record<string, unknown>)[path];
    if (typeof key !== 'string') throw new Error(`missing key for ${this.name}`);
    const request = new MemoryRequest<IDBValidKey>();
    const commit = () => {
      this.cloud.store(this.name).set(key, value);
      request.resolve(key);
    };
    const held = this.cloud.takeWriteHold(this.name);
    if (held) {
      const write = held.then(commit);
      this.transaction?.trackWrite(write);
    } else {
      commit();
    }
    return request as unknown as IDBRequest;
  }

  delete(key: IDBValidKey): IDBRequest {
    this.cloud.store(this.name).delete(String(key));
    const request = new MemoryRequest<undefined>();
    request.resolve(undefined);
    return request as unknown as IDBRequest;
  }
}

class MemoryDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.cloud.hasStore(name),
  } as DOMStringList;

  constructor(private readonly cloud: MemoryMockCloud) {}

  createObjectStore(name: string): IDBObjectStore {
    this.cloud.store(name);
    return new MemoryObjectStore(this.cloud, name) as unknown as IDBObjectStore;
  }

  transaction(): IDBTransaction {
    return new MemoryTransaction(this.cloud) as unknown as IDBTransaction;
  }

  close(): void {}
}

class MemoryMockCloud {
  private readonly stores = new Map<string, Map<string, unknown>>();
  private opened = false;
  private readonly writeHolds: Array<{
    store: string;
    started: () => void;
    released: Promise<void>;
    release: () => void;
  }> = [];
  private readonly readHolds: Array<{
    store: string;
    started: () => void;
    released: Promise<void>;
    release: () => void;
  }> = [];
  private readonly database = new MemoryDatabase(this);
  readonly open = vi.fn(() => this.openDatabase());
  readonly indexedDb = { open: this.open } as unknown as IDBFactory;

  reset(): void {
    for (const hold of this.writeHolds.splice(0)) hold.release();
    for (const hold of this.readHolds.splice(0)) hold.release();
    this.stores.clear();
    for (const store of Object.keys(MOCK_KEY_PATH)) this.store(store);
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

  rows<T>(store: MockStore): T[] {
    return [...this.store(store).values()] as T[];
  }

  holdNextPut(store: MockStore): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writeHolds.push({ store, started: markStarted, released, release });
    return { started, release };
  }

  holdNextGet(store: MockStore): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.readHolds.push({ store, started: markStarted, released, release });
    return { started, release };
  }

  takeWriteHold(store: string): Promise<void> | null {
    const index = this.writeHolds.findIndex((hold) => hold.store === store);
    if (index < 0) return null;
    const [hold] = this.writeHolds.splice(index, 1);
    hold.started();
    return hold.released;
  }

  takeReadHold(store: string): Promise<void> | null {
    const index = this.readHolds.findIndex((hold) => hold.store === store);
    if (index < 0) return null;
    const [hold] = this.readHolds.splice(index, 1);
    hold.started();
    return hold.released;
  }

  private openDatabase(): IDBOpenDBRequest {
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

const mockCloud = new MemoryMockCloud();

function seedCaller(userId: string, accountInstanceId = `instance:${userId}:1`): void {
  mockCloud.seed('users', userId, {
    userId,
    username: userId,
    displayName: 'Rocío',
    accountType: 'adult',
    socialEnabled: true,
    createdAt: NOW,
    email: 'rocio@example.com',
    accountInstanceId,
  });
  mockCloud.seed('credentials', userId, {
    username: userId,
    userId,
    password: 'Bosque123',
    mustChangePassword: false,
  });
}

function seedAccountGraph(): void {
  for (const userId of ['minor', 'friend', 'foreign-a', 'foreign-b']) {
    mockCloud.seed('users', userId, {
      userId,
      username: userId,
      displayName: userId,
      accountType: userId === 'minor' ? 'minor' : 'adult',
      socialEnabled: true,
      createdAt: NOW,
      email: `${userId}@example.com`,
    });
    mockCloud.seed('credentials', userId, {
      username: userId,
      userId,
      password: 'Bosque123',
      mustChangePassword: false,
      pendingConfirm: false,
    });
  }

  mockCloud.seed('guardianLinks', 'rocio~minor', {
    linkId: 'rocio~minor',
    guardianId: 'rocio',
    minorId: 'minor',
    kind: 'created',
    createdAt: NOW,
  });
  mockCloud.seed('guardianLinks', 'foreign-a~foreign-b', {
    linkId: 'foreign-a~foreign-b',
    guardianId: 'foreign-a',
    minorId: 'foreign-b',
    kind: 'created',
    createdAt: NOW,
  });
  mockCloud.seed('friendships', 'friend~rocio', {
    friendshipId: 'friend~rocio',
    userA: 'friend',
    userB: 'rocio',
    createdAt: NOW,
  });
  mockCloud.seed('friendships', 'foreign-a~foreign-b', {
    friendshipId: 'foreign-a~foreign-b',
    userA: 'foreign-a',
    userB: 'foreign-b',
    createdAt: NOW,
  });
  mockCloud.seed('friendRequests', 'friend->rocio', {
    requestId: 'friend->rocio',
    fromId: 'friend',
    toId: 'rocio',
    createdAt: NOW,
    expiresAt: NOW + DAY_MS,
  });
  mockCloud.seed('friendRequests', 'foreign-a->foreign-b', {
    requestId: 'foreign-a->foreign-b',
    fromId: 'foreign-a',
    toId: 'foreign-b',
    createdAt: NOW,
    expiresAt: NOW + DAY_MS,
  });
  mockCloud.seed('codes', 'ROCIOMINOR', {
    code: 'ROCIOMINOR',
    kind: 'coGuardian',
    userId: 'foreign-a',
    minorId: 'rocio',
    expiresAt: NOW + DAY_MS,
  });
  mockCloud.seed('codes', 'ROCIOFRIEND', {
    code: 'ROCIOFRIEND',
    kind: 'friend',
    userId: 'rocio',
    minorId: null,
    expiresAt: NOW + DAY_MS,
  });
  mockCloud.seed('codes', 'FOREIGN', {
    code: 'FOREIGN',
    kind: 'friend',
    userId: 'foreign-a',
    minorId: null,
    expiresAt: NOW + DAY_MS,
  });
  mockCloud.seed('records', 'rocio|trees|mine', {
    key: 'rocio|trees|mine',
    ownerId: 'rocio',
    store: 'trees',
    record: { ...SYNC_RECORD.record, id: 'mine' },
    seq: 1,
    syncedAt: NOW,
  } satisfies MockRecordRow);
  mockCloud.seed('records', 'foreign-a|trees|theirs', {
    key: 'foreign-a|trees|theirs',
    ownerId: 'foreign-a',
    store: 'trees',
    record: { ...SYNC_RECORD.record, id: 'theirs' },
    seq: 2,
    syncedAt: NOW,
  } satisfies MockRecordRow);
  mockCloud.seed('kv', 'rate:rocio:500000', { key: 'rate:rocio:500000', value: 3 });
  mockCloud.seed('kv', 'rate:foreign-a:500000', {
    key: 'rate:foreign-a:500000',
    value: 4,
  });
}

function seedDelegatedChild(): void {
  mockCloud.seed('users', 'child', {
    userId: 'child',
    username: 'child',
    displayName: 'Child',
    accountType: 'minor',
    socialEnabled: false,
    createdAt: NOW,
    email: null,
    accountInstanceId: 'instance:child:1',
  });
  mockCloud.seed('credentials', 'child', {
    username: 'child',
    userId: 'child',
    password: 'Semilla1!',
    mustChangePassword: false,
    pendingConfirm: false,
  });
  mockCloud.seed('guardianLinks', 'rocio~child', {
    linkId: 'rocio~child',
    guardianId: 'rocio',
    minorId: 'child',
    kind: 'created',
    createdAt: NOW,
  });
}

function mockToken(sub: string, accountInstanceId = `instance:${sub}:1`): string {
  return `mock.${btoa(JSON.stringify({ sub, username: sub, accountInstanceId }))}.token`;
}

function authFor(userId: string, accountInstanceId = `instance:${userId}:1`): AuthProvider {
  return {
    idToken: vi.fn(async () => mockToken(userId, accountInstanceId)),
  } as unknown as AuthProvider;
}

describe('commercial access contract fixtures', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockCloud.reset();
    seedCaller('rocio');
    vi.stubGlobal('indexedDB', mockCloud.indexedDb);
  });

  it('publishes the exact prepayment catalog without opening auth or mock cloud', async () => {
    const auth = {
      idToken: vi.fn(async () => {
        throw new Error('the public catalog must not request a token');
      }),
    } as unknown as AuthProvider;
    const opensBefore = mockCloud.open.mock.calls.length;

    const catalog = await new MockApi(auth).getPlans();

    expect(catalog).toEqual(EXPECTED_CATALOG);
    expect(PREPAYMENT_PLAN_CATALOG).toEqual(EXPECTED_CATALOG);
    expect(auth.idToken).not.toHaveBeenCalled();
    expect(mockCloud.open).toHaveBeenCalledTimes(opensBefore);
  });

  it('returns a deterministic Free fallback for the authenticated mock caller', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);

    const access = await new MockApi(authFor('rocio')).getAccess();

    expect(access).toEqual(EXPECTED_FREE_ACCESS);
  });

  it('never turns an arbitrary key into Premium in the on-device mock', async () => {
    await expect(
      new MockApi(authFor('rocio')).redeemAccessCode('RM2U1.fake.secret'),
    ).rejects.toMatchObject({ code: 'ACCESS_CODE_INVALID' });
  });

  it('routes mock account deletion through the API seam and returns a closure receipt', async () => {
    const auth = authFor('rocio');

    const receipt = await new MockApi(auth).deleteMe();

    expect(receipt).toEqual({
      closureId: expect.stringMatching(
        /^mock:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      state: 'completed',
    });
    expect(receipt.closureId).not.toContain('rocio');
    expect(mockCloud.rows('users')).toEqual([]);
    expect(mockCloud.rows('credentials')).toEqual([]);
  });

  it('returns the same completed closure receipt when another tab retries', async () => {
    const firstTab = new MockApi(authFor('rocio'));
    const secondTab = new MockApi(authFor('rocio'));

    const [first, concurrentRetry] = await Promise.all([firstTab.deleteMe(), secondTab.deleteMe()]);
    const lateRetry = await new MockApi(authFor('rocio')).deleteMe();

    expect(concurrentRetry).toEqual(first);
    expect(lateRetry).toEqual(first);
  });

  it('recovers a completed closure after response loss without authorizing normal APIs', async () => {
    const provider = new MockAuthProvider();
    await provider.signIn('rocio', 'Bosque123');
    const api = new MockApi(provider);

    const lostResponse = await api.deleteMe();

    await expect(api.getMe()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(provider.idToken()).resolves.toBeNull();
    await expect(api.deleteMe()).resolves.toEqual(lostResponse);
  });

  it('purges every account-owned reference without touching unrelated mock-cloud data', async () => {
    seedAccountGraph();

    await new MockApi(authFor('rocio')).deleteMe();

    expect(
      mockCloud
        .rows<{ userId: string }>('users')
        .map((row) => row.userId)
        .sort(),
    ).toEqual(['foreign-a', 'foreign-b', 'friend', 'minor']);
    expect(
      mockCloud
        .rows<{ userId: string }>('credentials')
        .map((row) => row.userId)
        .sort(),
    ).toEqual(['foreign-a', 'foreign-b', 'friend', 'minor']);
    expect(mockCloud.rows<{ linkId: string }>('guardianLinks').map((row) => row.linkId)).toEqual([
      'foreign-a~foreign-b',
    ]);
    expect(
      mockCloud.rows<{ friendshipId: string }>('friendships').map((row) => row.friendshipId),
    ).toEqual(['foreign-a~foreign-b']);
    expect(
      mockCloud.rows<{ requestId: string }>('friendRequests').map((row) => row.requestId),
    ).toEqual(['foreign-a->foreign-b']);
    expect(mockCloud.rows<{ code: string }>('codes').map((row) => row.code)).toEqual(['FOREIGN']);
    expect(mockCloud.rows<MockRecordRow>('records').map((row) => row.key)).toEqual([
      'foreign-a|trees|theirs',
    ]);
    expect(
      mockCloud
        .rows<{ key: string }>('kv')
        .map((row) => row.key)
        .sort(),
    ).toEqual([expect.stringMatching(/^accountClosure:/), 'rate:foreign-a:500000', 'seeded']);
  });

  it('does not reconnect deleted artifacts when the same username is registered again', async () => {
    seedAccountGraph();
    const firstClosure = await new MockApi(authFor('rocio')).deleteMe();
    seedCaller('rocio', 'instance:rocio:2');

    const me = await new MockApi(authFor('rocio', 'instance:rocio:2')).getMe();
    const secondClosure = await new MockApi(authFor('rocio', 'instance:rocio:2')).deleteMe();

    expect(me.family).toEqual({ guardians: [], minors: [] });
    expect(secondClosure.state).toBe('completed');
    expect(secondClosure.closureId).not.toBe(firstClosure.closureId);
    expect(mockCloud.rows<MockRecordRow>('records').map((row) => row.key)).toEqual([
      'foreign-a|trees|theirs',
    ]);
  });

  it('does not let a token from a closed account delete a recreated account with the same sub', async () => {
    const oldApi = new MockApi(authFor('rocio', 'instance:rocio:1'));
    await oldApi.deleteMe();
    seedCaller('rocio', 'instance:rocio:2');

    await expect(oldApi.deleteMe()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    expect(mockCloud.rows<{ accountInstanceId: string }>('users')).toEqual([
      expect.objectContaining({ accountInstanceId: 'instance:rocio:2' }),
    ]);
    await expect(
      new MockApi(authFor('rocio', 'instance:rocio:2')).patchMe({ displayName: 'Rocío nueva' }),
    ).resolves.toMatchObject({ displayName: 'Rocío nueva' });
  });

  it('uses a closure-only credential to recover the old receipt without deleting a recreated account', async () => {
    const provider = new MockAuthProvider();
    await provider.signIn('rocio', 'Bosque123');
    const api = new MockApi(provider);
    const lostResponse = await api.deleteMe();
    seedCaller('rocio', 'instance:rocio:2');

    await expect(api.deleteMe()).resolves.toEqual(lostResponse);

    expect(mockCloud.rows<{ accountInstanceId: string }>('users')).toEqual([
      expect.objectContaining({ accountInstanceId: 'instance:rocio:2' }),
    ]);
    expect(mockCloud.rows<{ password: string }>('credentials')).toEqual([
      expect.objectContaining({ password: 'Bosque123' }),
    ]);
    await expect(api.patchMe({ displayName: 'No debe entrar' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it.each([
    {
      label: 'nonterminal receipt',
      value: {
        receipt: { closureId: 'mock:pending', state: 'requested' },
        userId: 'rocio',
        accountInstanceId: 'instance:rocio:1',
        purgeCompleted: false,
      },
    },
    {
      label: 'malformed receipt',
      value: {
        receipt: { closureId: '', state: 'completed' },
        userId: 'rocio',
        accountInstanceId: 'instance:rocio:1',
        purgeCompleted: true,
      },
    },
    {
      label: 'other account instance',
      value: {
        receipt: { closureId: 'mock:other-instance', state: 'completed' },
        userId: 'rocio',
        accountInstanceId: 'instance:rocio:2',
        purgeCompleted: true,
      },
    },
  ])('rejects a closure credential backed by a $label', async ({ value }) => {
    const provider = new MockAuthProvider();
    await provider.signIn('rocio', 'Bosque123');
    const key = mockAccountClosureKey('rocio', 'instance:rocio:1');
    mockCloud.seed('kv', key, { key, value });

    await expect(new MockApi(provider).deleteMe()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    expect(mockCloud.rows<{ accountInstanceId: string }>('users')).toEqual([
      expect.objectContaining({ accountInstanceId: 'instance:rocio:1' }),
    ]);
    expect(mockCloud.rows('credentials')).toHaveLength(1);
  });

  it('does not reset a recreated account through an earlier recovery flow', async () => {
    const provider = new MockAuthProvider();
    await provider.forgotPassword('rocio');
    await new MockApi(authFor('rocio', 'instance:rocio:1')).deleteMe();
    seedCaller('rocio', 'instance:rocio:2');

    await expect(
      provider.confirmForgotPassword('rocio', '123456', 'Bosque456'),
    ).rejects.toMatchObject({ code: 'userNotFound' } satisfies Partial<AuthError>);

    expect(mockCloud.rows<{ password: string }>('credentials')).toEqual([
      expect.objectContaining({ password: 'Bosque123' }),
    ]);
  });

  it('upgrades a legacy mock user and token to one stable account instance', async () => {
    const current = mockCloud.rows<Record<string, unknown>>('users')[0];
    const legacyUser = { ...current };
    delete legacyUser['accountInstanceId'];
    mockCloud.seed('users', 'rocio', legacyUser);
    const legacyToken = `mock.${btoa(
      JSON.stringify({
        sub: 'rocio',
        username: 'rocio',
        'custom:accountType': 'adult',
        iat: NOW,
        exp: NOW + DAY_MS,
      }),
    )}.token`;
    localStorage.setItem('rm2u.mock.idToken', legacyToken);

    const upgradedToken = await new MockAuthProvider().idToken();
    const payload = upgradedToken ? parseMockToken(upgradedToken) : null;
    const upgradedUser = mockCloud.rows<{ accountInstanceId?: string }>('users')[0];

    expect(payload?.accountInstanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(upgradedUser.accountInstanceId).toBe(payload?.accountInstanceId);
    expect(localStorage.getItem('rm2u.mock.idToken')).toBe(upgradedToken);
  });

  it('does not bind an ambiguous legacy token to an already-instantiated account', async () => {
    const legacyToken = `mock.${btoa(
      JSON.stringify({
        sub: 'rocio',
        username: 'rocio',
        'custom:accountType': 'adult',
        iat: NOW,
        exp: NOW + DAY_MS,
      }),
    )}.token`;
    localStorage.setItem('rm2u.mock.idToken', legacyToken);

    await expect(new MockAuthProvider().idToken()).resolves.toBeNull();

    expect(localStorage.getItem('rm2u.mock.idToken')).toBeNull();
    expect(mockCloud.rows<{ accountInstanceId?: string }>('users')[0].accountInstanceId).toBe(
      'instance:rocio:1',
    );
  });

  it('linearizes a delayed profile write before terminal account closure', async () => {
    vi.useFakeTimers();
    const hold = mockCloud.holdNextPut('users');
    try {
      const api = new MockApi(authFor('rocio'));
      const patch = api.patchMe({ displayName: 'Escritura tardía' });
      await vi.advanceTimersByTimeAsync(400);
      await hold.started;

      const closure = api.deleteMe();
      await vi.advanceTimersByTimeAsync(400);
      hold.release();
      const [, receipt] = await Promise.all([patch, closure]);

      expect(receipt.state).toBe('completed');
      expect(mockCloud.rows('users')).toEqual([]);
    } finally {
      hold.release();
      vi.useRealTimers();
    }
  });

  it('linearizes a delayed sync write before terminal account closure', async () => {
    vi.useFakeTimers();
    const hold = mockCloud.holdNextPut('records');
    try {
      const api = new MockApi(authFor('rocio'));
      const push = api.pushSync({ schemaVersion: 12, records: [SYNC_RECORD] });
      await vi.advanceTimersByTimeAsync(400);
      await hold.started;

      const closure = api.deleteMe();
      await vi.advanceTimersByTimeAsync(400);
      hold.release();
      const [, receipt] = await Promise.all([push, closure]);

      expect(receipt.state).toBe('completed');
      expect(mockCloud.rows('records')).toEqual([]);
    } finally {
      hold.release();
      vi.useRealTimers();
    }
  });

  it('linearizes a delayed guardian profile write against the child closing their account', async () => {
    vi.useFakeTimers();
    seedDelegatedChild();
    const hold = mockCloud.holdNextPut('users');
    try {
      const guardian = new MockApi(authFor('rocio'));
      const child = new MockApi(authFor('child'));
      const patch = guardian.patchChild('child', { displayName: 'Escritura delegada' });
      await vi.advanceTimersByTimeAsync(400);
      await hold.started;

      const closure = child.deleteMe();
      await vi.advanceTimersByTimeAsync(400);
      hold.release();
      const [, receipt] = await Promise.all([patch, closure]);

      expect(receipt.state).toBe('completed');
      expect(
        mockCloud.rows<{ userId: string }>('users').some((user) => user.userId === 'child'),
      ).toBe(false);
    } finally {
      hold.release();
      vi.useRealTimers();
    }
  });

  it('linearizes a delayed guardian sync write against the child closing their account', async () => {
    vi.useFakeTimers();
    seedDelegatedChild();
    const hold = mockCloud.holdNextPut('records');
    try {
      const guardian = new MockApi(authFor('rocio'));
      const child = new MockApi(authFor('child'));
      const push = guardian.pushSyncFor('child', {
        schemaVersion: 12,
        records: [SYNC_RECORD],
      });
      await vi.advanceTimersByTimeAsync(400);
      await hold.started;

      const closure = child.deleteMe();
      await vi.advanceTimersByTimeAsync(400);
      hold.release();
      const [, receipt] = await Promise.all([push, closure]);

      expect(receipt.state).toBe('completed');
      expect(mockCloud.rows('records')).toEqual([]);
    } finally {
      hold.release();
      vi.useRealTimers();
    }
  });

  it('linearizes accepting a family invite against the invited minor closing their account', async () => {
    vi.useFakeTimers();
    seedCaller('issuer');
    mockCloud.seed('users', 'minor', {
      userId: 'minor',
      username: 'minor',
      displayName: 'Minor',
      accountType: 'minor',
      socialEnabled: false,
      createdAt: NOW,
      email: null,
      accountInstanceId: 'instance:minor:1',
    });
    mockCloud.seed('credentials', 'minor', {
      username: 'minor',
      userId: 'minor',
      password: 'Semilla1!',
      mustChangePassword: false,
      pendingConfirm: false,
    });
    mockCloud.seed('guardianLinks', 'issuer~minor', {
      linkId: 'issuer~minor',
      guardianId: 'issuer',
      minorId: 'minor',
      kind: 'created',
      createdAt: NOW,
    });
    mockCloud.seed('codes', 'FAMILYCODE', {
      code: 'FAMILYCODE',
      kind: 'coGuardian',
      userId: 'issuer',
      minorId: 'minor',
      expiresAt: NOW + DAY_MS,
    });
    const hold = mockCloud.holdNextPut('guardianLinks');
    try {
      const accept = new MockApi(authFor('rocio')).acceptFamilyInvite('FAMILYCODE');
      await vi.advanceTimersByTimeAsync(400);
      await hold.started;

      const closure = new MockApi(authFor('minor')).deleteMe();
      await vi.advanceTimersByTimeAsync(400);
      hold.release();
      const [, receipt] = await Promise.all([accept, closure]);

      expect(receipt.state).toBe('completed');
      expect(
        mockCloud
          .rows<{ guardianId: string; minorId: string }>('guardianLinks')
          .some((link) => link.guardianId === 'minor' || link.minorId === 'minor'),
      ).toBe(false);
    } finally {
      hold.release();
      vi.useRealTimers();
    }
  });

  it('linearizes accepting a friend request against its sender closing their account', async () => {
    vi.useFakeTimers();
    seedCaller('friend');
    mockCloud.seed('friendRequests', 'friend->rocio', {
      requestId: 'friend->rocio',
      fromId: 'friend',
      toId: 'rocio',
      createdAt: NOW,
      expiresAt: NOW + DAY_MS,
    });
    const hold = mockCloud.holdNextPut('friendships');
    try {
      const accept = new MockApi(authFor('rocio')).acceptFriendRequest('friend->rocio');
      await vi.advanceTimersByTimeAsync(400);
      await hold.started;

      const closure = new MockApi(authFor('friend')).deleteMe();
      await vi.advanceTimersByTimeAsync(400);
      hold.release();
      const [, receipt] = await Promise.all([accept, closure]);

      expect(receipt.state).toBe('completed');
      expect(
        mockCloud
          .rows<{ userA: string; userB: string }>('friendships')
          .some((friendship) => friendship.userA === 'friend' || friendship.userB === 'friend'),
      ).toBe(false);
    } finally {
      hold.release();
      vi.useRealTimers();
    }
  });

  it('serializes concurrent sign-ups for the same account incarnation boundary', async () => {
    vi.useFakeTimers();
    const hold = mockCloud.holdNextPut('users');
    const input = {
      username: 'luna',
      password: 'Bosque123',
      email: 'luna@example.com',
      displayName: 'Luna',
    };
    try {
      const first = new MockAuthProvider().signUp(input);
      await vi.advanceTimersByTimeAsync(400);
      await hold.started;

      const second = new MockAuthProvider().signUp(input);
      await vi.advanceTimersByTimeAsync(400);
      hold.release();
      const results = await Promise.allSettled([first, second]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'userExists' } satisfies Partial<AuthError>),
      });
      const user = mockCloud
        .rows<{ userId: string; accountInstanceId: string }>('users')
        .find((candidate) => candidate.userId === 'u-luna');
      const credential = mockCloud
        .rows<{ userId: string }>('credentials')
        .find((candidate) => candidate.userId === 'u-luna');
      expect(user?.accountInstanceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(credential?.userId).toBe(user?.userId);
    } finally {
      hold.release();
      vi.useRealTimers();
    }
  });

  it('linearizes confirmation credential writes before terminal account closure', async () => {
    vi.useFakeTimers();
    mockCloud.seed('credentials', 'rocio', {
      username: 'rocio',
      userId: 'rocio',
      password: 'Bosque123',
      mustChangePassword: false,
      pendingConfirm: true,
    });
    const hold = mockCloud.holdNextPut('credentials');
    try {
      const confirm = new MockAuthProvider().confirmSignUp('rocio', '123456');
      await vi.advanceTimersByTimeAsync(400);
      await hold.started;

      const closure = new MockApi(authFor('rocio')).deleteMe();
      await vi.advanceTimersByTimeAsync(400);
      hold.release();
      const [, receipt] = await Promise.all([confirm, closure]);

      expect(receipt.state).toBe('completed');
      expect(mockCloud.rows('credentials')).toEqual([]);
    } finally {
      hold.release();
      vi.useRealTimers();
    }
  });

  it('rejects a sign-in that reaches the account after terminal closure began', async () => {
    vi.useFakeTimers();
    const hold = mockCloud.holdNextPut('kv');
    try {
      const closure = new MockApi(authFor('rocio')).deleteMe();
      await vi.advanceTimersByTimeAsync(400);
      await hold.started;

      const signIn = new MockAuthProvider().signIn('rocio', 'Bosque123');
      const settled = Promise.allSettled([closure, signIn]);
      await vi.advanceTimersByTimeAsync(400);
      hold.release();
      const [closureResult, signInResult] = await settled;

      expect(closureResult).toMatchObject({
        status: 'fulfilled',
        value: expect.objectContaining({ state: 'completed' }),
      });
      expect(signInResult).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'userNotFound' } satisfies Partial<AuthError>),
      });
      expect(localStorage.getItem('rm2u.mock.idToken')).toBeNull();
    } finally {
      hold.release();
      vi.useRealTimers();
    }
  });

  it('does not return a current session after terminal closure acquired the account lock', async () => {
    vi.useFakeTimers();
    const provider = new MockAuthProvider();
    const initialSignIn = provider.signIn('rocio', 'Bosque123');
    await vi.advanceTimersByTimeAsync(400);
    await initialSignIn;
    const hold = mockCloud.holdNextPut('kv');
    try {
      const closure = new MockApi(authFor('rocio')).deleteMe();
      await vi.advanceTimersByTimeAsync(400);
      await hold.started;

      const currentSession = provider.currentSession();
      await vi.advanceTimersByTimeAsync(0);
      hold.release();
      await expect(closure).resolves.toMatchObject({ state: 'completed' });

      await expect(currentSession).resolves.toBeNull();
      expect(localStorage.getItem('rm2u.mock.idToken')).toBeNull();
    } finally {
      hold.release();
      vi.useRealTimers();
    }
  });

  it('does not refresh a token after terminal closure acquired the account lock', async () => {
    vi.useFakeTimers();
    const provider = new MockAuthProvider();
    const initialSignIn = provider.signIn('rocio', 'Bosque123');
    await vi.advanceTimersByTimeAsync(400);
    await initialSignIn;
    const hold = mockCloud.holdNextPut('kv');
    try {
      const closure = new MockApi(authFor('rocio')).deleteMe();
      await vi.advanceTimersByTimeAsync(400);
      await hold.started;

      const refreshed = provider.idToken({ forceRefresh: true });
      await vi.advanceTimersByTimeAsync(0);
      hold.release();
      await expect(closure).resolves.toMatchObject({ state: 'completed' });

      await expect(refreshed).resolves.toBeNull();
      expect(localStorage.getItem('rm2u.mock.idToken')).toBeNull();
    } finally {
      hold.release();
      vi.useRealTimers();
    }
  });

  it('does not let a stale refresh overwrite a newer signed-in identity', async () => {
    vi.useFakeTimers();
    const oldProvider = new MockAuthProvider();
    const initialSignIn = oldProvider.signIn('rocio', 'Bosque123');
    await vi.advanceTimersByTimeAsync(400);
    await initialSignIn;
    const hold = mockCloud.holdNextGet('users');
    try {
      const staleRefresh = oldProvider.idToken({ forceRefresh: true });
      await hold.started;

      seedCaller('luna');
      const newerSignIn = new MockAuthProvider().signIn('luna', 'Bosque123');
      await vi.advanceTimersByTimeAsync(400);
      await newerSignIn;
      const newerToken = localStorage.getItem('rm2u.mock.idToken');

      hold.release();

      await expect(staleRefresh).resolves.toBeNull();
      expect(parseMockToken(localStorage.getItem('rm2u.mock.idToken') ?? '')?.sub).toBe('luna');
      expect(localStorage.getItem('rm2u.mock.idToken')).toBe(newerToken);
    } finally {
      hold.release();
      vi.useRealTimers();
    }
  });

  it('keeps the v12 push shape while adding contract v2 mutation groups', () => {
    const legacy: SyncPushRequest = { schemaVersion: 12, records: [SYNC_RECORD] };
    const grouped: SyncPushV2Request = {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [{ id: 'mutation-1', expectedCount: 1, records: [SYNC_RECORD] }],
    };

    expect(legacy.records).toEqual([SYNC_RECORD]);
    expect(CONTRACT_VERSION).toBe(2);
    expect(grouped.contractVersion).toBe(2);
    expect(grouped.mutationGroups[0]).toEqual({
      id: 'mutation-1',
      expectedCount: 1,
      records: [SYNC_RECORD],
    });
    expect(LIMITS.syncPushMax).toBe(100);
    expect(LIMITS.syncMutationGroupMax).toBe(20);
  });

  it.each([
    { id: 'fractional', expectedCount: 1.5, records: [SYNC_RECORD] },
    { id: 'mismatch', expectedCount: 2, records: [SYNC_RECORD] },
    { id: 'empty', expectedCount: 0, records: [] },
    { id: 'too-large', expectedCount: 21, records: Array(21).fill(SYNC_RECORD) },
  ])('rejects an unsafe or incomplete mutation group: $id', async (group) => {
    await expect(
      new MockApi(authFor('rocio')).pushSync({
        schemaVersion: 12,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [group],
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_GROUP_INVALID' });
  });

  it('prevalidates every record in a v2 group before writing any member', async () => {
    const malformed = {
      store: 'trees',
      record: { id: 'tree-malformed', rev: 'not-a-number', updatedAt: NOW },
    } as unknown as typeof SYNC_RECORD;

    await expect(
      new MockApi(authFor('rocio')).pushSync({
        schemaVersion: 12,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'semantic-invalid',
            expectedCount: 2,
            records: [SYNC_RECORD, malformed],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SYNC_SCHEMA_INVALID' });

    expect(mockCloud.rows('records')).toEqual([]);
  });

  it('rejects a stale v2 group atomically and returns the stored winner', async () => {
    const storedRecord = {
      ...SYNC_RECORD.record,
      id: 'tree-stale',
      rev: 2,
      updatedAt: NOW + 2,
    } as Tree;
    const storedRow = {
      key: 'rocio|trees|tree-stale',
      ownerId: 'rocio',
      store: 'trees',
      record: storedRecord,
      seq: 7,
      syncedAt: NOW,
    } satisfies MockRecordRow;
    mockCloud.seed('records', storedRow.key, storedRow);
    mockCloud.seed('kv', 'changeSeq', { key: 'changeSeq', value: 7 });

    const validNew = {
      ...SYNC_RECORD,
      record: { ...SYNC_RECORD.record, id: 'tree-new' } as Tree,
    };
    const stale = {
      ...SYNC_RECORD,
      record: { ...SYNC_RECORD.record, id: 'tree-stale' } as Tree,
    };

    await expect(
      new MockApi(authFor('rocio')).pushSync({
        schemaVersion: 12,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [{ id: 'stale-group', expectedCount: 2, records: [validNew, stale] }],
      }),
    ).resolves.toEqual({
      applied: [],
      rejected: [{ id: 'tree-stale', reason: 'STALE_REV' }],
      serverRecords: [{ store: 'trees', record: storedRecord }],
    });

    expect(mockCloud.rows<MockRecordRow>('records')).toEqual([storedRow]);
  });

  it('recognizes every commercial error without adding retryability to the wire envelope', () => {
    expect(COMMERCIAL_CODES.every((code) => SERVER_API_ERROR_CODES.includes(code))).toBe(true);
    expect(isRetryableApiErrorCode('USAGE_MIGRATION_IN_PROGRESS')).toBe(true);
    expect(isRetryableApiErrorCode('ACCESS_REVISION_CONFLICT')).toBe(true);
    expect(isRetryableApiErrorCode('QUOTA_EXCEEDED')).toBe(false);
    const migrationError = new ApiError('USAGE_MIGRATION_IN_PROGRESS');
    expect(migrationError.retryable).toBe(true);
    expect(Object.hasOwn(migrationError, 'retryable')).toBe(false);
    expect(JSON.stringify(migrationError)).not.toContain('retryable');
  });

  it('has safe bilingual UX copy for every widened ApiErrorCode', () => {
    for (const code of ALL_API_ERROR_CODES) {
      expect(ES.familia.errors[code], `missing ES copy for ${code}`).toEqual(expect.any(String));
      expect(EN.familia.errors[code], `missing EN copy for ${code}`).toEqual(expect.any(String));
    }
  });
});

describe('HttpApi commercial transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('navigator', { onLine: true });
  });

  it('fetches the public catalog without asking AuthProvider for an idToken', async () => {
    const auth = {
      idToken: vi.fn(async () => {
        throw new Error('the public catalog must not request a token');
      }),
    } as unknown as AuthProvider;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(EXPECTED_CATALOG), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HttpApi(auth).getPlans()).resolves.toEqual(EXPECTED_CATALOG);

    expect(auth.idToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(expectedHttpUrl(API_PATHS.plans), {
      method: 'GET',
      headers: {},
      body: undefined,
    });
  });

  it('uses the authenticated exact access, redemption, and deletion routes', async () => {
    const auth = authFor('rocio');
    const receipt: AccountClosureReceipt = { closureId: 'closure-1', state: 'requested' };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.method === 'DELETE' ? receipt : EXPECTED_FREE_ACCESS;
      expect((init?.headers as Record<string, string>)['authorization']).toBe(
        `Bearer ${mockToken('rocio')}`,
      );
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpApi(auth);

    await expect(api.getAccess()).resolves.toEqual(EXPECTED_FREE_ACCESS);
    await expect(api.redeemAccessCode('RM2U1.issue.secret')).resolves.toEqual(EXPECTED_FREE_ACCESS);
    await expect(api.deleteMe()).resolves.toEqual(receipt);

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [expectedHttpUrl(API_PATHS.access), 'GET'],
      [expectedHttpUrl(API_PATHS.accessCodesRedeem), 'POST'],
      [expectedHttpUrl(API_PATHS.me), 'DELETE'],
    ]);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ code: 'RM2U1.issue.secret' }));
  });
});
