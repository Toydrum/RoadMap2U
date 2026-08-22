import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountClosureService } from '../../core/account-closure.service';
import { AccessService } from '../../core/access/access.service';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { EN } from '../../core/i18n/en';
import { ES, type Dict } from '../../core/i18n/es';
import { BackupService } from '../../core/repos/backup.service';
import { TreesRepo } from '../../core/repos/trees.repo';
import { SyncService } from '../../core/sync/sync.service';
import {
  ACCOUNT_CLOSURE_RESTART,
  AccountPage,
  createAccountInputError,
  normalizedUsername,
  safeLocalReturnUrl,
} from './account';

function accountHarness(dict: Dict = ES) {
  const status = signal<'guest' | 'signedIn'>('guest');
  const user = signal<{
    userId: string;
    username: string;
    displayName: string | null;
    email: string | null;
    accountType: 'adult';
  } | null>(null);
  const receipt = signal<{
    closureId: string;
    state: 'requested' | 'purging' | 'purgeComplete' | 'completed';
  } | null>({ closureId: 'closure-1', state: 'completed' });
  const hydrate = vi.fn<() => Promise<void>>(async () => undefined);
  const retry = vi.fn<
    () => Promise<'requested' | 'purging' | 'purgeComplete' | 'completed' | 'error'>
  >(async () => 'error');
  const auth = {
    status,
    user,
    busy: signal(false),
    lastError: signal(null),
    challenge: signal(null),
    sessionStale: signal(false),
    deliveryHint: signal(null),
    dismissChallenge: vi.fn(),
    signIn: vi.fn<() => Promise<'done' | 'error'>>(async () => 'error'),
    signOut: vi.fn(async () => undefined),
  };
  const closure = {
    receipt,
    busy: signal(false),
    lastError: signal(null),
    hydrate,
    retry,
    requestClosure: vi.fn(async () => 'requested' as const),
  };
  const i18n = {
    t: signal(dict),
    fill: (template: string, values: Record<string, string | number>) =>
      template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? '')),
  };
  const constructed = { backup: 0, sync: 0, trees: 0 };
  const restart = vi.fn();
  const access = { redeem: vi.fn(async () => undefined) };

  TestBed.configureTestingModule({
    imports: [AccountPage],
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: auth },
      { provide: AccountClosureService, useValue: closure },
      { provide: ACCOUNT_CLOSURE_RESTART, useValue: restart },
      { provide: I18nService, useValue: i18n },
      { provide: AccessService, useValue: access },
      {
        provide: BackupService,
        useFactory: () => {
          constructed.backup += 1;
          return {};
        },
      },
      {
        provide: SyncService,
        useFactory: () => {
          constructed.sync += 1;
          return {};
        },
      },
      {
        provide: TreesRepo,
        useFactory: () => {
          constructed.trees += 1;
          return {};
        },
      },
    ],
  });
  return { auth, closure, constructed, restart, access };
}

describe('account create validation', () => {
  it('normalizes username case before signup', () => {
    expect(normalizedUsername(' LynxPardelle ')).toBe('lynxpardelle');
  });

  it('rejects spaces in usernames before Cognito', () => {
    expect(
      createAccountInputError('Lynx Pardelle', 'lnxdrk@gmail.com', 'Abc12345', 'Abc12345'),
    ).toBe('invalidUsername');
  });

  it('rejects missing email before Cognito', () => {
    expect(createAccountInputError('lynxpardelle', '', 'Abc12345', 'Abc12345')).toBe(
      'invalidEmail',
    );
  });
});

describe('account return URL validation', () => {
  it.each([
    ['https://evil.example/forest', '/forest'],
    ['//evil.example/forest', '/forest'],
    ['/\\evil.example/forest', '/forest'],
    ['/forest/tree-a\n', '/forest'],
    ['/forest/tree-a?plant=1', '/forest/tree-a?plant=1'],
  ])('maps %s to %s', (target, expected) => {
    expect(safeLocalReturnUrl(target)).toBe(expected);
  });
});

describe('account closure recovery UI', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it.each([
    ['ES', ES],
    ['EN', EN],
  ] as const)(
    'shows an accessible retry-only terminal recovery in %s while guest',
    async (_lang, dict) => {
      const h = accountHarness(dict);
      const fixture = TestBed.createComponent(AccountPage);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const text = fixture.nativeElement.textContent as string;
      expect(text).toContain(dict.account.closureStatusTitle);
      expect(text).toContain(dict.account.closureRetry);
      expect(text).not.toContain(dict.account.signInDoor);
      expect(text).not.toContain(dict.account.createDoor);
      expect(text).not.toContain(dict.account.deleteCta);
      expect(fixture.nativeElement.querySelector('[role="status"]')).not.toBeNull();

      const retryButton = [...fixture.nativeElement.querySelectorAll('button')].find(
        (button: HTMLButtonElement) => button.textContent?.includes(dict.account.closureRetry),
      ) as HTMLButtonElement;
      retryButton.click();
      await fixture.whenStable();
      expect(h.closure.retry).toHaveBeenCalledOnce();
    },
  );

  it('rehydrates the owner receipt immediately after sign-in and hides the new-delete CTA', async () => {
    const h = accountHarness();
    h.closure.receipt.set(null);
    h.auth.signIn.mockImplementationOnce(async () => {
      h.auth.user.set({
        userId: 'owner-a',
        username: 'owner-a',
        displayName: 'Owner',
        email: 'owner@example.test',
        accountType: 'adult',
      });
      h.auth.status.set('signedIn');
      return 'done' as const;
    });
    h.closure.hydrate.mockImplementation(async () => {
      if (h.auth.status() === 'signedIn') {
        h.closure.receipt.set({ closureId: 'closure-1', state: 'purging' });
      }
    });
    const fixture = TestBed.createComponent(AccountPage);
    fixture.detectChanges();

    await (fixture.componentInstance as unknown as { doSignIn(): Promise<void> }).doSignIn();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(ES.account.closurePurging);
    expect(text).toContain(ES.account.closureRetry);
    expect(text).not.toContain(ES.account.deleteCta);
  });

  it('ignores a guest hydration that resolves after sign-in completed', async () => {
    const h = accountHarness();
    h.closure.receipt.set(null);
    let releaseGuest!: () => void;
    const guestHydration = new Promise<void>((resolve) => (releaseGuest = resolve));
    h.closure.hydrate.mockImplementation(async () => {
      if (h.auth.status() === 'guest') return guestHydration;
      h.closure.receipt.set({ closureId: 'closure-1', state: 'purging' });
    });
    h.auth.signIn.mockImplementationOnce(async () => {
      h.auth.user.set({
        userId: 'owner-a',
        username: 'owner-a',
        displayName: 'Owner',
        email: 'owner@example.test',
        accountType: 'adult',
      });
      h.auth.status.set('signedIn');
      return 'done' as const;
    });

    const fixture = TestBed.createComponent(AccountPage);
    fixture.detectChanges();
    await vi.waitFor(() => expect(h.closure.hydrate).toHaveBeenCalled());
    await (fixture.componentInstance as unknown as { doSignIn(): Promise<void> }).doSignIn();
    releaseGuest();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(ES.account.profileTitle);
    expect(text).toContain(ES.account.closurePurging);
    expect(text).not.toContain(ES.account.welcomeTitle);
  });

  it('moves an already-open guest page into terminal recovery when a sibling publishes it', async () => {
    const h = accountHarness();
    h.closure.receipt.set(null);
    const fixture = TestBed.createComponent(AccountPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent as string).toContain(ES.account.signInDoor);

    h.closure.receipt.set({ closureId: 'closure-1', state: 'completed' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(ES.account.closureStatusTitle);
    expect(text).toContain(ES.account.closureRetry);
    expect(text).not.toContain(ES.account.signInDoor);
  });

  it.each([
    ['ES', ES.account.closureRetryError, /conservamos todo/i],
    ['EN', EN.account.closureRetryError, /everything on this device was preserved/i],
  ] as const)(
    'does not promise that every local row survived an unknown late failure in %s',
    (_lang, copy, unsafeClaim) => {
      expect(copy).not.toMatch(unsafeClaim);
    },
  );

  it('restarts with a fresh service graph only after terminal cleanup succeeds', async () => {
    const h = accountHarness();
    h.closure.retry.mockImplementationOnce(async () => {
      h.closure.receipt.set(null);
      return 'completed' as const;
    });
    const fixture = TestBed.createComponent(AccountPage);
    fixture.detectChanges();
    await fixture.whenStable();

    await (
      fixture.componentInstance as unknown as { retryClosure(): Promise<void> }
    ).retryClosure();

    expect(h.restart).toHaveBeenCalledOnce();
  });

  it('does not construct Backup, Sync or repositories merely by visiting /account', async () => {
    const h = accountHarness();
    TestBed.createComponent(AccountPage).detectChanges();
    await Promise.resolve();

    expect(h.constructed).toEqual({ backup: 0, sync: 0, trees: 0 });
  });
});

describe('account sponsored access UI', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows the reusable key form on an adult profile', async () => {
    const h = accountHarness();
    h.closure.receipt.set(null);
    h.auth.user.set({
      userId: 'owner-a',
      username: 'owner-a',
      displayName: 'Owner',
      email: 'owner@example.test',
      accountType: 'adult',
    });
    h.auth.status.set('signedIn');
    const fixture = TestBed.createComponent(AccountPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-access-key-form')).not.toBeNull();
    expect(fixture.nativeElement.textContent as string).toContain(ES.access.key.title);
  });

  it('keeps a redeem intent on the profile after sign-in instead of navigating away', async () => {
    const h = accountHarness();
    h.closure.receipt.set(null);
    h.auth.signIn.mockImplementationOnce(async () => {
      h.auth.user.set({
        userId: 'owner-a',
        username: 'owner-a',
        displayName: 'Owner',
        email: 'owner@example.test',
        accountType: 'adult',
      });
      h.auth.status.set('signedIn');
      return 'done' as const;
    });
    const fixture = TestBed.createComponent(AccountPage);
    fixture.componentRef.setInput('intent', 'redeem');
    fixture.componentRef.setInput('returnUrl', '/forest/tree-a');
    fixture.detectChanges();

    await (fixture.componentInstance as unknown as { doSignIn(): Promise<void> }).doSignIn();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-access-key-form')).not.toBeNull();
    expect(fixture.nativeElement.textContent as string).toContain(ES.access.key.title);
  });
});
