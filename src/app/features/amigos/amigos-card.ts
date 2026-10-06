import { Component, computed, effect, inject, signal } from '@angular/core';
import { inputValue } from '../../shared/ui/dom';
import { ConfirmSheet } from '../../shared/ui/confirm-sheet';
import { Router } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { AuthService } from '../../core/auth/auth.service';
import { FamilyService } from '../../core/family.service';
import { API_CLIENT } from '../../core/api/api-client';
import {
  ApiError,
  ApiErrorCode,
  CodeGrant,
  FriendView,
  FriendsResponse,
  MinorFriendRequestView,
} from '../../core/api/contracts';
import { ToastService } from '../../shared/ui/toast.service';

/**
 * The friendships section in Settings — social-enabled accounts only (adults
 * always; minors when their guardian turned it on). No search, no discovery:
 * the shareable code is the ONLY introduction, every request needs an
 * explicit accept, and declines are silent (no-shame doctrine). A friend's
 * garden opens through the same /visit route family uses — read-only there.
 */
@Component({
  selector: 'app-amigos-card',
  imports: [ConfirmSheet],
  templateUrl: './amigos-card.html',
  styleUrl: './amigos-card.scss',
})
export class AmigosCard {
  protected readonly inputValue = inputValue;
  protected readonly i18n = inject(I18nService);
  protected readonly auth = inject(AuthService);
  private readonly fam = inject(FamilyService);
  private readonly api = inject(API_CLIENT);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly friends = signal<FriendsResponse | null>(null);
  protected readonly myCode = signal<CodeGrant | null>(null);
  protected readonly minorRequests = signal<MinorFriendRequestView[]>([]);
  protected readonly loading = signal(false);
  protected readonly lastError = signal<ApiErrorCode | null>(null);
  protected readonly redeemCode = signal('');
  protected readonly removing = signal<FriendView | null>(null);
  protected readonly isMinor = computed(() => this.auth.user()?.accountType === 'minor');

  /** Adults are always social; minors follow their own canonical household entry. */
  protected readonly socialOn = computed(() => {
    const user = this.auth.user();
    if (!user) return false;
    if (user.accountType === 'adult') return true;
    return this.fam.minors().find((minor) => minor.user.userId === user.userId)?.user.socialEnabled ?? false;
  });

  private loadedFor: string | null = null;

  constructor() {
    effect(() => {
      const user = this.auth.user();
      if (!user || !this.socialOn()) {
        this.loadedFor = null;
        this.friends.set(null);
        this.myCode.set(null);
        this.minorRequests.set([]);
        return;
      }
      if (this.loadedFor === user.userId) return;
      this.loadedFor = user.userId;
      this.friends.set(null);
      this.myCode.set(null);
      this.minorRequests.set([]);
      void this.load();
    });
  }

  protected readonly errorText = computed(() => {
    const code = this.lastError();
    return code ? this.i18n.t().familia.errors[code] : '';
  });

  protected async load(): Promise<void> {
    await this.run(async () => {
      await this.refreshViews(true);
    });
  }

  private async refreshViews(initial = false): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    const identity = user.userId;
    if (user.accountType === 'minor') {
      const [friends, requests] = await Promise.all([
        this.api.getFriends(), this.api.getMinorFriendRequests(identity),
      ]);
      if (this.auth.user()?.userId !== identity) return;
      this.friends.set(friends);
      this.minorRequests.set(requests);
    } else {
      const [friends, code] = await Promise.all([
        this.api.getFriends(), initial ? this.api.getFriendCode() : Promise.resolve(this.myCode()),
      ]);
      if (this.auth.user()?.userId !== identity) return;
      this.friends.set(friends);
      this.myCode.set(code);
    }
  }

  protected async doRotate(): Promise<void> {
    await this.run(async () => {
      const user = this.auth.user();
      if (!user) return;
      this.myCode.set(user.accountType === 'minor'
        ? await this.api.createMinorInviteCode({ minorId: user.userId })
        : await this.api.rotateFriendCode());
      this.toast.show({ message: this.i18n.t().amigos.rotateOk });
    });
  }

  protected async doRedeem(): Promise<void> {
    const code = this.redeemCode().trim();
    if (!code) return;
    await this.run(async () => {
      const user = this.auth.user();
      if (!user) return;
      if (user.accountType === 'minor')
        await this.api.createMinorFriendRequest({ minorId: user.userId, code });
      else await this.api.createAdultFriendRequest({ code });
      this.redeemCode.set('');
      this.toast.show({ message: this.i18n.t().amigos.requestSent });
      await this.refreshViews();
    });
  }

  protected async doAccept(requestId: string): Promise<void> {
    await this.run(async () => {
      const user = this.auth.user();
      if (!user) return;
      if (user.accountType === 'minor') await this.api.acceptMinorFriendRequest(requestId, {
        minorId: user.userId, commandId: crypto.randomUUID(), policyVersion: 'minor-social-v1',
      });
      else await this.api.acceptAdultFriendRequest(requestId);
      this.toast.show({ message: user.accountType === 'minor'
        ? this.i18n.t().amigos.minorAcceptPending : this.i18n.t().amigos.acceptOk });
      await this.refreshViews();
    });
  }

  protected async doDecline(requestId: string): Promise<void> {
    await this.run(async () => {
      const user = this.auth.user();
      if (!user) return;
      if (user.accountType === 'minor') await this.api.rejectMinorFriendRequest(requestId, {
        minorId: user.userId, commandId: crypto.randomUUID(), policyVersion: 'minor-social-v1',
      });
      else await this.api.declineFriendRequest(requestId);
      await this.refreshViews();
    });
  }

  protected async doCancel(requestId: string): Promise<void> {
    await this.run(async () => {
      const user = this.auth.user();
      if (!user) return;
      if (user.accountType === 'minor') await this.api.rejectMinorFriendRequest(requestId, {
        minorId: user.userId, commandId: crypto.randomUUID(), policyVersion: 'minor-social-v1',
      });
      else await this.api.cancelFriendRequest(requestId);
      await this.refreshViews();
    });
  }

  protected async doRemove(friend: FriendView): Promise<void> {
    await this.run(async () => {
      if (this.isMinor()) await this.api.removeMinorFriendship(friend.friendshipId);
      else await this.api.removeSocialFriendship(friend.friendshipId);
      this.removing.set(null);
      this.toast.show({ message: this.i18n.t().amigos.removeOk });
      await this.refreshViews();
    });
  }

  protected visit(friend: FriendView): void {
    void this.router.navigate(['/visit', friend.user.userId]);
  }

  protected prettyCode(code: string): string {
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  protected hasMinorConsent(request: MinorFriendRequestView, kind: string): boolean {
    return request.consents.some((consent) => consent.kind === kind);
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    // Synchronous re-entry guard: under zoneless, [disabled] repaints one
    // render late — a double-click lands here twice before the first await.
    if (this.loading()) return;
    this.loading.set(true);
    this.lastError.set(null);
    try {
      await operation();
    } catch (error) {
      this.lastError.set(error instanceof ApiError ? error.code : 'unknown');
    } finally {
      this.loading.set(false);
    }
  }
}
