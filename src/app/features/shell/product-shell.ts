import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { map } from 'rxjs';
import { FocusSessionService } from '../../core/focus-session.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { PerchAnchorService } from '../../core/perch-anchor.service';
import { PlacementPicker } from '../cosecha/placement-picker';
import { PromiseService } from '../cosecha/promise.service';
import { BloomBurstHost } from '../../shared/ui/bloom-burst';
import { HarvestSkyHost } from '../../shared/ui/harvest-sky';
import { PerchBody } from '../../shared/ui/perch-body';
import { ToastService } from '../../shared/ui/toast.service';

/** Chrome for the local-first product. Public routes never construct it. */
@Component({
  selector: 'app-product-shell',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    PerchBody,
    BloomBurstHost,
    HarvestSkyHost,
    PlacementPicker,
  ],
  templateUrl: './product-shell.html',
  styleUrl: './product-shell.scss',
})
export class ProductShell {
  protected readonly i18n = inject(I18nService);
  protected readonly toast = inject(ToastService);
  protected readonly focus = inject(FocusSessionService);
  protected readonly promise = inject(PromiseService);
  private readonly router = inject(Router);
  private readonly anchor = inject(PerchAnchorService);

  private readonly url = toSignal(this.router.events.pipe(map(() => this.router.url)), {
    initialValue: this.router.url,
  });

  /** The check-in ritual owns the full viewport and hides product navigation. */
  protected readonly showTabs = computed(() => !this.url().startsWith('/check-in'));

  /** The traveling perch yields to pages that already hold the companion. */
  protected readonly showPerch = computed(() => {
    if (!this.focus.active() || !this.showTabs() || this.anchor.claimed()) return false;
    const url = this.url();
    return !url.startsWith('/timer') && !url.startsWith('/ahora');
  });
}
