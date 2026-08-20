import { ApiClient } from './api-client';
import {
  AccessSummary,
  AccountClosureReceipt,
  ApiError,
  ApiErrorCode,
  CONTRACT_VERSION,
  CodeGrant,
  CreateChildRequest,
  CreateChildResponse,
  FamilyInviteRequest,
  FamilyLinkView,
  FriendRequestView,
  FriendView,
  FriendsResponse,
  ForestSnapshot,
  LIMITS,
  MeResponse,
  PREPAYMENT_PLAN_CATALOG,
  PlanCatalog,
  PublicProfile,
  SyncChangesResponse,
  SyncPushPayload,
  SyncRecord,
  SyncPushResponse,
  UserProfile,
  createFreeAccessSummary,
} from './contracts';
import {
  CheckIn,
  ExportEnvelope,
  Harvest,
  Preserve,
  SCHEMA_VERSION,
  TimerSession,
  Tree,
  TreeNode,
} from '../db/schema';
import { AuthProvider } from '../auth/auth-provider';
import { USERNAME_PATTERN } from '../auth/auth-types';
import { parseMockToken } from '../auth/mock-auth.provider';
import {
  MockCodeRow,
  MockCredentialRow,
  MockFriendRequestRow,
  MockFriendshipRow,
  MockGuardianLinkRow,
  MockRecordRow,
  MockUserRow,
  mockApplyRecordGroup,
  mockDelete,
  mockGet,
  mockGetAll,
  mockHash,
  mockNextSeq,
  mockPut,
  simLatency,
} from './mock-cloud';

const INVITE_TTL_MS = 72 * 3600 * 1000;

export function assertSocialEnabled(user: Pick<MockUserRow, 'socialEnabled'>): void {
  if (!user.socialEnabled) throw new ApiError('FORBIDDEN', 'social features are off');
}

/**
 * The executable contract spec: same interface, same permission rules, same
 * error codes the Lambdas must implement — running against the on-device
 * mock cloud. Endpoints land with their phase; the ones that would silently
 * lie if stubbed throw instead.
 */
export class MockApi implements ApiClient {
  constructor(private readonly auth: AuthProvider) {}

  // ── commercial access ────────────────────────────────────────────────────

  async getPlans(): Promise<PlanCatalog> {
    // Public and compiled: deliberately does not call auth or mock-cloud.
    return PREPAYMENT_PLAN_CATALOG;
  }

  async getAccess(): Promise<AccessSummary> {
    await simLatency('api.getAccess');
    await this.caller();
    return createFreeAccessSummary();
  }

  async redeemAccessCode(_code: string): Promise<AccessSummary> {
    await simLatency('api.redeemAccessCode');
    const caller = await this.caller();
    if (caller.accountType !== 'adult') throw new ApiError('FORBIDDEN');
    // The device mock has no HMAC secret or owner broker. Accepting a magic or
    // arbitrary string here would create a false Premium security model.
    throw new ApiError('ACCESS_CODE_INVALID');
  }

  // ── me (phase «cuentas») ──────────────────────────────────────────────────

  async getMe(): Promise<MeResponse> {
    await simLatency('api.getMe');
    const caller = await this.caller();
    const links = await mockGetAll<MockGuardianLinkRow>('guardianLinks');
    const guardians: FamilyLinkView[] = [];
    const minors: FamilyLinkView[] = [];
    for (const link of links) {
      if (link.minorId === caller.userId) {
        guardians.push(await this.linkView(link, link.guardianId, false));
      } else if (link.guardianId === caller.userId) {
        minors.push(await this.linkView(link, link.minorId, true));
      }
    }
    return { profile: this.profileOf(caller), family: { guardians, minors } };
  }

  async patchMe(patch: { displayName?: string }): Promise<UserProfile> {
    await simLatency('api.patchMe');
    const caller = await this.caller();
    const displayName = patch.displayName?.trim();
    if (displayName !== undefined) {
      if (!displayName || displayName.length > 40) throw new ApiError('VALIDATION');
      caller.displayName = displayName;
      await mockPut('users', caller);
    }
    return this.profileOf(caller);
  }

  async deleteMe(): Promise<AccountClosureReceipt> {
    await simLatency('api.deleteMe');
    const caller = await this.caller();
    await this.auth.deleteAccount();
    return { closureId: `mock:${caller.userId}`, state: 'completed' };
  }

  // ── family (phase «familia») ──────────────────────────────────────────────

  async createChild(req: CreateChildRequest): Promise<CreateChildResponse> {
    await simLatency('api.createChild');
    const caller = await this.caller();
    if (caller.accountType !== 'adult')
      throw new ApiError('FORBIDDEN', 'only adults create minors');
    const username = req.username?.trim().toLowerCase() ?? '';
    const displayName = req.displayName?.trim() ?? '';
    if (!USERNAME_PATTERN.test(username))
      throw new ApiError('VALIDATION', 'username 3-20 [a-z0-9_]');
    if (!displayName || displayName.length > 40)
      throw new ApiError('VALIDATION', 'displayName 1-40');
    if ((await this.minorsOf(caller.userId)).length >= LIMITS.maxChildrenPerGuardian) {
      throw new ApiError('LIMIT_EXCEEDED');
    }
    if (await mockGet<MockCredentialRow>('credentials', username)) {
      throw new ApiError('USERNAME_TAKEN');
    }
    const tempPassword = await this.mintTempPassword(username);
    const now = Date.now();
    const child: MockUserRow = {
      userId: `u-${username}`,
      username,
      displayName,
      accountType: 'minor',
      socialEnabled: false,
      createdAt: now,
      email: null,
    };
    await mockPut('users', child);
    await mockPut('credentials', {
      username,
      userId: child.userId,
      password: tempPassword,
      mustChangePassword: true,
      pendingConfirm: false,
    } satisfies MockCredentialRow);
    await mockPut('guardianLinks', this.newLink(caller.userId, child.userId, 'created', now));
    return { child: this.profileOf(child), tempPassword };
  }

  async resetChildPassword(userId: string): Promise<{ tempPassword: string }> {
    await simLatency('api.resetChildPassword');
    const caller = await this.caller();
    await this.requireCreatedLink(caller.userId, userId);
    const child = await mockGet<MockUserRow>('users', userId);
    if (!child) throw new ApiError('NOT_FOUND');
    const cred = await mockGet<MockCredentialRow>('credentials', child.username);
    if (!cred) throw new ApiError('NOT_FOUND');
    const tempPassword = await this.mintTempPassword(child.username);
    await mockPut('credentials', { ...cred, password: tempPassword, mustChangePassword: true });
    return { tempPassword };
  }

  async patchChild(
    userId: string,
    patch: { displayName?: string; socialEnabled?: boolean },
  ): Promise<UserProfile> {
    await simLatency('api.patchChild');
    const caller = await this.caller();
    await this.requireCreatedLink(caller.userId, userId);
    const child = await mockGet<MockUserRow>('users', userId);
    if (!child) throw new ApiError('NOT_FOUND');
    if (patch.displayName !== undefined) {
      const displayName = patch.displayName.trim();
      if (!displayName || displayName.length > 40) throw new ApiError('VALIDATION');
      child.displayName = displayName;
    }
    if (patch.socialEnabled !== undefined) child.socialEnabled = !!patch.socialEnabled;
    await mockPut('users', child);
    return this.profileOf(child);
  }

  async exportChild(userId: string): Promise<ExportEnvelope> {
    await simLatency('api.exportChild');
    const caller = await this.caller();
    await this.requireCreatedLink(caller.userId, userId);
    const records = (await mockGetAll<MockRecordRow>('records')).filter(
      (r) => r.ownerId === userId,
    );
    const of = <T>(store: string): T[] =>
      records.filter((r) => r.store === store).map((r) => r.record as T);
    return {
      app: 'roadmap2u',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      data: {
        trees: of<Tree>('trees'),
        nodes: of<TreeNode>('nodes'),
        checkins: of<CheckIn>('checkins'),
        sessions: of<TimerSession>('sessions'),
        harvests: of<Harvest>('harvests'),
        preserves: of<Preserve>('preserves'),
        settings: null, // device preferences never reach the cloud
      },
    };
  }

  /** Export-first is the CLIENT flow; here the purge is total and final. */
  async deleteChild(userId: string): Promise<void> {
    await simLatency('api.deleteChild');
    const caller = await this.caller();
    await this.requireCreatedLink(caller.userId, userId);
    const child = await mockGet<MockUserRow>('users', userId);
    if (!child) throw new ApiError('NOT_FOUND');

    await mockDelete('credentials', child.username);
    await mockDelete('users', userId);
    for (const link of await mockGetAll<MockGuardianLinkRow>('guardianLinks')) {
      if (link.minorId === userId || link.guardianId === userId) {
        await mockDelete('guardianLinks', link.linkId);
      }
    }
    for (const friendship of await mockGetAll<MockFriendshipRow>('friendships')) {
      if (friendship.userA === userId || friendship.userB === userId) {
        await mockDelete('friendships', friendship.friendshipId);
      }
    }
    for (const request of await mockGetAll<MockFriendRequestRow>('friendRequests')) {
      if (request.fromId === userId || request.toId === userId) {
        await mockDelete('friendRequests', request.requestId);
      }
    }
    for (const code of await mockGetAll<MockCodeRow>('codes')) {
      if (code.userId === userId || code.minorId === userId) {
        await mockDelete('codes', code.code);
      }
    }
    for (const record of await mockGetAll<MockRecordRow>('records')) {
      if (record.ownerId === userId) await mockDelete('records', record.key);
    }
  }

  async deleteFamilyLink(linkId: string): Promise<void> {
    await simLatency('api.deleteFamilyLink');
    const caller = await this.caller();
    const link = await mockGet<MockGuardianLinkRow>('guardianLinks', linkId);
    if (!link) throw new ApiError('NOT_FOUND');
    const callerIsGuardian = caller.userId === link.guardianId;
    const callerIsMinorSide = caller.userId === link.minorId && link.kind === 'invited';
    if (!callerIsGuardian && !callerIsMinorSide) throw new ApiError('NOT_FOUND');
    if (link.kind === 'created') {
      const remaining = (await this.guardiansOf(link.minorId)).filter(
        (l) => l.linkId !== link.linkId,
      );
      if (!remaining.length) throw new ApiError('LAST_GUARDIAN');
    }
    await mockDelete('guardianLinks', linkId);
  }

  async createFamilyInvite(req: FamilyInviteRequest): Promise<CodeGrant> {
    await simLatency('api.createFamilyInvite');
    const caller = await this.caller();
    if (caller.accountType !== 'adult') throw new ApiError('FORBIDDEN');
    let minorId: string | null = null;
    if (req.kind === 'coGuardian') {
      await this.requireCreatedLink(caller.userId, req.minorId);
      if ((await this.guardiansOf(req.minorId)).length >= LIMITS.maxGuardiansPerMinor) {
        throw new ApiError('LIMIT_EXCEEDED');
      }
      minorId = req.minorId;
    } else if (req.kind !== 'linkExisting') {
      throw new ApiError('VALIDATION', 'unknown invite kind');
    }
    const code = await this.mintCode();
    const expiresAt = Date.now() + INVITE_TTL_MS;
    await mockPut('codes', {
      code,
      kind: req.kind,
      userId: caller.userId,
      minorId,
      expiresAt,
    } satisfies MockCodeRow);
    return { code, expiresAt };
  }

  async acceptFamilyInvite(rawCode: string): Promise<FamilyLinkView> {
    await simLatency('api.acceptFamilyInvite');
    const caller = await this.caller();
    const code = rawCode?.trim().toUpperCase().replace(/-/g, '');
    if (!code) throw new ApiError('VALIDATION');
    // Same code-guessing brake as friend codes (the contract scopes it to
    // BAD redemptions of any code — family invites were uncovered).
    const bucket = Math.floor(Date.now() / 3_600_000);
    const rateKey = `rate:${caller.userId}:${bucket}`;
    const attempts = (await mockGet<{ key: string; value: number }>('kv', rateKey))?.value ?? 0;
    if (attempts >= LIMITS.codeAttemptsPerHour) throw new ApiError('RATE_LIMITED');
    const badAttempt = async (errorCode: ApiErrorCode): Promise<never> => {
      await mockNextSeq(rateKey);
      throw new ApiError(errorCode);
    };
    const invite = await mockGet<MockCodeRow>('codes', code);
    if (!invite || invite.kind === 'friend') return badAttempt('CODE_INVALID');
    if (invite.expiresAt <= Date.now()) return badAttempt('CODE_EXPIRED');

    const now = Date.now();
    if (invite.kind === 'coGuardian') {
      // Redeemer becomes a co-guardian (full admin) of the invite's minor.
      if (caller.accountType !== 'adult') throw new ApiError('FORBIDDEN');
      const minorId = invite.minorId;
      if (!minorId) return badAttempt('CODE_INVALID');
      const issuerLink = await this.linkBetween(invite.userId, minorId);
      if (issuerLink?.kind !== 'created') return badAttempt('CODE_INVALID');
      const minor = await mockGet<MockUserRow>('users', minorId);
      if (!minor) throw new ApiError('NOT_FOUND');
      if (await this.linkBetween(caller.userId, minorId)) {
        throw new ApiError('CONFLICT', 'already a guardian');
      }
      if ((await this.guardiansOf(minorId)).length >= LIMITS.maxGuardiansPerMinor) {
        throw new ApiError('LIMIT_EXCEEDED');
      }
      const link = this.newLink(caller.userId, minorId, 'created', now);
      await mockPut('guardianLinks', link);
      await mockDelete('codes', code); // single-use
      return this.linkView(link, minorId, true);
    }

    // linkExisting: the REDEEMER consents to become the issuer's invited minor.
    const issuer = await mockGet<MockUserRow>('users', invite.userId);
    if (!issuer) throw new ApiError('CODE_INVALID');
    if (invite.userId === caller.userId) throw new ApiError('VALIDATION', 'own invite');
    if (await this.linkBetween(invite.userId, caller.userId)) {
      throw new ApiError('CONFLICT', 'already linked');
    }
    if ((await this.minorsOf(invite.userId)).length >= LIMITS.maxChildrenPerGuardian) {
      throw new ApiError('LIMIT_EXCEEDED');
    }
    const link = this.newLink(invite.userId, caller.userId, 'invited', now);
    await mockPut('guardianLinks', link);
    await mockDelete('codes', code);
    // The redeemer sees the GUARDIAN on the other end of the new link.
    return this.linkView(link, invite.userId, false);
  }

  async revokeFamilyInvite(rawCode: string): Promise<void> {
    await simLatency('api.revokeFamilyInvite');
    const caller = await this.caller();
    const code = rawCode?.trim().toUpperCase().replace(/-/g, '') ?? '';
    const invite = await mockGet<MockCodeRow>('codes', code);
    if (!invite || invite.userId !== caller.userId || invite.kind === 'friend') {
      throw new ApiError('NOT_FOUND');
    }
    await mockDelete('codes', code);
  }

  /** Guardian oversight — same list the minor sees; removal, never initiation. */
  async listChildFriends(userId: string): Promise<FriendsResponse> {
    await simLatency('api.listChildFriends');
    const caller = await this.caller();
    if (!(await this.linkBetween(caller.userId, userId))) throw new ApiError('NOT_FOUND');
    return this.friendsOf(userId);
  }

  async removeChildFriendship(userId: string, friendshipId: string): Promise<void> {
    await simLatency('api.removeChildFriendship');
    const caller = await this.caller();
    if (!(await this.linkBetween(caller.userId, userId))) throw new ApiError('NOT_FOUND');
    await this.removeFriendshipAs(userId, friendshipId);
  }

  async cancelChildRequest(userId: string, requestId: string): Promise<void> {
    await simLatency('api.cancelChildRequest');
    const caller = await this.caller();
    if (!(await this.linkBetween(caller.userId, userId))) throw new ApiError('NOT_FOUND');
    const request = await mockGet<MockFriendRequestRow>('friendRequests', requestId);
    if (!request || request.fromId !== userId) throw new ApiError('NOT_FOUND');
    await mockDelete('friendRequests', requestId);
  }

  // ── friends ───────────────────────────────────────────────────────────────

  async getFriends(): Promise<FriendsResponse> {
    await simLatency('api.getFriends');
    const caller = await this.caller();
    this.requireSocial(caller);
    return this.friendsOf(caller.userId);
  }

  async getFriendCode(): Promise<CodeGrant> {
    await simLatency('api.getFriendCode');
    const caller = await this.caller();
    this.requireSocial(caller);
    const now = Date.now();
    const existing = (await mockGetAll<MockCodeRow>('codes')).find(
      (c) => c.kind === 'friend' && c.userId === caller.userId && c.expiresAt > now,
    );
    if (existing) return { code: existing.code, expiresAt: existing.expiresAt };
    return this.mintFriendCode(caller.userId);
  }

  async rotateFriendCode(): Promise<CodeGrant> {
    await simLatency('api.rotateFriendCode');
    const caller = await this.caller();
    this.requireSocial(caller);
    return this.mintFriendCode(caller.userId);
  }

  async createFriendRequest(rawCode: string): Promise<FriendRequestView> {
    await simLatency('api.createFriendRequest');
    const caller = await this.caller();
    this.requireSocial(caller);
    const code = rawCode?.trim().toUpperCase().replace(/-/g, '');
    if (!code) throw new ApiError('VALIDATION', 'code required');

    // Code-guessing brake: only BAD redemptions count (contract law — five
    // valid requests in an hour must never lock out the sixth).
    const bucket = Math.floor(Date.now() / 3_600_000);
    const rateKey = `rate:${caller.userId}:${bucket}`;
    const attempts = (await mockGet<{ key: string; value: number }>('kv', rateKey))?.value ?? 0;
    if (attempts >= LIMITS.codeAttemptsPerHour) throw new ApiError('RATE_LIMITED');
    const badAttempt = async (errorCode: ApiErrorCode, message?: string): Promise<never> => {
      await mockNextSeq(rateKey);
      throw new ApiError(errorCode, message);
    };

    const grant = await mockGet<MockCodeRow>('codes', code);
    if (!grant || grant.kind !== 'friend') return badAttempt('CODE_INVALID');
    if (grant.expiresAt <= Date.now()) return badAttempt('CODE_EXPIRED');
    if (grant.userId === caller.userId) throw new ApiError('VALIDATION', 'that is your own code');

    const target = await mockGet<MockUserRow>('users', grant.userId);
    if (!target || !target.socialEnabled) return badAttempt('CODE_INVALID');
    if (await this.friendshipBetween(caller.userId, grant.userId)) {
      throw new ApiError('CONFLICT', 'already friends');
    }
    const pending = await mockGetAll<MockFriendRequestRow>('friendRequests');
    const already = pending.find(
      (r) => r.fromId === caller.userId && r.toId === grant.userId && r.expiresAt > Date.now(),
    );
    if (already) throw new ApiError('CONFLICT', 'request already pending');
    // A pending request in the OPPOSITE direction means you're already mid-
    // handshake — redeeming back would mint a mutual pair that both accept.
    const inverse = pending.find(
      (r) => r.fromId === grant.userId && r.toId === caller.userId && r.expiresAt > Date.now(),
    );
    if (inverse) throw new ApiError('CONFLICT', 'they already asked you');
    const mine = (await mockGetAll<MockFriendshipRow>('friendships')).filter(
      (f) => f.userA === caller.userId || f.userB === caller.userId,
    );
    if (mine.length >= LIMITS.maxFriends) throw new ApiError('LIMIT_EXCEEDED');

    const now = Date.now();
    // DETERMINISTIC id (the Lambda's law): a double-submit race lands the
    // same key and the second write is a harmless overwrite, never a
    // duplicate row (`freq-<seq>` allowed two pending requests to coexist).
    const requestId = `freq-${caller.userId}~${grant.userId}`;
    const request: MockFriendRequestRow = {
      requestId,
      fromId: caller.userId,
      toId: grant.userId,
      createdAt: now,
      expiresAt: now + 14 * 24 * 3600 * 1000,
    };
    await mockPut('friendRequests', request);
    return {
      requestId,
      user: this.publicOf(target, false),
      createdAt: now,
      expiresAt: request.expiresAt,
    };
  }

  async acceptFriendRequest(requestId: string): Promise<FriendView> {
    await simLatency('api.acceptFriendRequest');
    const caller = await this.caller();
    this.requireSocial(caller);
    const request = await mockGet<MockFriendRequestRow>('friendRequests', requestId);
    if (!request || request.toId !== caller.userId || request.expiresAt <= Date.now()) {
      throw new ApiError('NOT_FOUND');
    }
    const other = await mockGet<MockUserRow>('users', request.fromId);
    if (!other) throw new ApiError('NOT_FOUND');
    // The cap holds on BOTH ends at accept time too — requests sit for days,
    // and either side may have filled up since the request was sent.
    const edges = await mockGetAll<MockFriendshipRow>('friendships');
    const countOf = (id: string) => edges.filter((f) => f.userA === id || f.userB === id).length;
    if (
      countOf(caller.userId) >= LIMITS.maxFriends ||
      countOf(request.fromId) >= LIMITS.maxFriends
    ) {
      throw new ApiError('LIMIT_EXCEEDED');
    }
    const [a, b] = [caller.userId, request.fromId].sort();
    const friendship: MockFriendshipRow = {
      friendshipId: `${a}~${b}`,
      userA: a,
      userB: b,
      createdAt: Date.now(),
    };
    await mockPut('friendships', friendship);
    await mockDelete('friendRequests', requestId);
    return {
      friendshipId: friendship.friendshipId,
      user: this.publicOf(other, false),
      since: friendship.createdAt,
    };
  }

  /** Silent by design — the requester's pending item simply disappears. */
  async declineFriendRequest(requestId: string): Promise<void> {
    await simLatency('api.declineFriendRequest');
    const caller = await this.caller();
    this.requireSocial(caller);
    const request = await mockGet<MockFriendRequestRow>('friendRequests', requestId);
    if (!request || request.toId !== caller.userId) throw new ApiError('NOT_FOUND');
    await mockDelete('friendRequests', requestId);
  }

  async cancelFriendRequest(requestId: string): Promise<void> {
    await simLatency('api.cancelFriendRequest');
    const caller = await this.caller();
    this.requireSocial(caller);
    const request = await mockGet<MockFriendRequestRow>('friendRequests', requestId);
    if (!request || request.fromId !== caller.userId) throw new ApiError('NOT_FOUND');
    await mockDelete('friendRequests', requestId);
  }

  async removeFriend(friendshipId: string): Promise<void> {
    await simLatency('api.removeFriend');
    const caller = await this.caller();
    this.requireSocial(caller);
    await this.removeFriendshipAs(caller.userId, friendshipId);
  }

  // ── forests & sync ────────────────────────────────────────────────────────

  /** Detail per the matrix: guardians get FULL nodes (co-gardening), family-up
   *  and friends get the STRIPPED view, strangers get 404 (no oracle). */
  async getForest(userId: string): Promise<ForestSnapshot> {
    await simLatency('api.getForest');
    const caller = await this.caller();
    let detail: ForestSnapshot['detail'] | null = null;
    let includeSocial = false;
    if (caller.userId === userId || (await this.linkBetween(caller.userId, userId))) {
      detail = 'full';
      includeSocial = caller.userId !== userId;
    } else if (await this.linkBetween(userId, caller.userId)) {
      detail = 'stripped'; // family visibility is mutual — minor sees guardian
    } else {
      const friends = (await mockGetAll<MockFriendshipRow>('friendships')).some(
        (f) =>
          (f.userA === caller.userId && f.userB === userId) ||
          (f.userB === caller.userId && f.userA === userId),
      );
      const target = await mockGet<MockUserRow>('users', userId);
      if (friends && caller.socialEnabled && target?.socialEnabled) detail = 'stripped';
    }
    if (!detail) throw new ApiError('NOT_FOUND');
    const owner = await mockGet<MockUserRow>('users', userId);
    if (!owner) throw new ApiError('NOT_FOUND');

    const records = (await mockGetAll<MockRecordRow>('records')).filter(
      (r) => r.ownerId === userId,
    );
    const trees = records
      .filter((r) => r.store === 'trees')
      .map((r) => r.record as Tree)
      .filter((t) => !t.deletedAt && !t.archivedAt);
    const liveTreeIds = new Set(trees.map((t) => t.id));
    const nodes = records
      .filter((r) => r.store === 'nodes')
      .map((r) => r.record as TreeNode)
      .filter((n) => !n.deletedAt && !n.archivedAt && liveTreeIds.has(n.treeId))
      .map((n) =>
        detail === 'full'
          ? n
          : {
              ...n,
              note: '',
              trigger: null,
              targetDate: null,
              priority: null,
              estimateMin: null,
              repeatsDaily: undefined,
              repeats: undefined,
              repeatsSetAt: undefined,
              remindAt: undefined,
            },
      );

    return {
      owner: this.publicOf(owner, includeSocial),
      detail,
      trees,
      nodes,
      fetchedAt: Date.now(),
    };
  }

  /** Own change feed, ordered by server receive order (`seq`); the cursor is
   *  the last seq seen, opaque to the client. */
  async getSyncChanges(cursor?: string): Promise<SyncChangesResponse> {
    await simLatency('api.getSyncChanges');
    const caller = await this.caller();
    const after = cursor ? Number(cursor) || 0 : 0;
    const page = 200;
    const mine = (await mockGetAll<MockRecordRow>('records'))
      .filter((r) => r.ownerId === caller.userId && r.seq > after)
      .sort((a, b) => a.seq - b.seq);
    const slice = mine.slice(0, page);
    return {
      changes: slice.map((r) => ({ store: r.store, record: r.record })),
      cursor: slice.length ? String(slice[slice.length - 1].seq) : (cursor ?? '0'),
      more: mine.length > page,
    };
  }

  async pushSync(req: SyncPushPayload): Promise<SyncPushResponse> {
    await simLatency('api.pushSync');
    const caller = await this.caller();
    return this.pushInto(caller.userId, req);
  }

  /** Guardian write-through (co-gardening): same rev-LWW law as own pushes;
   *  records land in the minor's cloud store. */
  async pushSyncFor(userId: string, req: SyncPushPayload): Promise<SyncPushResponse> {
    await simLatency('api.pushSyncFor');
    const caller = await this.caller();
    const link = await this.linkBetween(caller.userId, userId);
    if (!link) throw new ApiError('NOT_FOUND');
    return this.pushInto(userId, req);
  }

  /** Shared LWW write loop. v12 records remain independent singleton writes;
   *  v2 validates the complete request up front and commits each mutation
   *  group all-or-nothing. */
  private async pushInto(ownerId: string, req: SyncPushPayload): Promise<SyncPushResponse> {
    const groups = this.syncGroups(req);
    // The executable spec must rehearse what the Lambda enforces: a client
    // whose schema outruns the server gets SYNC_TOO_OLD, and every record
    // must carry a valid SyncBase + a known store.
    if (typeof req.schemaVersion !== 'number' || req.schemaVersion > SCHEMA_VERSION) {
      throw new ApiError('SYNC_TOO_OLD');
    }
    const STORES: readonly string[] = [
      'trees',
      'nodes',
      'checkins',
      'sessions',
      'harvests',
      'preserves',
    ];

    const isV2 = 'contractVersion' in req;
    for (const group of groups) {
      const groupKeys = new Set<string>();
      for (const entry of group) {
        const record = entry.record;
        if (
          !STORES.includes(entry.store) ||
          typeof record?.id !== 'string' ||
          typeof record.rev !== 'number' ||
          typeof record.updatedAt !== 'number'
        ) {
          throw new ApiError(isV2 ? 'SYNC_SCHEMA_INVALID' : 'VALIDATION', 'malformed sync record');
        }
        const key = `${entry.store}|${record.id}`;
        if (groupKeys.has(key)) {
          throw new ApiError(isV2 ? 'SYNC_SCHEMA_INVALID' : 'VALIDATION', 'duplicate sync record');
        }
        groupKeys.add(key);
      }
    }

    const applied: string[] = [];
    const rejected: { id: string; reason: 'STALE_REV' }[] = [];
    const serverRecords: SyncPushResponse['serverRecords'] = [];
    for (const group of groups) {
      const result = await mockApplyRecordGroup(ownerId, group, Date.now());
      if (result.stale.length) {
        for (const winner of result.stale) {
          rejected.push({ id: winner.record.id, reason: 'STALE_REV' });
          serverRecords.push({ store: winner.store, record: winner.record });
        }
        continue;
      }
      applied.push(...result.applied.map((row) => row.record.id));
    }
    return { applied, rejected, serverRecords };
  }

  private syncGroups(req: SyncPushPayload): SyncRecord[][] {
    if ('contractVersion' in req) {
      if (req.contractVersion !== CONTRACT_VERSION || !Array.isArray(req.mutationGroups)) {
        throw new ApiError('MUTATION_GROUP_INVALID');
      }
      const ids = new Set<string>();
      const groups: SyncRecord[][] = [];
      let total = 0;
      for (const group of req.mutationGroups) {
        if (
          typeof group?.id !== 'string' ||
          !group.id.trim() ||
          ids.has(group.id) ||
          !Number.isSafeInteger(group.expectedCount) ||
          group.expectedCount < 1 ||
          group.expectedCount > LIMITS.syncMutationGroupMax ||
          !Array.isArray(group.records) ||
          group.records.length !== group.expectedCount
        ) {
          throw new ApiError('MUTATION_GROUP_INVALID');
        }
        ids.add(group.id);
        total += group.records.length;
        groups.push(group.records);
      }
      if (total > LIMITS.syncPushMax) throw new ApiError('LIMIT_EXCEEDED');
      return groups;
    }
    if (!Array.isArray(req.records)) throw new ApiError('VALIDATION');
    if (req.records.length > LIMITS.syncPushMax) throw new ApiError('LIMIT_EXCEEDED');
    return req.records.map((record) => [record]);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Bearer-token gate — same 401 semantics HttpApi will meet in production. */
  private async caller(): Promise<MockUserRow> {
    const token = await this.auth.idToken();
    const payload = token ? parseMockToken(token) : null;
    if (!payload) throw new ApiError('UNAUTHENTICATED');
    const user = await mockGet<MockUserRow>('users', payload.sub);
    if (!user) throw new ApiError('UNAUTHENTICATED');
    return user;
  }

  private profileOf(user: MockUserRow): UserProfile {
    return {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      accountType: user.accountType,
      socialEnabled: user.socialEnabled,
      createdAt: user.createdAt,
    };
  }

  private publicOf(user: MockUserRow, includeSocial: boolean): PublicProfile {
    return {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      accountType: user.accountType,
      ...(includeSocial ? { socialEnabled: user.socialEnabled } : {}),
    };
  }

  /** `socialEnabled` is exposed only on minors the caller guards. */
  private async linkView(
    link: MockGuardianLinkRow,
    otherId: string,
    includeSocial: boolean,
  ): Promise<FamilyLinkView> {
    const other = await mockGet<MockUserRow>('users', otherId);
    if (!other) throw new ApiError('NOT_FOUND');
    const user: PublicProfile = {
      userId: other.userId,
      username: other.username,
      displayName: other.displayName,
      accountType: other.accountType,
      ...(includeSocial ? { socialEnabled: other.socialEnabled } : {}),
    };
    return { linkId: link.linkId, kind: link.kind, user, createdAt: link.createdAt };
  }

  // ── friends internals ─────────────────────────────────────────────────────

  private requireSocial(user: MockUserRow): void {
    assertSocialEnabled(user);
  }

  private async friendshipBetween(a: string, b: string): Promise<MockFriendshipRow | null> {
    const rows = await mockGetAll<MockFriendshipRow>('friendships');
    return (
      rows.find((f) => (f.userA === a && f.userB === b) || (f.userA === b && f.userB === a)) ?? null
    );
  }

  private async friendsOf(userId: string): Promise<FriendsResponse> {
    const now = Date.now();
    const friendships = (await mockGetAll<MockFriendshipRow>('friendships')).filter(
      (f) => f.userA === userId || f.userB === userId,
    );
    const requests = (await mockGetAll<MockFriendRequestRow>('friendRequests')).filter(
      (r) => r.expiresAt > now,
    );
    const friends: FriendView[] = [];
    for (const f of friendships) {
      const otherId = f.userA === userId ? f.userB : f.userA;
      const other = await mockGet<MockUserRow>('users', otherId);
      if (!other) continue;
      friends.push({
        friendshipId: f.friendshipId,
        user: this.publicOf(other, false),
        since: f.createdAt,
      });
    }
    const incoming: FriendRequestView[] = [];
    for (const r of requests.filter((r) => r.toId === userId)) {
      const other = await mockGet<MockUserRow>('users', r.fromId);
      if (!other) continue;
      incoming.push({
        requestId: r.requestId,
        user: this.publicOf(other, false),
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      });
    }
    const outgoing: FriendRequestView[] = [];
    for (const r of requests.filter((r) => r.fromId === userId)) {
      const other = await mockGet<MockUserRow>('users', r.toId);
      if (!other) continue;
      outgoing.push({
        requestId: r.requestId,
        user: this.publicOf(other, false),
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      });
    }
    return { friends, incoming, outgoing };
  }

  /** `asUserId` must be one side of the edge (self-removal or guardian oversight). */
  private async removeFriendshipAs(asUserId: string, friendshipId: string): Promise<void> {
    const row = await mockGet<MockFriendshipRow>('friendships', friendshipId);
    if (!row || (row.userA !== asUserId && row.userB !== asUserId)) {
      throw new ApiError('NOT_FOUND');
    }
    await mockDelete('friendships', friendshipId);
  }

  private async mintFriendCode(userId: string): Promise<CodeGrant> {
    for (const code of await mockGetAll<MockCodeRow>('codes')) {
      if (code.kind === 'friend' && code.userId === userId) await mockDelete('codes', code.code);
    }
    const code = await this.mintCode();
    const expiresAt = Date.now() + 7 * 24 * 3600 * 1000;
    await mockPut('codes', {
      code,
      kind: 'friend',
      userId,
      minorId: null,
      expiresAt,
    } satisfies MockCodeRow);
    return { code, expiresAt };
  }

  // ── family internals ──────────────────────────────────────────────────────

  private async linkBetween(
    guardianId: string,
    minorId: string,
  ): Promise<MockGuardianLinkRow | null> {
    const links = await mockGetAll<MockGuardianLinkRow>('guardianLinks');
    return links.find((l) => l.guardianId === guardianId && l.minorId === minorId) ?? null;
  }

  private async minorsOf(guardianId: string): Promise<MockGuardianLinkRow[]> {
    return (await mockGetAll<MockGuardianLinkRow>('guardianLinks')).filter(
      (l) => l.guardianId === guardianId,
    );
  }

  private async guardiansOf(minorId: string): Promise<MockGuardianLinkRow[]> {
    return (await mockGetAll<MockGuardianLinkRow>('guardianLinks')).filter(
      (l) => l.minorId === minorId,
    );
  }

  /** Identity-admin gate — 404-shaped like the real Lambda (no oracle). */
  private async requireCreatedLink(
    guardianId: string,
    minorId: string,
  ): Promise<MockGuardianLinkRow> {
    const link = await this.linkBetween(guardianId, minorId);
    if (!link) throw new ApiError('NOT_FOUND');
    if (link.kind !== 'created') {
      throw new ApiError('FORBIDDEN', 'invited links have no identity admin');
    }
    return link;
  }

  private newLink(
    guardianId: string,
    minorId: string,
    kind: MockGuardianLinkRow['kind'],
    now: number,
  ): MockGuardianLinkRow {
    return { linkId: `${guardianId}~${minorId}`, guardianId, minorId, kind, createdAt: now };
  }

  /** Deterministic (rule 4) yet unique: seq counter + hash. Meets the policy. */
  private async mintTempPassword(username: string): Promise<string> {
    const seq = await mockNextSeq('pwseq');
    return `Brote${1000 + (mockHash(`${username}:pw:${seq}`) % 9000)}`;
  }

  private async mintCode(): Promise<string> {
    const alphabet = '2346790CDFGHJKMNPQRTVWXZ';
    const seq = await mockNextSeq('codeseq');
    let code = '';
    for (let i = 0; i < 8; i++) code += alphabet[mockHash(`code:${seq}:${i}`) % alphabet.length];
    return code;
  }
}
