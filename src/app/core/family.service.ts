import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { API_CLIENT } from './api/api-client';
import {
  ApiError,
  ApiErrorCode,
  CodeGrant,
  CreateChildResponse,
  FamilyInviteRequest,
  FriendsResponse,
  MeResponse,
  UserProfile,
} from './api/contracts';
import { AuthService } from './auth/auth.service';
import { onAccountClosureQuiesce } from './db/account-closure-fence';
import { del, get, put } from './db/idb';

/**
 * The family facade — signals over GET /me and the family operations.
 * Never runs at boot (boot stays network-free): the familia surface calls
 * `open()` when it appears. Stale-while-revalidate: the last MeResponse is
 * cached under a meta key so the card paints instantly offline, then a
 * background refresh reconciles. Every mutation refreshes `me`.
 */

const META_FAMILY_ME = 'family.me';

export interface FamilyMeSnapshot {
  key: typeof META_FAMILY_ME;
  userId: string;
  me: MeResponse;
  cachedAt: number;
}

export interface FamilyCachePort {
  read(): Promise<FamilyMeSnapshot | null>;
  write(snapshot: FamilyMeSnapshot): Promise<void>;
  remove(): Promise<void>;
}

export const FAMILY_CACHE = new InjectionToken<FamilyCachePort>('FAMILY_CACHE', {
  providedIn: 'root',
  factory: () => ({
    read: async () => (await get<FamilyMeSnapshot>('meta', META_FAMILY_ME)) ?? null,
    write: (snapshot) => put('meta', snapshot),
    remove: () => del('meta', META_FAMILY_ME),
  }),
});

@Injectable({ providedIn: 'root' })
export class FamilyService {
  private readonly api = inject(API_CLIENT);
  private readonly auth = inject(AuthService);
  private readonly cache = inject(FAMILY_CACHE);

  private readonly meSignal = signal<MeResponse | null>(null);
  private readonly loadingSignal = signal(false);
  private readonly lastErrorSignal = signal<ApiErrorCode | null>(null);
  /** Invalidates cache/network completions once terminal account cleanup starts. */
  private generation = 0;
  private accountClosureQuiesced = false;
  private readonly pendingCacheWrites = new Set<Promise<void>>();

  readonly me = this.meSignal.asReadonly();
  readonly loading = this.loadingSignal.asReadonly();
  readonly lastError = this.lastErrorSignal.asReadonly();

  readonly minors = computed(() => this.meSignal()?.family.minors ?? []);
  readonly guardians = computed(() => this.meSignal()?.family.guardians ?? []);

  constructor() {
    const stopAccountClosure = onAccountClosureQuiesce(() => this.beginAccountClosureReset());
    inject(DestroyRef).onDestroy(stopAccountClosure);
  }

  /** Cache-first paint + background refresh. Call when the surface opens. */
  async open(): Promise<void> {
    if (this.accountClosureQuiesced) return;
    const userId = this.auth.user()?.userId;
    if (!userId) return;
    const generation = this.generation;
    try {
      const cached = await this.cache.read();
      if (
        generation === this.generation &&
        this.auth.user()?.userId === userId &&
        cached?.userId === userId &&
        !this.meSignal()
      ) {
        this.meSignal.set(cached.me);
      }
    } catch {
      /* no cache — network will answer */
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.accountClosureQuiesced) return;
    const userId = this.auth.user()?.userId;
    if (!userId) {
      this.meSignal.set(null);
      return;
    }
    const generation = this.generation;
    this.loadingSignal.set(true);
    this.lastErrorSignal.set(null);
    try {
      const me = await this.api.getMe();
      if (generation !== this.generation || this.auth.user()?.userId !== userId) return;
      this.meSignal.set(me);
      try {
        const write = this.cache.write({
          key: META_FAMILY_ME,
          userId,
          me,
          cachedAt: Date.now(),
        } satisfies FamilyMeSnapshot);
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
      if (generation === this.generation) {
        this.lastErrorSignal.set(error instanceof ApiError ? error.code : 'unknown');
      }
    } finally {
      if (generation === this.generation) this.loadingSignal.set(false);
    }
  }

  /** Wipes the signal on sign-out (the meta cache is keyed by user anyway). */
  clear(): void {
    this.generation += 1;
    this.meSignal.set(null);
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
      await this.cache.remove();
    } catch {
      /* memory-only session */
    }
  }

  // ── operations (each returns a value for the sheet, then refreshes) ───────

  async createChild(username: string, displayName: string): Promise<CreateChildResponse | null> {
    return this.run(async () => {
      const result = await this.api.createChild({ username, displayName });
      await this.refresh();
      return result;
    });
  }

  async resetChildPassword(userId: string): Promise<{ tempPassword: string } | null> {
    return this.run(() => this.api.resetChildPassword(userId));
  }

  async renameChild(userId: string, displayName: string): Promise<boolean> {
    return (
      (await this.run(async () => {
        await this.api.patchChild(userId, { displayName });
        await this.refresh();
        return true;
      })) ?? false
    );
  }

  /** Returns the SERVER's answer so the caller paints truth — a failed
   *  refresh must never resurrect the pre-toggle value on the switch. */
  async setChildSocial(userId: string, socialEnabled: boolean): Promise<UserProfile | null> {
    return this.run(async () => {
      const profile = await this.api.patchChild(userId, { socialEnabled });
      await this.refresh();
      return profile;
    });
  }

  async unlink(linkId: string): Promise<boolean> {
    return (
      (await this.run(async () => {
        await this.api.deleteFamilyLink(linkId);
        await this.refresh();
        return true;
      })) ?? false
    );
  }

  /** Export-first deletion: the backup downloads BEFORE the purge, always. */
  async deleteChild(userId: string, username: string): Promise<boolean> {
    return (
      (await this.run(async () => {
        const envelope = await this.api.exportChild(userId);
        this.download(`roadmap2u-${username}-respaldo.json`, envelope);
        await this.api.deleteChild(userId);
        await this.refresh();
        return true;
      })) ?? false
    );
  }

  async exportChild(userId: string, username: string): Promise<boolean> {
    return (
      (await this.run(async () => {
        const envelope = await this.api.exportChild(userId);
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
      (await this.run(async () => {
        await this.api.acceptFamilyInvite(code);
        await this.refresh();
        return true;
      })) ?? false
    );
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async run<T>(operation: () => Promise<T>): Promise<T | null> {
    if (this.accountClosureQuiesced) return null;
    this.loadingSignal.set(true);
    this.lastErrorSignal.set(null);
    try {
      return await operation();
    } catch (error) {
      this.lastErrorSignal.set(error instanceof ApiError ? error.code : 'unknown');
      return null;
    } finally {
      this.loadingSignal.set(false);
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
