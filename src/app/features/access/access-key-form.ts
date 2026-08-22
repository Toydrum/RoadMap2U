import {
  Component,
  DestroyRef,
  ElementRef,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { AccessService } from '../../core/access/access.service';
import { ApiError, type ApiErrorCode } from '../../core/api/contracts';
import { I18nService } from '../../core/i18n/i18n.service';
import { inputValue } from '../../shared/ui/dom';

@Component({
  selector: 'app-access-key-form',
  templateUrl: './access-key-form.html',
  styleUrl: './access-key-form.scss',
})
export class AccessKeyForm {
  protected readonly i18n = inject(I18nService);
  protected readonly inputValue = inputValue;
  private readonly access = inject(AccessService);

  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly errorText = signal('');
  protected readonly notice = signal('');
  private readonly codeInput = viewChild<ElementRef<HTMLInputElement>>('codeInput');
  readonly redeemed = output<void>();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearCode());
  }

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    const code = this.code().trim();
    this.clearCode();
    this.notice.set('');
    this.errorText.set('');
    if (!code || code.length > 256) {
      this.errorText.set(this.i18n.t().access.key.errors.invalid);
      return;
    }

    this.busy.set(true);
    try {
      await this.access.redeem(code);
      this.notice.set(this.i18n.t().access.key.success);
      this.redeemed.emit();
    } catch (error) {
      const errorCode: ApiErrorCode = error instanceof ApiError ? error.code : 'unknown';
      const copy = this.i18n.t().access.key.errors;
      switch (errorCode) {
        case 'ACCESS_CODE_INVALID':
          this.errorText.set(copy.invalid);
          break;
        case 'ACCESS_CODE_RATE_LIMITED':
        case 'RATE_LIMITED':
          this.errorText.set(copy.rateLimited);
          break;
        case 'ACCESS_CODE_ALREADY_REDEEMED':
          this.errorText.set(copy.alreadyRedeemed);
          break;
        case 'COMMERCIAL_CONFIGURATION_UNAVAILABLE':
          this.errorText.set(copy.unavailable);
          break;
        case 'UNAUTHENTICATED':
          this.errorText.set(copy.unauthenticated);
          break;
        case 'offline':
          this.errorText.set(copy.offline);
          break;
        default:
          this.errorText.set(copy.unknown);
      }
    } finally {
      this.clearCode();
      this.busy.set(false);
    }
  }

  private clearCode(): void {
    this.code.set('');
    const input = this.codeInput();
    if (input) input.nativeElement.value = '';
  }
}
