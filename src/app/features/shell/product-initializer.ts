import { Injectable, Injector, inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { AccompanimentService } from '../../core/accompaniment.service';
import { BackupReminderService } from '../../core/backup-reminder.service';
import { BootService } from '../../core/boot.service';
import { MotionService } from '../../core/motion.service';
import { RemindersService } from '../../core/reminders.service';
import { RitualsService } from '../../core/rituals.service';
import { SyncService } from '../../core/sync/sync.service';
import { ThemeService } from '../../core/theme/theme.service';
import { UpdateService } from '../../core/update.service';
import { AuthInitializer } from './auth-initializer';
import { markProductActive } from './product-activation';

/**
 * The single startup boundary for the local-first product.
 *
 * Nothing injects this service from `/` or `/account`. The lazy product route
 * awaits it before auth/check-in guards or ProductShell can touch repository
 * state. Its cached promise also prevents duplicate listeners and timers when
 * the user leaves the product and later returns.
 */
@Injectable({ providedIn: 'root' })
export class ProductInitializer {
  private readonly injector = inject(Injector);
  private pending: Promise<void> | null = null;

  init(): Promise<void> {
    return (this.pending ??= this.start());
  }

  private async start(): Promise<void> {
    await Promise.all([
      this.injector.get(BootService).init(),
      this.injector.get(AuthInitializer).init(),
      this.injector.get(SyncService).init(),
    ]);

    this.injector.get(ThemeService);
    this.injector.get(MotionService);
    this.injector.get(UpdateService).init();
    this.injector.get(AccompanimentService).init();
    this.injector.get(RemindersService).init();
    this.injector.get(RitualsService);
    this.injector.get(BackupReminderService);
    markProductActive();
  }
}

export const productReadyGate: CanActivateFn = () =>
  inject(ProductInitializer)
    .init()
    .then(() => true);
