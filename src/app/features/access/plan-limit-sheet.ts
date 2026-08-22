import { Component, inject, input, output, signal } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { SheetDirective } from '../../shared/ui/sheet.directive';
import { AccessKeyForm } from './access-key-form';

export type PlanLimitReason = 'ACTIVE_TREE_LIMIT' | 'VISIBLE_BRANCH_LIMIT';

@Component({
  selector: 'app-plan-limit-sheet',
  imports: [SheetDirective, AccessKeyForm],
  templateUrl: './plan-limit-sheet.html',
  styleUrl: './plan-limit-sheet.scss',
})
export class PlanLimitSheet {
  protected readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthService);
  protected readonly showRedeem = signal(false);
  readonly reason = input.required<PlanLimitReason>();
  readonly current = input.required<number>();
  readonly limit = input.required<number>();
  readonly closed = output<void>();
  readonly redeemRequested = output<void>();

  protected requestRedeem(): void {
    if (this.auth.status() === 'signedIn' && this.auth.user()?.accountType === 'adult') {
      this.showRedeem.set(true);
      return;
    }
    this.redeemRequested.emit();
  }
}
