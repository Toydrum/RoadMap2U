import { Injectable, inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

/**
 * Shared, idempotent auth hydration for `/account` and the product shell.
 * It reads only the cached identity meta row; it never constructs product
 * repositories, sync, reminders, or BootService.
 */
@Injectable({ providedIn: 'root' })
export class AuthInitializer {
  private readonly auth = inject(AuthService);
  private pending: Promise<void> | null = null;

  init(): Promise<void> {
    return (this.pending ??= this.auth.hydrate());
  }
}

export const authReadyGate: CanActivateFn = () =>
  inject(AuthInitializer)
    .init()
    .then(() => true);
