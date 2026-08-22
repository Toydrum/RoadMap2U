import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessService } from '../../core/access/access.service';
import { ApiError, createFreeAccessSummary } from '../../core/api/contracts';
import { I18nService } from '../../core/i18n/i18n.service';
import { AccessKeyForm } from './access-key-form';

const copy = {
  access: {
    key: {
      title: 'Canjear una llave',
      body: 'La llave se vincula a esta cuenta.',
      label: 'Llave de acceso',
      placeholder: 'RM2U1.…',
      submit: 'Activar Premium',
      busy: 'Revisando…',
      success: 'Premium ya está activo en tu cuenta 🌿',
      errors: {
        invalid: 'Esta llave no es válida o ya venció.',
        rateLimited: 'Hiciste varios intentos. Intenta más tarde.',
        alreadyRedeemed: 'Esta llave ya fue canjeada.',
        unavailable: 'El canje está en pausa por ahora.',
        unauthenticated: 'Vuelve a entrar antes de canjearla.',
        offline: 'Necesitas conexión para canjear la llave.',
        unknown: 'No pudimos revisar la llave. Intenta de nuevo.',
      },
    },
  },
};

function harness(redeem = vi.fn(async () => createFreeAccessSummary())) {
  TestBed.configureTestingModule({
    imports: [AccessKeyForm],
    providers: [
      { provide: AccessService, useValue: { redeem } },
      {
        provide: I18nService,
        useValue: { t: signal(copy) },
      },
    ],
  });
  const fixture = TestBed.createComponent(AccessKeyForm);
  fixture.detectChanges();
  return { fixture, redeem };
}

describe('AccessKeyForm', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('submits a trimmed key once, never persists it and clears it after success', async () => {
    let release!: () => void;
    const redeem = vi.fn(
      () =>
        new Promise<ReturnType<typeof createFreeAccessSummary>>((resolve) => {
          release = () => resolve(createFreeAccessSummary());
        }),
    );
    const local = vi.spyOn(Storage.prototype, 'setItem');
    const { fixture } = harness(redeem);
    const emitted = vi.fn();
    fixture.componentInstance.redeemed.subscribe(emitted);
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    input.value = '  RM2U1.issue.secret  ';
    input.dispatchEvent(new Event('input'));

    form.dispatchEvent(new Event('submit'));
    form.dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(redeem).toHaveBeenCalledOnce();
    expect(redeem).toHaveBeenCalledWith('RM2U1.issue.secret');
    expect((fixture.nativeElement.querySelector('button') as HTMLButtonElement).disabled).toBe(
      true,
    );
    release();
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement.querySelector('input') as HTMLInputElement).value).toBe('');
    expect(fixture.nativeElement.textContent as string).toContain(copy.access.key.success);
    expect(emitted).toHaveBeenCalledOnce();
    expect(local).not.toHaveBeenCalled();
  });

  it.each([
    ['ACCESS_CODE_INVALID', copy.access.key.errors.invalid],
    ['ACCESS_CODE_RATE_LIMITED', copy.access.key.errors.rateLimited],
    ['ACCESS_CODE_ALREADY_REDEEMED', copy.access.key.errors.alreadyRedeemed],
    ['COMMERCIAL_CONFIGURATION_UNAVAILABLE', copy.access.key.errors.unavailable],
    ['UNAUTHENTICATED', copy.access.key.errors.unauthenticated],
    ['offline', copy.access.key.errors.offline],
  ] as const)('maps %s to calm copy and clears the rejected key', async (code, message) => {
    const { fixture } = harness(
      vi.fn(async () => {
        throw new ApiError(code);
      }),
    );
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = 'RM2U1.rejected.secret';
    input.dispatchEvent(new Event('input'));
    (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit'),
    );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent as string).toContain(message);
    expect((fixture.nativeElement.querySelector('input') as HTMLInputElement).value).toBe('');
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
  });
});
