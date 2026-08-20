import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AccompanimentService } from '../../core/accompaniment.service';
import { AccessService } from '../../core/access/access.service';
import { AuthService } from '../../core/auth/auth.service';
import { BackupReminderService } from '../../core/backup-reminder.service';
import { BootService } from '../../core/boot.service';
import { MotionService } from '../../core/motion.service';
import { RemindersService } from '../../core/reminders.service';
import { RitualsService } from '../../core/rituals.service';
import { SyncService } from '../../core/sync/sync.service';
import { ThemeService } from '../../core/theme/theme.service';
import { UpdateService } from '../../core/update.service';
import { AuthInitializer } from './auth-initializer';
import { ProductInitializer } from './product-initializer';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('route-scoped startup', () => {
  it('hydrates account auth once without constructing any product service', async () => {
    const gate = deferred();
    const hydrate = vi.fn(() => gate.promise);
    const constructed: string[] = [];

    TestBed.configureTestingModule({
      providers: [
        AuthInitializer,
        { provide: AuthService, useValue: { hydrate } },
        { provide: BootService, useFactory: () => (constructed.push('boot'), {}) },
        { provide: SyncService, useFactory: () => (constructed.push('sync'), {}) },
        { provide: RemindersService, useFactory: () => (constructed.push('reminders'), {}) },
      ],
    });

    const initializer = TestBed.inject(AuthInitializer);
    const first = initializer.init();
    const second = initializer.init();

    expect(first).toBe(second);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(constructed).toEqual([]);

    gate.resolve();
    await first;
  });

  it('starts data seams before chrome and performs the whole startup only once', async () => {
    const dataReady = deferred();
    const accessReady = deferred();
    const calls: string[] = [];
    const start = (name: string) => () => {
      calls.push(name);
      return dataReady.promise;
    };
    const tracked =
      <T>(name: string, value: T) =>
      () => {
        calls.push(name);
        return value;
      };

    TestBed.configureTestingModule({
      providers: [
        ProductInitializer,
        { provide: BootService, useValue: { init: start('boot') } },
        { provide: AuthInitializer, useValue: { init: start('auth') } },
        {
          provide: AccessService,
          useValue: { start: () => (calls.push('access'), accessReady.promise) },
        },
        { provide: SyncService, useValue: { init: () => (calls.push('sync'), Promise.resolve()) } },
        { provide: ThemeService, useFactory: tracked('theme', {}) },
        { provide: MotionService, useFactory: tracked('motion', {}) },
        {
          provide: UpdateService,
          useFactory: tracked('updates', { init: () => calls.push('updates:init') }),
        },
        {
          provide: AccompanimentService,
          useFactory: tracked('accompaniment', {
            init: () => calls.push('accompaniment:init'),
          }),
        },
        {
          provide: RemindersService,
          useFactory: tracked('reminders', { init: () => calls.push('reminders:init') }),
        },
        { provide: RitualsService, useFactory: tracked('rituals', {}) },
        { provide: BackupReminderService, useFactory: tracked('backup-reminder', {}) },
      ],
    });

    const initializer = TestBed.inject(ProductInitializer);
    const first = initializer.init();
    const second = initializer.init();

    expect(first).toBe(second);
    expect(calls).toEqual(['boot', 'auth']);

    dataReady.resolve();
    await vi.waitFor(() => expect(calls).toEqual(['boot', 'auth', 'access']));
    accessReady.resolve();
    await first;

    expect(calls).toEqual([
      'boot',
      'auth',
      'access',
      'sync',
      'theme',
      'motion',
      'updates',
      'updates:init',
      'accompaniment',
      'accompaniment:init',
      'reminders',
      'reminders:init',
      'rituals',
      'backup-reminder',
    ]);

    await initializer.init();
    expect(calls.filter((call) => call === 'boot')).toHaveLength(1);
    expect(calls.filter((call) => call === 'reminders:init')).toHaveLength(1);
  });
});
