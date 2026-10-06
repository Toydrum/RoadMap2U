import { beforeEach, describe, expect, it } from 'vitest';

import { AuthProvider } from '../auth/auth-provider';
import { ApiError, CONSENT_KINDS, ConsentKind, LIMITS } from './contracts';
import { MockUserRow } from './mock-cloud';
import {
  assertSocialEnabled,
  friendshipClassForAccounts,
  hasCompleteMinorFriendConsents,
  MockApi,
} from './mock-api';
import { MockApiMemoryDb } from './mock-api-test-memory.spec-helper';

const NOW = 1_800_000_000_000;
const memory = new MockApiMemoryDb();

function user(userId: string, accountType: MockUserRow['accountType']): MockUserRow {
  return {
    userId,
    username: userId,
    displayName: userId,
    accountType,
    socialEnabled: true,
    createdAt: NOW,
    email: accountType === 'adult' ? `${userId}@example.com` : null,
    accountInstanceId: `instance:${userId}:1`,
  };
}

function tokenFor(caller: MockUserRow): string {
  return `mock.${btoa(
    JSON.stringify({
      sub: caller.userId,
      username: caller.username,
      accountInstanceId: caller.accountInstanceId,
    }),
  )}.token`;
}

function apiFor(caller: MockUserRow): MockApi {
  return new MockApi({ idToken: async () => tokenFor(caller) } as unknown as AuthProvider);
}

function seedHousehold(primary: MockUserRow, minor: MockUserRow): string {
  const householdId = `household:${primary.userId}`;
  memory.seed('households', householdId, {
    householdId,
    primaryResponsibleId: primary.userId,
    country: 'MX',
    state: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  memory.seed('seatAssignments', `${householdId}:minor:1`, {
    assignmentId: `${householdId}:minor:1`,
    householdId,
    seatType: 'minor',
    position: 1,
    accountId: minor.userId,
    majorityAt: '2035-01-01',
    assignedAt: NOW,
  });
  memory.seed('supervisionLinks', `${householdId}:${primary.userId}:${minor.userId}`, {
    linkId: `${householdId}:${primary.userId}:${minor.userId}`,
    householdId,
    adultId: primary.userId,
    minorId: minor.userId,
    role: 'primary_responsible',
    state: 'active',
    createdAt: NOW,
    revokedAt: null,
  });
  return householdId;
}

beforeEach(() => {
  memory.reset();
  memory.install();
});

describe('assertSocialEnabled', () => {
  it('allows social operations only when the caller enabled them', () => {
    expect(() => assertSocialEnabled({ socialEnabled: true })).not.toThrow();

    try {
      assertSocialEnabled({ socialEnabled: false });
      throw new Error('expected assertSocialEnabled to reject the caller');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('FORBIDDEN');
    }
  });
});

describe('friendship account classes', () => {
  it('accepts only adult-adult or minor-minor pairs', () => {
    expect(friendshipClassForAccounts('adult', 'adult')).toBe('adult_adult');
    expect(friendshipClassForAccounts('minor', 'minor')).toBe('minor_minor');

    for (const pair of [
      ['adult', 'minor'],
      ['minor', 'adult'],
    ] as const) {
      expect(() => friendshipClassForAccounts(pair[0], pair[1])).toThrowError(
        expect.objectContaining({ code: 'ADULT_MINOR_FRIENDSHIP_FORBIDDEN' }),
      );
    }
  });

  it('requires all four independent consent kinds in every permutation', () => {
    for (let mask = 0; mask < 16; mask += 1) {
      const present = CONSENT_KINDS.filter((_, index) => (mask & (1 << index)) !== 0);
      expect(hasCompleteMinorFriendConsents(present), `mask ${mask.toString(2)}`).toBe(mask === 15);
    }
    expect(hasCompleteMinorFriendConsents([...CONSENT_KINDS, CONSENT_KINDS[0]])).toBe(true);
  });
});

describe('MockApi social v2', () => {
  it('creates direct adult friendship but rejects a minor target without family traversal', async () => {
    const adultA = user('adult_a', 'adult');
    const adultB = user('adult_b', 'adult');
    const minorB = user('minor_b', 'minor');
    for (const account of [adultA, adultB, minorB]) {
      memory.seed('users', account.userId, account);
    }
    seedHousehold(adultB, minorB);
    memory.seed('codes', 'ADULTB1', {
      code: 'ADULTB1',
      kind: 'friend',
      userId: adultB.userId,
      minorId: null,
      expiresAt: Date.now() + 60_000,
    });
    memory.seed('codes', 'MINORB1', {
      code: 'MINORB1',
      kind: 'friend',
      userId: minorB.userId,
      minorId: null,
      expiresAt: Date.now() + 60_000,
    });

    const request = await apiFor(adultA).createAdultFriendRequest({ code: 'ADULTB1' });
    const friendship = await apiFor(adultB).acceptAdultFriendRequest(request.requestId);
    expect(friendship.user.userId).toBe(adultA.userId);
    expect(memory.rows<Record<string, unknown>>('friendships')).toContainEqual(
      expect.objectContaining({
        friendshipId: friendship.friendshipId,
        friendshipClass: 'adult_adult',
      }),
    );

    await expect(
      apiFor(adultA).createAdultFriendRequest({ code: 'MINORB1' }),
    ).rejects.toMatchObject({ code: 'ADULT_MINOR_FRIENDSHIP_FORBIDDEN' });
    await expect(apiFor(adultA).getForest(minorB.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('fails closed when legacy friendship commands try to bypass account-class policy', async () => {
    const adult = user('adult', 'adult');
    const minorA = user('minor_a', 'minor');
    const minorB = user('minor_b', 'minor');
    for (const account of [adult, minorA, minorB]) {
      memory.seed('users', account.userId, account);
    }
    memory.seed('codes', 'MINORA1', {
      code: 'MINORA1',
      kind: 'friend',
      userId: minorA.userId,
      minorId: null,
      expiresAt: Date.now() + 60_000,
    });
    memory.seed('codes', 'MINORB1', {
      code: 'MINORB1',
      kind: 'friend',
      userId: minorB.userId,
      minorId: null,
      expiresAt: Date.now() + 60_000,
    });

    await expect(apiFor(adult).createFriendRequest('MINORA1')).rejects.toMatchObject({
      code: 'ADULT_MINOR_FRIENDSHIP_FORBIDDEN',
    });
    await expect(apiFor(minorA).createFriendRequest('MINORB1')).rejects.toMatchObject({
      code: 'CONSENT_INCOMPLETE',
    });

    memory.seed('friendRequests', 'legacy-minor-request', {
      requestId: 'legacy-minor-request',
      fromId: minorA.userId,
      toId: minorB.userId,
      createdAt: NOW,
      expiresAt: Date.now() + 60_000,
    });
    await expect(apiFor(minorB).acceptFriendRequest('legacy-minor-request')).rejects.toMatchObject({
      code: 'CONSENT_INCOMPLETE',
    });
    expect(memory.rows('friendships')).toHaveLength(0);
  });

  it('redeems a one-use minor code exactly once under concurrent requests', async () => {
    const requesterA = user('requester_a', 'minor');
    const requesterB = user('requester_b', 'minor');
    const recipient = user('recipient', 'minor');
    for (const account of [requesterA, requesterB, recipient]) {
      memory.seed('users', account.userId, account);
    }
    const code = await apiFor(recipient).createMinorInviteCode({ minorId: recipient.userId });
    const heldWrite = memory.holdNextPut('minorFriendRequests');
    const first = apiFor(requesterA).createMinorFriendRequest({
      minorId: requesterA.userId,
      code: code.code,
    });
    await heldWrite.started;
    const second = apiFor(requesterB).createMinorFriendRequest({
      minorId: requesterB.userId,
      code: code.code,
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    heldWrite.release();
    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(memory.rows('minorFriendRequests')).toHaveLength(1);
    expect(memory.rows('codes')).toHaveLength(0);
  });

  it('keeps only one active minor invite code under concurrent rotations', async () => {
    const primary = user('primary', 'adult');
    const minor = user('minor', 'minor');
    memory.seed('users', primary.userId, primary);
    memory.seed('users', minor.userId, minor);
    seedHousehold(primary, minor);
    const heldWrite = memory.holdNextPut('codes');
    const first = apiFor(primary).createMinorInviteCode({ minorId: minor.userId });
    await heldWrite.started;
    const second = apiFor(minor).createMinorInviteCode({ minorId: minor.userId });
    await new Promise((resolve) => setTimeout(resolve, 450));
    heldWrite.release();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(
      memory
        .rows<{ kind: string; minorId: string | null }>('codes')
        .filter((code) => code.kind === 'minorFriend' && code.minorId === minor.userId),
    ).toHaveLength(1);
  });

  it('rate-limits invalid minor-code redemption attempts per account', async () => {
    const requester = user('requester', 'minor');
    memory.seed('users', requester.userId, requester);
    const api = apiFor(requester);

    for (let attempt = 0; attempt < LIMITS.codeAttemptsPerHour; attempt += 1) {
      await expect(
        api.createMinorFriendRequest({
          minorId: requester.userId,
          code: `BAD${attempt.toString().padStart(5, '0')}`,
        }),
      ).rejects.toMatchObject({ code: 'CODE_INVALID' });
    }
    await expect(
      api.createMinorFriendRequest({ minorId: requester.userId, code: 'BAD99999' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('activates a minor friendship only after both minors and both responsible adults consent', async () => {
    const primaryA = user('primary_a', 'adult');
    const primaryB = user('primary_b', 'adult');
    const stranger = user('stranger', 'adult');
    const minorA = user('minor_a', 'minor');
    const minorB = user('minor_b', 'minor');
    for (const account of [primaryA, primaryB, stranger, minorA, minorB]) {
      memory.seed('users', account.userId, account);
    }
    seedHousehold(primaryA, minorA);
    seedHousehold(primaryB, minorB);
    memory.seed('guardianLinks', `${stranger.userId}~${minorA.userId}`, {
      linkId: `${stranger.userId}~${minorA.userId}`,
      guardianId: stranger.userId,
      minorId: minorA.userId,
      kind: 'created',
      createdAt: NOW,
    });
    memory.seed('supervisionLinks', `stale:${stranger.userId}:${minorA.userId}`, {
      linkId: `stale:${stranger.userId}:${minorA.userId}`,
      householdId: 'household:old',
      adultId: stranger.userId,
      minorId: minorA.userId,
      role: 'additional_responsible',
      state: 'revoked',
      createdAt: NOW - 1,
      revokedAt: NOW,
    });

    const code = await apiFor(minorB).createMinorInviteCode({ minorId: minorB.userId });
    await expect(
      apiFor(primaryA).createMinorFriendRequest({ minorId: primaryA.userId, code: code.code }),
    ).rejects.toMatchObject({ code: 'ADULT_MINOR_FRIENDSHIP_FORBIDDEN' });

    let request = await apiFor(minorA).createMinorFriendRequest({
      minorId: minorA.userId,
      code: code.code,
    });
    expect(request.state).toBe('pending');
    expect(request.revision).toBe(2);
    expect(request.consents.map((consent) => consent.kind)).toEqual(['requester_action']);

    await expect(
      apiFor(stranger).approveMinorFriendRequest(request.requestId, {
        minorId: minorA.userId,
        commandId: 'stranger-approval',
        policyVersion: 'minor-social-v1',
      }),
    ).rejects.toMatchObject({ code: 'RESPONSIBLE_SCOPE_REQUIRED' });

    request = await apiFor(primaryA).approveMinorFriendRequest(request.requestId, {
      minorId: minorA.userId,
      commandId: 'requester-responsible',
      policyVersion: 'minor-social-v1',
    });
    expect(request.revision).toBe(3);
    memory.seed('users', minorB.userId, { ...minorB, socialEnabled: false });
    await expect(
      apiFor(minorB).acceptMinorFriendRequest(request.requestId, {
        minorId: minorB.userId,
        commandId: 'recipient-disabled',
        policyVersion: 'minor-social-v1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    memory.seed('users', minorB.userId, minorB);
    request = await apiFor(minorB).acceptMinorFriendRequest(request.requestId, {
      minorId: minorB.userId,
      commandId: 'recipient-accepts',
      policyVersion: 'minor-social-v1',
    });
    expect(request.state).toBe('pending');
    expect(request.revision).toBe(4);
    expect(memory.rows('friendships')).toHaveLength(0);

    request = await apiFor(primaryB).approveMinorFriendRequest(request.requestId, {
      minorId: minorB.userId,
      commandId: 'recipient-responsible',
      policyVersion: 'minor-social-v1',
    });
    expect(request.state).toBe('active');
    expect(request.revision).toBe(6);
    expect(new Set(request.consents.map((consent) => consent.kind))).toEqual(
      new Set<ConsentKind>(CONSENT_KINDS),
    );
    expect(memory.rows<Record<string, unknown>>('friendships')).toContainEqual(
      expect.objectContaining({ friendshipClass: 'minor_minor' }),
    );

    const [edge] = memory.rows<{ friendshipId: string }>('friendships');
    await apiFor(primaryA).removeMinorFriendship(edge.friendshipId);
    expect(memory.rows('friendships')).toHaveLength(0);
    expect(memory.rows<Record<string, unknown>>('minorFriendRequests')).toContainEqual(
      expect.objectContaining({ requestId: request.requestId, state: 'revoked' }),
    );
  });
});
