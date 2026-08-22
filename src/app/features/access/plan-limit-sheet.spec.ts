import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nService } from '../../core/i18n/i18n.service';
import { AccessService } from '../../core/access/access.service';
import { AuthService } from '../../core/auth/auth.service';
import { PlanLimitSheet } from './plan-limit-sheet';

const copy = {
  access: {
    planLimit: {
      title: 'Llegaste al límite de tu plan Free',
      activeTrees: 'Tu bosque puede tener hasta {limit} árboles activos en Free.',
      visibleBranches: 'Tu árbol puede tener hasta {limit} ramas visibles en Free.',
      usage: '{current}/{limit}',
      plansCta: 'Ver planes',
      redeemCta: 'Canjear una llave',
      stayCta: 'Seguir con Free',
    },
    key: {
      title: 'Canjear una llave',
      body: 'La llave se vincula a esta cuenta.',
      label: 'Llave de acceso',
      placeholder: 'RM2U1.…',
      submit: 'Activar Premium',
      busy: 'Revisando…',
      success: 'Premium activo',
      errors: {
        invalid: 'Inválida',
        rateLimited: 'Espera',
        alreadyRedeemed: 'Ya usada',
        unavailable: 'En pausa',
        unauthenticated: 'Entra otra vez',
        offline: 'Sin conexión',
        unknown: 'Intenta otra vez',
      },
    },
  },
};

async function render(reason: 'ACTIVE_TREE_LIMIT' | 'VISIBLE_BRANCH_LIMIT', signedIn = false) {
  TestBed.configureTestingModule({
    imports: [PlanLimitSheet],
    providers: [
      {
        provide: I18nService,
        useValue: {
          t: signal(copy),
          fill: (template: string, values: Record<string, string | number>) =>
            template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? '')),
        },
      },
      {
        provide: AuthService,
        useValue: {
          status: signal(signedIn ? 'signedIn' : 'guest'),
          user: signal(signedIn ? { userId: 'owner-a', accountType: 'adult' } : null),
        },
      },
      { provide: AccessService, useValue: { redeem: vi.fn() } },
    ],
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(PlanLimitSheet);
  fixture.componentRef.setInput('reason', reason);
  fixture.componentRef.setInput('current', reason === 'ACTIVE_TREE_LIMIT' ? 2 : 10);
  fixture.componentRef.setInput('limit', reason === 'ACTIVE_TREE_LIMIT' ? 2 : 10);
  fixture.detectChanges();
  return fixture;
}

describe('PlanLimitSheet', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('explains a branch limit and exposes plans, redeem and stay actions', async () => {
    const fixture = await render('VISIBLE_BRANCH_LIMIT');
    const closed = vi.fn();
    const redeemRequested = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.componentInstance.redeemRequested.subscribe(redeemRequested);
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(root.querySelector('[autofocus]')).toBeNull();
    expect(root.querySelector('h2')?.textContent).toContain('límite de tu plan Free');
    expect(root.querySelector('[data-limit-copy]')?.textContent).toContain(
      'hasta 10 ramas visibles',
    );
    expect(root.querySelector('[data-limit-usage]')?.textContent).toContain('10/10');
    expect(
      root.querySelector<HTMLAnchorElement>('[data-action="plans"]')?.getAttribute('href'),
    ).toBe('/#plans');

    root.querySelector<HTMLButtonElement>('[data-action="redeem"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-action="stay"]')?.click();

    expect(redeemRequested).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('opens the key form in place for an authenticated adult', async () => {
    const fixture = await render('ACTIVE_TREE_LIMIT', true);
    const redeemRequested = vi.fn();
    fixture.componentInstance.redeemRequested.subscribe(redeemRequested);

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-action="redeem"]')
      ?.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-access-key-form')).not.toBeNull();
    expect(redeemRequested).not.toHaveBeenCalled();
  });
});
