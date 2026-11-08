import { Injectable, inject } from '@angular/core';
import { AccessService } from '../access/access.service';
import type { AccessSummary } from '../api/contracts';
import { IndividualBillingService } from '../api/individual-billing.service';
import { AuthService } from '../auth/auth.service';
import type { AuthUser } from '../auth/auth-types';
import { accountClosureGuardedWriteInDatabase, get, openDb, put } from '../db/idb';
import { runAccountClosureGuardedWrite } from '../db/account-closure-fence';
import { PrivacyService } from '../privacy.service';

const KEY = 'premium.cloud.pending';
const INTENT_MS = 24 * 60 * 60 * 1000;

type ActivationSource =
  | { kind: 'checkout'; afterRevision: number }
  | { kind: 'sponsored'; sourceId: string };

interface CloudChoice {
  owner: AuthUser;
  session: string;
  revision: number;
  language: 'es' | 'en';
  allowLocalUpload: boolean;
}

export interface PremiumCloudIntent extends Omit<CloudChoice, 'owner'> {
  key: typeof KEY;
  id: string;
  ownerId: string;
  expiresAt: number;
  source: ActivationSource;
}

export async function clearPremiumCloudIntent(id?: string): Promise<void> {
  await runAccountClosureGuardedWrite([{ store: 'meta', value: { key: KEY } }], async () => {
    const db = await openDb();
    return accountClosureGuardedWriteInDatabase(db, ['meta'], (tx) => {
      const meta = tx.objectStore('meta');
      const previous = meta.get(KEY);
      previous.onsuccess = () => {
        if (previous.result && (id === undefined || previous.result.id === id)) meta.delete(KEY);
      };
    });
  }).catch(() => undefined);
}

export function cloudAccessAllowed(
  access: AccessSummary | null,
  source: ActivationSource,
  now: number,
): boolean {
  return Boolean(
    access?.cloudAutoStartEnabled === true &&
      access.status === 'active' &&
      access.effectivePlanKey === 'premium' &&
      access.capabilities.cloudSync &&
      !access.simulation &&
      access.offlineValidUntil > now &&
      access.activeSources.some((entry) =>
        entry.planKey === 'premium' &&
        (entry.validUntil === null || entry.validUntil > now) &&
        (source.kind === 'checkout'
          ? entry.kind === 'subscription' &&
            entry.scope === 'individual' &&
            entry.validUntil !== null
          : entry.kind === 'sponsored' && entry.sourceId === source.sourceId),
      ),
  );
}

/** Device intent contains no forest content, credentials, payment or redemption code. */
@Injectable({ providedIn: 'root' })
export class PremiumCloudIntentService {
  private readonly auth = inject(AuthService);
  private readonly privacy = inject(PrivacyService);
  private readonly access = inject(AccessService);
  private readonly billing = inject(IndividualBillingService);

  async choose(
    language: 'es' | 'en',
    documentHash: string,
    alreadyAuthorized: boolean,
    allowLocalUpload: boolean,
  ): Promise<CloudChoice | null> {
    const owner = this.auth.user();
    const session = this.auth.deviceSession();
    if (!owner || !session || this.auth.sessionStale()) return null;
    let status = await this.privacy.refresh(language);
    if (
      !this.current(owner) ||
      status.scope !== 'adult' ||
      status.privateOnly ||
      status.accountAdmission !== 'standard' ||
      status.commonDocumentHash !== documentHash
    ) return null;
    if (!alreadyAuthorized && (!status.canUseCloud || this.privacy.cloudBlocked()))
      status = await this.privacy.grantCloud(language, true);
    if (!this.current(owner) || !status.canUseCloud || this.privacy.cloudBlocked()) return null;
    if (this.auth.deviceSession() !== session) return null;
    return { owner, session, revision: status.revision, language, allowLocalUpload };
  }

  async arm(choice: CloudChoice, source: ActivationSource): Promise<void> {
    const intent: PremiumCloudIntent = {
      key: KEY,
      id: crypto.randomUUID(),
      ownerId: choice.owner.userId,
      session: choice.session,
      revision: choice.revision,
      language: choice.language,
      allowLocalUpload: choice.allowLocalUpload,
      expiresAt: Date.now() + INTENT_MS,
      source,
    };
    await put('meta', intent, () => {
      if (!this.current(choice.owner) || this.auth.deviceSession() !== choice.session ||
          this.privacy.cloudBlocked())
        throw new Error('cloud intent no longer current');
    });
  }

  async pending(): Promise<PremiumCloudIntent | null> {
    const intent = await get<PremiumCloudIntent>('meta', KEY).catch(() => undefined);
    if (!intent || typeof intent.id !== 'string' || typeof intent.session !== 'string' ||
        !Number.isSafeInteger(intent.expiresAt) ||
        !Number.isSafeInteger(intent.revision) || typeof intent.allowLocalUpload !== 'boolean' ||
        (intent.language !== 'es' && intent.language !== 'en') ||
        !(intent.source?.kind === 'checkout'
          ? Number.isSafeInteger(intent.source.afterRevision)
          : intent.source?.kind === 'sponsored' && typeof intent.source.sourceId === 'string'))
      return null;
    if (intent.ownerId !== this.auth.user()?.userId || intent.session !== this.auth.deviceSession() ||
        intent.expiresAt <= Date.now()) {
      await this.clear(intent.id);
      return null;
    }
    return intent;
  }

  async clear(id?: string): Promise<void> {
    return clearPremiumCloudIntent(id);
  }

  async verified(intent: PremiumCloudIntent): Promise<AccessSummary | null> {
    const owner = this.auth.user();
    if (!owner || owner.userId !== intent.ownerId || !this.current(owner)) return null;
    const [access, billing] = await Promise.all([
      this.access.refreshVerified(),
      intent.source.kind === 'checkout' ? this.billing.readFreshSummary() : Promise.resolve(null),
    ]);
    if (!this.current(owner) || intent.expiresAt <= Date.now() ||
        (await this.pending())?.id !== intent.id) return null;
    if (intent.source.kind === 'checkout') {
      if (!billing || billing.simulation || billing.revision <= intent.source.afterRevision) return null;
      if (billing.processing === 'review' || (billing.processing === 'idle' &&
          ['none', 'expired', 'past_due', 'closed'].includes(billing.state))) {
        await this.clear(intent.id);
        return null;
      }
      if (billing.processing !== 'idle' ||
          !['active', 'cancel_at_period_end'].includes(billing.state) ||
          billing.paidThrough === null || billing.paidThrough <= Date.now()) return null;
    }
    return this.current(owner) && cloudAccessAllowed(access, intent.source, Date.now()) ? access : null;
  }

  private current(owner: AuthUser): boolean {
    return this.auth.user() === owner && !this.auth.sessionStale();
  }
}
