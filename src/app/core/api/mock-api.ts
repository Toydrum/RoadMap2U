import { ApiClient } from './api-client';
import {
  AccessSummary,
  AcceptAdditionalResponsibleInvitationRequest,
  AcceptMinorLinkRequest,
  AccountType,
  AccountClosureReceipt,
  AdditionalResponsibleInvitationView,
  ApiError,
  ApiErrorCode,
  ApplySubscriptionChangeRequest,
  ApproveMinorLinkRequest,
  BillingActionView,
  BillingCommandBase,
  BillingRedirectView,
  BillingSummary,
  CONTRACT_VERSION,
  CONSENT_KINDS,
  CURRENT_MINOR_LINK_PRIVACY_VERSION,
  CURRENT_MINOR_LINK_RESPONSIBILITY_VERSION,
  CodeGrant,
  ConsentKind,
  CreateAdditionalResponsibleInvitationRequest,
  CreateAdultFriendRequestRequest,
  CreateChildRequest,
  CreateChildResponse,
  CreateCheckoutRequest,
  CreateMinorFriendRequestRequest,
  CreateMinorInviteCodeRequest,
  CreateMinorLinkRequest,
  CreateMinorRequest,
  CreateMinorResponse,
  CreatePortalRequest,
  FAMILY_BILLING_CONTRACT_VERSION,
  FamilyInviteRequest,
  FamilyCommandBase,
  FamilyLinkView,
  FriendRequestView,
  FriendView,
  FriendshipClass,
  FriendsResponse,
  ForestSnapshot,
  HouseholdView,
  LIMITS,
  MeResponse,
  MinorFriendActionRequest,
  MinorFriendRequestView,
  MinorLinkRequestView,
  PREPAYMENT_PLAN_CATALOG,
  PlanCatalog,
  PreviewSubscriptionChangeRequest,
  PublicProfile,
  ReplaceAdditionalResponsibleScopeRequest,
  RevokeAdditionalResponsibleRequest,
  SubscriptionChangePreviewView,
  SyncChangesResponse,
  SyncPushPayload,
  SyncRecord,
  SyncPushResponse,
  TransferPrimaryResponsibilityRequest,
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
  MockConsentRow,
  MockCoverageRow,
  MockCredentialRow,
  MockAccountNoticeRow,
  MockFriendRequestRow,
  MockFriendshipRow,
  MockGuardianLinkRow,
  MockHouseholdRow,
  MockMinorFriendRequestRow,
  MockRecordRow,
  MockCheckoutReservationRow,
  MockSeatAssignmentRow,
  MockSubscriptionProjectionRow,
  MockSupervisionLinkRow,
  MockUserRow,
  mockAccountClosureKey,
  mockApplyRecordGroup,
  mockDelete,
  mockGet,
  mockGetAll,
  mockHash,
  mockNextSeq,
  mockPut,
  simLatency,
  withMockAccountLock,
  withMockAccountLocks,
} from './mock-cloud';

const INVITE_TTL_MS = 72 * 3600 * 1000;
const MINOR_INVITE_TTL_MS = 24 * 3600 * 1000;
const FRIEND_REQUEST_TTL_MS = 14 * 24 * 3600 * 1000;

interface MockAccountClosureState {
  receipt: AccountClosureReceipt;
  userId: string;
  accountInstanceId: string;
  purgeCompleted: boolean;
}

interface MockAccountClosureRow {
  key: string;
  value: MockAccountClosureState;
}

interface MockCallerIdentity {
  sub: string;
  accountInstanceId: string;
  closureOnly?: boolean;
}

interface AccountClosureCredentialProvider {
  accountClosureCredential(): Promise<string | null>;
}

export function assertSocialEnabled(user: Pick<MockUserRow, 'socialEnabled'>): void {
  if (!user.socialEnabled) throw new ApiError('FORBIDDEN', 'social features are off');
}

export function friendshipClassForAccounts(
  first: AccountType,
  second: AccountType,
): FriendshipClass {
  if (first === 'adult' && second === 'adult') return 'adult_adult';
  if (first === 'minor' && second === 'minor') return 'minor_minor';
  throw new ApiError('ADULT_MINOR_FRIENDSHIP_FORBIDDEN');
}

export function hasCompleteMinorFriendConsents(kinds: readonly ConsentKind[]): boolean {
  const present = new Set(kinds);
  return CONSENT_KINDS.every((kind) => present.has(kind));
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
    const caller = await this.caller();
    const coverage = await mockGet<MockCoverageRow>('coverages', caller.userId);
    if (
      !coverage ||
      !['active', 'grace', 'scheduled_end'].includes(coverage.state) ||
      (coverage.validUntil !== null && coverage.validUntil <= Date.now())
    ) {
      return createFreeAccessSummary();
    }
    const fallback = createFreeAccessSummary();
    return {
      ...fallback,
      effectivePlanKey: 'premium',
      activeSources: [
        {
          kind: 'subscription',
          sourceId: coverage.source,
          planKey: 'premium',
          validUntil: coverage.validUntil,
          scope: 'family_member',
          householdId: coverage.householdId,
          ...(coverage.seatType ? { seatType: coverage.seatType } : {}),
        },
      ],
      limits: { ...PREPAYMENT_PLAN_CATALOG.plans.premium.limits },
      capabilities: {
        ...PREPAYMENT_PLAN_CATALOG.plans.premium.capabilities,
        family: true,
      },
      revision: 1,
      nextRecomputeAt: coverage.validUntil,
    };
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
    return this.withAccountMutation(async (caller) => {
      const displayName = patch.displayName?.trim();
      if (displayName !== undefined) {
        if (!displayName || displayName.length > 40) throw new ApiError('VALIDATION');
        caller.displayName = displayName;
        await mockPut('users', caller);
      }
      return this.profileOf(caller);
    });
  }

  async deleteMe(): Promise<AccountClosureReceipt> {
    await simLatency('api.deleteMe');
    const identity = await this.accountClosureIdentity();

    return withMockAccountLock(identity.sub, async () => {
      const key = mockAccountClosureKey(identity.sub, identity.accountInstanceId);
      const prior = await mockGet<MockAccountClosureRow>('kv', key);
      const caller = await mockGet<MockUserRow>('users', identity.sub);
      if (
        prior?.value.accountInstanceId === identity.accountInstanceId &&
        (!caller || caller.accountInstanceId === identity.accountInstanceId || identity.closureOnly)
      ) {
        return this.completeMockAccountClosure(key, prior.value);
      }
      if (!caller) {
        throw new ApiError('UNAUTHENTICATED');
      }
      if (caller.accountInstanceId !== identity.accountInstanceId) {
        throw new ApiError('UNAUTHENTICATED');
      }
      await this.assertAccountClosureAllowed(caller);

      const state: MockAccountClosureState = {
        receipt: { closureId: `mock:${crypto.randomUUID()}`, state: 'completed' },
        userId: caller.userId,
        accountInstanceId: identity.accountInstanceId,
        purgeCompleted: false,
      };
      await mockPut('kv', { key, value: state } satisfies MockAccountClosureRow);

      // The mock API owns the same server-side identity boundary as the real
      // closure worker. The retained opaque receipt makes retries terminal;
      // the client signs out only after observing it.
      return this.completeMockAccountClosure(key, state);
    });
  }

  // ── family (phase «familia») ──────────────────────────────────────────────

  async createChild(req: CreateChildRequest): Promise<CreateChildResponse> {
    await simLatency('api.createChild');
    return this.withAccountMutation(
      async (caller) => {
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
        if (await mockGet<MockUserRow>('users', `u-${username}`)) {
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
          accountInstanceId: crypto.randomUUID(),
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
      },
      undefined,
      async () => {
        const username = req.username?.trim().toLowerCase() ?? '';
        return USERNAME_PATTERN.test(username) ? [`u-${username}`] : [];
      },
    );
  }

  async resetChildPassword(userId: string): Promise<{ tempPassword: string }> {
    await simLatency('api.resetChildPassword');
    return this.withAccountMutation(
      async (caller) => {
        await this.requireCreatedLink(caller.userId, userId);
        const child = await mockGet<MockUserRow>('users', userId);
        if (!child) throw new ApiError('NOT_FOUND');
        const cred = await mockGet<MockCredentialRow>('credentials', child.username);
        if (!cred) throw new ApiError('NOT_FOUND');
        const tempPassword = await this.mintTempPassword(child.username);
        await mockPut('credentials', { ...cred, password: tempPassword, mustChangePassword: true });
        return { tempPassword };
      },
      async () => [userId],
    );
  }

  async patchChild(
    userId: string,
    patch: { displayName?: string; socialEnabled?: boolean },
  ): Promise<UserProfile> {
    await simLatency('api.patchChild');
    return this.withAccountMutation(
      async (caller) => {
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
      },
      async () => [userId],
    );
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
    return this.withAccountMutation(
      async (caller) => {
        await this.requireCreatedLink(caller.userId, userId);
        const child = await mockGet<MockUserRow>('users', userId);
        if (!child) throw new ApiError('NOT_FOUND');
        await this.purgeMockUser(userId);
      },
      async () => [userId],
    );
  }

  private async purgeMockUser(userId: string): Promise<void> {
    const affectedHouseholdIds = new Set<string>();
    const removedHouseholdIds = new Set<string>();
    const removedMinorRequestIds = new Set<string>();

    for (const credential of await mockGetAll<MockCredentialRow>('credentials')) {
      if (credential.userId === userId) await mockDelete('credentials', credential.username);
    }
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
    for (const link of await mockGetAll<MockSupervisionLinkRow>('supervisionLinks')) {
      if (link.adultId === userId || link.minorId === userId) {
        affectedHouseholdIds.add(link.householdId);
        await mockDelete('supervisionLinks', link.linkId);
      }
    }
    for (const seat of await mockGetAll<MockSeatAssignmentRow>('seatAssignments')) {
      if (seat.accountId === userId) {
        affectedHouseholdIds.add(seat.householdId);
        await mockDelete('seatAssignments', seat.assignmentId);
      }
    }
    for (const coverage of await mockGetAll<MockCoverageRow>('coverages')) {
      if (coverage.accountId === userId) {
        affectedHouseholdIds.add(coverage.householdId);
        await mockDelete('coverages', coverage.coverageId);
      }
    }
    for (const request of await mockGetAll<MockMinorFriendRequestRow>('minorFriendRequests')) {
      if (request.requesterId === userId || request.recipientId === userId) {
        removedMinorRequestIds.add(request.requestId);
        await mockDelete('minorFriendRequests', request.requestId);
      }
    }
    for (const consent of await mockGetAll<MockConsentRow>('consents')) {
      if (
        removedMinorRequestIds.has(consent.requestId) ||
        consent.actorId === userId ||
        consent.subjectMinorId === userId
      ) {
        await mockDelete('consents', consent.consentId);
      }
    }
    for (const notice of await mockGetAll<MockAccountNoticeRow>('accountNotices')) {
      if (
        notice.createdById === userId ||
        notice.sourcePrimaryId === userId ||
        notice.acceptedById === userId ||
        notice.minorId === userId ||
        notice.minorIds.includes(userId)
      ) {
        affectedHouseholdIds.add(notice.householdId);
        if (notice.sourceHouseholdId) affectedHouseholdIds.add(notice.sourceHouseholdId);
        if (notice.code) await mockDelete('codes', notice.code);
        await mockDelete('accountNotices', notice.noticeId);
      }
    }
    for (const projection of await mockGetAll<MockSubscriptionProjectionRow>(
      'subscriptionProjections',
    )) {
      if (projection.payerAccountId === userId) {
        affectedHouseholdIds.add(projection.householdId);
        await mockDelete('subscriptionProjections', projection.projectionId);
      }
    }

    const ownedHouseholds = (await mockGetAll<MockHouseholdRow>('households')).filter(
      (household) => household.primaryResponsibleId === userId,
    );
    for (const household of ownedHouseholds) {
      if ((await this.minorSeats(household.householdId)).length > 0) {
        throw new ApiError('CONFLICT', 'transfer supervised minors before closing the account');
      }
      removedHouseholdIds.add(household.householdId);
      await mockDelete('households', household.householdId);
    }

    if (removedHouseholdIds.size) {
      for (const link of await mockGetAll<MockSupervisionLinkRow>('supervisionLinks')) {
        if (removedHouseholdIds.has(link.householdId)) {
          await mockDelete('supervisionLinks', link.linkId);
        }
      }
      for (const seat of await mockGetAll<MockSeatAssignmentRow>('seatAssignments')) {
        if (removedHouseholdIds.has(seat.householdId)) {
          await mockDelete('seatAssignments', seat.assignmentId);
        }
      }
      for (const coverage of await mockGetAll<MockCoverageRow>('coverages')) {
        if (removedHouseholdIds.has(coverage.householdId)) {
          await mockDelete('coverages', coverage.coverageId);
        }
      }
      for (const notice of await mockGetAll<MockAccountNoticeRow>('accountNotices')) {
        if (
          removedHouseholdIds.has(notice.householdId) ||
          (notice.sourceHouseholdId && removedHouseholdIds.has(notice.sourceHouseholdId))
        ) {
          if (notice.code) await mockDelete('codes', notice.code);
          await mockDelete('accountNotices', notice.noticeId);
        }
      }
      for (const projection of await mockGetAll<MockSubscriptionProjectionRow>(
        'subscriptionProjections',
      )) {
        if (removedHouseholdIds.has(projection.householdId)) {
          await mockDelete('subscriptionProjections', projection.projectionId);
        }
      }
      for (const reservation of await mockGetAll<MockCheckoutReservationRow>(
        'checkoutReservations',
      )) {
        if (removedHouseholdIds.has(reservation.householdId)) {
          await mockDelete('checkoutReservations', reservation.reservationId);
        }
      }
    }

    for (const householdId of affectedHouseholdIds) {
      if (removedHouseholdIds.has(householdId)) continue;
      const household = await mockGet<MockHouseholdRow>('households', householdId);
      if (household) await this.bumpHousehold(household);
    }
    for (const row of await mockGetAll<{ key: string }>('kv')) {
      if (row.key.startsWith(`rate:${userId}:`)) await mockDelete('kv', row.key);
    }
    await mockDelete('users', userId);
  }

  private async assertAccountClosureAllowed(caller: MockUserRow): Promise<void> {
    if (caller.accountType !== 'adult') return;
    const primaryHouseholds = (await mockGetAll<MockHouseholdRow>('households')).filter(
      (household) =>
        household.primaryResponsibleId === caller.userId && household.state !== 'closed',
    );
    for (const household of primaryHouseholds) {
      if ((await this.minorSeats(household.householdId)).length > 0) {
        throw new ApiError('CONFLICT', 'transfer supervised minors before closing the account');
      }
    }
  }

  private async completeMockAccountClosure(
    key: string,
    state: MockAccountClosureState,
  ): Promise<AccountClosureReceipt> {
    if (!state.purgeCompleted) {
      const current = await mockGet<MockUserRow>('users', state.userId);
      if (current && current.accountInstanceId !== state.accountInstanceId) {
        throw new ApiError('UNAUTHENTICATED');
      }
      await this.purgeMockUser(state.userId);
      await mockPut('kv', {
        key,
        value: { ...state, purgeCompleted: true },
      } satisfies MockAccountClosureRow);
    }
    return state.receipt;
  }

  async deleteFamilyLink(linkId: string): Promise<void> {
    await simLatency('api.deleteFamilyLink');
    return this.withAccountMutation(
      async (caller) => {
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
      },
      () => this.familyLinkParticipantIds(linkId),
    );
  }

  async createFamilyInvite(req: FamilyInviteRequest): Promise<CodeGrant> {
    await simLatency('api.createFamilyInvite');
    return this.withAccountMutation(
      async (caller) => {
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
      },
      async () => (req.kind === 'coGuardian' ? [req.minorId] : []),
    );
  }

  async acceptFamilyInvite(rawCode: string): Promise<FamilyLinkView> {
    await simLatency('api.acceptFamilyInvite');
    return this.withAccountMutation(
      async (caller) => {
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
        if (!invite || !['coGuardian', 'linkExisting'].includes(invite.kind)) {
          return badAttempt('CODE_INVALID');
        }
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
      },
      () => this.familyInviteParticipantIds(rawCode),
    );
  }

  async revokeFamilyInvite(rawCode: string): Promise<void> {
    await simLatency('api.revokeFamilyInvite');
    return this.withAccountMutation(
      async (caller) => {
        const code = rawCode?.trim().toUpperCase().replace(/-/g, '') ?? '';
        const invite = await mockGet<MockCodeRow>('codes', code);
        if (
          !invite ||
          invite.userId !== caller.userId ||
          !['coGuardian', 'linkExisting'].includes(invite.kind)
        ) {
          throw new ApiError('NOT_FOUND');
        }
        await mockDelete('codes', code);
      },
      () => this.familyInviteParticipantIds(rawCode),
    );
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
    return this.withAccountMutation(
      async (caller) => {
        if (!(await this.linkBetween(caller.userId, userId))) throw new ApiError('NOT_FOUND');
        await this.removeFriendshipAs(userId, friendshipId);
      },
      async () => [userId, ...(await this.friendshipParticipantIds(friendshipId))],
    );
  }

  async cancelChildRequest(userId: string, requestId: string): Promise<void> {
    await simLatency('api.cancelChildRequest');
    return this.withAccountMutation(
      async (caller) => {
        if (!(await this.linkBetween(caller.userId, userId))) throw new ApiError('NOT_FOUND');
        const request = await mockGet<MockFriendRequestRow>('friendRequests', requestId);
        if (!request || request.fromId !== userId) throw new ApiError('NOT_FOUND');
        await mockDelete('friendRequests', requestId);
      },
      async () => [userId, ...(await this.friendRequestParticipantIds(requestId))],
    );
  }

  // ── family v2 ─────────────────────────────────────────────────────────────
  async getHousehold(): Promise<HouseholdView> {
    await simLatency('api.getHousehold');
    const caller = await this.caller();
    const household = await this.householdForCaller(caller);
    return this.householdView(household, caller.userId);
  }

  async createMinor(req: CreateMinorRequest): Promise<CreateMinorResponse> {
    await simLatency('api.createMinor');
    return this.withAccountMutation(
      async (caller) => {
        const household = await this.requirePrimaryHousehold(caller, req);
        if (req.country !== 'MX') throw new ApiError('LEGAL_REGION_UNSUPPORTED');
        const username = req.username?.trim().toLowerCase() ?? '';
        if (!USERNAME_PATTERN.test(username)) throw new ApiError('VALIDATION');
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(req.majorityAt) ||
          req.majorityAt <= new Date().toISOString().slice(0, 10) ||
          !req.declarationVersion?.trim() ||
          !req.consentVersion?.trim()
        ) {
          throw new ApiError('VALIDATION');
        }
        const seats = await this.minorSeats(household.householdId);
        if (seats.length >= 2) throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
        if (
          (await mockGet<MockCredentialRow>('credentials', username)) ||
          (await mockGet<MockUserRow>('users', `u-${username}`))
        ) {
          throw new ApiError('USERNAME_TAKEN');
        }

        const now = Date.now();
        const tempPassword = await this.mintTempPassword(username);
        const minor: MockUserRow = {
          userId: `u-${username}`,
          username,
          displayName: username,
          accountType: 'minor',
          socialEnabled: false,
          createdAt: now,
          email: null,
          accountInstanceId: crypto.randomUUID(),
        };
        await mockPut('users', minor);
        await mockPut('credentials', {
          username,
          userId: minor.userId,
          password: tempPassword,
          mustChangePassword: true,
          pendingConfirm: false,
        } satisfies MockCredentialRow);
        const position = this.firstAvailableMinorSeat(seats);
        await mockPut(
          'seatAssignments',
          this.minorSeat(household.householdId, position, minor.userId, req.majorityAt, now),
        );
        await mockPut(
          'supervisionLinks',
          this.supervisionLink(
            household.householdId,
            caller.userId,
            minor.userId,
            'primary_responsible',
            now,
          ),
        );
        await mockPut('guardianLinks', this.newLink(caller.userId, minor.userId, 'created', now));
        await mockPut(
          'coverages',
          this.testCoverage(household.householdId, minor.userId, 'minor', now),
        );
        if (!(await mockGet<MockCoverageRow>('coverages', caller.userId))) {
          await mockPut(
            'coverages',
            this.testCoverage(household.householdId, caller.userId, null, now),
          );
        }
        const updated = await this.bumpHousehold(household);
        return {
          contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
          household: await this.householdView(updated, caller.userId),
          minor: this.profileOf(minor),
          tempPassword,
        };
      },
      undefined,
      async () => {
        const username = req.username?.trim().toLowerCase() ?? '';
        return USERNAME_PATTERN.test(username) ? [`u-${username}`] : [];
      },
    );
  }

  async createMinorLinkRequest(req: CreateMinorLinkRequest): Promise<MinorLinkRequestView> {
    await simLatency('api.createMinorLinkRequest');
    return this.withAccountMutation(async (caller) => {
      const targetHousehold = await this.requirePrimaryHousehold(caller, req);
      const code = this.normalizeCode(req.code);
      const grant = await mockGet<MockCodeRow>('codes', code);
      if (
        !grant ||
        grant.kind !== 'linkExisting' ||
        !grant.minorId ||
        grant.expiresAt <= Date.now()
      ) {
        throw new ApiError('CODE_INVALID');
      }
      const minor = await mockGet<MockUserRow>('users', grant.minorId);
      if (!minor || minor.accountType !== 'minor') throw new ApiError('CODE_INVALID');
      const sourceHousehold = await this.primaryHouseholdForMinor(minor.userId);
      if (
        !sourceHousehold ||
        sourceHousehold.primaryResponsibleId !== grant.userId ||
        sourceHousehold.householdId === targetHousehold.householdId
      ) {
        throw new ApiError('CODE_INVALID');
      }
      if ((await this.minorSeats(targetHousehold.householdId)).length >= 2) {
        throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
      }
      const requestId = `minor-link:${minor.userId}:${targetHousehold.householdId}`;
      const existing = await mockGet<MockAccountNoticeRow>('accountNotices', requestId);
      if (existing?.state === 'pending') throw new ApiError('CONFLICT');
      const now = Date.now();
      const notice: MockAccountNoticeRow = {
        noticeId: requestId,
        kind: 'minor_link_request',
        householdId: targetHousehold.householdId,
        createdById: caller.userId,
        minorId: minor.userId,
        minorIds: [minor.userId],
        sourceHouseholdId: sourceHousehold.householdId,
        sourceHouseholdRevision: sourceHousehold.revision,
        sourcePrimaryId: sourceHousehold.primaryResponsibleId,
        intendedAdultId: null,
        acceptedById: null,
        sourceApprovalCommandId: null,
        sourceApprovedAt: null,
        state: 'pending',
        createdAt: now,
        expiresAt: Math.min(grant.expiresAt, now + INVITE_TTL_MS),
        revision: 1,
        code,
      };
      await mockPut('accountNotices', notice);
      return this.minorLinkRequestView(notice, minor);
    });
  }

  async approveMinorLinkRequest(
    requestId: string,
    req: ApproveMinorLinkRequest,
  ): Promise<MinorLinkRequestView> {
    await simLatency('api.approveMinorLinkRequest');
    return this.withAccountMutation(
      async (caller) => {
        const notice = await mockGet<MockAccountNoticeRow>('accountNotices', requestId);
        if (
          !notice ||
          notice.kind !== 'minor_link_request' ||
          notice.state !== 'pending' ||
          !notice.minorId ||
          !notice.sourceHouseholdId ||
          notice.sourceHouseholdRevision === null ||
          !notice.sourcePrimaryId ||
          notice.expiresAt <= Date.now()
        ) {
          throw new ApiError('NOT_FOUND');
        }
        if (caller.userId !== notice.sourcePrimaryId) {
          throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
        }
        const target = await mockGet<MockHouseholdRow>('households', notice.householdId);
        const source = await mockGet<MockHouseholdRow>('households', notice.sourceHouseholdId);
        if (!target || !source) throw new ApiError('NOT_FOUND');
        if (
          source.primaryResponsibleId !== caller.userId ||
          source.primaryResponsibleId !== notice.sourcePrimaryId ||
          source.revision !== notice.sourceHouseholdRevision ||
          target.primaryResponsibleId !== notice.createdById
        ) {
          throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
        }
        this.assertFamilyCommand(req);
        if (req.householdId !== target.householdId) throw new ApiError('NOT_FOUND');
        this.assertHouseholdRevision(target, req.expectedHouseholdRevision);
        const minor = await mockGet<MockUserRow>('users', notice.minorId);
        if (!minor) throw new ApiError('NOT_FOUND');
        const now = Date.now();
        const approved = {
          ...notice,
          state: 'approved',
          sourceApprovalCommandId: req.commandId,
          sourceApprovedAt: now,
          revision: notice.revision + 1,
        } satisfies MockAccountNoticeRow;
        await mockPut('accountNotices', approved);
        return this.minorLinkRequestView(approved, minor);
      },
      () => this.minorLinkNoticeParticipantIds(requestId),
      async () => [`resource:account-notice:${requestId}`, `resource:household:${req.householdId}`],
    );
  }

  async acceptMinorLinkRequest(
    requestId: string,
    req: AcceptMinorLinkRequest,
  ): Promise<HouseholdView> {
    await simLatency('api.acceptMinorLinkRequest');
    return this.withAccountMutation(
      async (caller) => {
        const notice = await mockGet<MockAccountNoticeRow>('accountNotices', requestId);
        if (
          !notice ||
          notice.kind !== 'minor_link_request' ||
          notice.state !== 'approved' ||
          !notice.minorId ||
          !notice.sourceHouseholdId ||
          notice.sourceHouseholdRevision === null ||
          !notice.sourcePrimaryId ||
          !notice.sourceApprovalCommandId ||
          notice.sourceApprovedAt === null ||
          notice.expiresAt <= Date.now()
        ) {
          throw new ApiError('NOT_FOUND');
        }
        this.assertFamilyCommand(req);
        if (
          req.responsibilityVersion !== CURRENT_MINOR_LINK_RESPONSIBILITY_VERSION ||
          req.privacyVersion !== CURRENT_MINOR_LINK_PRIVACY_VERSION
        ) {
          throw new ApiError('VALIDATION');
        }
        const target = await mockGet<MockHouseholdRow>('households', notice.householdId);
        const source = await mockGet<MockHouseholdRow>('households', notice.sourceHouseholdId);
        if (!target || !source) throw new ApiError('NOT_FOUND');
        if (
          req.householdId !== target.householdId ||
          caller.userId !== notice.createdById ||
          target.primaryResponsibleId !== caller.userId ||
          source.primaryResponsibleId !== notice.sourcePrimaryId ||
          source.revision !== notice.sourceHouseholdRevision
        ) {
          throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
        }
        this.assertHouseholdRevision(target, req.expectedHouseholdRevision);
        if ((await this.minorSeats(target.householdId)).length >= 2) {
          throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
        }

        const minor = await mockGet<MockUserRow>('users', notice.minorId);
        if (!minor) throw new ApiError('NOT_FOUND');
        const oldSeats = (await this.minorSeats(source.householdId)).filter(
          (seat) => seat.accountId === minor.userId,
        );
        if (oldSeats.length !== 1) throw new ApiError('NOT_FOUND');
        const targetSeats = await this.minorSeats(target.householdId);
        const majorityAt = oldSeats[0]?.majorityAt ?? '9999-12-31';
        for (const seat of oldSeats) await mockDelete('seatAssignments', seat.assignmentId);
        await this.revokeSupervision(source.householdId, source.primaryResponsibleId, minor.userId);
        await mockDelete('guardianLinks', `${source.primaryResponsibleId}~${minor.userId}`);
        const now = Date.now();
        await mockPut(
          'seatAssignments',
          this.minorSeat(
            target.householdId,
            this.firstAvailableMinorSeat(targetSeats),
            minor.userId,
            majorityAt,
            now,
          ),
        );
        await mockPut(
          'supervisionLinks',
          this.supervisionLink(
            target.householdId,
            target.primaryResponsibleId,
            minor.userId,
            'primary_responsible',
            now,
          ),
        );
        await mockPut(
          'guardianLinks',
          this.newLink(target.primaryResponsibleId, minor.userId, 'created', now),
        );
        await mockPut(
          'coverages',
          this.testCoverage(target.householdId, minor.userId, 'minor', now),
        );
        await this.bumpHousehold(source);
        const updatedTarget = await this.bumpHousehold(target);
        await mockPut('accountNotices', {
          ...notice,
          state: 'accepted',
          acceptedById: caller.userId,
          revision: notice.revision + 1,
        } satisfies MockAccountNoticeRow);
        if (notice.code) await mockDelete('codes', notice.code);
        return this.householdView(updatedTarget, caller.userId);
      },
      () => this.minorLinkNoticeParticipantIds(requestId),
      async () => [`resource:account-notice:${requestId}`, `resource:household:${req.householdId}`],
    );
  }

  async createAdditionalResponsibleInvitation(
    req: CreateAdditionalResponsibleInvitationRequest,
  ): Promise<AdditionalResponsibleInvitationView> {
    await simLatency('api.createAdditionalResponsibleInvitation');
    return this.withAccountMutation(async (caller) => {
      const household = await this.requirePrimaryHousehold(caller, req);
      const intendedAdult = await mockGet<MockUserRow>('users', req.intendedAdultId);
      if (!intendedAdult || intendedAdult.accountType !== 'adult') {
        throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
      }
      if (intendedAdult.userId === caller.userId) throw new ApiError('CONFLICT');
      const minorIds = await this.validateHouseholdMinorScope(household.householdId, req.minorIds);
      if (await this.additionalSeat(household.householdId)) {
        throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
      }
      const now = Date.now();
      const invitationId = `additional-invitation:${household.householdId}:${req.commandId}`;
      const notice: MockAccountNoticeRow = {
        noticeId: invitationId,
        kind: 'additional_responsible_invitation',
        householdId: household.householdId,
        createdById: caller.userId,
        minorId: null,
        minorIds,
        sourceHouseholdId: null,
        sourceHouseholdRevision: null,
        sourcePrimaryId: caller.userId,
        intendedAdultId: req.intendedAdultId,
        acceptedById: null,
        sourceApprovalCommandId: null,
        sourceApprovedAt: null,
        state: 'pending',
        createdAt: now,
        expiresAt: now + INVITE_TTL_MS,
        revision: 1,
        code: null,
      };
      await mockPut('accountNotices', notice);
      return this.additionalInvitationView(notice);
    });
  }

  async acceptAdditionalResponsibleInvitation(
    invitationId: string,
    req: AcceptAdditionalResponsibleInvitationRequest,
  ): Promise<HouseholdView> {
    await simLatency('api.acceptAdditionalResponsibleInvitation');
    return this.withAccountMutation(
      async (caller) => {
        if (caller.accountType !== 'adult') throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
        const notice = await mockGet<MockAccountNoticeRow>('accountNotices', invitationId);
        if (
          !notice ||
          notice.kind !== 'additional_responsible_invitation' ||
          notice.state !== 'pending' ||
          !notice.intendedAdultId ||
          notice.expiresAt <= Date.now()
        ) {
          throw new ApiError('NOT_FOUND');
        }
        const household = await mockGet<MockHouseholdRow>('households', notice.householdId);
        if (!household) throw new ApiError('NOT_FOUND');
        this.assertFamilyCommand(req);
        if (req.householdId !== household.householdId) throw new ApiError('NOT_FOUND');
        if (caller.userId !== notice.intendedAdultId) throw new ApiError('FORBIDDEN');
        this.assertHouseholdRevision(household, req.expectedHouseholdRevision);
        if (
          notice.createdById !== household.primaryResponsibleId ||
          notice.sourcePrimaryId !== household.primaryResponsibleId
        ) {
          throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
        }
        const minorIds = await this.validateHouseholdMinorScope(
          household.householdId,
          notice.minorIds,
        );
        if (caller.userId === household.primaryResponsibleId) throw new ApiError('CONFLICT');
        if (await this.additionalSeat(household.householdId)) {
          throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
        }
        const now = Date.now();
        await mockPut('seatAssignments', {
          assignmentId: `${household.householdId}:additional`,
          householdId: household.householdId,
          seatType: 'additional_responsible',
          position: null,
          accountId: caller.userId,
          majorityAt: null,
          assignedAt: now,
        } satisfies MockSeatAssignmentRow);
        for (const minorId of minorIds) {
          await mockPut(
            'supervisionLinks',
            this.supervisionLink(
              household.householdId,
              caller.userId,
              minorId,
              'additional_responsible',
              now,
            ),
          );
        }
        await mockPut(
          'coverages',
          this.testCoverage(household.householdId, caller.userId, 'additional_responsible', now),
        );
        const updated = await this.bumpHousehold(household);
        await mockPut('accountNotices', {
          ...notice,
          state: 'accepted',
          acceptedById: caller.userId,
          revision: notice.revision + 1,
        } satisfies MockAccountNoticeRow);
        return this.householdView(updated, caller.userId);
      },
      () => this.additionalInvitationParticipantIds(invitationId),
      async () => [
        `resource:account-notice:${invitationId}`,
        `resource:household:${req.householdId}`,
      ],
    );
  }

  async replaceAdditionalResponsibleScope(
    req: ReplaceAdditionalResponsibleScopeRequest,
  ): Promise<HouseholdView> {
    await simLatency('api.replaceAdditionalResponsibleScope');
    return this.withAccountMutation(
      async (caller) => {
        const household = await this.requirePrimaryHousehold(caller, req);
        const seat = await this.additionalSeat(household.householdId);
        if (!seat) throw new ApiError('NOT_FOUND');
        const minorIds = await this.validateHouseholdMinorScope(
          household.householdId,
          req.minorIds,
        );
        const now = Date.now();
        const current = (await mockGetAll<MockSupervisionLinkRow>('supervisionLinks')).filter(
          (link) =>
            link.householdId === household.householdId &&
            link.adultId === seat.accountId &&
            link.role === 'additional_responsible' &&
            link.state === 'active',
        );
        for (const link of current.filter((link) => !minorIds.includes(link.minorId))) {
          await mockPut('supervisionLinks', { ...link, state: 'revoked', revokedAt: now });
        }
        for (const minorId of minorIds) {
          await mockPut(
            'supervisionLinks',
            this.supervisionLink(
              household.householdId,
              seat.accountId,
              minorId,
              'additional_responsible',
              now,
            ),
          );
        }
        return this.householdView(await this.bumpHousehold(household), caller.userId);
      },
      () => this.householdParticipantIds(req.householdId),
      async () => [`resource:household:${req.householdId}`],
    );
  }

  async revokeAdditionalResponsible(
    req: RevokeAdditionalResponsibleRequest,
  ): Promise<HouseholdView> {
    await simLatency('api.revokeAdditionalResponsible');
    return this.withAccountMutation(
      async (caller) => {
        const household = await this.requirePrimaryHousehold(caller, req);
        const seat = await this.additionalSeat(household.householdId);
        if (!seat) throw new ApiError('NOT_FOUND');
        const now = Date.now();
        for (const link of await mockGetAll<MockSupervisionLinkRow>('supervisionLinks')) {
          if (
            link.householdId === household.householdId &&
            link.adultId === seat.accountId &&
            link.role === 'additional_responsible' &&
            link.state === 'active'
          ) {
            await mockPut('supervisionLinks', { ...link, state: 'revoked', revokedAt: now });
          }
        }
        await mockDelete('seatAssignments', seat.assignmentId);
        const coverage = await mockGet<MockCoverageRow>('coverages', seat.accountId);
        if (coverage?.householdId === household.householdId) {
          await mockPut('coverages', { ...coverage, state: 'ended', validUntil: now });
        }
        return this.householdView(await this.bumpHousehold(household), caller.userId);
      },
      () => this.householdParticipantIds(req.householdId),
      async () => [`resource:household:${req.householdId}`],
    );
  }

  async transferPrimaryResponsibility(
    req: TransferPrimaryResponsibilityRequest,
  ): Promise<HouseholdView> {
    await simLatency('api.transferPrimaryResponsibility');
    return this.withAccountMutation(
      async (caller) => {
        const household = await this.requirePrimaryHousehold(caller, req);
        const additional = await this.additionalSeat(household.householdId);
        if (!additional || additional.accountId !== req.newPrimaryAccountId) {
          throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
        }
        const nextPrimary = await mockGet<MockUserRow>('users', req.newPrimaryAccountId);
        if (!nextPrimary || nextPrimary.accountType !== 'adult') {
          throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
        }
        const now = Date.now();
        const minors = await this.minorSeats(household.householdId);
        for (const seat of minors) {
          await mockPut(
            'supervisionLinks',
            this.supervisionLink(
              household.householdId,
              nextPrimary.userId,
              seat.accountId,
              'primary_responsible',
              now,
            ),
          );
          await mockPut(
            'supervisionLinks',
            this.supervisionLink(
              household.householdId,
              caller.userId,
              seat.accountId,
              'additional_responsible',
              now,
            ),
          );
          await mockDelete('guardianLinks', `${caller.userId}~${seat.accountId}`);
          await mockPut(
            'guardianLinks',
            this.newLink(nextPrimary.userId, seat.accountId, 'created', now),
          );
        }
        await mockPut('seatAssignments', {
          ...additional,
          accountId: caller.userId,
          assignedAt: now,
        });
        await mockPut(
          'coverages',
          this.testCoverage(household.householdId, nextPrimary.userId, null, now),
        );
        await mockPut(
          'coverages',
          this.testCoverage(household.householdId, caller.userId, 'additional_responsible', now),
        );
        const updated = await this.bumpHousehold({
          ...household,
          primaryResponsibleId: nextPrimary.userId,
        });
        return this.householdView(updated, caller.userId);
      },
      () => this.householdParticipantIds(req.householdId),
      async () => [`resource:household:${req.householdId}`],
    );
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
    return this.withAccountMutation(async (current) => {
      this.requireSocial(current);
      const live = (await mockGetAll<MockCodeRow>('codes')).find(
        (code) =>
          code.kind === 'friend' && code.userId === current.userId && code.expiresAt > Date.now(),
      );
      return live
        ? { code: live.code, expiresAt: live.expiresAt }
        : this.mintFriendCode(current.userId);
    });
  }

  async rotateFriendCode(): Promise<CodeGrant> {
    await simLatency('api.rotateFriendCode');
    return this.withAccountMutation(async (caller) => {
      this.requireSocial(caller);
      return this.mintFriendCode(caller.userId);
    });
  }

  async createFriendRequest(rawCode: string): Promise<FriendRequestView> {
    await simLatency('api.createFriendRequest');
    return this.withAccountMutation(
      async (caller) => {
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
        if (grant.userId === caller.userId)
          throw new ApiError('VALIDATION', 'that is your own code');

        const target = await mockGet<MockUserRow>('users', grant.userId);
        if (!target || !target.socialEnabled) return badAttempt('CODE_INVALID');
        const friendshipClass = friendshipClassForAccounts(caller.accountType, target.accountType);
        if (friendshipClass !== 'adult_adult') throw new ApiError('CONSENT_INCOMPLETE');
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
          friendshipClass: 'adult_adult',
        };
        await mockPut('friendRequests', request);
        return {
          requestId,
          user: this.publicOf(target, false),
          createdAt: now,
          expiresAt: request.expiresAt,
        };
      },
      () => this.friendCodeParticipantIds(rawCode),
    );
  }

  async acceptFriendRequest(requestId: string): Promise<FriendView> {
    await simLatency('api.acceptFriendRequest');
    return this.withAccountMutation(
      async (caller) => {
        this.requireSocial(caller);
        const request = await mockGet<MockFriendRequestRow>('friendRequests', requestId);
        if (!request || request.toId !== caller.userId || request.expiresAt <= Date.now()) {
          throw new ApiError('NOT_FOUND');
        }
        const other = await mockGet<MockUserRow>('users', request.fromId);
        if (!other) throw new ApiError('NOT_FOUND');
        const friendshipClass = friendshipClassForAccounts(caller.accountType, other.accountType);
        if (friendshipClass !== 'adult_adult') throw new ApiError('CONSENT_INCOMPLETE');
        // The cap holds on BOTH ends at accept time too — requests sit for days,
        // and either side may have filled up since the request was sent.
        const edges = await mockGetAll<MockFriendshipRow>('friendships');
        const countOf = (id: string) =>
          edges.filter((f) => f.userA === id || f.userB === id).length;
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
          friendshipClass: 'adult_adult',
          state: 'active',
          revision: 1,
        };
        await mockPut('friendships', friendship);
        await mockDelete('friendRequests', requestId);
        return {
          friendshipId: friendship.friendshipId,
          user: this.publicOf(other, false),
          since: friendship.createdAt,
        };
      },
      () => this.friendRequestParticipantIds(requestId),
    );
  }

  /** Silent by design — the requester's pending item simply disappears. */
  async declineFriendRequest(requestId: string): Promise<void> {
    await simLatency('api.declineFriendRequest');
    return this.withAccountMutation(
      async (caller) => {
        this.requireSocial(caller);
        const request = await mockGet<MockFriendRequestRow>('friendRequests', requestId);
        if (!request || request.toId !== caller.userId) throw new ApiError('NOT_FOUND');
        await mockDelete('friendRequests', requestId);
      },
      () => this.friendRequestParticipantIds(requestId),
    );
  }

  async cancelFriendRequest(requestId: string): Promise<void> {
    await simLatency('api.cancelFriendRequest');
    return this.withAccountMutation(
      async (caller) => {
        this.requireSocial(caller);
        const request = await mockGet<MockFriendRequestRow>('friendRequests', requestId);
        if (!request || request.fromId !== caller.userId) throw new ApiError('NOT_FOUND');
        await mockDelete('friendRequests', requestId);
      },
      () => this.friendRequestParticipantIds(requestId),
    );
  }

  async removeFriend(friendshipId: string): Promise<void> {
    await simLatency('api.removeFriend');
    return this.withAccountMutation(
      async (caller) => {
        this.requireSocial(caller);
        await this.removeFriendshipAs(caller.userId, friendshipId);
      },
      () => this.friendshipParticipantIds(friendshipId),
    );
  }

  // ── social v2 ─────────────────────────────────────────────────────────────
  async createAdultFriendRequest(req: CreateAdultFriendRequestRequest): Promise<FriendRequestView> {
    await simLatency('api.createAdultFriendRequest');
    const caller = await this.caller();
    this.requireSocial(caller);
    const grant = await mockGet<MockCodeRow>('codes', this.normalizeCode(req.code));
    const target =
      grant?.kind === 'friend' ? await mockGet<MockUserRow>('users', grant.userId) : null;
    if (!target || grant!.expiresAt <= Date.now()) throw new ApiError('CODE_INVALID');
    if (friendshipClassForAccounts(caller.accountType, target.accountType) !== 'adult_adult') {
      throw new ApiError('ADULT_MINOR_FRIENDSHIP_FORBIDDEN');
    }
    const request = await this.createFriendRequest(req.code);
    const row = await mockGet<MockFriendRequestRow>('friendRequests', request.requestId);
    if (row) await mockPut('friendRequests', { ...row, friendshipClass: 'adult_adult' });
    return request;
  }

  async acceptAdultFriendRequest(requestId: string): Promise<FriendView> {
    await simLatency('api.acceptAdultFriendRequest');
    const caller = await this.caller();
    const request = await mockGet<MockFriendRequestRow>('friendRequests', requestId);
    const requester = request ? await mockGet<MockUserRow>('users', request.fromId) : null;
    if (!request || request.toId !== caller.userId || !requester) throw new ApiError('NOT_FOUND');
    if (friendshipClassForAccounts(caller.accountType, requester.accountType) !== 'adult_adult') {
      throw new ApiError('ADULT_MINOR_FRIENDSHIP_FORBIDDEN');
    }
    const friend = await this.acceptFriendRequest(requestId);
    const row = await mockGet<MockFriendshipRow>('friendships', friend.friendshipId);
    if (row) {
      await mockPut('friendships', {
        ...row,
        friendshipClass: 'adult_adult',
        state: 'active',
        revision: row.revision ?? 1,
      });
    }
    return friend;
  }

  async removeSocialFriendship(friendshipId: string): Promise<void> {
    return this.removeFriend(friendshipId);
  }

  async createMinorInviteCode(req: CreateMinorInviteCodeRequest): Promise<CodeGrant> {
    await simLatency('api.createMinorInviteCode');
    return this.withAccountMutation(
      async (caller) => {
        const minor = await mockGet<MockUserRow>('users', req.minorId);
        if (!minor || minor.accountType !== 'minor') {
          throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
        }
        this.requireSocial(minor);
        if (
          caller.userId !== minor.userId &&
          !(await this.isResponsibleFor(caller.userId, minor.userId))
        ) {
          throw new ApiError('RESPONSIBLE_SCOPE_REQUIRED');
        }
        for (const code of await mockGetAll<MockCodeRow>('codes')) {
          if (code.kind === 'minorFriend' && code.minorId === minor.userId) {
            await mockDelete('codes', code.code);
          }
        }
        const code = await this.mintCode();
        const expiresAt = Date.now() + MINOR_INVITE_TTL_MS;
        await mockPut('codes', {
          code,
          kind: 'minorFriend',
          userId: minor.userId,
          minorId: minor.userId,
          expiresAt,
        } satisfies MockCodeRow);
        return { code, expiresAt };
      },
      () => this.existingParticipantIds([req.minorId]),
      async () => [`resource:minor-invite-code:${req.minorId}`],
    );
  }

  async createMinorFriendRequest(
    req: CreateMinorFriendRequestRequest,
  ): Promise<MinorFriendRequestView> {
    await simLatency('api.createMinorFriendRequest');
    return this.withAccountMutation(
      async (caller) => {
        const code = this.normalizeCode(req.code);
        const bucket = Math.floor(Date.now() / 3_600_000);
        const rateKey = `rate:${caller.userId}:${bucket}`;
        const attempts = (await mockGet<{ key: string; value: number }>('kv', rateKey))?.value ?? 0;
        if (attempts >= LIMITS.codeAttemptsPerHour) throw new ApiError('RATE_LIMITED');
        const badAttempt = async (): Promise<never> => {
          await mockNextSeq(rateKey);
          throw new ApiError('CODE_INVALID');
        };
        const grant = await mockGet<MockCodeRow>('codes', code);
        const recipient =
          grant?.kind === 'minorFriend' && grant.minorId
            ? await mockGet<MockUserRow>('users', grant.minorId)
            : null;
        if (!grant || !recipient || grant.expiresAt <= Date.now()) {
          return badAttempt();
        }
        const friendshipClass = friendshipClassForAccounts(
          caller.accountType,
          recipient.accountType,
        );
        if (friendshipClass !== 'minor_minor' || caller.userId !== req.minorId) {
          throw new ApiError('ADULT_MINOR_FRIENDSHIP_FORBIDDEN');
        }
        this.requireSocial(caller);
        this.requireSocial(recipient);
        if (caller.userId === recipient.userId) throw new ApiError('VALIDATION');
        const [a, b] = [caller.userId, recipient.userId].sort();
        const friendshipId = `${a}~${b}`;
        if (await mockGet<MockFriendshipRow>('friendships', friendshipId)) {
          throw new ApiError('CONFLICT');
        }
        const pending = (await mockGetAll<MockMinorFriendRequestRow>('minorFriendRequests')).find(
          (row) =>
            row.state === 'pending' &&
            ((row.requesterId === caller.userId && row.recipientId === recipient.userId) ||
              (row.requesterId === recipient.userId && row.recipientId === caller.userId)),
        );
        if (pending) throw new ApiError('CONFLICT');
        const now = Date.now();
        const request: MockMinorFriendRequestRow = {
          requestId: `minor-friend:${a}~${b}`,
          requesterId: caller.userId,
          recipientId: recipient.userId,
          state: 'pending',
          createdAt: now,
          expiresAt: now + FRIEND_REQUEST_TTL_MS,
          revision: 1,
          friendshipId: null,
        };
        await mockPut('minorFriendRequests', request);
        const updated = await this.putMinorConsent(
          request,
          'requester_action',
          caller.userId,
          caller.userId,
          'minor-social-v1',
        );
        await mockDelete('codes', code);
        return this.minorFriendRequestView(updated);
      },
      () => this.minorFriendCodeParticipantIds(req.code),
      async () => [`resource:minor-friend-code:${this.normalizeCode(req.code)}`],
    );
  }

  async acceptMinorFriendRequest(
    requestId: string,
    req: MinorFriendActionRequest,
  ): Promise<MinorFriendRequestView> {
    await simLatency('api.acceptMinorFriendRequest');
    return this.withAccountMutation(
      async (caller) => {
        const request = await this.pendingMinorFriendRequest(requestId);
        this.assertMinorSocialCommand(req);
        if (caller.accountType !== 'minor' || caller.userId !== req.minorId) {
          throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
        }
        if (request.recipientId !== caller.userId) throw new ApiError('NOT_FOUND');
        this.requireSocial(caller);
        const updated = await this.putMinorConsent(
          request,
          'recipient_acceptance',
          caller.userId,
          caller.userId,
          req.policyVersion,
        );
        return this.activateMinorFriendshipIfReady(updated);
      },
      () => this.minorFriendRequestParticipantIds(requestId),
      async () => [`resource:minor-friend-request:${requestId}`],
    );
  }

  async approveMinorFriendRequest(
    requestId: string,
    req: MinorFriendActionRequest,
  ): Promise<MinorFriendRequestView> {
    await simLatency('api.approveMinorFriendRequest');
    return this.withAccountMutation(
      async (caller) => {
        const request = await this.pendingMinorFriendRequest(requestId);
        this.assertMinorSocialCommand(req);
        if (req.minorId !== request.requesterId && req.minorId !== request.recipientId) {
          throw new ApiError('NOT_FOUND');
        }
        if (!(await this.isResponsibleFor(caller.userId, req.minorId))) {
          throw new ApiError('RESPONSIBLE_SCOPE_REQUIRED');
        }
        const kind: ConsentKind =
          req.minorId === request.requesterId
            ? 'requester_responsible_approval'
            : 'recipient_responsible_approval';
        const updated = await this.putMinorConsent(
          request,
          kind,
          caller.userId,
          req.minorId,
          req.policyVersion,
        );
        return this.activateMinorFriendshipIfReady(updated);
      },
      () => this.minorFriendRequestParticipantIds(requestId),
      async () => [`resource:minor-friend-request:${requestId}`],
    );
  }

  async rejectMinorFriendRequest(requestId: string, req: MinorFriendActionRequest): Promise<void> {
    await simLatency('api.rejectMinorFriendRequest');
    return this.withAccountMutation(
      async (caller) => {
        const request = await this.pendingMinorFriendRequest(requestId);
        this.assertMinorSocialCommand(req);
        if (req.minorId !== request.requesterId && req.minorId !== request.recipientId) {
          throw new ApiError('NOT_FOUND');
        }
        const ownAction = caller.accountType === 'minor' && caller.userId === req.minorId;
        const responsibleAction = await this.isResponsibleFor(caller.userId, req.minorId);
        if (!ownAction && !responsibleAction) throw new ApiError('RESPONSIBLE_SCOPE_REQUIRED');
        await mockPut('minorFriendRequests', {
          ...request,
          state: 'rejected',
          revision: request.revision + 1,
        });
      },
      () => this.minorFriendRequestParticipantIds(requestId),
      async () => [`resource:minor-friend-request:${requestId}`],
    );
  }

  async removeMinorFriendship(friendshipId: string): Promise<void> {
    await simLatency('api.removeMinorFriendship');
    return this.withAccountMutation(async (caller) => {
      const friendship = await mockGet<MockFriendshipRow>('friendships', friendshipId);
      if (!friendship || friendship.friendshipClass !== 'minor_minor') {
        throw new ApiError('NOT_FOUND');
      }
      const participant = [friendship.userA, friendship.userB].includes(caller.userId);
      const responsible =
        caller.accountType === 'adult' &&
        ((await this.isResponsibleFor(caller.userId, friendship.userA)) ||
          (await this.isResponsibleFor(caller.userId, friendship.userB)));
      if (!participant && !responsible) throw new ApiError('NOT_FOUND');
      await mockDelete('friendships', friendshipId);
      for (const request of await mockGetAll<MockMinorFriendRequestRow>('minorFriendRequests')) {
        if (request.friendshipId === friendshipId && request.state === 'active') {
          await mockPut('minorFriendRequests', {
            ...request,
            state: 'revoked',
            revision: request.revision + 1,
          });
        }
      }
    });
  }

  // ── billing v1 ────────────────────────────────────────────────────────────
  async getBillingSummary(): Promise<BillingSummary> {
    await simLatency('api.getBillingSummary');
    const caller = await this.caller();
    const household = await this.householdForCaller(caller);
    if (household.primaryResponsibleId !== caller.userId) throw new ApiError('FORBIDDEN');
    return {
      contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
      availability: 'disabled',
      householdId: household.householdId,
      payerAccountId: household.primaryResponsibleId,
      state: 'none',
      currentOfferKey: null,
      interval: null,
      paidThrough: null,
      graceUntil: null,
      cancelAtPeriodEnd: false,
      pendingChange: null,
      revision: 0,
    };
  }

  async createCheckout(req: CreateCheckoutRequest): Promise<BillingRedirectView> {
    await simLatency('api.createCheckout');
    return this.rejectDisabledBillingCommand(req);
  }

  async previewSubscriptionChange(
    req: PreviewSubscriptionChangeRequest,
  ): Promise<SubscriptionChangePreviewView> {
    await simLatency('api.previewSubscriptionChange');
    return this.rejectDisabledBillingCommand(req);
  }

  async applySubscriptionChange(req: ApplySubscriptionChangeRequest): Promise<BillingActionView> {
    await simLatency('api.applySubscriptionChange');
    return this.rejectDisabledBillingCommand(req);
  }

  async createPortalSession(req: CreatePortalRequest): Promise<BillingRedirectView> {
    await simLatency('api.createPortalSession');
    return this.rejectDisabledBillingCommand(req);
  }

  // ── forests & sync ────────────────────────────────────────────────────────

  /** Detail per the matrix: guardians get FULL nodes (co-gardening), family-up
   *  and friends get the STRIPPED view, strangers get 404 (no oracle). */
  async getForest(userId: string): Promise<ForestSnapshot> {
    await simLatency('api.getForest');
    const caller = await this.caller();
    const owner = await mockGet<MockUserRow>('users', userId);
    if (!owner) throw new ApiError('NOT_FOUND');
    let detail: ForestSnapshot['detail'] | null = null;
    let includeSocial = false;
    if (caller.userId === userId || (await this.canSupervise(caller.userId, userId))) {
      detail = 'full';
      includeSocial = caller.userId !== userId;
    } else {
      const expectedClass =
        caller.accountType === owner.accountType
          ? friendshipClassForAccounts(caller.accountType, owner.accountType)
          : null;
      const friends = (await mockGetAll<MockFriendshipRow>('friendships')).some(
        (friendship) =>
          (friendship.state === undefined || friendship.state === 'active') &&
          (!friendship.friendshipClass || friendship.friendshipClass === expectedClass) &&
          ((friendship.userA === caller.userId && friendship.userB === userId) ||
            (friendship.userB === caller.userId && friendship.userA === userId)),
      );
      if (friends && expectedClass && caller.socialEnabled && owner.socialEnabled)
        detail = 'stripped';
    }
    if (!detail) throw new ApiError('NOT_FOUND');

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
    return this.withAccountMutation((caller) => this.pushInto(caller.userId, req));
  }

  /** Guardian write-through (co-gardening): same rev-LWW law as own pushes;
   *  records land in the minor's cloud store. */
  async pushSyncFor(userId: string, req: SyncPushPayload): Promise<SyncPushResponse> {
    await simLatency('api.pushSyncFor');
    return this.withAccountMutation(
      async (caller) => {
        if (!(await this.canSupervise(caller.userId, userId))) throw new ApiError('NOT_FOUND');
        return this.pushInto(userId, req);
      },
      async () => [userId],
    );
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

  private normalizeCode(rawCode: string): string {
    const code = rawCode?.trim().toUpperCase().replace(/-/g, '') ?? '';
    if (!code) throw new ApiError('VALIDATION');
    return code;
  }

  private assertFamilyCommand(command: FamilyCommandBase): void {
    if (
      !command.householdId?.trim() ||
      !command.commandId?.trim() ||
      !command.policyVersion?.trim() ||
      !Number.isSafeInteger(command.expectedHouseholdRevision) ||
      command.expectedHouseholdRevision < 1
    ) {
      throw new ApiError('VALIDATION');
    }
  }

  private assertHouseholdRevision(household: MockHouseholdRow, expected: number): void {
    if (household.revision !== expected) throw new ApiError('STALE_REVISION');
  }

  private async householdForCaller(caller: MockUserRow): Promise<MockHouseholdRow> {
    const households = await mockGetAll<MockHouseholdRow>('households');
    if (caller.accountType === 'adult') {
      const primary = households.find(
        (row) => row.primaryResponsibleId === caller.userId && row.state !== 'closed',
      );
      if (primary) return primary;
      const additionalLink = (await mockGetAll<MockSupervisionLinkRow>('supervisionLinks')).find(
        (link) =>
          link.adultId === caller.userId &&
          link.role === 'additional_responsible' &&
          link.state === 'active',
      );
      if (additionalLink) {
        const additionalHousehold = households.find(
          (row) => row.householdId === additionalLink.householdId && row.state !== 'closed',
        );
        if (additionalHousehold) return additionalHousehold;
      }
      const now = Date.now();
      const household: MockHouseholdRow = {
        householdId: `household-${mockHash(`household:${caller.userId}`).toString(36)}`,
        primaryResponsibleId: caller.userId,
        country: 'MX',
        state: 'active',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      await mockPut('households', household);
      return household;
    }

    const primaryLink = (await mockGetAll<MockSupervisionLinkRow>('supervisionLinks')).find(
      (link) =>
        link.minorId === caller.userId &&
        link.role === 'primary_responsible' &&
        link.state === 'active',
    );
    const household = primaryLink
      ? households.find((row) => row.householdId === primaryLink.householdId)
      : null;
    if (!household) throw new ApiError('NOT_FOUND');
    return household;
  }

  private async requirePrimaryHousehold(
    caller: MockUserRow,
    command: FamilyCommandBase,
  ): Promise<MockHouseholdRow> {
    this.assertFamilyCommand(command);
    const household = await mockGet<MockHouseholdRow>('households', command.householdId);
    if (!household) throw new ApiError('NOT_FOUND');
    if (caller.accountType !== 'adult' || household.primaryResponsibleId !== caller.userId) {
      throw new ApiError('FORBIDDEN');
    }
    this.assertHouseholdRevision(household, command.expectedHouseholdRevision);
    if (household.state !== 'active') throw new ApiError('FORBIDDEN');
    return household;
  }

  private async primaryHouseholdForMinor(minorId: string): Promise<MockHouseholdRow | null> {
    const link = (await mockGetAll<MockSupervisionLinkRow>('supervisionLinks')).find(
      (row) =>
        row.minorId === minorId && row.role === 'primary_responsible' && row.state === 'active',
    );
    if (!link) return null;
    return (await mockGet<MockHouseholdRow>('households', link.householdId)) ?? null;
  }

  private async minorSeats(householdId: string): Promise<MockSeatAssignmentRow[]> {
    return (await mockGetAll<MockSeatAssignmentRow>('seatAssignments'))
      .filter((seat) => seat.householdId === householdId && seat.seatType === 'minor')
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  private async additionalSeat(householdId: string): Promise<MockSeatAssignmentRow | null> {
    return (
      (await mockGetAll<MockSeatAssignmentRow>('seatAssignments')).find(
        (seat) => seat.householdId === householdId && seat.seatType === 'additional_responsible',
      ) ?? null
    );
  }

  private firstAvailableMinorSeat(seats: readonly MockSeatAssignmentRow[]): 1 | 2 {
    return seats.some((seat) => seat.position === 1) ? 2 : 1;
  }

  private minorSeat(
    householdId: string,
    position: 1 | 2,
    accountId: string,
    majorityAt: string,
    assignedAt: number,
  ): MockSeatAssignmentRow {
    return {
      assignmentId: `${householdId}:minor:${position}`,
      householdId,
      seatType: 'minor',
      position,
      accountId,
      majorityAt,
      assignedAt,
    };
  }

  private supervisionLink(
    householdId: string,
    adultId: string,
    minorId: string,
    role: MockSupervisionLinkRow['role'],
    createdAt: number,
  ): MockSupervisionLinkRow {
    return {
      linkId: `${householdId}:${adultId}:${minorId}`,
      householdId,
      adultId,
      minorId,
      role,
      state: 'active',
      createdAt,
      revokedAt: null,
    };
  }

  private testCoverage(
    householdId: string,
    accountId: string,
    seatType: MockCoverageRow['seatType'],
    createdAt: number,
  ): MockCoverageRow {
    return {
      coverageId: accountId,
      householdId,
      accountId,
      seatType,
      state: 'active',
      source: 'test_seed',
      validUntil: null,
      createdAt,
    };
  }

  private async bumpHousehold(household: MockHouseholdRow): Promise<MockHouseholdRow> {
    const updated = {
      ...household,
      revision: household.revision + 1,
      updatedAt: Date.now(),
    } satisfies MockHouseholdRow;
    await mockPut('households', updated);
    return updated;
  }

  private async householdView(
    household: MockHouseholdRow,
    callerId: string,
  ): Promise<HouseholdView> {
    const primary = await mockGet<MockUserRow>('users', household.primaryResponsibleId);
    if (!primary) throw new ApiError('NOT_FOUND');
    const seats = await this.minorSeats(household.householdId);
    const minors: HouseholdView['minors'] = [];
    for (const seat of seats.slice(0, 2)) {
      const minor = await mockGet<MockUserRow>('users', seat.accountId);
      if (!minor) continue;
      const coverage = await mockGet<MockCoverageRow>('coverages', minor.userId);
      minors.push({
        user: this.publicOf(minor, true),
        seat: seat.position === 2 ? 2 : 1,
        majorityAt: seat.majorityAt ?? '9999-12-31',
        coverageState: coverage?.householdId === household.householdId ? coverage.state : null,
      });
    }
    const additionalSeat = await this.additionalSeat(household.householdId);
    let additionalResponsible: HouseholdView['additionalResponsible'] = null;
    if (additionalSeat) {
      const additional = await mockGet<MockUserRow>('users', additionalSeat.accountId);
      if (additional) {
        const links = (await mockGetAll<MockSupervisionLinkRow>('supervisionLinks')).filter(
          (link) =>
            link.householdId === household.householdId &&
            link.adultId === additional.userId &&
            link.role === 'additional_responsible' &&
            link.state === 'active',
        );
        const coverage = await mockGet<MockCoverageRow>('coverages', additional.userId);
        additionalResponsible = {
          user: this.publicOf(additional, false),
          minorIds: links.map((link) => link.minorId).sort(),
          coverageState: coverage?.householdId === household.householdId ? coverage.state : null,
        };
      }
    }
    const myRole =
      household.primaryResponsibleId === callerId
        ? 'primary_responsible'
        : additionalSeat?.accountId === callerId
          ? 'additional_responsible'
          : null;
    return {
      contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
      householdId: household.householdId,
      country: household.country,
      state: household.state,
      myRole,
      primaryResponsible: this.publicOf(primary, false),
      additionalResponsible,
      minors,
      availableMinorSeats: Math.max(0, 2 - minors.length) as 0 | 1 | 2,
      additionalResponsibleSeatAvailable: !additionalResponsible,
      revision: household.revision,
    };
  }

  private minorLinkRequestView(
    notice: MockAccountNoticeRow,
    minor: MockUserRow,
  ): MinorLinkRequestView {
    return {
      contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
      requestId: notice.noticeId,
      householdId: notice.householdId,
      minor: this.publicOf(minor, true),
      state: notice.state as MinorLinkRequestView['state'],
      expiresAt: notice.expiresAt,
      revision: notice.revision,
    };
  }

  private additionalInvitationView(
    notice: MockAccountNoticeRow,
  ): AdditionalResponsibleInvitationView {
    return {
      contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
      invitationId: notice.noticeId,
      householdId: notice.householdId,
      intendedAdultId: notice.intendedAdultId!,
      minorIds: [...notice.minorIds],
      state: notice.state as AdditionalResponsibleInvitationView['state'],
      expiresAt: notice.expiresAt,
      revision: notice.revision,
    };
  }

  private async validateHouseholdMinorScope(
    householdId: string,
    rawMinorIds: readonly string[],
  ): Promise<string[]> {
    const minorIds = [...new Set(rawMinorIds)].sort();
    if (minorIds.length < 1 || minorIds.length > 2 || minorIds.length !== rawMinorIds.length) {
      throw new ApiError('VALIDATION');
    }
    const available = new Set((await this.minorSeats(householdId)).map((seat) => seat.accountId));
    if (minorIds.some((minorId) => !available.has(minorId))) {
      throw new ApiError('RESPONSIBLE_SCOPE_REQUIRED');
    }
    return minorIds;
  }

  private async revokeSupervision(
    householdId: string,
    adultId: string,
    minorId: string,
  ): Promise<void> {
    const link = await mockGet<MockSupervisionLinkRow>(
      'supervisionLinks',
      `${householdId}:${adultId}:${minorId}`,
    );
    if (link?.state === 'active') {
      await mockPut('supervisionLinks', {
        ...link,
        state: 'revoked',
        revokedAt: Date.now(),
      });
    }
  }

  private async isResponsibleFor(adultId: string, minorId: string): Promise<boolean> {
    const adult = await mockGet<MockUserRow>('users', adultId);
    const minor = await mockGet<MockUserRow>('users', minorId);
    if (adult?.accountType !== 'adult' || minor?.accountType !== 'minor') return false;
    const pairLinks = (await mockGetAll<MockSupervisionLinkRow>('supervisionLinks')).filter(
      (link) => link.adultId === adultId && link.minorId === minorId,
    );
    const activeLinks = pairLinks.filter((link) => link.state === 'active');
    for (const link of activeLinks.filter((row) => row.role === 'primary_responsible')) {
      const household = await mockGet<MockHouseholdRow>('households', link.householdId);
      const hasMinorSeat = (await this.minorSeats(link.householdId)).some(
        (seat) => seat.accountId === minorId,
      );
      if (
        household?.state === 'active' &&
        household.primaryResponsibleId === adultId &&
        hasMinorSeat
      ) {
        return true;
      }
    }
    for (const link of activeLinks.filter((row) => row.role === 'additional_responsible')) {
      const household = await mockGet<MockHouseholdRow>('households', link.householdId);
      const seat = await this.additionalSeat(link.householdId);
      const coverage = await mockGet<MockCoverageRow>('coverages', adultId);
      const hasMinorSeat = (await this.minorSeats(link.householdId)).some(
        (minorSeat) => minorSeat.accountId === minorId,
      );
      if (
        household?.state === 'active' &&
        seat?.accountId === adultId &&
        hasMinorSeat &&
        coverage?.householdId === link.householdId &&
        ['active', 'grace', 'scheduled_end'].includes(coverage.state)
      ) {
        return true;
      }
    }
    // Once a pair has entered the v2 supervision model, its v2 state is
    // authoritative. A revoked row must never be resurrected by legacy data.
    return pairLinks.length === 0 && !!(await this.linkBetween(adultId, minorId));
  }

  private async canSupervise(adultId: string, minorId: string): Promise<boolean> {
    return this.isResponsibleFor(adultId, minorId);
  }

  private assertMinorSocialCommand(command: MinorFriendActionRequest): void {
    if (!command.minorId?.trim() || !command.commandId?.trim() || !command.policyVersion?.trim()) {
      throw new ApiError('VALIDATION');
    }
  }

  private async pendingMinorFriendRequest(requestId: string): Promise<MockMinorFriendRequestRow> {
    const request = await mockGet<MockMinorFriendRequestRow>('minorFriendRequests', requestId);
    if (!request || request.state !== 'pending') throw new ApiError('NOT_FOUND');
    if (request.expiresAt <= Date.now()) {
      await mockPut('minorFriendRequests', {
        ...request,
        state: 'expired',
        revision: request.revision + 1,
      });
      throw new ApiError('NOT_FOUND');
    }
    return request;
  }

  private async putMinorConsent(
    request: MockMinorFriendRequestRow,
    kind: ConsentKind,
    actorId: string,
    subjectMinorId: string,
    policyVersion: string,
  ): Promise<MockMinorFriendRequestRow> {
    const consentId = `${request.requestId}:${kind}`;
    const existing = await mockGet<MockConsentRow>('consents', consentId);
    const isResponsibleApproval =
      kind === 'requester_responsible_approval' || kind === 'recipient_responsible_approval';
    if (
      existing &&
      (!isResponsibleApproval ||
        (existing.actorId === actorId &&
          existing.subjectMinorId === subjectMinorId &&
          existing.policyVersion === policyVersion))
    ) {
      return request;
    }
    await mockPut('consents', {
      consentId,
      requestId: request.requestId,
      kind,
      actorId,
      subjectMinorId,
      policyVersion,
      recordedAt: Date.now(),
    } satisfies MockConsentRow);
    const updated = { ...request, revision: request.revision + 1 };
    await mockPut('minorFriendRequests', updated);
    return updated;
  }

  private async minorFriendRequestView(
    request: MockMinorFriendRequestRow,
  ): Promise<MinorFriendRequestView> {
    const requester = await mockGet<MockUserRow>('users', request.requesterId);
    const recipient = await mockGet<MockUserRow>('users', request.recipientId);
    if (!requester || !recipient) throw new ApiError('NOT_FOUND');
    const order = new Map(CONSENT_KINDS.map((kind, index) => [kind, index]));
    const consents = (await mockGetAll<MockConsentRow>('consents'))
      .filter((consent) => consent.requestId === request.requestId)
      .sort((a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0))
      .map((consent) => ({ kind: consent.kind, recordedAt: consent.recordedAt }));
    return {
      contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
      requestId: request.requestId,
      friendshipClass: 'minor_minor',
      state: request.state,
      requester: this.publicOf(requester, false),
      recipient: this.publicOf(recipient, false),
      consents,
      expiresAt: request.expiresAt,
      revision: request.revision,
    };
  }

  private async activateMinorFriendshipIfReady(
    request: MockMinorFriendRequestRow,
  ): Promise<MinorFriendRequestView> {
    const consentRows = (await mockGetAll<MockConsentRow>('consents')).filter(
      (consent) => consent.requestId === request.requestId,
    );
    if (!hasCompleteMinorFriendConsents(consentRows.map((consent) => consent.kind))) {
      return this.minorFriendRequestView(request);
    }
    const requester = await mockGet<MockUserRow>('users', request.requesterId);
    const recipient = await mockGet<MockUserRow>('users', request.recipientId);
    if (!requester || !recipient) throw new ApiError('NOT_FOUND');
    this.requireSocial(requester);
    this.requireSocial(recipient);
    if (
      friendshipClassForAccounts(requester.accountType, recipient.accountType) !== 'minor_minor'
    ) {
      throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
    }
    const requesterApproval = consentRows.find(
      (consent) => consent.kind === 'requester_responsible_approval',
    );
    const recipientApproval = consentRows.find(
      (consent) => consent.kind === 'recipient_responsible_approval',
    );
    if (
      !requesterApproval ||
      !recipientApproval ||
      !(await this.isResponsibleFor(requesterApproval.actorId, requester.userId)) ||
      !(await this.isResponsibleFor(recipientApproval.actorId, recipient.userId))
    ) {
      throw new ApiError('CONSENT_INCOMPLETE');
    }
    const [a, b] = [requester.userId, recipient.userId].sort();
    const friendshipId = `${a}~${b}`;
    if (!(await mockGet<MockFriendshipRow>('friendships', friendshipId))) {
      await mockPut('friendships', {
        friendshipId,
        userA: a,
        userB: b,
        createdAt: Date.now(),
        friendshipClass: 'minor_minor',
        state: 'active',
        revision: 1,
      } satisfies MockFriendshipRow);
    }
    const active = {
      ...request,
      state: 'active' as const,
      friendshipId,
      revision: request.revision + 1,
    };
    await mockPut('minorFriendRequests', active);
    return this.minorFriendRequestView(active);
  }

  private async rejectDisabledBillingCommand(command: BillingCommandBase): Promise<never> {
    if (
      !command.householdId?.trim() ||
      !command.commandId?.trim() ||
      !Number.isSafeInteger(command.expectedHouseholdRevision)
    ) {
      throw new ApiError('VALIDATION');
    }
    const caller = await this.caller();
    const household = await mockGet<MockHouseholdRow>('households', command.householdId);
    if (!household) throw new ApiError('NOT_FOUND');
    if (household.primaryResponsibleId !== caller.userId) throw new ApiError('FORBIDDEN');
    this.assertHouseholdRevision(household, command.expectedHouseholdRevision);
    throw new ApiError('PAYMENT_REQUIRED');
  }

  private async unavailable<T>(operation: string): Promise<T> {
    await simLatency(operation);
    await this.caller();
    throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
  }

  /** Bearer-token gate — same 401 semantics HttpApi will meet in production. */
  private async caller(): Promise<MockUserRow> {
    return this.callerForIdentity(await this.callerIdentity());
  }

  private async callerIdentity(): Promise<MockCallerIdentity> {
    return this.identityFromToken(await this.auth.idToken());
  }

  private async accountClosureIdentity(): Promise<MockCallerIdentity> {
    const closureAuth = this.auth as AuthProvider & Partial<AccountClosureCredentialProvider>;
    const accountClosureCredential = closureAuth.accountClosureCredential;
    const hasClosureCredential = typeof accountClosureCredential === 'function';
    const token = hasClosureCredential
      ? await accountClosureCredential.call(closureAuth)
      : await this.auth.idToken();
    return { ...this.identityFromToken(token), closureOnly: hasClosureCredential };
  }

  private identityFromToken(token: string | null): MockCallerIdentity {
    const payload = token ? parseMockToken(token) : null;
    if (
      !payload ||
      typeof payload.accountInstanceId !== 'string' ||
      !payload.accountInstanceId.trim()
    ) {
      throw new ApiError('UNAUTHENTICATED');
    }
    return { sub: payload.sub, accountInstanceId: payload.accountInstanceId };
  }

  private async callerForIdentity(identity: MockCallerIdentity): Promise<MockUserRow> {
    const user = await mockGet<MockUserRow>('users', identity.sub);
    if (!user || user.accountInstanceId !== identity.accountInstanceId) {
      throw new ApiError('UNAUTHENTICATED');
    }
    return user;
  }

  /** All mock writes linearize against terminal closure for this incarnation. */
  private async withAccountMutation<T>(
    operation: (caller: MockUserRow) => Promise<T>,
    participantIds: () => Promise<readonly string[]> = async () => [],
    lockOnlyIds: () => Promise<readonly string[]> = async () => [],
  ): Promise<T> {
    const identity = await this.callerIdentity();
    await this.callerForIdentity(identity);
    const normalize = (ids: readonly string[]) => [...new Set(ids)].sort();
    const initialParticipants = normalize(await participantIds());
    const initialLockOnly = normalize(await lockOnlyIds());
    const targetIdentities = await Promise.all(
      initialParticipants
        .filter((userId) => userId !== identity.sub)
        .map((userId) => this.activeAccountIdentity(userId)),
    );
    const identities = [identity, ...targetIdentities];

    return withMockAccountLocks(
      [...identities.map((participant) => participant.sub), ...initialLockOnly],
      async () => {
        const liveParticipants = normalize(await participantIds());
        const liveLockOnly = normalize(await lockOnlyIds());
        if (
          liveParticipants.join('\u0000') !== initialParticipants.join('\u0000') ||
          liveLockOnly.join('\u0000') !== initialLockOnly.join('\u0000')
        ) {
          throw new ApiError('NOT_FOUND');
        }
        let caller: MockUserRow | null = null;
        for (const participant of identities) {
          const tombstone = await mockGet<MockAccountClosureRow>(
            'kv',
            mockAccountClosureKey(participant.sub, participant.accountInstanceId),
          );
          const user = await mockGet<MockUserRow>('users', participant.sub);
          if (tombstone || user?.accountInstanceId !== participant.accountInstanceId) {
            throw new ApiError(participant.sub === identity.sub ? 'UNAUTHENTICATED' : 'NOT_FOUND');
          }
          if (participant.sub === identity.sub) caller = user;
        }
        if (!caller) throw new ApiError('UNAUTHENTICATED');
        return operation(caller);
      },
    );
  }

  private async familyLinkParticipantIds(linkId: string): Promise<string[]> {
    const link = await mockGet<MockGuardianLinkRow>('guardianLinks', linkId);
    return this.existingParticipantIds(link ? [link.guardianId, link.minorId] : []);
  }

  private async familyInviteParticipantIds(rawCode: string): Promise<string[]> {
    const code = rawCode?.trim().toUpperCase().replace(/-/g, '') ?? '';
    const invite = await mockGet<MockCodeRow>('codes', code);
    return this.existingParticipantIds(
      invite && ['coGuardian', 'linkExisting'].includes(invite.kind)
        ? [invite.userId, ...(invite.minorId ? [invite.minorId] : [])]
        : [],
    );
  }

  private async friendCodeParticipantIds(rawCode: string): Promise<string[]> {
    const code = rawCode?.trim().toUpperCase().replace(/-/g, '') ?? '';
    const grant = await mockGet<MockCodeRow>('codes', code);
    return this.existingParticipantIds(grant?.kind === 'friend' ? [grant.userId] : []);
  }

  private async friendRequestParticipantIds(requestId: string): Promise<string[]> {
    const request = await mockGet<MockFriendRequestRow>('friendRequests', requestId);
    return this.existingParticipantIds(request ? [request.fromId, request.toId] : []);
  }

  private async minorFriendCodeParticipantIds(rawCode: string): Promise<string[]> {
    const grant = await mockGet<MockCodeRow>('codes', this.normalizeCode(rawCode));
    return this.existingParticipantIds(
      grant?.kind === 'minorFriend' && grant.minorId ? [grant.minorId] : [],
    );
  }

  private async minorFriendRequestParticipantIds(requestId: string): Promise<string[]> {
    const request = await mockGet<MockMinorFriendRequestRow>('minorFriendRequests', requestId);
    return this.existingParticipantIds(request ? [request.requesterId, request.recipientId] : []);
  }

  private async additionalInvitationParticipantIds(invitationId: string): Promise<string[]> {
    const notice = await mockGet<MockAccountNoticeRow>('accountNotices', invitationId);
    return this.existingParticipantIds(
      notice
        ? [
            notice.createdById,
            ...(notice.intendedAdultId ? [notice.intendedAdultId] : []),
            ...notice.minorIds,
            ...(notice.acceptedById ? [notice.acceptedById] : []),
          ]
        : [],
    );
  }

  private async householdParticipantIds(householdId: string): Promise<string[]> {
    const household = await mockGet<MockHouseholdRow>('households', householdId);
    if (!household) return [];
    const seats = (await mockGetAll<MockSeatAssignmentRow>('seatAssignments')).filter(
      (seat) => seat.householdId === householdId,
    );
    return this.existingParticipantIds([
      household.primaryResponsibleId,
      ...seats.map((seat) => seat.accountId),
    ]);
  }

  private async minorLinkNoticeParticipantIds(requestId: string): Promise<string[]> {
    const notice = await mockGet<MockAccountNoticeRow>('accountNotices', requestId);
    return this.existingParticipantIds(
      notice
        ? [
            notice.createdById,
            ...(notice.sourcePrimaryId ? [notice.sourcePrimaryId] : []),
            ...(notice.minorId ? [notice.minorId] : []),
          ]
        : [],
    );
  }

  private async friendshipParticipantIds(friendshipId: string): Promise<string[]> {
    const friendship = await mockGet<MockFriendshipRow>('friendships', friendshipId);
    return this.existingParticipantIds(friendship ? [friendship.userA, friendship.userB] : []);
  }

  private async existingParticipantIds(userIds: readonly string[]): Promise<string[]> {
    const unique = [...new Set(userIds)].sort();
    const users = await Promise.all(unique.map((userId) => mockGet<MockUserRow>('users', userId)));
    return unique.filter((_, index) => !!users[index]);
  }

  private async activeAccountIdentity(userId: string): Promise<MockCallerIdentity> {
    const user = await mockGet<MockUserRow>('users', userId);
    if (!user) throw new ApiError('NOT_FOUND');
    if (user.accountInstanceId) {
      return { sub: userId, accountInstanceId: user.accountInstanceId };
    }
    return withMockAccountLock(userId, async () => {
      const current = await mockGet<MockUserRow>('users', userId);
      if (!current) throw new ApiError('NOT_FOUND');
      if (current.accountInstanceId) {
        return { sub: userId, accountInstanceId: current.accountInstanceId };
      }
      const upgraded = { ...current, accountInstanceId: crypto.randomUUID() };
      await mockPut('users', upgraded);
      return { sub: userId, accountInstanceId: upgraded.accountInstanceId };
    });
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
