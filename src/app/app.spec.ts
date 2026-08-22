import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { App } from './app';
import { AccompanimentService } from './core/accompaniment.service';
import { BackupReminderService } from './core/backup-reminder.service';
import { FocusSessionService } from './core/focus-session.service';
import { MotionService } from './core/motion.service';
import { PerchAnchorService } from './core/perch-anchor.service';
import { RemindersService } from './core/reminders.service';
import { RitualsService } from './core/rituals.service';
import { ThemeService } from './core/theme/theme.service';
import { UpdateService } from './core/update.service';
import { PromiseService } from './features/cosecha/promise.service';
import { ToastService } from './shared/ui/toast.service';

describe('public app root', () => {
  it('constructs no product chrome or background service', async () => {
    const constructed: string[] = [];
    const tracked = <T>(name: string, value: T) => () => {
      constructed.push(name);
      return value;
    };

    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        {
          provide: ToastService,
          useFactory: tracked('toast', { current: signal(null), dismiss: () => undefined }),
        },
        {
          provide: FocusSessionService,
          useFactory: tracked('focus', { active: signal(null) }),
        },
        {
          provide: PromiseService,
          useFactory: tracked('promise', { placementRequest: signal(null) }),
        },
        {
          provide: PerchAnchorService,
          useFactory: tracked('perch-anchor', { claimed: signal(false) }),
        },
        { provide: ThemeService, useFactory: tracked('theme', {}) },
        { provide: MotionService, useFactory: tracked('motion', { reduced: signal(false) }) },
        {
          provide: UpdateService,
          useFactory: tracked('updates', { init: () => undefined }),
        },
        {
          provide: AccompanimentService,
          useFactory: tracked('accompaniment', { init: () => undefined }),
        },
        {
          provide: RemindersService,
          useFactory: tracked('reminders', { init: () => undefined }),
        },
        { provide: RitualsService, useFactory: tracked('rituals', {}) },
        {
          provide: BackupReminderService,
          useFactory: tracked('backup-reminder', {}),
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    expect(constructed).toEqual([]);
    expect(fixture.nativeElement.querySelector('router-outlet')).not.toBeNull();
  });
});
