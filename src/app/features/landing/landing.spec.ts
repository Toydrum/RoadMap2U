import { APP_BASE_HREF } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_INDIVIDUAL_CATALOG } from '../../core/api/public-individual-catalog';
import { CLOSED_INDIVIDUAL_BILLING_CATALOG } from '../../core/api/contracts';
import { AuthService } from '../../core/auth/auth.service';
import { BootService } from '../../core/boot.service';
import { EN } from '../../core/i18n/en';
import { ES } from '../../core/i18n/es';
import { RemindersService } from '../../core/reminders.service';
import { SyncService } from '../../core/sync/sync.service';
import { LandingPage } from './landing';
import { marketingTreeModel } from './marketing-tree';

describe('commercial landing foundation', () => {
  it('shows the actual individual catalog availability and opens the subscription account door', async () => {
    await TestBed.configureTestingModule({
      imports: [LandingPage],
      providers: [
        provideRouter([]),
        {
          provide: PUBLIC_INDIVIDUAL_CATALOG,
          useValue: async () => ({ ...CLOSED_INDIVIDUAL_BILLING_CATALOG, purchasesEnabled: true }),
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LandingPage);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('.individual-offer-status')?.textContent ?? '').toContain(
        ES.billing.available,
      );
    });
    expect(root.querySelector('.premium-plan a')?.getAttribute('href')).toBe(
      '/account/subscription',
    );
    expect(root.querySelector('.premium-prices')?.textContent).toContain('$114.84 MXN');
    expect(root.querySelector('.premium-prices')?.textContent).toContain('$1,100.84 MXN');
    expect(root.querySelector('.premium-plan')?.textContent).toContain(ES.billing.recurring);
  });
  it('keeps the individual offer closed when the public catalog is unavailable', async () => {
    await TestBed.configureTestingModule({
      imports: [LandingPage],
      providers: [
        provideRouter([]),
        {
          provide: PUBLIC_INDIVIDUAL_CATALOG,
          useValue: async () => {
            throw new Error('offline');
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LandingPage);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('.individual-offer-status')
          ?.textContent ?? '',
      ).toContain(ES.billing.catalogUnavailable);
    });
  });
  it('explains the visual goals and tasks app in both languages without a stale availability promise', () => {
    expect(ES.landing.hero.title).toMatch(/metas.*tareas/i);
    expect(ES.landing.hero.body).toMatch(/árboles visuales/i);
    expect(ES.landing.hero.primary).toBe('Crear mi bosque gratis');
    expect(ES.landing.hero.secondary).toBe('Ver cómo funciona');
    expect(ES.landing.hero.microcopy).toBe(
      'Sin tarjeta · empieza con 2 árboles y 10 ramas por árbol',
    );
    expect(ES.landing.plans.premium.monthly).toBe('$114.84 MXN al mes');
    expect(ES.landing.plans.premium.yearly).toBe('$1,100.84 MXN al año · ahorra $277.24 · IVA incluido');
    expect(JSON.stringify(ES.landing)).not.toMatch(/familia|hogares|menores|próximamente|propuesta de lanzamiento/i);
    expect(EN.landing.hero.title).toMatch(/goals.*tasks/i);
    expect(EN.landing.hero.body).toMatch(/visual trees/i);
    expect(EN.landing.hero.primary).toBe('Create my forest for free');
    expect(EN.landing.hero.secondary).toBe('See how it works');
    expect(EN.landing.hero.microcopy).toBe(
      'No card required · start with 2 trees and 10 branches per tree',
    );
    expect(JSON.stringify(EN.landing)).not.toMatch(/famil(?:y|ies)|households|minors|coming soon|proposed launch/i);
  });

  it('preserves section destinations, legal language and useful page metadata without opening sales', async () => {
    await TestBed.configureTestingModule({
      imports: [LandingPage],
      providers: [provideRouter([]), { provide: PUBLIC_INDIVIDUAL_CATALOG, useValue: async () => structuredClone(CLOSED_INDIVIDUAL_BILLING_CATALOG) }],
    }).compileComponents();
    const fixture = TestBed.createComponent(LandingPage);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('.individual-offer-status')?.textContent).toContain(ES.billing.purchasesClosed);
    });
    const how = root.querySelector('.hero-actions .text-link') as HTMLAnchorElement;
    expect(new URL(how.href).hash).toBe('#how-it-works');
    expect(root.querySelector(new URL(how.href).hash)).not.toBeNull();
    expect(root.querySelector('.key-section')).toBeNull();
    expect(document.title).toMatch(/metas.*tareas/i);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toMatch(/árboles visuales/i);
    (root.querySelector('[data-lang="en"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(document.title).toMatch(/goals.*tasks/i);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toMatch(/visual trees/i);
    for (const route of ['privacy', 'terms', 'subscription-terms', 'support']) {
      expect(root.querySelector(`.site-footer a[href="/${route}?lang=en"]`)).not.toBeNull();
    }
    expect(root.querySelector('.premium-plan a')?.getAttribute('href')).toBe('/account/subscription');
  });

  it('builds the product tree deterministically with the real pure tree brain', () => {
    const first = marketingTreeModel();
    const second = marketingTreeModel();
    expect(first).toEqual(second);
    expect(first.limbs.length).toBeGreaterThanOrEqual(8);
    expect(first.pads.length).toBeGreaterThanOrEqual(3);
    expect(first.flower.shape).toBeTruthy();
  });

  it('renders a standalone semantic landing and changes locale only in memory', async () => {
    await TestBed.configureTestingModule({
      imports: [LandingPage],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(LandingPage);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('main')).not.toBeNull();
    expect(root.querySelector('h1')?.textContent?.trim()).toBe(ES.landing.hero.title);
    expect(root.querySelectorAll('section').length).toBeGreaterThanOrEqual(6);
    expect(root.querySelector('#how-it-works')).not.toBeNull();
    expect(root.querySelector('#plans')).not.toBeNull();
    expect(root.querySelector('#faq')).not.toBeNull();

    (root.querySelector('[data-lang="en"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('h1')?.textContent?.trim()).toBe(EN.landing.hero.title);
    expect(document.documentElement.lang).toBe('en');
  });

  it('renders app navigation against the configured legacy base href', async () => {
    await TestBed.configureTestingModule({
      imports: [LandingPage],
      providers: [provideRouter([]), { provide: APP_BASE_HREF, useValue: '/RoadMap2U/' }],
    }).compileComponents();
    const fixture = TestBed.createComponent(LandingPage);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.brand')?.getAttribute('href')).toBe('/RoadMap2U/');
    expect(root.querySelector('.sign-in')?.getAttribute('href')).toBe('/RoadMap2U/account');
  });

  it('constructs no storage, auth, sync, or reminder service', async () => {
    const constructed: string[] = [];
    const tracked = (name: string) => () => {
      constructed.push(name);
      return {};
    };

    await TestBed.configureTestingModule({
      imports: [LandingPage],
      providers: [
        provideRouter([]),
        { provide: BootService, useFactory: tracked('boot') },
        { provide: AuthService, useFactory: tracked('auth') },
        { provide: SyncService, useFactory: tracked('sync') },
        { provide: RemindersService, useFactory: tracked('reminders') },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(LandingPage);
    fixture.detectChanges();

    expect(constructed).toEqual([]);
  });
});
