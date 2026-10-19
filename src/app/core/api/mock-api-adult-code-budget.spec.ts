import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthProvider } from '../auth/auth-provider';
import {
  ADULT_PRIVACY_VERSIONS,
  LIMITS,
  type CreateAdultFriendRequestRequest,
  type PrivacyConsentCommand,
} from './contracts';
import { MockApi } from './mock-api';
import { MockApiMemoryDb } from './mock-api-test-memory.spec-helper';
import type { MockCodeRow, MockFriendRequestRow, MockUserRow } from './mock-cloud';
import { MOCK_USERS } from './mock-seed';
import { privacyDocument } from './privacy-document';

// The v2 public API runs against its real memory adapter and normal admission.
// Five bearer lookups per hour, valid or invalid: family readiness plan 176–177.
// No legacy-v1 call, browser, real login, cloud grant or account service here.
const NOW = Date.parse('2026-10-18T18:15:00.000Z');
const CAP = 5;
const memory = new MockApiMemoryDb();
let fetchAttempts = 0;

beforeEach(() => {
  memory.reset();
  vi.stubGlobal('indexedDB', memory.indexedDb);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  fetchAttempts = 0;
  vi.stubGlobal('fetch', async () => {
    fetchAttempts++;
    throw Error('ADULT_CODE_BUDGET_FETCH_FORBIDDEN');
  });
  expect(LIMITS.codeAttemptsPerHour).toBe(CAP);
});

afterEach(() => {
  try {
    expect(fetchAttempts, 'the real mock source must not attempt fetch').toBe(0);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

function account(userId: string): MockUserRow {
  return {
    userId,
    username: userId,
    displayName: userId,
    accountType: 'adult',
    socialEnabled: true,
    email: `${userId}@example.invalid`,
    accountInstanceId: `budget-test:${userId}:1`,
    createdAt: NOW - 1_000,
  };
}

function tokenFor(owner: MockUserRow): string {
  // Source-supported unsigned mock token, never an actual Cognito token.
  return `mock.${btoa(JSON.stringify({
    sub: owner.userId,
    username: owner.username,
    accountInstanceId: owner.accountInstanceId,
    auth_time: Math.floor(NOW / 1_000),
    email_verified: owner.accountType === 'adult',
  }))}.token`;
}

function apiFor(owner: MockUserRow): MockApi {
  return new MockApi({ idToken: async () => tokenFor(owner) } as unknown as AuthProvider, {
    adultPrivacyMode: 'enforce',
    privateAdolescentMode: 'enforce',
  });
}

async function adultDeclaration(commandId: string): Promise<PrivacyConsentCommand> {
  const { hash } = await privacyDocument('es');
  return {
    action: 'declare_adult',
    commandId,
    expectedRevision: 0,
    language: 'es',
    documentHash: hash,
    ...ADULT_PRIVACY_VERSIONS,
    declareAdult: true,
    acceptTerms: true,
  };
}

async function admittedAdult(userId: string) {
  const owner = account(userId);
  memory.seed('users', owner.userId, owner);
  const api = apiFor(owner);
  const status = await api.changePrivacyConsent(await adultDeclaration(`declare-${userId}`));
  expect(status.scope).toBe('adult');
  expect(status.adultDeclared).toBe(true);
  expect(status.cloudConsent, 'admission never supplies optional cloud consent').toBe('absent');
  expect(status.canUseCloud).toBe(false);
  return { owner, api };
}

async function targetCodes(count: number) {
  const targets: Array<{ owner: MockUserRow; grant: MockCodeRow }> = [];
  for (let ordinal = 1; ordinal <= count; ordinal++) {
    const { owner } = await admittedAdult(`target_${ordinal}`);
    const grant: MockCodeRow = {
      code: `ADULT${String(ordinal).padStart(3, '0')}`,
      kind: 'friend',
      userId: owner.userId,
      minorId: null,
      expiresAt: NOW + 60_000,
    };
    memory.seed('codes', grant.code, grant);
    targets.push({ owner, grant });
  }
  return targets;
}

function reservations(owner: MockUserRow): number {
  const key = `rate:${owner.userId}:${Math.floor(NOW / 3_600_000)}`;
  return memory.rows<{ key: string; value: number }>('kv').find(row => row.key === key)?.value ?? 0;
}

describe('MockApi adult bearer-code budget v2 under privacy enforce', () => {
  it('counts five invalid lookups and rate-limits the sixth', async () => {
    const { owner, api } = await admittedAdult('lookup_caller');
    for (let ordinal = 0; ordinal < CAP; ordinal++) {
      await expect(api.createAdultFriendRequest({ code: `MISSING${ordinal}` })).rejects.toMatchObject({
        code: 'CODE_INVALID',
      });
    }
    await expect(api.createAdultFriendRequest({ code: 'MISSING5' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(reservations(owner), 'only the five permitted lookups are reserved').toBe(CAP);
    expect(memory.rows('friendRequests')).toEqual([]);
    expect(memory.rows('friendships')).toEqual([]);
  });

  it('counts valid lookups too without creating a sixth request', async () => {
    const { owner, api } = await admittedAdult('valid_caller');
    const targets = await targetCodes(CAP + 1);
    for (const { owner: target, grant } of targets.slice(0, CAP)) {
      const request = await api.createAdultFriendRequest({ code: grant.code });
      expect(request.user.userId).toBe(target.userId);
    }
    await expect(api.createAdultFriendRequest({ code: targets[CAP].grant.code })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    const requests = memory.rows<MockFriendRequestRow>('friendRequests');
    expect(requests).toHaveLength(CAP);
    expect(requests.some(row => row.toId === targets[CAP].owner.userId)).toBe(false);
    expect(reservations(owner), 'successful lookups count too').toBe(CAP);
    expect(memory.rows('friendships'), 'requesting never grants friendship').toEqual([]);
    expect(memory.rows<MockCodeRow>('codes'), 'lookups do not consume bearer codes').toEqual(
      targets.map(target => target.grant),
    );
  });

  it('retains CODE_EXPIRED and the stored grant while consuming one lookup', async () => {
    const { owner, api } = await admittedAdult('expired_caller');
    const [{ grant }] = await targetCodes(1);
    const expired = { ...grant, expiresAt: NOW - 1 };
    memory.seed('codes', expired.code, expired);
    await expect(api.createAdultFriendRequest({ code: expired.code })).rejects.toMatchObject({
      code: 'CODE_EXPIRED',
    });
    expect(memory.rows('codes'), 'a failed lookup cannot delete or renew the grant').toEqual([expired]);
    expect(reservations(owner)).toBe(1);
    expect(memory.rows('friendRequests')).toEqual([]);
  });

  it('allows exactly five reservations and requests from six concurrent valid lookups', async () => {
    const { owner, api } = await admittedAdult('parallel_caller');
    const targets = await targetCodes(CAP + 1);
    const results = await Promise.allSettled(
      targets.map(({ grant }) => api.createAdultFriendRequest({ code: grant.code })),
    );
    const accepted = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(accepted, 'concurrent requests share one atomic five-lookup allowance').toHaveLength(CAP);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'RATE_LIMITED' });
    expect(reservations(owner)).toBe(CAP);
    const requests = memory.rows<MockFriendRequestRow>('friendRequests');
    expect(requests).toHaveLength(CAP);
    expect(new Set(requests.map(row => row.requestId)).size).toBe(CAP);
    expect(requests.every(row => row.fromId === owner.userId)).toBe(true);
    expect(memory.rows('friendships')).toEqual([]);
  });

  it('rejects non-string or empty input before any lookup reservation', async () => {
    const { owner, api } = await admittedAdult('input_caller');
    const before = structuredClone(memory.rows('kv'));
    for (const code of [undefined, null, 12, {}, '', ' \t\n ', '--']) {
      const malformed = { code } as unknown as CreateAdultFriendRequestRequest;
      await expect(api.createAdultFriendRequest(malformed)).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(reservations(owner)).toBe(0);
    expect(memory.rows('kv'), 'invalid shape or normalized emptiness writes no budget or consent').toEqual(before);
    expect(memory.rows('friendRequests')).toEqual([]);
  });

  it('retains all five lookup slots after rejecting one malformed input', async () => {
    const { owner, api } = await admittedAdult('input_capacity');
    await expect(api.createAdultFriendRequest({ code: '' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(reservations(owner)).toBe(0);
    for (let ordinal = 0; ordinal < CAP; ordinal++) {
      await expect(api.createAdultFriendRequest({ code: `ABSENT${ordinal}` })).rejects.toMatchObject({
        code: 'CODE_INVALID',
      });
    }
    await expect(api.createAdultFriendRequest({ code: 'ABSENT5' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('keeps original Nico and Val as unsupported minors without promoting them into the adult flow', async () => {
    for (const username of ['nico', 'val']) {
      memory.reset();
      const original = MOCK_USERS.find(row => row.username === username);
      if (!original) throw Error('expected source demo account');
      expect(original.accountType).toBe('minor');
      const owner = { ...structuredClone(original), accountInstanceId: `budget-minor:${username}:1` };
      memory.seed('users', owner.userId, owner);
      const api = apiFor(owner);
      const usersBefore = structuredClone(memory.rows('users'));
      const kvBefore = structuredClone(memory.rows('kv'));
      const status = await api.getPrivacyStatus('es');
      expect(status.scope).toBe('unsupported');
      expect(status.adultDeclared).toBe(false);
      await expect(api.createAdultFriendRequest({ code: 'MISSING0' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(api.changePrivacyConsent(await adultDeclaration(`minor-declare-${username}`))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(memory.rows('users')).toEqual(usersBefore);
      expect(memory.rows('kv')).toEqual(kvBefore);
      expect(memory.rows('friendRequests')).toEqual([]);
      expect(memory.rows('friendships')).toEqual([]);
    }
  });

  it('rejects a switch from admitted A to admitted B after reserving A without creating a request as B', async () => {
    const { owner: first } = await admittedAdult('identity_a');
    const { owner: replacement } = await admittedAdult('identity_b');
    const [{ grant }] = await targetCodes(1);
    const changingAuth = {
      idToken: async () => tokenFor(reservations(first) >= 1 ? replacement : first),
    } as unknown as AuthProvider;
    const api = new MockApi(changingAuth, {
      adultPrivacyMode: 'enforce',
      privateAdolescentMode: 'enforce',
    });

    await expect(api.createAdultFriendRequest({ code: grant.code })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(reservations(first), 'the original identity consumed the single attempt').toBe(1);
    expect(reservations(replacement), 'a new identity cannot inherit or reserve a second attempt').toBe(0);
    expect(memory.rows('friendRequests')).toEqual([]);
    expect(memory.rows('friendships')).toEqual([]);
  });

  it('rejects a privacy-off minor caller before reserving or looking up an adult bearer code', async () => {
    const [{ grant }] = await targetCodes(1);
    const original = MOCK_USERS.find(row => row.username === 'val');
    if (!original) throw Error('expected source Val account');
    expect(original.accountType).toBe('minor');
    expect(original.socialEnabled).toBe(true);
    const minor = { ...structuredClone(original), accountInstanceId: 'budget-off-minor:val:1' };
    memory.seed('users', minor.userId, minor);
    const before = structuredClone(memory.rows('users'));
    const codeLookup = vi.spyOn(memory.store('codes'), 'get');
    const api = new MockApi({ idToken: async () => tokenFor(minor) } as unknown as AuthProvider, {
      adultPrivacyMode: 'off',
      privateAdolescentMode: 'off',
    });

    await expect(api.createAdultFriendRequest({ code: grant.code })).rejects.toMatchObject({
      code: 'ACCOUNT_TYPE_INCOMPATIBLE',
    });
    expect(codeLookup, 'account class is checked before the bearer-code lookup').not.toHaveBeenCalled();
    expect(reservations(minor)).toBe(0);
    expect(memory.rows('users')).toEqual(before);
    expect(memory.rows('friendRequests')).toEqual([]);
    expect(memory.rows('friendships')).toEqual([]);
  });
});
