import { Component, InjectionToken, computed, effect, inject, input, signal } from '@angular/core';
import { inputValue } from '../../shared/ui/dom';
import { Router, RouterLink } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { AuthService } from '../../core/auth/auth.service';
import { APP_CONFIG } from '../../core/config';
import { PASSWORD_POLICY, USERNAME_PATTERN, passwordMeetsPolicy } from '../../core/auth/auth-types';
import { AccountClosureService } from '../../core/account-closure.service';
import type { AccountClosureState } from '../../core/api/contracts';

type Step =
  | 'welcome'
  | 'signIn'
  | 'create'
  | 'confirmCode'
  | 'newPassword'
  | 'forgot'
  | 'forgotCode'
  | 'closureRecovery'
  | 'profile';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ACCOUNT_CLOSURE_RESTART = new InjectionToken<() => void>('ACCOUNT_CLOSURE_RESTART', {
  providedIn: 'root',
  factory: () => () => location.reload(),
});

export function normalizedUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function createAccountInputError(
  username: string,
  email: string,
  password: string,
  password2: string,
): 'invalidUsername' | 'invalidEmail' | 'passwordPolicy' | 'passwordMismatch' | null {
  if (!USERNAME_PATTERN.test(normalizedUsername(username))) return 'invalidUsername';
  if (!EMAIL_PATTERN.test(email.trim())) return 'invalidEmail';
  if (!passwordMeetsPolicy(password)) return 'passwordPolicy';
  if (password !== password2) return 'passwordMismatch';
  return null;
}

/**
 * The account ritual — same full-screen pattern as the check-in: one
 * component, a signal-driven step machine, no tab bar. Steps advance from
 * flow RESULTS ('done' | 'confirmSignUp' | 'newPasswordRequired' | 'error');
 * errors render as calm copy from the `lastError` signal, never as thrown
 * surprises. Signing in or out never touches the local forest.
 */
@Component({
  selector: 'app-account',
  imports: [RouterLink],
  templateUrl: './account.html',
  styleUrl: './account.scss',
})
export class AccountPage {
  protected readonly inputValue = inputValue;
  protected readonly i18n = inject(I18nService);
  protected readonly auth = inject(AuthService);
  protected readonly closure = inject(AccountClosureService);
  protected readonly bugReportUrl =
    'https://docs.google.com/forms/d/e/1FAIpQLSelXiTkj1W9hKmgw1z_fLVFKy_a2bpWDFT8FdSABTLteHxmew/viewform';
  private readonly router = inject(Router);
  private readonly restartAfterClosure = inject(ACCOUNT_CLOSURE_RESTART);

  /** Where the auth gate was headed — internal paths only. */
  readonly volver = input<string>();

  protected readonly isMock = APP_CONFIG.backend === 'mock';
  protected readonly minLength = PASSWORD_POLICY.minLength;

  protected readonly step = signal<Step>('welcome');

  protected readonly username = signal('');
  protected readonly password = signal('');
  protected readonly password2 = signal('');
  protected readonly email = signal('');
  protected readonly code = signal('');

  /** Client-side-only complaint (password mismatch) — not an auth error. */
  protected readonly localError = signal('');
  /** Gentle success line ("your new password is ready"). */
  protected readonly notice = signal('');
  protected readonly confirmingDelete = signal(false);

  constructor() {
    if (this.auth.status() === 'signedIn') this.step.set('profile');
    // Auth is the only eager graph on /account. Receipt hydration stays local
    // meta-only; Backup/Sync/repos remain behind the explicit closure click.
    effect(() => {
      this.auth.status();
      void this.closure.hydrate();
    });
    // Read the receipt synchronously so a cross-tab terminal publication is a
    // real dependency of this effect, not a one-off value hidden in a promise.
    effect(() => {
      const status = this.auth.status();
      const receipt = this.closure.receipt();
      if (status === 'guest' && receipt?.state === 'completed') {
        this.step.set('closureRecovery');
      } else if (
        status === 'guest' &&
        (this.step() === 'profile' || this.step() === 'closureRecovery')
      ) {
        this.step.set('welcome');
      }
    });
  }

  protected readonly errorText = computed(() => {
    const code = this.auth.lastError();
    return code ? this.i18n.t().account.errors[code] : '';
  });

  protected go(step: Step): void {
    this.auth.dismissChallenge();
    this.localError.set('');
    this.notice.set('');
    this.confirmingDelete.set(false);
    this.step.set(step);
  }

  protected async doSignIn(): Promise<void> {
    this.localError.set('');
    this.notice.set('');
    const result = await this.auth.signIn(this.username().trim(), this.password());
    if (result === 'done') await this.afterAuth();
    else if (result === 'confirmSignUp') this.step.set('confirmCode');
    else if (result === 'newPasswordRequired') {
      this.password.set('');
      this.password2.set('');
      this.step.set('newPassword');
    }
  }

  protected async doCreate(): Promise<void> {
    this.notice.set('');
    const inputError = createAccountInputError(
      this.username(),
      this.email(),
      this.password(),
      this.password2(),
    );
    if (inputError) {
      this.localError.set(
        inputError === 'passwordMismatch'
          ? this.i18n.t().account.passwordMismatch
          : this.i18n.t().account.errors[inputError],
      );
      return;
    }
    this.localError.set('');
    const username = normalizedUsername(this.username());
    this.username.set(username);
    const result = await this.auth.signUp({
      username,
      password: this.password(),
      email: this.email().trim(),
      // Severed from signup (0.0.108): providers fall back to the username.
      displayName: '',
    });
    if (result === 'confirmSignUp') this.step.set('confirmCode');
    else if (result === 'done') await this.afterAuth();
  }

  protected async doConfirmCode(): Promise<void> {
    const result = await this.auth.confirmCode(this.code().trim());
    if (result === 'done') await this.afterAuth();
    else if (result === 'newPasswordRequired') {
      this.password.set('');
      this.password2.set('');
      this.step.set('newPassword');
    }
  }

  protected async doResend(): Promise<void> {
    if ((await this.auth.resendCode()) === 'done') {
      this.notice.set(this.i18n.t().account.resent);
    }
  }

  protected async doNewPassword(): Promise<void> {
    this.notice.set('');
    if (this.password() !== this.password2()) {
      this.localError.set(this.i18n.t().account.passwordMismatch);
      return;
    }
    this.localError.set('');
    const result = await this.auth.completeNewPassword(this.password());
    if (result === 'done') await this.afterAuth();
  }

  protected async doForgot(): Promise<void> {
    this.notice.set('');
    const result = await this.auth.forgotPassword(this.username().trim());
    if (result === 'done') {
      this.code.set('');
      this.password.set('');
      this.password2.set('');
      this.step.set('forgotCode');
    }
  }

  protected async doForgotConfirm(): Promise<void> {
    if (this.password() !== this.password2()) {
      this.localError.set(this.i18n.t().account.passwordMismatch);
      return;
    }
    this.localError.set('');
    const result = await this.auth.confirmForgotPassword(this.code().trim(), this.password());
    if (result === 'done') {
      this.password.set('');
      this.password2.set('');
      this.notice.set(this.i18n.t().account.forgotDone);
      this.step.set('signIn');
    }
  }

  protected async doSignOut(): Promise<void> {
    await this.auth.signOut();
    this.password.set('');
    this.go('welcome');
  }

  protected async doDelete(): Promise<void> {
    const result = await this.closure.requestClosure();
    if (result === 'completed' && !this.closure.receipt()) this.restartAfterClosure();
  }

  protected async retryClosure(): Promise<void> {
    const result = await this.closure.retry();
    if (result === 'completed' && !this.closure.receipt()) this.restartAfterClosure();
  }

  protected closureStateText(state: AccountClosureState): string {
    switch (state) {
      case 'requested':
        return this.i18n.t().account.closureRequested;
      case 'purging':
        return this.i18n.t().account.closurePurging;
      case 'purgeComplete':
        return this.i18n.t().account.closurePurgeComplete;
      case 'completed':
        return this.i18n.t().account.closureCompleted;
    }
  }

  protected closureErrorText(): string {
    const code = this.closure.lastError();
    if (code === 'UNAUTHENTICATED') return this.i18n.t().account.closureSessionExpired;
    if (code === 'offline') return this.i18n.t().account.closureOffline;
    return code ? this.i18n.t().account.closureRetryError : '';
  }

  /** A finished sign-in returns to `volver` (internal only) or shows profile. */
  private async afterAuth(): Promise<void> {
    this.password.set('');
    this.password2.set('');
    this.code.set('');
    await this.closure.hydrate();
    const target = this.volver();
    // '//' is protocol-relative — it would escape the origin.
    if (target && target.startsWith('/') && !target.startsWith('//')) {
      void this.router.navigateByUrl(target);
      return;
    }
    this.step.set('profile');
  }
}
