import { Component, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { SheetDirective } from '../../shared/ui/sheet.directive';
import { PromiseJar } from '../forest/promise-jar';
import { PromiseService } from './promise.service';

/**
 * «¿En cuál frasco?» (0.0.93) — the cross-page placement picker, mounted in App
 * so the bloom toast can offer it from any route. It shows only when >1 goal
 * jar can take the fruit (the toast places directly into the one jar otherwise). DOORS
 * CANCEL: backdrop/Escape just clears the request — the fruit stays fresh.
 * Self-styled (shared-overlay law: bring your own backdrop).
 */
@Component({
  selector: 'app-placement-picker',
  imports: [SheetDirective, PromiseJar],
  template: `
    @if (promise.placementRequest()) {
      <div class="sheet-backdrop" (click)="promise.clearPlacement()">
        <div
          class="sheet card picker"
          appSheet
          (sheetClose)="promise.clearPlacement()"
          (click)="$event.stopPropagation()"
          role="dialog"
          aria-modal="true"
          [attr.aria-label]="i18n.t().cosecha.promise.pickerTitle"
        >
          <h2>{{ i18n.t().cosecha.promise.pickerTitle }}</h2>
          <ul class="jar-list">
            @for (jar of promise.acceptingFruit(); track jar.id) {
              <li>
                <button type="button" class="jar-pick" (click)="pick(jar.id)">
                  <app-promise-jar [fruits]="promise.membersOf(jar.id)" [vessel]="jar.size ?? 'frasco'" [size]="0.7" />
                  <span class="jar-pick-name">{{ jar.name }}</span>
                </button>
              </li>
            }
          </ul>
          <div class="row-actions">
            <button type="button" class="btn btn-ghost" (click)="promise.clearPlacement()">
              {{ i18n.t().common.cancel }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    .sheet-backdrop {
      position: fixed;
      inset: 0;
      z-index: 620;
      background: rgba(20, 26, 18, 0.45);
      display: flex;
      align-items: flex-end;
      justify-content: center;
    }

    .sheet {
      width: min(520px, 100%);
      max-height: 82vh;
      overflow-y: auto;
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
      padding: 1.4rem 1.4rem calc(1.4rem + env(safe-area-inset-bottom));
      animation: sheet-up 0.28s ease both;
    }

    @keyframes sheet-up {
      from {
        transform: translateY(40px);
        opacity: 0;
      }
    }

    h2 {
      margin-bottom: 0.9rem;
    }

    .jar-list {
      list-style: none;
      margin: 0 0 1rem;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      gap: 0.6rem;
    }

    .jar-pick {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.35rem;
      width: 100%;
      padding: 0.6rem;
      border: 1.5px solid color-mix(in srgb, var(--text) 16%, transparent);
      border-radius: 14px;
      background: var(--surface);
      font: inherit;
      color: inherit;
      cursor: pointer;
    }

    .jar-pick:hover,
    .jar-pick:focus-visible {
      border-color: var(--primary);
      background: color-mix(in srgb, var(--primary) 8%, var(--surface));
    }

    .jar-pick-name {
      font-size: 0.82rem;
      font-weight: 700;
      text-align: center;
      overflow-wrap: anywhere;
    }

    .row-actions {
      display: flex;
      justify-content: flex-end;
    }

    :host-context(.reduce-motion) .sheet {
      animation: none;
    }
  `,
})
export class PlacementPicker {
  protected readonly i18n = inject(I18nService);
  protected readonly promise = inject(PromiseService);

  protected async pick(jarId: string): Promise<void> {
    const fruit = this.promise.placementRequest();
    if (!fruit) return;
    if (await this.promise.placeAndCelebrate(fruit.id, jarId)) this.promise.clearPlacement();
  }
}
