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
  households: 'householdId',
  supervisionLinks: 'linkId',
  seatAssignments: 'assignmentId',
  coverages: 'coverageId',
  minorFriendRequests: 'requestId',
  consents: 'consentId',
  subscriptionProjections: 'projectionId',
  checkoutReservations: 'reservationId',
  accountNotices: 'noticeId',
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

  constructor(private readonly memory: MemoryIndexedDb) {}

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
    return new MemoryObjectStore(this.memory, name, this) as unknown as IDBObjectStore;
  }

  trackWrite(write: Promise<void>): void {
    this.pendingWrites.push(write);
  }
}

class MemoryObjectStore {
  constructor(
    private readonly memory: MemoryIndexedDb,
    private readonly name: string,
    private readonly transaction?: MemoryTransaction,
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
    const request = new MemoryRequest<IDBValidKey>();
    const commit = () => {
      this.memory.store(this.name).set(key, value);
      request.resolve(key);
    };
    const held = this.memory.takeWriteHold(this.name);
    if (held) {
      const write = held.then(commit);
      this.transaction?.trackWrite(write);
    } else {
      commit();
    }
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
  private readonly writeHolds: Array<{
    store: string;
    started: () => void;
    released: Promise<void>;
    release: () => void;
  }> = [];
  private readonly database = new MemoryDatabase(this);

  reset(): void {
    for (const hold of this.writeHolds.splice(0)) hold.release();
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

  takeWriteHold(store: string): Promise<void> | null {
    const index = this.writeHolds.findIndex((hold) => hold.store === store);
    if (index < 0) return null;
    const [hold] = this.writeHolds.splice(index, 1);
    hold.started();
    return hold.released;
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

function seedHousehold(primary: MockUserRow, minors: MockUserRow[] = []): string {
  const householdId = `household:${primary.userId}`;
  memoryIndexedDb.seed('households', householdId, {
    householdId,
    primaryResponsibleId: primary.userId,
    country: 'MX',
    state: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  minors.forEach((minor, index) => {
    const seat = index + 1;
    memoryIndexedDb.seed('seatAssignments', `${householdId}:minor:${seat}`, {
      assignmentId: `${householdId}:minor:${seat}`,
      householdId,
      seatType: 'minor',
      position: seat,
      accountId: minor.userId,
      majorityAt: '2035-01-01',
      assignedAt: NOW,
    });
    memoryIndexedDb.seed('supervisionLinks', `${householdId}:${primary.userId}:${minor.userId}`, {
      linkId: `${householdId}:${primary.userId}:${minor.userId}`,
      householdId,
      adultId: primary.userId,
      minorId: minor.userId,
      role: 'primary_responsible',
      state: 'active',
      createdAt: NOW,
      revokedAt: null,
    });
    memoryIndexedDb.seed('coverages', minor.userId, {
      coverageId: minor.userId,
      householdId,
      accountId: minor.userId,
      seatType: 'minor',
      state: 'active',
      source: 'test_seed',
      validUntil: null,
      createdAt: NOW,
    });
  });
  return householdId;
}

function familyCommand(householdId: string, revision: number, suffix: string) {
  return {
    householdId,
    expectedHouseholdRevision: revision,
    commandId: `command-${suffix}`,
    policyVersion: 'family-policy-v1',
  };
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

  it('creates a deterministic household, enforces two minor seats, and marks test coverage', async () => {
    const rocio = user('rocio', 'adult');
    memoryIndexedDb.seed('users', rocio.userId, rocio);
    const api = apiFor(rocio);

    const initial = await api.getHousehold();
    expect(await api.getHousehold()).toEqual(initial);
    expect(initial).toMatchObject({
      country: 'MX',
      state: 'active',
      myRole: 'primary_responsible',
      primaryResponsible: { userId: rocio.userId },
      minors: [],
      availableMinorSeats: 2,
      additionalResponsibleSeatAvailable: true,
    });

    await expect(
      api.createMinor({
        ...familyCommand(initial.householdId, initial.revision, 'wrong-region'),
        username: 'nico',
        country: 'US' as 'MX',
        majorityAt: '2035-01-01',
        declarationVersion: 'responsible-declaration-v1',
        consentVersion: 'minor-privacy-v1',
      }),
    ).rejects.toMatchObject({ code: 'LEGAL_REGION_UNSUPPORTED' });

    const first = await api.createMinor({
      ...familyCommand(initial.householdId, initial.revision, 'nico'),
      username: 'nico',
      country: 'MX',
      majorityAt: '2035-01-01',
      declarationVersion: 'responsible-declaration-v1',
      consentVersion: 'minor-privacy-v1',
    });
    expect(first.minor).toMatchObject({ accountType: 'minor', username: 'nico' });
    expect(first.tempPassword).toEqual(expect.any(String));
    expect(first.household).toMatchObject({
      availableMinorSeats: 1,
      revision: initial.revision + 1,
    });
    expect(first.household.minors[0]).toMatchObject({
      user: { userId: first.minor.userId },
      seat: 1,
      majorityAt: '2035-01-01',
      coverageState: 'active',
    });
    expect(memoryIndexedDb.rows('coverages')).toContainEqual(
      expect.objectContaining({
        accountId: first.minor.userId,
        householdId: initial.householdId,
        source: 'test_seed',
        state: 'active',
      }),
    );

    await expect(
      api.createMinor({
        ...familyCommand(initial.householdId, initial.revision, 'stale'),
        username: 'stale',
        country: 'MX',
        majorityAt: '2035-01-01',
        declarationVersion: 'responsible-declaration-v1',
        consentVersion: 'minor-privacy-v1',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });

    const second = await api.createMinor({
      ...familyCommand(first.household.householdId, first.household.revision, 'val'),
      username: 'val',
      country: 'MX',
      majorityAt: '2036-01-01',
      declarationVersion: 'responsible-declaration-v1',
      consentVersion: 'minor-privacy-v1',
    });
    expect(second.household).toMatchObject({ availableMinorSeats: 0 });

    await expect(
      api.createMinor({
        ...familyCommand(second.household.householdId, second.household.revision, 'third'),
        username: 'third',
        country: 'MX',
        majorityAt: '2037-01-01',
        declarationVersion: 'responsible-declaration-v1',
        consentVersion: 'minor-privacy-v1',
      }),
    ).rejects.toMatchObject({ code: 'HOUSEHOLD_CAPACITY_EXCEEDED' });
  });

  it('lets only the current primary approve moving an existing minor account', async () => {
    const rocio = user('rocio', 'adult');
    const ana = user('ana', 'adult');
    const nico = user('nico', 'minor');
    for (const account of [rocio, ana, nico]) {
      memoryIndexedDb.seed('users', account.userId, account);
    }
    const sourceHouseholdId = seedHousehold(rocio, [nico]);
    const targetHouseholdId = seedHousehold(ana);
    memoryIndexedDb.seed('codes', 'LINKNICO', {
      code: 'LINKNICO',
      kind: 'linkExisting',
      userId: rocio.userId,
      minorId: nico.userId,
      expiresAt: Date.now() + 60_000,
    });

    const request = await apiFor(ana).createMinorLinkRequest({
      ...familyCommand(targetHouseholdId, 1, 'link-nico'),
      code: 'LINKNICO',
    });
    expect(request).toMatchObject({
      householdId: targetHouseholdId,
      minor: { userId: nico.userId },
      state: 'pending',
    });
    expect(memoryIndexedDb.rows('seatAssignments')).toContainEqual(
      expect.objectContaining({ householdId: sourceHouseholdId, accountId: nico.userId }),
    );

    await expect(
      apiFor(ana).approveMinorLinkRequest(
        request.requestId,
        familyCommand(targetHouseholdId, 1, 'self-approve'),
      ),
    ).rejects.toMatchObject({ code: 'CURRENT_PRIMARY_APPROVAL_REQUIRED' });

    const approved = await apiFor(rocio).approveMinorLinkRequest(
      request.requestId,
      familyCommand(targetHouseholdId, 1, 'current-primary-approve'),
    );
    expect(approved).toMatchObject({ state: 'approved' });
    expect(memoryIndexedDb.rows('seatAssignments')).toContainEqual(
      expect.objectContaining({ householdId: sourceHouseholdId, accountId: nico.userId }),
    );

    const moved = await apiFor(ana).acceptMinorLinkRequest(request.requestId, {
      ...familyCommand(targetHouseholdId, 1, 'target-primary-accepts'),
      responsibilityVersion: 'minor-link-responsibility-v1',
      privacyVersion: 'minor-link-privacy-v1',
    });
    expect(moved).toMatchObject({
      householdId: targetHouseholdId,
      primaryResponsible: { userId: ana.userId },
      minors: [{ user: { userId: nico.userId }, coverageState: 'active' }],
    });
    expect(memoryIndexedDb.rows('seatAssignments')).not.toContainEqual(
      expect.objectContaining({ householdId: sourceHouseholdId, accountId: nico.userId }),
    );
  });

  it('limits an additional responsible account to the minors selected by the primary', async () => {
    const rocio = user('rocio', 'adult');
    const sam = user('sam', 'adult');
    const nico = user('nico', 'minor');
    const val = user('val', 'minor');
    for (const account of [rocio, sam, nico, val]) {
      memoryIndexedDb.seed('users', account.userId, account);
    }
    const householdId = seedHousehold(rocio, [nico, val]);
    const primaryApi = apiFor(rocio);

    const invitation = await primaryApi.createAdditionalResponsibleInvitation({
      ...familyCommand(householdId, 1, 'invite-sam'),
      intendedAdultId: sam.userId,
      minorIds: [nico.userId],
    });
    const accepted = await apiFor(sam).acceptAdditionalResponsibleInvitation(
      invitation.invitationId,
      familyCommand(householdId, 1, 'accept-sam'),
    );
    expect(accepted).toMatchObject({
      myRole: 'additional_responsible',
      additionalResponsible: { user: { userId: sam.userId }, minorIds: [nico.userId] },
    });

    await expect(
      apiFor(sam).replaceAdditionalResponsibleScope({
        ...familyCommand(householdId, accepted.revision, 'sam-widens-scope'),
        minorIds: [nico.userId, val.userId],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const widened = await primaryApi.replaceAdditionalResponsibleScope({
      ...familyCommand(householdId, accepted.revision, 'primary-widens-scope'),
      minorIds: [nico.userId, val.userId],
    });
    expect(widened.additionalResponsible?.minorIds).toEqual([nico.userId, val.userId]);

    await expect(apiFor(sam).resetChildPassword(nico.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const revoked = await primaryApi.revokeAdditionalResponsible(
      familyCommand(householdId, widened.revision, 'revoke-sam'),
    );
    expect(revoked).toMatchObject({
      additionalResponsible: null,
      additionalResponsibleSeatAvailable: true,
    });
  });

  it('accepts an additional-responsible seat exactly once under concurrent claims', async () => {
    const rocio = user('rocio', 'adult');
    const sam = user('sam', 'adult');
    const lee = user('lee', 'adult');
    const nico = user('nico', 'minor');
    for (const account of [rocio, sam, lee, nico]) {
      memoryIndexedDb.seed('users', account.userId, account);
    }
    const householdId = seedHousehold(rocio, [nico]);
    const invitation = await apiFor(rocio).createAdditionalResponsibleInvitation({
      ...familyCommand(householdId, 1, 'single-seat-race'),
      intendedAdultId: sam.userId,
      minorIds: [nico.userId],
    });
    const heldWrite = memoryIndexedDb.holdNextPut('seatAssignments');
    const first = apiFor(sam).acceptAdditionalResponsibleInvitation(
      invitation.invitationId,
      familyCommand(householdId, 1, 'sam-claims'),
    );
    await heldWrite.started;
    const second = apiFor(lee).acceptAdditionalResponsibleInvitation(
      invitation.invitationId,
      familyCommand(householdId, 1, 'lee-claims'),
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    heldWrite.release();
    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const additionalSeats = memoryIndexedDb
      .rows('seatAssignments')
      .filter(
        (row) =>
          (row as { householdId: string }).householdId === householdId &&
          (row as { seatType: string }).seatType === 'additional_responsible',
      );
    expect(additionalSeats).toHaveLength(1);
    const winner = (additionalSeats[0] as { accountId: string }).accountId;
    expect(winner).toBe(sam.userId);
    expect(
      memoryIndexedDb
        .rows('supervisionLinks')
        .filter(
          (row) =>
            (row as { householdId: string }).householdId === householdId &&
            (row as { role: string }).role === 'additional_responsible',
        ),
    ).toEqual([expect.objectContaining({ adultId: winner, minorId: nico.userId })]);
  });

  it('does not recreate additional authority after that account closes concurrently', async () => {
    const rocio = user('rocio', 'adult');
    const sam = user('sam', 'adult');
    const nico = user('nico', 'minor');
    const val = user('val', 'minor');
    for (const account of [rocio, sam, nico, val]) {
      memoryIndexedDb.seed('users', account.userId, account);
    }
    const householdId = seedHousehold(rocio, [nico, val]);
    const invitation = await apiFor(rocio).createAdditionalResponsibleInvitation({
      ...familyCommand(householdId, 1, 'invite-sam-for-close-race'),
      intendedAdultId: sam.userId,
      minorIds: [nico.userId],
    });
    const accepted = await apiFor(sam).acceptAdditionalResponsibleInvitation(
      invitation.invitationId,
      familyCommand(householdId, 1, 'sam-accepts-before-close'),
    );
    const heldWrite = memoryIndexedDb.holdNextPut('supervisionLinks');
    const replace = apiFor(rocio).replaceAdditionalResponsibleScope({
      ...familyCommand(householdId, accepted.revision, 'widen-while-sam-closes'),
      minorIds: [nico.userId, val.userId],
    });
    await heldWrite.started;
    const closure = apiFor(sam).deleteMe();
    await new Promise((resolve) => setTimeout(resolve, 450));
    heldWrite.release();

    await expect(Promise.all([replace, closure])).resolves.toHaveLength(2);
    expect(memoryIndexedDb.rows('seatAssignments')).not.toContainEqual(
      expect.objectContaining({ accountId: sam.userId }),
    );
    expect(memoryIndexedDb.rows('supervisionLinks')).not.toContainEqual(
      expect.objectContaining({ adultId: sam.userId, state: 'active' }),
    );
    expect(memoryIndexedDb.rows('coverages')).not.toContainEqual(
      expect.objectContaining({ accountId: sam.userId }),
    );
  });

  it('serializes primary transfer before the incoming responsible can close', async () => {
    const rocio = user('rocio', 'adult');
    const sam = user('sam', 'adult');
    const nico = user('nico', 'minor');
    for (const account of [rocio, sam, nico]) {
      memoryIndexedDb.seed('users', account.userId, account);
    }
    const householdId = seedHousehold(rocio, [nico]);
    const invitation = await apiFor(rocio).createAdditionalResponsibleInvitation({
      ...familyCommand(householdId, 1, 'invite-sam-for-transfer'),
      intendedAdultId: sam.userId,
      minorIds: [nico.userId],
    });
    const accepted = await apiFor(sam).acceptAdditionalResponsibleInvitation(
      invitation.invitationId,
      familyCommand(householdId, 1, 'sam-accepts-before-transfer'),
    );
    const heldWrite = memoryIndexedDb.holdNextPut('households');
    const transfer = apiFor(rocio).transferPrimaryResponsibility({
      ...familyCommand(householdId, accepted.revision, 'transfer-to-sam'),
      newPrimaryAccountId: sam.userId,
    });
    await heldWrite.started;
    const closure = apiFor(sam).deleteMe();
    await new Promise((resolve) => setTimeout(resolve, 450));
    heldWrite.release();
    const outcomes = await Promise.allSettled([transfer, closure]);

    expect(outcomes[0]).toMatchObject({ status: 'fulfilled' });
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'CONFLICT' }),
    });
    expect(memoryIndexedDb.rows('households')).toContainEqual(
      expect.objectContaining({
        householdId,
        primaryResponsibleId: sam.userId,
      }),
    );
    expect(memoryIndexedDb.rows('users')).toContainEqual(
      expect.objectContaining({ userId: sam.userId }),
    );
  });
});
