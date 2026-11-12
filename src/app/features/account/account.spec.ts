import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountClosureService } from '../../core/account-closure.service';
import { AccessService } from '../../core/access/access.service';
import { AuthService } from '../../core/auth/auth.service';
import { API_CLIENT } from '../../core/api/api-client';
import { ADULT_PRIVACY_VERSIONS, createFreeAccessSummary } from '../../core/api/contracts';
import { privacyDocument, commonAccountDocument } from '../../core/api/privacy-document';
import { I18nService } from '../../core/i18n/i18n.service';
import { EN } from '../../core/i18n/en';
import { ES, type Dict } from '../../core/i18n/es';
import { BackupService } from '../../core/repos/backup.service';
import { TreesRepo } from '../../core/repos/trees.repo';
import { SyncService } from '../../core/sync/sync.service';
import { PrivacyService } from '../../core/privacy.service';
import {
  ACCOUNT_CLOSURE_RESTART,
  AccountPage,
  createAccountInputError,
  normalizedUsername,
  safeLocalReturnUrl,
} from './account';

function accountHarness(dict: Dict = ES, routed = false) {
  const privacyScope = signal<'adult' | 'adolescent_private'>('adult');
  const adultDeclared = signal(true);
  const admission = signal<'standard' | 'absent'>('standard');
  const privateOnly = signal(false);
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
    signUp: vi.fn(async () => 'confirmSignUp' as const),
    confirmCode: vi.fn(async () => 'done' as const),
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
    lang: signal<'es' | 'en'>(dict === EN ? 'en' : 'es'),
    fill: (template: string, values: Record<string, string | number>) =>
      template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? '')),
  };
  const constructed = { backup: 0, sync: 0, trees: 0 };
  const restart = vi.fn();
  const access = {
    redeem: vi.fn(async () => undefined),
    access: signal(createFreeAccessSummary()),
    leaseState: signal('valid'),
    loading: signal(false),
    lastError: signal(null),
    start: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  };
  const readPrivacy = async (language: 'es' | 'en') => ({
    userId: user()!.userId, scope: privacyScope(), enforcement: 'enforce', revision: 1,
    adultDeclared: adultDeclared(), accountAdmission: admission(), cloudConsent: 'absent',
    privateOnly: privateOnly(),
    canUseCloud: false, erasure: 'none', versions: ADULT_PRIVACY_VERSIONS,
    documentHash: (await privacyDocument(language)).hash, updatedAt: 1,
    commonVersions: (await commonAccountDocument(language)).document.versions,
    commonDocumentHash: (await commonAccountDocument(language)).hash,
  });
  const api = {
    getPrivacyStatus: readPrivacy,
    changePrivacyConsent: vi.fn(async (command: { language: 'es' | 'en' }) => {
      admission.set('standard');
      return readPrivacy(command.language);
    }),
  };

  TestBed.configureTestingModule({
    imports: [AccountPage],
    providers: [
      provideRouter(routed ? [{ path: 'account', component: AccountPage }] : [], withComponentInputBinding()),
      ...(routed ? provideLocationMocks() : []),
      { provide: AuthService, useValue: auth },
      {
        provide: API_CLIENT,
        useValue: api,
      },
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
  return { auth, closure, constructed, restart, access, privacyScope, adultDeclared, admission, privateOnly, api };
}

describe('standard account admission copy', () => {
  it.each([
    {
      locale: 'es',
      dict: ES,
      declaration: /Free.*Premium/i,
      falseClaim: /representación verificada|parentesco verificado|tutela verificada/i,
    },
    {
      locale: 'en',
      dict: EN,
      declaration: /Free.*Premium/i,
      falseClaim: /verified representation|verified parentage|verified guardianship/i,
    },
  ])(
    'describes standard Free and Premium without promoting a family guide ($locale)',
    ({ dict, declaration, falseClaim }) => {
      const familyGuide = dict.guide.sections.find((section) => section.icon === '🤝');
      expect(familyGuide).toBeUndefined();
      for (const copy of [dict.account.createHint]) {
        expect(copy).toMatch(declaration);
        expect(copy).not.toMatch(falseClaim);
        expect(copy).not.toMatch(/12.*17|invita|guardian|tutor/i);
      }
    },
  );
});

describe('account create validation', () => {
  it.each([['es', ES], ['en', EN]] as const)('opens the legal documents in the displayed signup language (%s)', async (language, dictionary) => {
    TestBed.resetTestingModule();
    const harness = accountHarness(dictionary);
    harness.closure.receipt.set(null);
    const fixture = TestBed.createComponent(AccountPage);
    fixture.componentRef.setInput('intent', 'create');
    fixture.detectChanges();
    await vi.waitFor(() => expect((fixture.componentInstance as any).signupDocument()).not.toBeNull());
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('a[href^="/privacy"]').getAttribute('href')).toBe('/privacy?lang=' + language);
    expect(fixture.nativeElement.querySelector('a[href^="/terms"]').getAttribute('href')).toBe('/terms?lang=' + language);
  });

  it.each([['privacy', ES.legal.privacy], ['terms', ES.legal.terms]] as const)(
    'keeps the signup form open while reading %s',
    async (kind, documentCopy) => {
      const harness = accountHarness(ES, true);
      harness.closure.receipt.set(null);
      const router = TestBed.inject(Router);
      router.setUpLocationChangeListener();
      const location = TestBed.inject(Location);
      const start = '/account?intent=create';
      const route = await RouterTestingHarness.create(start);
      const host = route.routeNativeElement!;
      await vi.waitFor(() => {
        route.detectChanges();
        expect(host.querySelector(`a[href^="/${kind}"]`)).not.toBeNull();
      });
      const link = host.querySelector<HTMLAnchorElement>(`a[href^="/${kind}"]`)!;
      const username = host.querySelector<HTMLInputElement>('input[autocomplete="username"]')!;
      const [password, password2] = host.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]');
      for (const [field, value] of [[username, 'brisa'], [password, 'Bosque123'], [password2, 'Bosque123']] as const) {
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }

      link.focus();
      link.click();
      await vi.waitFor(() => {
        route.detectChanges();
        expect(location.path()).toBe(`${start}&read=${kind}`);
      });

      const dialog = host.querySelector('[role="dialog"]');
      expect(dialog?.querySelector('h2')?.textContent?.trim()).toBe(documentCopy.title);
      expect(dialog?.textContent).toContain(documentCopy.sections.at(-1)?.paragraphs.at(-1));
      if (kind === 'terms') location.back();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await vi.waitFor(() => {
        route.detectChanges();
        expect(location.path()).toBe(start);
        expect(host.querySelector('[role="dialog"]')).toBeNull();
      });
      expect(host.querySelector('input[autocomplete="username"]')).toBe(username);
      expect(username.value).toBe('brisa');
      expect(password.value).toBe('Bosque123');
      expect(password2.value).toBe('Bosque123');
      expect(document.activeElement).toBe(link);
      if (kind === 'terms') {
        location.forward();
        await vi.waitFor(() => {
          route.detectChanges();
          expect(host.querySelector('[role="dialog"]')).not.toBeNull();
        });
        expect(password.value).toBe('Bosque123');
        expect(password2.value).toBe('Bosque123');
      }
    },
  );

  it('clears signup passwords when leaving the flow and keeps the username', () => {
    const harness = accountHarness();
    harness.closure.receipt.set(null);
    const fixture = TestBed.createComponent(AccountPage);
    fixture.componentRef.setInput('intent', 'create');
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const username = host.querySelector<HTMLInputElement>('input[autocomplete="username"]')!;
    const [password, password2] = host.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]');
    for (const [field, value] of [[username, 'brisa'], [password, 'Bosque123'], [password2, 'Bosque123']] as const) {
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const choose = (copy: string) => {
      Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.trim() === copy)!.click();
      fixture.detectChanges();
    };

    host.querySelector<HTMLButtonElement>('.step-back')!.click();
    fixture.detectChanges();
    choose(ES.account.signInDoor);
    expect(host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')?.value).toBe('');
    expect(host.querySelector<HTMLInputElement>('input[autocomplete="username"]')?.value).toBe('brisa');

    host.querySelector<HTMLButtonElement>('.step-back')!.click();
    fixture.detectChanges();
    choose(ES.account.createDoor);
    expect(Array.from(host.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]'), (field) => field.value)).toEqual(['', '']);
  });

  it.each([['es', ES], ['en', EN]] as const)(
    'associates signup rules before submit and identifies the invalid username (%s)',
    async (_language, dictionary) => {
      const harness = accountHarness(dictionary);
      harness.closure.receipt.set(null);
      const fixture = TestBed.createComponent(AccountPage);
      fixture.componentRef.setInput('intent', 'create');
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      const username = host.querySelector<HTMLInputElement>('input[autocomplete="username"]')!;
      const password = host.querySelector<HTMLInputElement>('input[autocomplete="new-password"]')!;
      const description = (field: HTMLInputElement) =>
        host.querySelector('#' + field.getAttribute('aria-describedby'))?.textContent?.trim();

      expect(description(username)).toBe(dictionary.account.errors.invalidUsername);
      expect(description(password)).toBe(dictionary.account.passwordHint);
      expect(username.getAttribute('aria-invalid')).not.toBe('true');
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      fixture.detectChanges();
      expect(username.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(username);
      expect(harness.auth.signUp).not.toHaveBeenCalled();
    },
  );

  it('moves keyboard focus to the heading when starting signup', async () => {
    const harness = accountHarness();
    harness.closure.receipt.set(null);
    const fixture = TestBed.createComponent(AccountPage);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const button = Array.from(host.querySelectorAll('button')).find(
      (element) => element.textContent?.trim() === ES.account.createDoor,
    )!;
    button.focus();
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const heading = host.querySelector('h1');
    expect(heading?.textContent?.trim()).toBe(ES.account.createTitle);
    expect(document.activeElement).toBe(heading);
  });

  it('moves keyboard focus to the account main when using its skip link', () => {
    accountHarness();
    const fixture = TestBed.createComponent(AccountPage);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const skip = host.querySelector<HTMLAnchorElement>('.skip-link')!;
    skip.focus();
    skip.click();
    expect(document.activeElement).toBe(host.querySelector('main'));
  });
  it('offers a standard signup with unchecked terms and no age or guardian choice', async () => {
    TestBed.resetTestingModule();
    const harness = accountHarness();
    harness.closure.receipt.set(null);
    const fixture = TestBed.createComponent(AccountPage);
    fixture.componentRef.setInput('intent', 'create');
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect((fixture.componentInstance as any).signupDocument()).not.toBeNull());
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('input[name="signup-age"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('input[maxlength="64"]')).toBeNull();
    const choices = fixture.nativeElement.querySelectorAll('input[type="checkbox"]');
    expect(choices).toHaveLength(1);
    expect(choices[0].checked).toBe(false);
  });

  it('creates a standard account after terms acceptance without an age declaration', async () => {
    TestBed.resetTestingModule();
    const harness = accountHarness();
    harness.closure.receipt.set(null);
    const fixture = TestBed.createComponent(AccountPage);
    fixture.componentRef.setInput('intent', 'create');
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance as any;
    await vi.waitFor(() => expect(page.signupDocument()).not.toBeNull());
    page.username.set('brisa');
    page.email.set('brisa@example.invalid');
    page.password.set('Bosque123');
    page.password2.set('Bosque123');
    await page.doCreate();
    expect(harness.auth.signUp).not.toHaveBeenCalled();
    page.acceptsTerms.set(true);
    await page.doCreate();
    expect(harness.auth.signUp).toHaveBeenCalledWith({
      username: 'brisa', email: 'brisa@example.invalid', password: 'Bosque123', displayName: '',
    });
    expect(page.step()).toBe('confirmCode');
    expect(page.password()).toBe('');
    expect(page.password2()).toBe('');
    expect(harness.api.changePrivacyConsent).not.toHaveBeenCalled();
    harness.admission.set('absent');
    harness.adultDeclared.set(false);
    harness.auth.confirmCode.mockImplementation(async () => {
      harness.auth.user.set({ userId: 'brisa', username: 'brisa', displayName: null, email: 'brisa@example.invalid', accountType: 'adult' });
      harness.auth.status.set('signedIn');
      return 'done';
    });
    await page.doConfirmCode();
    fixture.detectChanges();
    expect(page.step()).toBe('profile');
    expect(harness.api.changePrivacyConsent).toHaveBeenCalledWith(expect.objectContaining({ action: 'accept_account_terms', documentFamily: 'common', acceptTerms: true }));
    expect(harness.api.changePrivacyConsent.mock.calls[0][0]).not.toHaveProperty('declareAdult');
    expect(fixture.nativeElement.querySelector('.who-role').textContent).toContain(ES.account.roleAccount);
    expect(fixture.nativeElement.querySelector('.who-role').textContent).not.toContain(ES.account.roleAdult);
    expect(harness.constructed).toEqual({ backup: 0, sync: 0, trees: 0 });
  });

  it('recovers an interrupted signup through terms-only admission on sign-in', async () => {
    TestBed.resetTestingModule();
    const harness = accountHarness();
    harness.closure.receipt.set(null);
    harness.admission.set('absent');
    harness.adultDeclared.set(false);
    harness.auth.signIn.mockImplementation(async () => {
      harness.auth.user.set({ userId: 'returning', username: 'returning', displayName: null, email: 'returning@example.invalid', accountType: 'adult' });
      harness.auth.status.set('signedIn');
      return 'done';
    });
    const fixture = TestBed.createComponent(AccountPage);
    fixture.detectChanges();
    const page = fixture.componentInstance as any;
    await page.doSignIn();
    expect(page.step()).toBe('admission');
    expect(harness.api.changePrivacyConsent).not.toHaveBeenCalled();
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.account-terms-form')).not.toBeNull();
    });
    expect(fixture.nativeElement.querySelector('input[name="privacy-age"]')).toBeNull();
  });
  it('preserves profile access after an existing private account explicitly completed historical adult review', async () => {
    TestBed.resetTestingModule();
    const harness = accountHarness();
    harness.closure.receipt.set(null);
    harness.admission.set('absent');
    harness.privateOnly.set(true);
    harness.adultDeclared.set(true);
    harness.auth.signIn.mockImplementation(async () => {
      harness.auth.user.set({ userId: 'legacy', username: 'legacy', displayName: null, email: 'legacy@example.invalid', accountType: 'adult' });
      harness.auth.status.set('signedIn');
      return 'done';
    });
    const fixture = TestBed.createComponent(AccountPage);
    fixture.detectChanges();
    await (fixture.componentInstance as any).doSignIn();
    expect((fixture.componentInstance as any).step()).toBe('profile');
    expect(harness.api.changePrivacyConsent).not.toHaveBeenCalled();
  });

  it.each(['create', 'signIn'])('allows returning to the welcome screen after a direct %s entry', async (intent) => {
    TestBed.resetTestingModule();
    const harness = accountHarness();
    harness.closure.receipt.set(null);
    const fixture = TestBed.createComponent(AccountPage);
    fixture.componentRef.setInput('intent', intent);
    fixture.detectChanges();
    await fixture.whenStable();
    expect((fixture.componentInstance as any).step()).toBe(intent);
    (fixture.componentInstance as any).go('welcome');
    fixture.detectChanges();
    await fixture.whenStable();
    expect((fixture.componentInstance as any).step()).toBe('welcome');
    TestBed.resetTestingModule();
  });
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
    await TestBed.inject(PrivacyService).refresh('es');
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

describe('account individual subscription entry', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it.each([
    ['adult', true, true],
    ['adolescent_private', false, false],
    ['adult', false, true],
  ] as const)(
    'uses canonical %s privacy when auth still has the initial adult claim',
    async (scope, declared, visible) => {
      const h = accountHarness();
      h.closure.receipt.set(null);
      h.privacyScope.set(scope);
      h.adultDeclared.set(declared);
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
      await TestBed.inject(PrivacyService).refresh('es');
      await fixture.whenStable();
      fixture.detectChanges();

      expect(Boolean(fixture.nativeElement.querySelector('.billing-account-link'))).toBe(visible);
    },
  );
});
