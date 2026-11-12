import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { PrivacyService } from '../privacy.service';
import { PremiumCloudIntentService } from './premium-cloud-intent';
import { SyncService } from './sync.service';

type ActivationPhase = 'idle' | 'waiting' | 'syncing' | 'current' | 'attention' | 'retry';

@Injectable({ providedIn: 'root' })
export class PremiumCloudActivation {
  private readonly auth = inject(AuthService);
  private readonly privacy = inject(PrivacyService);
  private readonly intents = inject(PremiumCloudIntentService);
  private readonly sync = inject(SyncService);
  private readonly phase = signal<ActivationPhase>('idle');
  readonly status = this.phase.asReadonly();
  private pending: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private remaining = 0;

  constructor() {
    effect(() => {
      this.auth.user()?.userId;
      this.phase.set('idle');
    });
    const resume = () => this.start();
    window.addEventListener('online', resume);
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.retry);
      window.removeEventListener('online', resume);
    });
  }

  start(): void {
    this.remaining = 6;
    this.attempt();
  }

  private attempt(): void {
    if (this.pending) return;
    clearTimeout(this.retry);
    this.pending = this.activate().catch(() => {
      this.phase.set('waiting');
    }).finally(() => {
      this.pending = null;
      if (this.phase() !== 'waiting' || !navigator.onLine) return;
      if (--this.remaining > 0) {
        this.retry = setTimeout(() => this.attempt(), 5_000);
      } else {
        this.phase.set('retry');
      }
    });
  }

  private async activate(): Promise<void> {
    const owner = this.auth.user();
    const intent = await this.intents.pending();
    if (!intent || !owner || this.auth.user() !== owner) {
      if (this.phase() !== 'current') this.phase.set('idle');
      return;
    }
    if (this.auth.sessionStale() || this.privacy.cloudBlocked()) {
      await this.intents.clear(intent.id);
      this.phase.set('attention');
      return;
    }
    this.phase.set('waiting');
    if (!navigator.onLine) return;
    if (!await this.intents.verified(intent)) {
      if (!await this.intents.pending()) this.phase.set('idle');
      return;
    }
    const status = await this.privacy.refresh(intent.language);
    if (this.auth.user() !== owner || this.privacy.cloudBlocked() ||
        status.revision !== intent.revision || !status.canUseCloud ||
        status.scope !== 'adult' || status.privateOnly) {
      await this.intents.clear(intent.id);
      this.phase.set('attention');
      return;
    }
    this.phase.set('syncing');
    const complete = await this.sync.activatePremiumCloud({
      privacyRevision: intent.revision,
      session: intent.session,
      allowLocalUpload: intent.allowLocalUpload,
      verify: async () => Boolean(await this.intents.verified(intent)),
    });
    if (complete) {
      await this.intents.clear(intent.id);
      if (this.auth.user() === owner) this.phase.set('current');
    } else {
      this.phase.set('waiting');
    }
  }
}
