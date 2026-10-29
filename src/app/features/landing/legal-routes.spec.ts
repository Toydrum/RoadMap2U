import { APP_BASE_HREF } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { describe, expect, it } from 'vitest';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth/auth.service';
import { BootService } from '../../core/boot.service';
import { SyncService } from '../../core/sync/sync.service';
import { subscriptionTermsDocument } from '../../core/api/subscription-terms-documents';

describe('public legal documents', () => {
  const subscriptionHarness = async (url: string) => {
    await TestBed.configureTestingModule({ providers: [provideRouter(routes), { provide: APP_BASE_HREF, useValue: '/' }] }).compileComponents();
    return RouterTestingHarness.create(url);
  };
  it('displays the exact retained subscription text for an allowlisted historical version', async () => {
    const version = 'individual-subscription-2026-10-28-v1';
    const harness = await subscriptionHarness('/subscription-terms?lang=en&version=' + version);
    expect(harness.routeNativeElement!.querySelector('main section p')?.textContent?.trim()).toBe(subscriptionTermsDocument('en', version).text);
    expect(harness.routeNativeElement!.querySelector('main section h2')?.textContent?.trim()).toBe(version);
  });
  it('keeps the current document as the default and reacts to a version query change', async () => {
    const harness = await subscriptionHarness('/subscription-terms?lang=en');
    expect(harness.routeNativeElement!.querySelector('main section p')?.textContent?.trim()).toBe(subscriptionTermsDocument('en').text);
    await harness.navigateByUrl('/subscription-terms?lang=en&version=not-accepted');
    expect(harness.routeNativeElement!.querySelector('main [role="alert"]')?.textContent).toContain('not available');
  });
  it('shows an explicit unavailable result for an unknown subscription version', async () => {
    const harness = await subscriptionHarness('/subscription-terms?lang=en&version=unknown-contract');
    const root = harness.routeNativeElement!;
    expect(root.querySelector('main [role="alert"]')?.textContent).toContain('not available');
    expect(root.querySelectorAll('main section')).toHaveLength(0);
    expect(root.textContent).not.toContain(subscriptionTermsDocument('en').text);
  });
  it('preserves a selected historical version and language in locale changes and subscription navigation', async () => {
    const version = 'individual-subscription-2026-10-28-v1';
    const harness = await subscriptionHarness('/subscription-terms?lang=es&version=' + version);
    (harness.routeNativeElement!.querySelector('[data-lang="en"]') as HTMLButtonElement).click();
    harness.detectChanges(); await harness.fixture.whenStable();
    const query = new URL('https://example.test' + TestBed.inject(Router).url).searchParams;
    expect(query.get('version')).toBe(version); expect(query.get('lang')).toBe('en');
    expect(harness.routeNativeElement!.querySelector('main section p')?.textContent?.trim()).toBe(subscriptionTermsDocument('en', version).text);
    const link = new URL('https://example.test' + harness.routeNativeElement!.querySelector('footer a[href^="/subscription-terms"]')!.getAttribute('href'));
    expect(link.searchParams.get('version')).toBe(version); expect(link.searchParams.get('lang')).toBe('en');
  });
  for (const [path, spanish, english] of [
    ['privacy', 'Aviso de privacidad', 'Privacy notice'],
    ['terms', 'Términos de uso', 'Terms of use'],
    ['support', 'Soporte y cuidado', 'Support and care'],
    ['subscription-terms', 'Condiciones de suscripción', 'Subscription terms'],
  ]) {
    it(`opens /${path} directly without starting the product or auth`, async () => {
      const constructed: string[] = [];
      const forbidden = (name: string) => () => {
        constructed.push(name);
        throw new Error('Public documents must not start ' + name);
      };
      await TestBed.configureTestingModule({
        providers: [
          provideRouter(routes),
          { provide: APP_BASE_HREF, useValue: '/' },
          { provide: AuthService, useFactory: forbidden('auth') },
          { provide: BootService, useFactory: forbidden('boot') },
          { provide: SyncService, useFactory: forbidden('sync') },
        ],
      }).compileComponents();
      const harness = await RouterTestingHarness.create('/' + path);
      const root = harness.routeNativeElement!;
      expect(root.querySelector('h1')?.textContent?.trim()).toBe(spanish);
      expect(root.querySelector('footer a[href^="/' + path + '?"]')?.getAttribute('aria-current')).toBe('page');
      expect(root.querySelectorAll('main')).toHaveLength(1);
      expect(root.querySelector('[data-review-status]')?.textContent).toContain('Tus decisiones sobre tus datos');
      expect(constructed).toEqual([]);
      (root.querySelector('[data-lang="en"]') as HTMLButtonElement).click();
      harness.detectChanges();
      await harness.fixture.whenStable();
      expect(root.querySelector('h1')?.textContent?.trim()).toBe(english);
      for (const legalPath of ['privacy', 'terms', 'support', 'subscription-terms']) {
        expect(root.querySelector('footer a[href^="/' + legalPath + '"]')?.getAttribute('href')).toBe('/' + legalPath + '?lang=en');
      }
      expect(document.documentElement.lang).toBe('en');
      expect(root.querySelector('a[data-home]')?.getAttribute('href')).toBe('/');
      expect(root.querySelector('.skip-link')?.getAttribute('href')).toBe('/' + path + '?lang=en#legal-main');
      expect(root.querySelectorAll('a[href^="mailto:"]')).toHaveLength(0);
    });
  }
});
