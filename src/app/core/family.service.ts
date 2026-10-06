import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { API_CLIENT } from './api/api-client';
import {
  ApiError,
  ApiErrorCode,
  CodeGrant,
  CreateChildResponse,
  FamilyInviteRequest,
  FriendsResponse,
  UserProfile,
  FAMILY_BILLING_CONTRACT_VERSION,
  HouseholdView,
  CreateMinorRequest,
  CreateMinorResponse,
  CreateMinorLinkRequest,
  MinorLinkRequestView,
  ApproveMinorLinkRequest,
  AcceptMinorLinkRequest,
  CreateAdditionalResponsibleInvitationRequest,
  AdditionalResponsibleInvitationView,
  AcceptAdditionalResponsibleInvitationRequest,
  ReplaceAdditionalResponsibleScopeRequest,
  RevokeAdditionalResponsibleRequest,
  MinorFriendRequestView,
  FamilyInboxView,
  FamilyInboxEntry,
  TransferPrimaryResponsibilityRequest,
} from './api/contracts';
import { AuthService } from './auth/auth.service';
import { onAccountClosureQuiesce } from './db/account-closure-fence';
import { del, get, getAll, put } from './db/idb';

/**
 * The family facade — signals over GET /family/household and family operations.
 * Never runs at boot (boot stays network-free): the familia surface calls
 * `open()` when it appears. Cached views are informative, never permission.
 * Each session owns its async completions, including temporary credentials.
 */

const META_FAMILY_PREFIX = 'family.household.v2:';
const familyCacheKey = (userId: string) => `${META_FAMILY_PREFIX}${userId}`;

export interface FamilyHouseholdSnapshot {
  key: string;
  userId: string;
  household: HouseholdView;
  cachedAt: number;
}

export interface FamilyCachePort {
  read(userId: string): Promise<FamilyHouseholdSnapshot | null>;
  write(snapshot: FamilyHouseholdSnapshot): Promise<void>;
  remove(): Promise<void>;
  removeLegacy(): Promise<void>;
}

export const FAMILY_CACHE = new InjectionToken<FamilyCachePort>('FAMILY_CACHE', {
  providedIn: 'root',
  factory: () => ({
    read: async (userId) =>
      (await get<FamilyHouseholdSnapshot>('meta', familyCacheKey(userId))) ?? null,
    write: (snapshot) => put('meta', snapshot),
    remove: async () => {
      const rows = await getAll<{ key: string }>('meta');
      await Promise.all(
        rows
          .filter((row) => row.key.startsWith(META_FAMILY_PREFIX))
          .map((row) => del('meta', row.key)),
      );
      await del('meta', 'family.me');
    },
    removeLegacy: () => del('meta', 'family.me'),
  }),
});

@Injectable({ providedIn: 'root' })
export class FamilyService {
  private readonly api = inject(API_CLIENT);
  private readonly auth = inject(AuthService);
  private readonly cache = inject(FAMILY_CACHE);

  private readonly householdSignal = signal<HouseholdView | null>(null);
  private readonly viewIdentity = signal(this.auth.user());
  private readonly loadingSignal = signal(false);
  private readonly mutatingSignal = signal(false);
  private readonly freshSignal = signal(false);
  private readonly lastErrorSignal = signal<ApiErrorCode | null>(null);
  /** Invalidates cache/network completions once terminal account cleanup starts. */
  private generation = 0;
  private accountClosureQuiesced = false;
  private readonly pendingCacheWrites = new Set<Promise<void>>();
  private cacheTail: Promise<void> = Promise.resolve();
  private refreshSequence = 0;
  private inboxSequence = 0;
  private readonly inboxSignal = signal<FamilyInboxView | null>(null);
  private readonly inboxLoadingSignal = signal(false);
  private readonly inboxErrorSignal = signal<ApiErrorCode | null>(null);
  private lastIdentity = this.auth.user();

  private readonly sameIdentity = computed(() => this.viewIdentity() === this.auth.user());
  readonly household = computed(() => (this.sameIdentity() ? this.householdSignal() : null));
  readonly loading = computed(
    () => this.sameIdentity() && (this.loadingSignal() || this.mutatingSignal()),
  );
  readonly lastError = computed(() => (this.sameIdentity() ? this.lastErrorSignal() : null));
  readonly fresh = computed(() => this.sameIdentity() && this.freshSignal());
  readonly myRole = computed(() => this.household()?.myRole ?? null);
  readonly minors = computed(() => this.household()?.minors ?? []);
  readonly additionalResponsible = computed(() => this.household()?.additionalResponsible ?? null);
  readonly inboxLoading = computed(() => this.sameIdentity() && this.inboxLoadingSignal());
  readonly inboxError = computed(() => (this.sameIdentity() ? this.inboxErrorSignal() : null));
  readonly inbox = computed(() => (this.sameIdentity() ? this.inboxSignal() : null));
  readonly pendingRequests = computed(
    () =>
      this.inbox()?.entries.filter(
        (entry) => entry.state === 'pending' || entry.state === 'approved',
      ) ?? null,
  );
  readonly notices = computed(
    () =>
      this.inbox()?.entries.filter(
        (entry) => entry.state !== 'pending' && entry.state !== 'approved',
      ) ?? null,
  );
  readonly statusNotices = computed(() => {
    const household = this.household();
    if (!household) return [];
    const notices: (
      'cached' | 'coverage_ended' | 'disputed' | 'legacy_over_capacity' | 'closed'
    )[] = [];
    if (!this.fresh()) notices.push('cached');
    if (household.state !== 'active') notices.push(household.state);
    if (
      household.minors.some(
        (minor) => minor.coverageState === 'ended' || minor.coverageState === null,
      )
    )
      notices.push('coverage_ended');
    return notices;
  });

  constructor() {
    effect(() => this.adoptIdentity());
    const stopAccountClosure = onAccountClosureQuiesce(() => this.beginAccountClosureReset());
    inject(DestroyRef).onDestroy(stopAccountClosure);
  }

  /** Cache-first paint + background refresh. Call when the surface opens. */
  async open(): Promise<void> {
    this.adoptIdentity();
    if (this.accountClosureQuiesced) return;
    const userId = this.auth.user()?.userId;
    if (!userId) return;
    const generation = this.generation;
    const identity = this.auth.user();
    try {
      const cached = await this.cache.read(userId);
      if (
        generation === this.generation &&
        this.auth.user() === identity &&
        cached?.key === familyCacheKey(userId) &&
        cached?.userId === userId &&
        cached.household?.contractVersion === FAMILY_BILLING_CONTRACT_VERSION &&
        !this.householdSignal()
      ) {
        this.householdSignal.set(cached.household);
        this.freshSignal.set(false);
      }
    } catch {
      /* no cache — network will answer */
    }
    if (generation === this.generation && this.auth.user() === identity) await this.refresh();
  }

  async refresh(): Promise<void> {
    this.adoptIdentity();
    if (this.accountClosureQuiesced) return;
    const userId = this.auth.user()?.userId;
    if (!userId) {
      this.householdSignal.set(null);
      return;
    }
    const generation = this.generation;
    const identity = this.auth.user();
    const sequence = ++this.refreshSequence;
    const current = () =>
      generation === this.generation &&
      this.auth.user() === identity &&
      sequence === this.refreshSequence;
    const inboxLoad = this.refreshInbox();
    this.loadingSignal.set(true);
    this.lastErrorSignal.set(null);
    try {
      const household = await this.api.getHousehold();
      if (!current()) return;
      if (household.contractVersion !== FAMILY_BILLING_CONTRACT_VERSION)
        throw new ApiError('VALIDATION');
      this.householdSignal.set(household);
      this.freshSignal.set(true);
      try {
        const write = this.cacheTail
          .catch(() => undefined)
          .then(async () => {
            if (!current()) return;
            await this.cache.write({
              key: familyCacheKey(userId),
              userId,
              household,
              cachedAt: Date.now(),
            });
            if (current()) await this.cache.removeLegacy();
          });
        this.cacheTail = write;
        this.pendingCacheWrites.add(write);
        try {
          await write;
        } finally {
          this.pendingCacheWrites.delete(write);
        }
      } catch {
        /* memory-only session */
      }
    } catch (error) {
      // Cached view stands; the card shows the calm error line.
      if (current()) {
        this.freshSignal.set(false);
        if (
          error instanceof ApiError &&
          ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code)
        )
          this.householdSignal.set(null);
        this.lastErrorSignal.set(error instanceof ApiError ? error.code : 'unknown');
      }
    } finally {
      if (current()) this.loadingSignal.set(false);
      await inboxLoad;
    }
  }

  /** Independent from household membership: intended invitees may have no home yet. */
  async refreshInbox(append = false): Promise<void> {
    this.adoptIdentity();
    const identity = this.auth.user();
    if (this.accountClosureQuiesced || !identity) return;
    const cursor = append ? this.inboxSignal()?.nextCursor : undefined;
    if (append && (!cursor || this.inboxLoadingSignal())) return;
    const generation = this.generation;
    const sequence = ++this.inboxSequence;
    const current = () =>
      generation === this.generation &&
      this.auth.user() === identity &&
      sequence === this.inboxSequence;
    this.inboxLoadingSignal.set(true);
    this.inboxErrorSignal.set(null);
    try {
      const inbox = await this.api.getFamilyInbox(cursor ?? undefined);
      if (!current()) return;
      if (inbox.contractVersion !== FAMILY_BILLING_CONTRACT_VERSION)
        throw new ApiError('VALIDATION');
      const entries = new Map<string, FamilyInboxEntry>();
      for (const entry of [
        ...(append ? (this.inboxSignal()?.entries ?? []) : []),
        ...inbox.entries,
      ]) {
        entries.set(entry.kind + ':' + entry.householdId + ':' + entry.noticeId, entry);
      }
      this.inboxSignal.set({ ...inbox, entries: [...entries.values()] });
    } catch (error) {
      if (current()) {
        if (!append) this.inboxSignal.set(null);
        this.inboxErrorSignal.set(error instanceof ApiError ? error.code : 'unknown');
      }
    } finally {
      if (current()) this.inboxLoadingSignal.set(false);
    }
  }

  /** Wipes the signal on sign-out (the meta cache is keyed by user anyway). */
  clear(): void {
    this.generation += 1;
    this.householdSignal.set(null);
    this.inboxSignal.set(null);
    this.inboxLoadingSignal.set(false);
    this.inboxErrorSignal.set(null);
    this.freshSignal.set(false);
    this.mutatingSignal.set(false);
    this.viewIdentity.set(this.auth.user());
    this.lastErrorSignal.set(null);
    this.loadingSignal.set(false);
  }

  async resetAfterAccountClosure(): Promise<void> {
    this.beginAccountClosureReset();
    while (this.pendingCacheWrites.size) {
      await Promise.allSettled([...this.pendingCacheWrites]);
    }
    this.beginAccountClosureReset();
  }

  /** Practice-cloud reset: the cached snapshot must go WITH the cloud — the
   *  reseeded accounts share ids with the wiped ones, so a kept cache would
   *  paint a family that no longer exists. */
  async clearCache(): Promise<void> {
    this.clear();
    try {
      await Promise.allSettled([...this.pendingCacheWrites]);
      await this.cache.remove();
    } catch {
      /* memory-only session */
    }
  }

  // ── operations (each returns a value for the sheet, then refreshes) ───────

  async createMinor(req: CreateMinorRequest): Promise<CreateMinorResponse | null> {
    return this.run(async (current) => {
      const result = await this.api.createMinor(req);
      if (current()) await this.refresh();
      return result;
    });
  }

  async createMinorLinkCode(minorId: string): Promise<CodeGrant | null> {
    return this.run(() => this.api.createMinorLinkCode({ minorId }));
  }

  async requestMinorLink(req: CreateMinorLinkRequest): Promise<MinorLinkRequestView | null> {
    return this.run(async (current) => {
      const result = await this.api.createMinorLinkRequest(req);
      if (current()) await this.refreshInbox();
      return result;
    });
  }

  async approveMinorLink(requestId: string, req: ApproveMinorLinkRequest): Promise<boolean> {
    return (await this.run(async (current) => {
      await this.api.approveMinorLinkRequest(requestId, req);
      if (current()) await this.refreshInbox();
      return true;
    })) ?? false;
  }

  async acceptMinorLink(requestId: string, req: AcceptMinorLinkRequest): Promise<boolean> {
    return (await this.run(async (current) => {
      await this.api.acceptMinorLinkRequest(requestId, req);
      if (current()) await this.refresh();
      return true;
    })) ?? false;
  }

  async inviteAdditional(req: CreateAdditionalResponsibleInvitationRequest): Promise<AdditionalResponsibleInvitationView | null> {
    return this.run(async (current) => {
      const result = await this.api.createAdditionalResponsibleInvitation(req);
      if (current()) await this.refreshInbox();
      return result;
    });
  }

  async acceptAdditional(invitationId: string, req: AcceptAdditionalResponsibleInvitationRequest): Promise<boolean> {
    return (await this.run(async (current) => {
      await this.api.acceptAdditionalResponsibleInvitation(invitationId, req);
      if (current()) await this.refresh();
      return true;
    })) ?? false;
  }

  async replaceAdditionalScope(req: ReplaceAdditionalResponsibleScopeRequest): Promise<boolean> {
    return (await this.run(async (current) => {
      await this.api.replaceAdditionalResponsibleScope(req);
      if (current()) await this.refresh();
      return true;
    })) ?? false;
  }

  async revokeAdditional(req: RevokeAdditionalResponsibleRequest): Promise<boolean> {
    return (await this.run(async (current) => {
      await this.api.revokeAdditionalResponsible(req);
      if (current()) await this.refresh();
      return true;
    })) ?? false;
  }

  async transferPrimaryResponsibility(req: TransferPrimaryResponsibilityRequest): Promise<boolean> {
    return (
      (await this.run(async (current) => {
        await this.api.transferPrimaryResponsibility(req);
        if (current()) await this.refresh();
        return true;
      })) ?? false
    );
  }

  async createChild(username: string, displayName: string): Promise<CreateChildResponse | null> {
    return this.run(async (current) => {
      const result = await this.api.createChild({ username, displayName });
      if (current()) await this.refresh();
      return result;
    });
  }

  async resetChildPassword(userId: string): Promise<{ tempPassword: string } | null> {
    return this.run(() => this.api.resetChildPassword(userId));
  }

  async renameChild(userId: string, displayName: string): Promise<boolean> {
    return (
      (await this.run(async (current) => {
        await this.api.patchChild(userId, { displayName });
        if (current()) await this.refresh();
        return true;
      })) ?? false
    );
  }

  /** Returns the SERVER's answer so the caller paints truth — a failed
   *  refresh must never resurrect the pre-toggle value on the switch. */
  async setChildSocial(userId: string, socialEnabled: boolean): Promise<UserProfile | null> {
    return this.run(async (current) => {
      const profile = await this.api.patchChild(userId, { socialEnabled });
      if (current()) await this.refresh();
      return profile;
    });
  }

  async unlink(linkId: string): Promise<boolean> {
    return (
      (await this.run(async (current) => {
        await this.api.deleteFamilyLink(linkId);
        if (current()) await this.refresh();
        return true;
      })) ?? false
    );
  }

  /** Export-first deletion: the backup downloads BEFORE the purge, always. */
  async deleteChild(userId: string, username: string): Promise<boolean> {
    return (
      (await this.run(async (current) => {
        const envelope = await this.api.exportChild(userId);
        if (!current()) return false;
        this.download(`roadmap2u-${username}-respaldo.json`, envelope);
        await this.api.deleteChild(userId);
        if (current()) await this.refresh();
        return true;
      })) ?? false
    );
  }

  async exportChild(userId: string, username: string): Promise<boolean> {
    return (
      (await this.run(async (current) => {
        const envelope = await this.api.exportChild(userId);
        if (!current()) return false;
        this.download(`roadmap2u-${username}-respaldo.json`, envelope);
        return true;
      })) ?? false
    );
  }

  async createInvite(req: FamilyInviteRequest): Promise<CodeGrant | null> {
    return this.run(() => this.api.createFamilyInvite(req));
  }

  // ── guardian oversight of a minor's friendships (transparent to the minor) ─

  async listChildFriends(userId: string): Promise<FriendsResponse | null> {
    return this.run(() => this.api.listChildFriends(userId));
  }

  async listMinorFriendRequests(minorId: string): Promise<MinorFriendRequestView[] | null> {
    return this.run(() => this.api.getMinorFriendRequests(minorId));
  }

  async approveMinorFriendRequest(minorId: string, requestId: string): Promise<boolean> {
    return (await this.run(async () => {
      await this.api.approveMinorFriendRequest(requestId, {
        minorId, commandId: crypto.randomUUID(), policyVersion: 'minor-social-v1',
      });
      return true;
    })) ?? false;
  }

  async rejectMinorFriendRequest(minorId: string, requestId: string): Promise<boolean> {
    return (await this.run(async () => {
      await this.api.rejectMinorFriendRequest(requestId, {
        minorId, commandId: crypto.randomUUID(), policyVersion: 'minor-social-v1',
      });
      return true;
    })) ?? false;
  }

  async removeChildFriendship(userId: string, friendshipId: string): Promise<boolean> {
    return (
      (await this.run(async () => {
        await this.api.removeChildFriendship(userId, friendshipId);
        return true;
      })) ?? false
    );
  }

  async cancelChildRequest(userId: string, requestId: string): Promise<boolean> {
    return (
      (await this.run(async () => {
        await this.api.cancelChildRequest(userId, requestId);
        return true;
      })) ?? false
    );
  }

  async acceptInvite(code: string): Promise<boolean> {
    return (
      (await this.run(async (current) => {
        await this.api.acceptFamilyInvite(code);
        if (current()) await this.refresh();
        return true;
      })) ?? false
    );
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async run<T>(operation: (current: () => boolean) => Promise<T>): Promise<T | null> {
    this.adoptIdentity();
    const identity = this.auth.user();
    if (this.accountClosureQuiesced || !identity || this.mutatingSignal()) return null;
    const generation = this.generation;
    const current = () => generation === this.generation && this.auth.user() === identity;
    this.mutatingSignal.set(true);
    this.lastErrorSignal.set(null);
    try {
      const result = await operation(current);
      return current() ? result : null;
    } catch (error) {
      if (current()) this.lastErrorSignal.set(error instanceof ApiError ? error.code : 'unknown');
      return null;
    } finally {
      if (current()) this.mutatingSignal.set(false);
    }
  }

  private adoptIdentity(): void {
    const identity = this.auth.user();
    if (identity !== this.lastIdentity) {
      this.lastIdentity = identity;
      this.clear();
    }
  }

  private beginAccountClosureReset(): void {
    this.accountClosureQuiesced = true;
    this.clear();
  }

  private download(filename: string, payload: unknown): void {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
