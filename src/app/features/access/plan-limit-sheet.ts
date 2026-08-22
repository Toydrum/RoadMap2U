import { Component, inject, input, output } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { SheetDirective } from '../../shared/ui/sheet.directive';

export type PlanLimitReason = 'ACTIVE_TREE_LIMIT' | 'VISIBLE_BRANCH_LIMIT';

@Component({
  selector: 'app-plan-limit-sheet',
  imports: [SheetDirective],
  templateUrl: './plan-limit-sheet.html',
  styleUrl: './plan-limit-sheet.scss',
})
export class PlanLimitSheet {
  protected readonly i18n = inject(I18nService);
  readonly reason = input.required<PlanLimitReason>();
  readonly current = input.required<number>();
  readonly limit = input.required<number>();
  readonly closed = output<void>();
  readonly redeemRequested = output<void>();
}
