import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate } from '@angular/service-worker';
import { ToastService } from '../shared/ui/toast.service';
import { I18nService } from './i18n/i18n.service';
import { storageAvailable } from './db/idb';
import { SyncService } from './sync/sync.service';

type UpdateStatus = 'idle' | 'ready' | 'recovery';
type UpdateCheck = 'current' | 'ready' | 'unavailable';
const RESUME_AFTER_UPDATE = 'rm2u.update-resume';

/** Skip the startup check-in once after explicitly updating from Ahora. */
export function consumeUpdateRouteContinuity(): boolean {
  try {
    const expiry = Number(sessionStorage.getItem(RESUME_AFTER_UPDATE));
    sessionStorage.removeItem(RESUME_AFTER_UPDATE);
    return expiry > Date.now();
  } catch {
    return false;
  }
}

export const APP_UPDATE_RUNTIME = new InjectionToken<{
  online(): boolean;
  storageReady(): Promise<boolean>;
  reload(): void;
}>('APP_UPDATE_RUNTIME', {
  providedIn: 'root',
  factory: () => {
    const sync = inject(SyncService);
    return {
      online: () => navigator.onLine,
      storageReady: async () => {
        if (!await storageAvailable()) return false;
        await sync.flushLocalQueue();
        return true;
      },
      reload: () => {
        if (/\/ahora\/?$/.test(location.pathname)) {
          try {
            sessionStorage.setItem(RESUME_AFTER_UPDATE, String(Date.now() + 120_000));
          } catch {
            /* Reload still works without session storage. */
          }
        }
        location.reload();
      },
    };
  },
});

/** Checking and applying are separate actions. The running tab stays intact until Apply. */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly swUpdate = inject(SwUpdate);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly runtime = inject(APP_UPDATE_RUNTIME);
  private readonly state = signal<UpdateStatus>('idle');
  private readonly checkingState = signal(false);
  private readonly applyingState = signal(false);
  readonly status = this.state.asReadonly();
  readonly checking = this.checkingState.asReadonly();
  readonly applying = this.applyingState.asReadonly();
  private started = false;
  private lastCheck = -Infinity;
  private pendingCheck: Promise<UpdateCheck> | null = null;

  init(): void {
    if (this.started || !this.swUpdate.isEnabled) return;
    this.started = true;
    this.swUpdate.versionUpdates
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        if (event.type === 'VERSION_READY') this.offer('ready');
      });
    this.swUpdate.unrecoverable
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.offer('recovery'));

    const check = () => {
      const now = Date.now();
      if (now - this.lastCheck < 600_000 || !this.runtime.online()) return;
      this.lastCheck = now;
      void this.check();
    };
    const onVisibility = () => {
      if (!document.hidden) check();
    };
    check();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', check);
    const timer = setInterval(check, 900_000);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', check);
      clearInterval(timer);
    });
  }

  check(): Promise<UpdateCheck> {
    if (!this.swUpdate.isEnabled || !this.runtime.online()) return Promise.resolve('unavailable');
    if (this.status() !== 'idle') return Promise.resolve('ready');
    if (this.pendingCheck) return this.pendingCheck;
    this.checkingState.set(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<UpdateCheck>((resolve) => {
      timer = setTimeout(() => resolve('unavailable'), 10_000);
    });
    const check = this.swUpdate.checkForUpdate().then((found): UpdateCheck => {
      if (found) this.offer('ready');
      return this.status() === 'idle' ? 'current' : 'ready';
    }, (): UpdateCheck => 'unavailable');
    this.pendingCheck = Promise.race([check, deadline]).finally(() => {
      clearTimeout(timer);
      this.pendingCheck = null;
      this.checkingState.set(false);
    });
    return this.pendingCheck;
  }

  async apply(): Promise<void> {
    if (this.status() !== 'idle') await this.reloadWhenSafe();
  }

  /** The explicit repair path only removes this app's worker and its scoped assets. */
  async repair(): Promise<void> {
    await this.reloadWhenSafe(async () => {
      const scope = new URL('.', document.baseURI);
      const registration = await navigator.serviceWorker?.getRegistration(scope.href);
      const worker = registration?.active ?? registration?.waiting ?? registration?.installing;
      if (registration?.scope !== scope.href || worker?.scriptURL !== new URL('sw.js', scope).href) return;
      await registration.unregister();
      if (!('caches' in window)) return;
      const prefix = `ngsw:${scope.pathname}:`;
      for (const key of await caches.keys()) {
        if (key.startsWith(prefix)) await caches.delete(key);
      }
    });
  }

  private async reloadWhenSafe(beforeReload?: () => Promise<void>): Promise<void> {
    if (this.applying()) return;
    this.applyingState.set(true);
    try {
      if (!this.runtime.online()) {
        this.toast.show({ message: this.i18n.t().settings.updateFailed });
        return;
      }
      if (!await this.runtime.storageReady()) {
        this.toast.show({ message: this.i18n.t().app.memoryOnly });
        return;
      }
      await beforeReload?.();
      this.runtime.reload();
    } catch {
      this.toast.show({ message: this.i18n.t().settings.updateFailed });
    } finally {
      this.applyingState.set(false);
    }
  }

  private offer(status: Exclude<UpdateStatus, 'idle'>): void {
    if (this.status() === status || this.status() === 'recovery') return;
    this.state.set(status);
    const { update, settings } = this.i18n.t();
    this.toast.show({
      message: status === 'ready' ? `${update.ready} · ${update.action}` : settings.repairHint,
      actionLabel: update.reload,
      sticky: true,
      action: () => void this.apply(),
    });
  }
}
