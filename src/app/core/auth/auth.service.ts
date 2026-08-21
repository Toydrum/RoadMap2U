import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { AUTH_PROVIDER } from './auth-provider';
import {
  AuthError,
  AuthErrorCode,
  AuthIdentitySnapshot,
  AuthNext,
  AuthSession,
  AuthUser,
  META_AUTH_IDENTITY,
} from './auth-types';
import { deleteAuthIdentitySnapshot, get, put } from '../db/idb';

/**
 * The app-facing identity facade — components talk to these signals, never to
 * a provider or an exception. Every flow method converts thrown AuthErrors
 * into `lastError` values and challenge steps into the `challenge` signal.
 *
 * Boot doctrine (fail-open, like BootService): `hydrate()` reads ONE meta key
 * and never touches the network or the auth SDK — an offline PWA start shows
 * the cached identity instantly. Validation happens in the background later;
 * a definitively-dead session sets `sessionStale` instead of silently
 * demoting to guest (re-auth is only demanded when a cloud feature needs it).
 */

export type AuthFlowResult = 'done' | 'confirmSignUp' | 'newPasswordRequired' | 'error';

const AUTH_CHANNEL = 'roadmap2u-auth';
const VALIDATE_DELAY_MS = 4000;

/** @internal Injectable seam for deterministic auth/storage race tests. */
export interface AuthIdentityPersistence {
  read(): Promise<AuthIdentitySnapshot | undefined>;
  write(snapshot: AuthIdentitySnapshot): Promise<void>;
  clear(): Promise<void>;
}

/** @internal */
export const AUTH_IDENTITY_PERSISTENCE = new InjectionToken<AuthIdentityPersistence>(
  'AUTH_IDENTITY_PERSISTENCE',
  {
    providedIn: 'root',
    factory: () => ({
      read: () => get<AuthIdentitySnapshot>('meta', META_AUTH_IDENTITY),
      write: (snapshot) => put('meta', snapshot),
      clear: () => deleteAuthIdentitySnapshot(),
    }),
  },
);

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly provider = inject(AUTH_PROVIDER);
  private readonly identityPersistence = inject(AUTH_IDENTITY_PERSISTENCE);

  private readonly statusSignal = signal<'guest' | 'signedIn'>('guest');
  private readonly userSignal = signal<AuthUser | null>(null);
  private readonly busySignal = signal(false);
  private readonly lastErrorSignal = signal<AuthErrorCode | null>(null);
  private readonly challengeSignal = signal<'confirmSignUp' | 'newPasswordRequired' | null>(null);
  private readonly sessionStaleSignal = signal(false);
  private readonly deliveryHintSignal = signal<string | null>(null);

  readonly status = this.statusSignal.asReadonly();
  readonly user = this.userSignal.asReadonly();
  readonly busy = this.busySignal.asReadonly();
  readonly lastError = this.lastErrorSignal.asReadonly();
  readonly challenge = this.challengeSignal.asReadonly();
  readonly sessionStale = this.sessionStaleSignal.asReadonly();
  /** Masked destination of the last emailed code ("r***@d***"). */
  readonly deliveryHint = this.deliveryHintSignal.asReadonly();

  /** Username the current challenge/recovery flow is about. */
  private pendingUsername: string | null = null;
  /** Credentials held IN MEMORY for the sign-up → confirm → sign-in hop only. */
  private heldCredentials: { username: string; password: string } | null = null;
  /** Invalidates any async identity read that started in an older auth state. */
  private identityEpoch = 0;
  private channelSubscribed = false;
  /**
   * Cognito session mutations are ordered by invocation. A sign-out requested
   * behind a pending login must clear that login before a newer login starts.
  */
  private providerSessionTail: Promise<void> = Promise.resolve();
  /** Orders a started identity write before a later sign-out delete. */
  private identityPersistenceTail: Promise<void> = Promise.resolve();

  private readonly channel: BroadcastChannel | null =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(AUTH_CHANNEL) : null;

  /** App initializer — one IDB read, zero network, any failure ⇒ guest. */
  async hydrate(): Promise<void> {
    // Subscribe before the read. Otherwise a sibling can sign out while this
    // tab is awaiting IndexedDB and the missed message lets stale identity win.
    this.subscribeToChannel();
    const epoch = this.identityEpoch;
    try {
      const snapshot = await this.identityPersistence.read();
      if (epoch === this.identityEpoch) this.applySnapshot(snapshot);
    } catch {
      // Storage unavailable — the session runs as guest.
    }

    // Background validation — never at boot, never offline, never blocking.
    setTimeout(() => void this.validateQuietly(), VALIDATE_DELAY_MS);
  }

  async signIn(username: string, password: string): Promise<AuthFlowResult> {
    const epoch = ++this.identityEpoch;
    return this.run(async () => {
      const next = await this.queueProviderSessionOperation(() =>
        this.provider.signIn(username, password),
      );
      if (epoch !== this.identityEpoch) return 'error';
      // Held only while a confirm step might need to finish the sign-in.
      this.heldCredentials = { username, password };
      return this.applyNext(next, epoch);
    });
  }

  async signUp(input: {
    username: string;
    password: string;
    email: string;
    displayName: string;
  }): Promise<AuthFlowResult> {
    const epoch = ++this.identityEpoch;
    return this.run(async () => {
      const next = await this.queueProviderSessionOperation(() => this.provider.signUp(input));
      if (epoch !== this.identityEpoch) return 'error';
      this.heldCredentials = { username: input.username, password: input.password };
      return this.applyNext(next, epoch);
    });
  }

  /** Finishes confirmSignUp; if we hold credentials, completes the sign-in. */
  async confirmCode(code: string): Promise<AuthFlowResult> {
    const epoch = ++this.identityEpoch;
    return this.run(async () => {
      const pendingUsername = this.pendingUsername;
      const heldCredentials = this.heldCredentials;
      if (!pendingUsername) throw new AuthError('unknown', 'no pending confirmation');
      const next = await this.queueProviderSessionOperation(async () => {
        await this.provider.confirmSignUp(pendingUsername, code);
        if (epoch !== this.identityEpoch || !heldCredentials) return null;
        return this.provider.signIn(heldCredentials.username, heldCredentials.password);
      });
      if (epoch !== this.identityEpoch) return 'error';
      if (next) return this.applyNext(next, epoch);
      this.challengeSignal.set(null);
      return 'done';
    });
  }

  async resendCode(): Promise<AuthFlowResult> {
    return this.run(async () => {
      if (!this.pendingUsername) throw new AuthError('unknown', 'no pending confirmation');
      await this.provider.resendCode(this.pendingUsername);
      return 'done';
    });
  }

  async completeNewPassword(newPassword: string): Promise<AuthFlowResult> {
    const epoch = ++this.identityEpoch;
    return this.run(async () => {
      const next = await this.queueProviderSessionOperation(() =>
        this.provider.completeNewPassword(newPassword),
      );
      return this.applyNext(next, epoch);
    });
  }

  async forgotPassword(username: string): Promise<AuthFlowResult> {
    return this.run(async () => {
      const { deliveryHint } = await this.provider.forgotPassword(username);
      this.pendingUsername = username;
      this.deliveryHintSignal.set(deliveryHint);
      return 'done';
    });
  }

  async confirmForgotPassword(code: string, newPassword: string): Promise<AuthFlowResult> {
    return this.run(async () => {
      if (!this.pendingUsername) throw new AuthError('unknown', 'no pending recovery');
      await this.provider.confirmForgotPassword(this.pendingUsername, code, newPassword);
      return 'done';
    });
  }

  /** Clears identity only — local forests are NEVER touched by sign-out. */
  async signOut(): Promise<void> {
    // Invalidate validation/hydration and the visible local session before
    // the provider can yield. The queued provider operation runs after every
    // older login but before any newer login invoked after this sign-out.
    this.identityEpoch += 1;
    this.applySnapshot(undefined);
    this.challengeSignal.set(null);
    this.heldCredentials = null;
    this.pendingUsername = null;
    const clearPersistedIdentity = this.queueIdentityPersistenceOperation(async () => {
      try {
        await this.identityPersistence.clear();
      } catch {
        /* nothing to clear */
      }
    });
    await this.queueProviderSessionOperation(async () => {
      try {
        await this.provider.signOut();
      } catch {
        // Provider hiccups must not trap the user in a session.
      }
      await clearPersistedIdentity;
      this.channel?.postMessage('changed');
    });
  }

  /** Leaves a challenge flow without finishing it (UI "volver"). */
  dismissChallenge(): void {
    this.challengeSignal.set(null);
    this.lastErrorSignal.set(null);
    this.heldCredentials = null;
    this.pendingUsername = null;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async run(flow: () => Promise<AuthFlowResult>): Promise<AuthFlowResult> {
    this.busySignal.set(true);
    this.lastErrorSignal.set(null);
    try {
      return await flow();
    } catch (error) {
      this.lastErrorSignal.set(error instanceof AuthError ? error.code : 'unknown');
      return 'error';
    } finally {
      this.busySignal.set(false);
    }
  }

  private applyNext(next: AuthNext, epoch: number): AuthFlowResult {
    if (epoch !== this.identityEpoch) return 'error';
    if (next.kind === 'done') {
      void this.commit(next.session, epoch);
      return 'done';
    }
    if (next.kind === 'confirmSignUp') {
      this.pendingUsername = next.username;
      this.deliveryHintSignal.set(next.deliveryHint);
      this.challengeSignal.set('confirmSignUp');
      return 'confirmSignUp';
    }
    this.challengeSignal.set('newPasswordRequired');
    return 'newPasswordRequired';
  }

  private async commit(session: AuthSession, epoch: number): Promise<void> {
    if (epoch !== this.identityEpoch) return;
    this.userSignal.set(session.user);
    this.statusSignal.set('signedIn');
    this.challengeSignal.set(null);
    this.sessionStaleSignal.set(false);
    this.heldCredentials = null;
    this.pendingUsername = null;
    try {
      await this.queueIdentityPersistenceOperation(() =>
        this.identityPersistence.write({
          key: META_AUTH_IDENTITY,
          user: session.user,
          cachedAt: Date.now(),
        } satisfies AuthIdentitySnapshot),
      );
    } catch {
      // Memory-only session — identity still works until the app closes.
    }
    if (epoch === this.identityEpoch) this.channel?.postMessage('changed');
  }

  /** Another tab signed in/out — mirror whatever meta now says. */
  private async mirrorFromMeta(epoch: number): Promise<void> {
    try {
      const snapshot = await this.identityPersistence.read();
      if (epoch === this.identityEpoch) this.applySnapshot(snapshot);
    } catch {
      /* keep current state */
    }
  }

  /** Post-boot check: refresh the snapshot, or flag the session as stale. */
  private async validateQuietly(): Promise<void> {
    if (this.statusSignal() !== 'signedIn') return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    const epoch = this.identityEpoch;
    try {
      const session = await this.queueProviderSessionOperation(() =>
        this.provider.currentSession(),
      );
      if (epoch !== this.identityEpoch || this.statusSignal() !== 'signedIn') return;
      if (session) {
        await this.commit(session, epoch);
      } else {
        // Definitively no live session (revoked/expired refresh) — keep the
        // identity visible, demand re-auth only when a cloud feature needs it.
        this.sessionStaleSignal.set(true);
      }
    } catch {
      // Network or SDK-load failure — cached identity stands, try next boot.
    }
  }

  private subscribeToChannel(): void {
    if (!this.channel || this.channelSubscribed) return;
    this.channelSubscribed = true;
    this.channel.addEventListener('message', () => {
      const epoch = ++this.identityEpoch;
      void this.mirrorFromMeta(epoch);
    });
  }

  private applySnapshot(snapshot: AuthIdentitySnapshot | undefined): void {
    this.userSignal.set(snapshot?.user ?? null);
    this.statusSignal.set(snapshot?.user ? 'signedIn' : 'guest');
    this.sessionStaleSignal.set(false);
  }

  private queueProviderSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.providerSessionTail.then(operation);
    this.providerSessionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private queueIdentityPersistenceOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.identityPersistenceTail.then(operation);
    this.identityPersistenceTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
