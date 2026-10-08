import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { API_CLIENT } from './api/api-client';
import {
  ADULT_PRIVACY_VERSIONS,
  ApiError,
  type PrivacyStatus,
  type PrivacyConsentCommand,
  type PrivacyCommandBase,
  type PrivateAdolescentInvitation,
  type PrivacyExportPage,
  type PrivateAdolescentGuardianCommand,
} from './api/contracts';
import { privacyDocument } from './api/privacy-document';
import { AuthService } from './auth/auth.service';
import type { AuthUser } from './auth/auth-types';

export interface CloudPrivacyLease {
  readonly owner: AuthUser;
  readonly generation: number;
  readonly revision: number;
}
const WITHDRAW_INTENTS_KEY = 'roadmap2u-privacy-withdraw-intents-v1';
function savedWithdrawIntents(): ReadonlySet<string> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(WITHDRAW_INTENTS_KEY) ?? '[]');
    return new Set(
      Array.isArray(ids)
        ? ids.filter((id): id is string => typeof id === 'string' && id.length <= 128)
        : [],
    );
  } catch {
    return new Set();
  }
}
/** Metadata only. Importing /account must never wake Sync, Backup or forest repositories. */
@Injectable({ providedIn: 'root' })
export class PrivacyService {
  private readonly api = inject(API_CLIENT);
  private readonly auth = inject(AuthService);
  private readonly cached = signal<{ owner: AuthUser; status: PrivacyStatus } | null>(null);
  // Local withdrawal intent only; no server consent evidence enters forest backups.
  private readonly blocked = signal<ReadonlySet<string>>(savedWithdrawIntents());
  private generation = 0;
  private readonly pending = new Map<
    string,
    PrivacyConsentCommand | PrivateAdolescentGuardianCommand | PrivacyCommandBase
  >();
  private readonly channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('roadmap2u-privacy');
  readonly status = computed(() =>
    this.cached()?.owner === this.auth.user() && !this.auth.sessionStale()
      ? this.cached()!.status
      : null,
  );
  readonly cloudBlocked = computed(
    () => !this.auth.user() || this.blocked().has(this.auth.user()!.userId),
  );
  constructor() {
    if (this.channel)
      this.channel.onmessage = (event) => {
        if (event.data?.action === 'withdraw' && typeof event.data.userId === 'string')
          this.block(event.data.userId, false);
      };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === WITHDRAW_INTENTS_KEY)
        for (const id of savedWithdrawIntents()) this.block(id, false);
    };
    window.addEventListener('storage', storageChanged);
    inject(DestroyRef).onDestroy(() => this.channel?.close());
    inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', storageChanged));
  }
  private owner(): AuthUser {
    const owner = this.auth.user();
    if (!owner || this.auth.sessionStale()) throw new ApiError('UNAUTHENTICATED');
    return owner;
  }
  private check(owner: AuthUser) {
    if (this.auth.user() !== owner || this.auth.sessionStale())
      throw new ApiError('UNAUTHENTICATED');
  }
  private block(id: string, publish = true) {
    this.generation++;
    this.blocked.update((current) => new Set([...current, id]));
    this.saveWithdrawIntents();
    if (publish) this.channel?.postMessage({ action: 'withdraw', userId: id });
  }
  private saveWithdrawIntents() {
    try {
      localStorage.setItem(WITHDRAW_INTENTS_KEY, JSON.stringify([...this.blocked()]));
    } catch {
      /* Session remains blocked when device storage is unavailable. */
    }
  }
  async refresh(language: 'es' | 'en'): Promise<PrivacyStatus> {
    const owner = this.owner();
    const status = await this.api.getPrivacyStatus(language);
    this.check(owner);
    if (status.userId !== owner.userId) throw new ApiError('UNAUTHENTICATED');
    const document = await privacyDocument(language);
    this.check(owner);
    if (
      status.documentHash !== document.hash ||
      Object.entries(ADULT_PRIVACY_VERSIONS).some(
        ([key, value]) => (status.versions as Record<string, string>)[key] !== value,
      )
    )
      throw new ApiError('VALIDATION');
    this.cached.set({ owner, status });
    return status;
  }
  async requireCloud(language: 'es' | 'en'): Promise<CloudPrivacyLease> {
    const owner = this.owner();
    const generation = this.generation;
    if (this.blocked().has(owner.userId)) throw new ApiError('CLOUD_CONSENT_REQUIRED');
    const status = await this.refresh(language);
    if (!status.canUseCloud || generation !== this.generation || this.blocked().has(owner.userId))
      throw new ApiError('CLOUD_CONSENT_REQUIRED');
    return { owner, generation, revision: status.revision };
  }
  assertLease(lease: CloudPrivacyLease): void {
    this.check(lease.owner);
    if (
      lease.generation !== this.generation ||
      this.blocked().has(lease.owner.userId) ||
      this.status()?.revision !== lease.revision ||
      !this.status()?.canUseCloud
    )
      throw new ApiError('CLOUD_CONSENT_REQUIRED');
  }
  private async decide(
    language: 'es' | 'en',
    action: Record<string, unknown>,
  ): Promise<PrivacyStatus> {
    const owner = this.owner();
    const status = await this.refresh(language);
    this.check(owner);
    const key = `${owner.userId}:${language}:${JSON.stringify(action)}`;
    let command = this.pending.get(key) as PrivacyConsentCommand | undefined;
    if (!command) {
      command = {
        ...ADULT_PRIVACY_VERSIONS,
        language,
        commandId: crypto.randomUUID(),
        expectedRevision: status.revision,
        documentHash: status.documentHash,
        ...action,
      } as PrivacyConsentCommand;
      this.pending.set(key, command);
    }
    try {
      const next = await this.api.changePrivacyConsent(command);
      this.check(owner);
      if (next.userId !== owner.userId || next.documentHash !== status.documentHash)
        throw new ApiError('VALIDATION');
      this.cached.set({ owner, status: next });
      this.pending.delete(key);
      if (action['action'] === 'grant_cloud' && next.canUseCloud) {
        this.blocked.update((current) => new Set([...current].filter((id) => id !== owner.userId)));
        this.generation++;
        this.saveWithdrawIntents();
      }
      return next;
    } catch (error) {
      if (error instanceof ApiError && !['offline', 'server', 'unknown'].includes(error.code))
        this.pending.delete(key);
      throw error;
    }
  }
  declareAdult(language: 'es' | 'en', adultChosen: boolean, acceptsTerms: boolean) {
    if (!adultChosen || !acceptsTerms) return Promise.reject(new ApiError('VALIDATION'));
    return this.decide(language, {
      action: 'declare_adult',
      declareAdult: true,
      acceptTerms: true,
    });
  }
  acceptAdolescent(
    language: 'es' | 'en',
    invitationId: string,
    acceptsTerms: boolean,
    understandsPrivacy: boolean,
  ) {
    if (!acceptsTerms || !understandsPrivacy) return Promise.reject(new ApiError('VALIDATION'));
    return this.decide(language, {
      action: 'accept_adolescent',
      invitationId,
      acceptTerms: true,
      understandsPrivacy: true,
    });
  }
  grantCloud(language: 'es' | 'en', accepted: boolean) {
    if (!accepted) return Promise.reject(new ApiError('VALIDATION'));
    return this.decide(language, { action: 'grant_cloud', accepted: true });
  }
  revokeCloud(language: 'es' | 'en') {
    this.block(this.owner().userId);
    return this.decide(language, { action: 'revoke_cloud' });
  }
  eraseCloud(language: 'es' | 'en') {
    this.block(this.owner().userId);
    return this.decide(language, { action: 'erase_cloud' });
  }
  async invitations(): Promise<PrivateAdolescentInvitation[]> {
    const owner = this.owner();
    const result = await this.api.listPrivateAdolescentInvitations();
    this.check(owner);
    return result;
  }
  async invite(
    language: 'es' | 'en',
    recipientUsername: string,
    majorityAt: string,
    guardianName: string,
    guardianRelationship: 'parent' | 'legal_guardian' | '',
    representsMinor: boolean,
    authorizesCloud: boolean,
  ) {
    if (!representsMinor || !authorizesCloud || !guardianName.trim() || guardianRelationship === '')
      throw new ApiError('VALIDATION');
    const owner = this.owner();
    const status = await this.refresh(language);
    const key = JSON.stringify([
      owner.userId,
      'invite',
      language,
      recipientUsername,
      majorityAt,
      guardianName.trim(),
      guardianRelationship,
    ]);
    const command = this.pending.get(key) ?? {
      ...ADULT_PRIVACY_VERSIONS,
      language,
      documentHash: status.documentHash,
      commandId: crypto.randomUUID(),
      expectedRevision: 0,
      recipientUsername,
      majorityAt,
      guardianName: guardianName.trim(),
      guardianRelationship,
      representsMinor: true as const,
      authorizesCloud: true as const,
    };
    this.pending.set(key, command);
    try {
      const result = await this.api.createPrivateAdolescentInvitation(
        command as Parameters<typeof this.api.createPrivateAdolescentInvitation>[0],
      );
      this.check(owner);
      this.pending.delete(key);
      return result;
    } catch (error) {
      if (error instanceof ApiError && !['offline', 'server', 'unknown'].includes(error.code))
        this.pending.delete(key);
      throw error;
    }
  }
  async guardian(
    language: 'es' | 'en',
    invitation: PrivateAdolescentInvitation,
    grant: boolean,
    representsMinor = false,
    authorizesCloud = false,
  ) {
    if (
      !invitation.adolescentId ||
      invitation.consentRevision === undefined ||
      (grant && (!representsMinor || !authorizesCloud))
    )
      throw new ApiError('VALIDATION');
    const owner = this.owner();
    const status = await this.refresh(language);
    const key = `${owner.userId}:guardian:${invitation.adolescentId}:${language}:${grant}`;
    const command = this.pending.get(key) ?? {
      ...ADULT_PRIVACY_VERSIONS,
      language,
      documentHash: status.documentHash,
      commandId: crypto.randomUUID(),
      expectedRevision: invitation.consentRevision,
      action: grant ? 'grant_guardian' : 'revoke_guardian',
      ...(grant ? { representsMinor: true, authorizesCloud: true } : {}),
    };
    this.pending.set(key, command);
    try {
      const result = await this.api.changePrivateAdolescentGuardianConsent(
        invitation.adolescentId,
        command as PrivateAdolescentGuardianCommand,
      );
      this.check(owner);
      this.pending.delete(key);
      return result;
    } catch (error) {
      if (error instanceof ApiError && !['offline', 'server', 'unknown'].includes(error.code))
        this.pending.delete(key);
      throw error;
    }
  }
  async exportOwn(): Promise<PrivacyExportPage> {
    const owner = this.owner();
    let cursor: string | undefined;
    let result: PrivacyExportPage | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const next = await this.api.exportOwnPrivacy(cursor);
      this.check(owner);
      if (next.userId !== owner.userId) throw new ApiError('UNAUTHENTICATED');
      result = result
        ? {
            ...result,
            records: [...result.records, ...next.records],
            privacy: [...result.privacy, ...next.privacy],
            cursor: next.cursor,
          }
        : next;
      if (!next.cursor) return result;
      if (seen.has(next.cursor)) throw new ApiError('server');
      seen.add(next.cursor);
      cursor = next.cursor;
    }
    throw new ApiError('server');
  }
}
