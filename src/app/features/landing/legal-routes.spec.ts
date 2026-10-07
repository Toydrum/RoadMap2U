import { APP_BASE_HREF } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { describe, expect, it } from 'vitest';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth/auth.service';
import { BootService } from '../../core/boot.service';
import { SyncService } from '../../core/sync/sync.service';

describe('public legal documents', () => {
  for (const [path, spanish, english] of [
    ['privacy', 'Privacidad', 'Privacy'],
    ['terms', 'Términos de uso', 'Terms of use'],
    ['support', 'Soporte y cuidado', 'Support and care'],
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
      expect(root.querySelectorAll('main')).toHaveLength(1);
      expect(root.querySelector('[data-review-status]')?.textContent).toContain('Borrador');
      expect(constructed).toEqual([]);
      (root.querySelector('[data-lang="en"]') as HTMLButtonElement).click();
      harness.detectChanges();
      await harness.fixture.whenStable();
      expect(root.querySelector('h1')?.textContent?.trim()).toBe(english);
      expect(document.documentElement.lang).toBe('en');
      expect(root.querySelector('a[data-home]')?.getAttribute('href')).toBe('/');
      expect(root.querySelector('.skip-link')?.getAttribute('href')).toBe('/' + path + '#legal-main');
      expect(root.querySelectorAll('a[href^="mailto:"]')).toHaveLength(0);
    });
  }
});
