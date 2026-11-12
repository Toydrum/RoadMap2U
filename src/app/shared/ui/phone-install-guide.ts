import { Component, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { PwaInstallService } from '../../core/pwa-install.service';

@Component({
  selector: 'app-phone-install-guide',
  template: `
    @if (!install.installed()) {
      @let copy = i18n.t().settings.installGuide;
      <details class="install-guide">
        <summary>{{ copy.title }}</summary>
        <div class="install-steps">
          @if (install.canPrompt()) {
            <button type="button" class="btn btn-soft" (click)="install.install()">
              {{ copy.action }}
            </button>
          }
          @for (phone of [copy.iphone, copy.android]; track phone.title) {
            <h3>{{ phone.title }}</h3>
            <ol>
              @for (step of phone.steps; track step) {
                <li>{{ step }}</li>
              }
            </ol>
          }
          <p>{{ copy.openFromIcon }}</p>
          @if (!install.canPrompt()) {
            <p class="desktop-install-hint">{{ copy.desktopHint }}</p>
          }
        </div>
      </details>
    }
  `,
  styles: `
    .install-guide {
      max-inline-size: 36rem;
    }

    summary {
      inline-size: fit-content;
      min-block-size: 44px;
      padding: 0.65rem 0.8rem;
      border-radius: var(--radius);
      background: var(--surface-2);
      color: var(--text);
      font-weight: 700;
      cursor: pointer;
    }

    .install-steps {
      margin-block-start: 0.4rem;
      padding: 0.85rem 1rem;
      border-radius: var(--radius);
      background: var(--surface);
      color: var(--text);
    }

    h3 {
      margin: 0.75rem 0 0.25rem;
      font-size: 1rem;
    }

    h3:first-child,
    ol {
      margin-block-start: 0;
    }

    ol {
      padding-inline-start: 1.35em;
    }

    li + li {
      margin-block-start: 0.35em;
    }

    p {
      margin-block-end: 0;
    }

    @media (pointer: coarse) {
      .desktop-install-hint {
        display: none;
      }
    }
  `,
})
export class PhoneInstallGuide {
  protected readonly i18n = inject(I18nService);
  protected readonly install = inject(PwaInstallService);
}
