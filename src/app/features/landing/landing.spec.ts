import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { EN } from '../../core/i18n/en';
import { ES } from '../../core/i18n/es';
import { LandingPage } from './landing';
import { marketingTreeModel } from './marketing-tree';

describe('commercial landing foundation', () => {
  it('keeps the approved hero and prepayment offer exact in both languages', () => {
    expect(ES.landing.hero.eyebrow).toBe('Un mapa vivo para tus planes');
    expect(ES.landing.hero.title).toBe('Haz visible el camino. Hazlo crecer.');
    expect(ES.landing.hero.body).toBe(
      'Convierte lo que quieres construir en árboles, ramas y siguientes pasos que realmente puedas recorrer.',
    );
    expect(ES.landing.hero.primary).toBe('Crear mi bosque gratis');
    expect(ES.landing.hero.secondary).toBe('Ver cómo funciona');
    expect(ES.landing.hero.microcopy).toBe(
      'Sin tarjeta · empieza con 2 árboles y 10 ramas por árbol',
    );
    expect(ES.landing.plans.premium.monthly).toBe('$99 MXN al mes');
    expect(ES.landing.plans.premium.yearly).toBe('$949 MXN al año · ahorra $239 · IVA incluido');
    expect(ES.landing.plans.premium.badge).toBe('Próximamente');

    expect(EN.landing.hero.eyebrow).toBe('A living map for your plans');
    expect(EN.landing.hero.title).toBe('See the path. Help it grow.');
    expect(EN.landing.hero.body).toBe(
      'Turn what you want to build into trees, branches, and next steps you can actually follow.',
    );
    expect(EN.landing.hero.primary).toBe('Create my forest for free');
    expect(EN.landing.hero.secondary).toBe('See how it works');
    expect(EN.landing.hero.microcopy).toBe(
      'No card required · start with 2 trees and 10 branches per tree',
    );
    expect(EN.landing.plans.premium.badge).toBe('Coming soon');
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
    await TestBed.configureTestingModule({ imports: [LandingPage] }).compileComponents();
    const fixture = TestBed.createComponent(LandingPage);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('main')).not.toBeNull();
    expect(root.querySelector('h1')?.textContent?.trim()).toBe(ES.landing.hero.title);
    expect(root.querySelectorAll('section').length).toBeGreaterThanOrEqual(7);
    expect(root.querySelector('#how-it-works')).not.toBeNull();
    expect(root.querySelector('#plans')).not.toBeNull();
    expect(root.querySelector('#faq')).not.toBeNull();

    (root.querySelector('[data-lang="en"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('h1')?.textContent?.trim()).toBe(EN.landing.hero.title);
    expect(document.documentElement.lang).toBe('en');
  });
});
