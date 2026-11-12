import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot, convertToParamMap } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { AuthInitializer, authReadyGate } from './auth-initializer';

describe('public account route language', () => {
  it.each([
    { requested: 'en', saved: 'es', signedIn: false, expected: 'en' },
    { requested: 'es', saved: 'en', signedIn: false, expected: 'es' },
    { requested: 'en', saved: 'es', signedIn: true, expected: 'es' },
    { requested: 'invalid', saved: 'en', signedIn: false, expected: 'en' },
  ] as const)(
    'uses $expected for a $saved preference, $requested request and signedIn=$signedIn',
    async ({ requested, saved, signedIn, expected }) => {
      const status = signal<'guest' | 'signedIn'>('guest');
      const lang = signal<'es' | 'en'>(saved);
      const init = vi.fn(async () => {
        status.set(signedIn ? 'signedIn' : 'guest');
      });
      const set = vi.fn(async (requestedLanguage: 'es' | 'en') => lang.set(requestedLanguage));
      TestBed.configureTestingModule({
        providers: [
          { provide: AuthInitializer, useValue: { init } },
          { provide: AuthService, useValue: { status } },
          { provide: I18nService, useValue: { lang, set } },
        ],
      });
      const route = { queryParamMap: convertToParamMap({ lang: requested }) } as ActivatedRouteSnapshot;
      const state = {} as RouterStateSnapshot;
      const result = await TestBed.runInInjectionContext(() => authReadyGate(route, state));

      expect(result).toBe(true);
      expect(lang()).toBe(expected);
      expect(document.documentElement.lang).toBe(expected);
      if (expected === saved) expect(set).not.toHaveBeenCalled();
      else expect(set).toHaveBeenCalledWith(expected);
    },
  );
});
