import { DOCUMENT, Injectable, inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService } from '../../core/i18n/i18n.service';
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

export const authReadyGate: CanActivateFn = async (route) => {
  const initializer = inject(AuthInitializer);
  const auth = inject(AuthService);
  const i18n = inject(I18nService);
  const document = inject(DOCUMENT);
  await initializer.init();

  const requested = route.queryParamMap.get('lang');
  if (
    auth.status() === 'guest' &&
    (requested === 'es' || requested === 'en') &&
    requested !== i18n.lang()
  ) {
    // A closing account can reject local preference writes. Keep the route usable.
    await i18n.set(requested).catch(() => undefined);
  }
  document.documentElement.lang = i18n.lang();
  return true;
};
