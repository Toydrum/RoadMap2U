import { Injectable, inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { SettingsService } from '../../core/repos/settings.service';

/**
 * Shared, idempotent auth hydration for `/account` and the product shell.
 * It reads the cached identity and preferences meta rows; it never constructs product
 * repositories, sync, reminders, or BootService.
 */
@Injectable({ providedIn: 'root' })
export class AuthInitializer {
  private readonly auth = inject(AuthService);
  private readonly settings = inject(SettingsService);
  private pending: Promise<void> | null = null;

  init(): Promise<void> {
    return (this.pending ??= Promise.all([this.auth.hydrate(), this.settings.load()]).then(
      () => undefined,
    ));
  }
}

export const authReadyGate: CanActivateFn = () =>
  inject(AuthInitializer)
    .init()
    .then(() => true);
