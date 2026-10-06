import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import { inputValue } from '../../shared/ui/dom';
import { Switch } from '../../shared/ui/switch';
import { SheetDirective } from '../../shared/ui/sheet.directive';
import { ToastService } from '../../shared/ui/toast.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { AuthService } from '../../core/auth/auth.service';
import { USERNAME_PATTERN } from '../../core/auth/auth-types';
import { FamilyService } from '../../core/family.service';
import type {
  CreateMinorRequest,
  CodeGrant,
  FamilyInboxEntry,
  FriendsResponse,
  MinorFriendRequestView,
  HouseholdMinorView,
  TransferPrimaryResponsibilityRequest,
  UserProfile,
} from '../../core/api/contracts';

type Sheet =
  | { kind: 'create' }
  | { kind: 'linkCode'; minor: HouseholdMinorView; grant: CodeGrant | null }
  | { kind: 'linkRequest'; commandId: string }
  | { kind: 'inviteAdditional'; commandId: string }
  | { kind: 'scope'; commandId: string }
  | { kind: 'revokeAdditional'; commandId: string }
  | { kind: 'notice'; entry: FamilyInboxEntry; commandId: string }
  | { kind: 'transfer'; request: TransferPrimaryResponsibilityRequest; accepting: boolean }
  | { kind: 'created'; child: UserProfile; tempPassword: string }
  | { kind: 'child' | 'delete'; minor: HouseholdMinorView }
  | { kind: 'reset'; minor: HouseholdMinorView; tempPassword: string }
  | { kind: 'childFriends'; minor: HouseholdMinorView; data: FriendsResponse | null;
      requests: MinorFriendRequestView[] | null }
  | null;

/** Household roles drive affordances; every operation is still server-authorized. */
@Component({
  selector: 'app-familia-card',
  imports: [SheetDirective, Switch, DatePipe],
  templateUrl: './familia-card.html',
  styleUrl: './familia-card.scss',
})
export class FamiliaCard {
  protected readonly inputValue = inputValue;
  protected readonly i18n = inject(I18nService);
  protected readonly auth = inject(AuthService);
  protected readonly fam = inject(FamilyService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private sheetEpoch = 0;
  private createAttempt: CreateMinorRequest | null = null;
  private sheetIdentity = this.auth.user();
  private readonly sheetSignal = signal<Sheet>(null);
  // Mask synchronously, before effects: a credential must never flash for a new login.
  protected readonly sheet = computed(() =>
    this.auth.user() === this.sheetIdentity ? this.sheetSignal() : null,
  );
  protected readonly newUsername = signal('');
  protected readonly majorityDate = signal('');
  protected readonly declarationAccepted = signal(false);
  protected readonly privacyAccepted = signal(false);
  protected readonly renameValue = signal('');
  protected readonly linkCodeValue = signal('');
  protected readonly adultIdValue = signal('');
  protected readonly selectedMinorIds = signal<string[]>([]);
  protected readonly isPrimary = computed(
    () => this.auth.user()?.accountType === 'adult' && this.fam.myRole() === 'primary_responsible',
  );
  protected readonly scopeNames = computed(() => {
    const scope = this.fam.additionalResponsible()?.minorIds ?? [];
    return this.fam
      .minors()
      .filter((minor) => scope.includes(minor.user.userId))
      .map((minor) => minor.user.displayName)
      .join(', ');
  });
  protected readonly canCreate = computed(
    () =>
      this.isPrimary() &&
      this.fam.fresh() &&
      this.fam.household()?.state === 'active' &&
      (this.fam.household()?.familyCoverage === undefined ||
        this.fam.household()?.familyCoverage?.state === 'active') &&
      (this.fam.household()?.availableMinorSeats ?? 0) > 0,
  );
  protected readonly canTransfer = computed(
    () =>
      this.isPrimary() &&
      this.fam.fresh() &&
      this.fam.household()?.state === 'active' &&
      !!this.fam.additionalResponsible(),
  );
  protected readonly canLink = computed(() => this.canCreate());
  protected readonly canInviteAdditional = computed(() =>
    this.isPrimary() && this.fam.fresh() && this.fam.household()?.state === 'active' &&
    this.fam.household()?.additionalResponsibleSeatAvailable === true &&
    this.fam.minors().length > 0 &&
    (this.fam.household()?.familyCoverage === undefined ||
      this.fam.household()?.familyCoverage?.state === 'active'));
  protected readonly validCreate = computed(() => {
    const date = this.majorityDate();
    const time = Date.parse(date + 'T00:00:00.000Z');
    const upper = new Date();
    upper.setUTCFullYear(upper.getUTCFullYear() + 18);
    return (
      this.canCreate() &&
      USERNAME_PATTERN.test(this.newUsername().trim().toLowerCase()) &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === date &&
      time > Date.now() &&
      time <= upper.getTime() &&
      this.declarationAccepted() &&
      this.privacyAccepted()
    );
  });
  protected readonly errorText = computed(() => {
    const code = this.fam.lastError();
    return code ? this.i18n.t().familia.errors[code] : '';
  });

  constructor() {
    effect(() => {
      const identity = this.auth.user();
      if (identity !== this.sheetIdentity) this.close();
      if (identity) void this.fam.open();
      else this.fam.clear();
    });
    this.destroyRef.onDestroy(() => this.close());
  }

  protected canManage(minor: HouseholdMinorView): boolean {
    if (
      this.fam.household()?.state !== 'active' ||
      !this.fam.minors().some((m) => m.user.userId === minor.user.userId)
    )
      return false;
    if (this.isPrimary()) return true;
    const additional = this.fam.additionalResponsible();
    return (
      this.auth.user()?.accountType === 'adult' &&
      this.fam.myRole() === 'additional_responsible' &&
      !!additional?.minorIds.includes(minor.user.userId) &&
      additional.coverageState !== null &&
      additional.coverageState !== 'ended'
    );
  }

  private primaryAction(minor: HouseholdMinorView): boolean {
    return this.isPrimary() && this.canManage(minor);
  }

  private openSheet(sheet: Sheet): number {
    this.sheetIdentity = this.auth.user();
    this.sheetEpoch++;
    this.sheetSignal.set(sheet);
    return this.sheetEpoch;
  }

  private setSheetLater(epoch: number, sheet: Sheet): void {
    if (
      !this.destroyRef.destroyed &&
      this.sheetEpoch === epoch &&
      this.auth.user() === this.sheetIdentity
    )
      this.sheetSignal.set(sheet);
  }

  protected close(): void {
    this.sheetEpoch++;
    this.sheetIdentity = this.auth.user();
    this.sheetSignal.set(null);
    this.createAttempt = null;
    this.newUsername.set('');
    this.majorityDate.set('');
    this.declarationAccepted.set(false);
    this.privacyAccepted.set(false);
    this.linkCodeValue.set('');
    this.adultIdValue.set('');
    this.selectedMinorIds.set([]);
  }

  protected async openLinkCode(minor: HouseholdMinorView): Promise<void> {
    if (!this.primaryAction(minor)) return;
    const epoch = this.openSheet({ kind: 'linkCode', minor, grant: null });
    const grant = await this.fam.createMinorLinkCode(minor.user.userId);
    this.setSheetLater(epoch, { kind: 'linkCode', minor, grant });
  }

  protected openLinkRequest(): void {
    if (!this.canLink()) return;
    this.openSheet({ kind: 'linkRequest', commandId: crypto.randomUUID() });
  }

  protected async submitLinkRequest(commandId: string): Promise<void> {
    const household = this.fam.household();
    if (!household || !this.canLink() || !this.linkCodeValue().trim()) return;
    if (await this.fam.requestMinorLink({ householdId: household.householdId,
      expectedHouseholdRevision: household.revision, commandId,
      policyVersion: 'family-policy-v2', code: this.linkCodeValue().trim() })) {
      this.toast.show({ message: this.i18n.t().familia.linkRequested });
      this.close();
    }
  }

  protected openInviteAdditional(): void {
    if (!this.canInviteAdditional()) return;
    this.selectedMinorIds.set(this.fam.minors().map((minor) => minor.user.userId));
    this.openSheet({ kind: 'inviteAdditional', commandId: crypto.randomUUID() });
  }

  protected toggleScopeMinor(minorId: string): void {
    this.selectedMinorIds.update((ids) => ids.includes(minorId)
      ? ids.filter((id) => id !== minorId) : [...ids, minorId]);
  }

  protected async submitInviteAdditional(commandId: string): Promise<void> {
    const household = this.fam.household();
    if (!household || !this.canInviteAdditional() ||
      !this.adultIdValue().trim() || !this.selectedMinorIds().length) return;
    const result = await this.fam.inviteAdditional({
      householdId: household.householdId,
      expectedHouseholdRevision: household.revision,
      commandId, policyVersion: 'family-policy-v2',
      intendedAdultId: this.adultIdValue().trim(), minorIds: this.selectedMinorIds(),
    });
    if (result) {
      this.toast.show({ message: this.i18n.t().familia.additionalInvited });
      this.close();
    }
  }

  protected openScope(): void {
    if (!this.isPrimary() || !this.fam.additionalResponsible()) return;
    this.selectedMinorIds.set([...this.fam.additionalResponsible()!.minorIds]);
    this.openSheet({ kind: 'scope', commandId: crypto.randomUUID() });
  }

  protected async submitScope(commandId: string): Promise<void> {
    const household = this.fam.household();
    if (!household || !this.isPrimary() || !this.selectedMinorIds().length) return;
    if (await this.fam.replaceAdditionalScope({ householdId: household.householdId,
      expectedHouseholdRevision: household.revision, commandId,
      policyVersion: 'family-policy-v2', minorIds: this.selectedMinorIds() })) {
      this.toast.show({ message: this.i18n.t().familia.scopeSaved });
      this.close();
    }
  }

  protected openRevokeAdditional(): void {
    if (this.isPrimary() && this.fam.additionalResponsible())
      this.openSheet({ kind: 'revokeAdditional', commandId: crypto.randomUUID() });
  }

  protected async submitRevokeAdditional(commandId: string): Promise<void> {
    const household = this.fam.household();
    if (!household || !this.isPrimary()) return;
    if (await this.fam.revokeAdditional({ householdId: household.householdId,
      expectedHouseholdRevision: household.revision, commandId,
      policyVersion: 'family-policy-v2' })) {
      this.toast.show({ message: this.i18n.t().familia.additionalRevoked });
      this.close();
    }
  }

  protected noticeAction(entry: FamilyInboxEntry): 'linkApprove' | 'linkAccept' | 'additionalAccept' | null {
    if (this.auth.user()?.accountType !== 'adult' ||
      entry.expiresAt <= Date.now()) return null;
    if (entry.kind === 'minor_link_request') {
      if (entry.state === 'pending' && this.isPrimary() &&
        entry.householdId !== this.fam.household()?.householdId) return 'linkApprove';
      if (entry.state === 'approved' && this.isPrimary() &&
        entry.householdId === this.fam.household()?.householdId) return 'linkAccept';
    }
    if (entry.kind === 'additional_responsible_invitation' && entry.state === 'pending' &&
      entry.householdId !== this.fam.household()?.householdId) return 'additionalAccept';
    return null;
  }

  protected openNotice(entry: FamilyInboxEntry): void {
    if (this.noticeAction(entry))
      this.openSheet({ kind: 'notice', entry, commandId: crypto.randomUUID() });
  }

  protected async submitNotice(entry: FamilyInboxEntry, commandId: string): Promise<void> {
    const action = this.noticeAction(entry);
    if (!action) return;
    const base = { householdId: entry.householdId,
      expectedHouseholdRevision: entry.expectedHouseholdRevision,
      commandId, policyVersion: 'family-policy-v2' };
    const done = action === 'linkApprove'
      ? await this.fam.approveMinorLink(entry.noticeId, base)
      : action === 'linkAccept'
        ? await this.fam.acceptMinorLink(entry.noticeId, { ...base,
          responsibilityVersion: 'minor-link-responsibility-v1',
          privacyVersion: 'minor-link-privacy-v1' })
        : await this.fam.acceptAdditional(entry.noticeId, base);
    if (done) {
      this.toast.show({ message: this.i18n.t().familia.noticeCompleted });
      this.close();
    }
  }

  protected openCreate(): void {
    if (!this.canCreate()) return;
    this.close();
    this.openSheet({ kind: 'create' });
  }

  protected canAcceptTransfer(entry: FamilyInboxEntry): boolean {
    return (
      this.auth.user()?.accountType === 'adult' &&
      this.fam.myRole() === 'additional_responsible' &&
      this.fam.fresh() &&
      entry.kind === 'primary_transfer' &&
      entry.state === 'pending' &&
      entry.householdId === this.fam.household()?.householdId &&
      entry.expiresAt > Date.now()
    );
  }

  protected openTransfer(entry?: FamilyInboxEntry): void {
    if (entry ? !this.canAcceptTransfer(entry) : !this.canTransfer()) return;
    const household = this.fam.household()!;
    const newPrimaryAccountId = entry
      ? this.auth.user()!.userId
      : this.fam.additionalResponsible()!.user.userId;
    this.openSheet({
      kind: 'transfer',
      accepting: !!entry,
      request: {
        householdId: household.householdId,
        expectedHouseholdRevision: entry?.expectedHouseholdRevision ?? household.revision,
        commandId: entry?.noticeId ?? crypto.randomUUID(),
        policyVersion: 'family-policy-v2',
        newPrimaryAccountId,
      },
    });
  }

  protected async submitTransfer(
    request: TransferPrimaryResponsibilityRequest,
    accepting: boolean,
  ): Promise<void> {
    if (this.fam.loading()) return;
    if (accepting) {
      const entry = this.fam.pendingRequests()?.find((item) => item.noticeId === request.commandId);
      if (!entry || !this.canAcceptTransfer(entry)) return;
    } else if (!this.canTransfer()) return;
    const epoch = this.sheetEpoch;
    if (await this.fam.transferPrimaryResponsibility(request)) {
      if (this.sheetEpoch === epoch) {
        this.toast.show({
          message: accepting
            ? this.i18n.t().familia.transferAccepted
            : this.i18n.t().familia.transferProposed,
        });
        this.close();
      }
    }
  }

  protected async submitCreate(): Promise<void> {
    if (!this.validCreate() || this.fam.loading()) return;
    const household = this.fam.household()!;
    const epoch = this.sheetEpoch;
    const fields = {
      householdId: household.householdId,
      expectedHouseholdRevision: household.revision,
      policyVersion: 'family-policy-v2',
      username: this.newUsername().trim().toLowerCase(),
      country: 'MX' as const,
      majorityAt: this.majorityDate(),
      declarationVersion: 'declaration-v1',
      consentVersion: 'consent-v1',
    };
    const prior = this.createAttempt;
    if (
      !prior ||
      Object.entries(fields).some(
        ([key, value]) => prior[key as keyof CreateMinorRequest] !== value,
      )
    ) {
      this.createAttempt = { ...fields, commandId: crypto.randomUUID() };
    }
    const result = await this.fam.createMinor(this.createAttempt!);
    if (result)
      this.setSheetLater(epoch, {
        kind: 'created',
        child: result.minor,
        tempPassword: result.tempPassword,
      });
  }

  protected openChild(minor: HouseholdMinorView): void {
    if (!this.canManage(minor)) return;
    this.renameValue.set(minor.user.displayName);
    this.openSheet({ kind: 'child', minor });
  }

  protected enterForest(minor: HouseholdMinorView): void {
    if (!this.canManage(minor)) return;
    this.close();
    void this.router.navigate(['/visit', minor.user.userId]);
  }

  protected async doRename(minor: HouseholdMinorView): Promise<void> {
    if (!this.primaryAction(minor)) return;
    const name = this.renameValue().trim();
    if (!name || name === minor.user.displayName) return;
    const epoch = this.sheetEpoch;
    if (await this.fam.renameChild(minor.user.userId, name)) {
      if (this.sheetEpoch === epoch) {
        this.toast.show({ message: this.i18n.t().common.done });
        this.close();
      }
    }
  }

  protected async toggleSocial(minor: HouseholdMinorView): Promise<void> {
    if (!this.primaryAction(minor)) return;
    const epoch = this.sheetEpoch;
    const profile = await this.fam.setChildSocial(minor.user.userId, !minor.user.socialEnabled);
    if (profile)
      this.setSheetLater(epoch, {
        kind: 'child',
        minor: { ...minor, user: { ...minor.user, socialEnabled: profile.socialEnabled } },
      });
  }

  protected async doReset(minor: HouseholdMinorView): Promise<void> {
    if (!this.primaryAction(minor)) return;
    const epoch = this.sheetEpoch;
    const result = await this.fam.resetChildPassword(minor.user.userId);
    if (result)
      this.setSheetLater(epoch, { kind: 'reset', minor, tempPassword: result.tempPassword });
  }

  protected async doExport(minor: HouseholdMinorView): Promise<void> {
    if (!this.primaryAction(minor)) return;
    if (await this.fam.exportChild(minor.user.userId, minor.user.username))
      this.toast.show({ message: this.i18n.t().familia.exportOk });
  }

  protected confirmDelete(minor: HouseholdMinorView): void {
    if (this.primaryAction(minor)) this.openSheet({ kind: 'delete', minor });
  }

  protected async doDelete(minor: HouseholdMinorView): Promise<void> {
    if (!this.primaryAction(minor)) return;
    const epoch = this.sheetEpoch;
    if (await this.fam.deleteChild(minor.user.userId, minor.user.username)) {
      if (this.sheetEpoch === epoch) {
        this.toast.show({
          message: this.i18n.fill(this.i18n.t().familia.deleteOk, { name: minor.user.displayName }),
        });
        this.close();
      }
    }
  }

  protected async openChildFriends(minor: HouseholdMinorView): Promise<void> {
    if (!this.canManage(minor)) return;
    const epoch = this.openSheet({ kind: 'childFriends', minor, data: null, requests: null });
    const data = await this.fam.listChildFriends(minor.user.userId);
    const requests = await this.fam.listMinorFriendRequests(minor.user.userId);
    this.setSheetLater(epoch, { kind: 'childFriends', minor, data, requests });
  }

  protected childNeedsApproval(request: MinorFriendRequestView, minorId: string): boolean {
    const kind = request.requester.userId === minorId
      ? 'requester_responsible_approval' : 'recipient_responsible_approval';
    return !request.consents.some((consent) => consent.kind === kind);
  }

  protected async approveChildFriend(minor: HouseholdMinorView, requestId: string): Promise<void> {
    if (!this.canManage(minor)) return;
    if (await this.fam.approveMinorFriendRequest(minor.user.userId, requestId))
      await this.openChildFriends(minor);
  }

  protected async rejectChildFriend(minor: HouseholdMinorView, requestId: string): Promise<void> {
    if (!this.canManage(minor)) return;
    if (await this.fam.rejectMinorFriendRequest(minor.user.userId, requestId))
      await this.openChildFriends(minor);
  }

  protected async removeChildFriend(
    minor: HouseholdMinorView,
    friendshipId: string,
  ): Promise<void> {
    if (!this.canManage(minor)) return;
    const epoch = this.sheetEpoch;
    if (
      (await this.fam.removeChildFriendship(minor.user.userId, friendshipId)) &&
      this.sheetEpoch === epoch
    )
      await this.openChildFriends(minor);
  }

  protected async cancelChildRequest(minor: HouseholdMinorView, requestId: string): Promise<void> {
    if (!this.canManage(minor)) return;
    const epoch = this.sheetEpoch;
    if (
      (await this.fam.cancelChildRequest(minor.user.userId, requestId)) &&
      this.sheetEpoch === epoch
    )
      await this.openChildFriends(minor);
  }
}
