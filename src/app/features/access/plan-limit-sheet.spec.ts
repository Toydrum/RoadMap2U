import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nService } from '../../core/i18n/i18n.service';
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
  },
};

async function render(reason: 'ACTIVE_TREE_LIMIT' | 'VISIBLE_BRANCH_LIMIT') {
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
});
