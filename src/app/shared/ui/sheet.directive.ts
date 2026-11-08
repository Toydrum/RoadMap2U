import {
  Directive,
  ElementRef,
  OnDestroy,
  OnInit,
  afterNextRender,
  booleanAttribute,
  inject,
  input,
  output,
} from '@angular/core';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const SWIPE_EXCLUDED = 'a, button, input, textarea, select, label, summary, [contenteditable], [role="button"]';
const SWIPE_DISTANCE = 72;
const SWIPE_SLOP = 10;
const SWIPE_DIRECTION_RATIO = 1.5;

/**
 * Shared modal behavior for every hand-rolled sheet: initial focus,
 * Escape-to-close (topmost sheet only), a minimal Tab trap, and focus
 * restoration to the opener. Purely behavioral — each sheet keeps its
 * own markup and styles.
 */
@Directive({
  selector: '[appSheet]',
  host: {
    '(document:keydown.escape)': 'onEscape($event)',
    '(keydown)': 'onTab($event)',
  },
})
export class SheetDirective implements OnInit, OnDestroy {
  readonly appSheetSwipeToClose = input(false, { transform: booleanAttribute });
  readonly sheetClose = output<void>();

  /** Stacked sheets (node sheet → branch flow): only the top one obeys Escape. */
  private static stack: SheetDirective[] = [];

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private prevFocus: Element | null = null;
  private swipeListeners?: AbortController;
  private swipe: { identifier: number; x: number; y: number; scrollArea: HTMLElement } | null = null;

  constructor() {
    afterNextRender(() => {
      this.captureOpener();
      const host = this.el.nativeElement;
      if (!host.hasAttribute('tabindex')) host.setAttribute('tabindex', '-1');
      (host.querySelector<HTMLElement>('[autofocus]') ?? host).focus();
    });
  }

  /** Remember whoever REALLY had focus (never body) — keyboard openers
   *  capture at init; late programmatic focus is caught post-render. */
  private captureOpener(): void {
    const active = document.activeElement;
    if (active && active !== document.body) this.prevFocus = active;
  }

  ngOnInit(): void {
    this.captureOpener();
    SheetDirective.stack.at(-1)?.cancelSwipe();
    SheetDirective.stack.push(this);
    // Lock the page behind the first open sheet: wheel/touch past the sheet's
    // end must not scroll the background (the user would land far from where
    // they were on close). The sheet's own overflow keeps scrolling fine.
    if (SheetDirective.stack.length === 1) document.body.style.overflow = 'hidden';
    if (this.appSheetSwipeToClose()) {
      this.swipeListeners = new AbortController();
      const options = { capture: true, passive: true, signal: this.swipeListeners.signal };
      document.addEventListener('touchstart', this.startSwipe, options);
      document.addEventListener('touchmove', this.moveSwipe, options);
      document.addEventListener('touchend', this.endSwipe, options);
      document.addEventListener('touchcancel', this.cancelSwipe, options);
    }
  }

  private readonly startSwipe = (event: TouchEvent): void => {
    this.cancelSwipe();
    const host = this.el.nativeElement;
    const target = event.target;
    if (
      SheetDirective.stack.at(-1) !== this ||
      event.touches.length !== 1 ||
      !(target instanceof Element) ||
      !host.contains(target) ||
      target.closest(SWIPE_EXCLUDED)
    ) {
      return;
    }

    const scrollArea = host.querySelector<HTMLElement>('[data-sheet-scroll]') ?? host;
    if (scrollArea.scrollTop > 0) return;
    const touch = event.touches[0];
    this.swipe = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY, scrollArea };
  };

  private readonly moveSwipe = (event: TouchEvent): void => {
    const swipe = this.swipe;
    if (!swipe) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch.identifier !== swipe.identifier) {
      this.cancelSwipe();
      return;
    }

    const dx = Math.abs(touch.clientX - swipe.x);
    const dy = touch.clientY - swipe.y;
    // Native scrolling keeps the gesture once it moves into the content.
    if (swipe.scrollArea.scrollTop > 0 || dy < -SWIPE_SLOP || (dx > SWIPE_SLOP && dx > Math.abs(dy))) {
      this.cancelSwipe();
    }
  };

  private readonly endSwipe = (event: TouchEvent): void => {
    const swipe = this.swipe;
    this.cancelSwipe();
    if (!swipe || SheetDirective.stack.at(-1) !== this || event.touches.length || swipe.scrollArea.scrollTop > 0) {
      return;
    }
    const touch = event.changedTouches[0];
    if (touch?.identifier !== swipe.identifier) return;

    const dx = Math.abs(touch.clientX - swipe.x);
    const dy = touch.clientY - swipe.y;
    if (dy >= SWIPE_DISTANCE && dy >= dx * SWIPE_DIRECTION_RATIO) this.sheetClose.emit();
  };

  private readonly cancelSwipe = (): void => {
    this.swipe = null;
  };

  protected onEscape(ev: Event): void {
    if (SheetDirective.stack.at(-1) !== this) return;
    ev.preventDefault();
    this.sheetClose.emit();
  }

  protected onTab(ev: KeyboardEvent): void {
    if (ev.key !== 'Tab') return;
    const items = [...this.el.nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) {
      ev.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey && (active === first || active === this.el.nativeElement)) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  ngOnDestroy(): void {
    this.swipeListeners?.abort();
    SheetDirective.stack = SheetDirective.stack.filter((s) => s !== this);
    if (!SheetDirective.stack.length) document.body.style.overflow = '';
    // Element, not HTMLElement: tree nodes are focusable SVG <g> elements.
    if (this.prevFocus instanceof Element && this.prevFocus.isConnected) {
      (this.prevFocus as HTMLElement).focus?.();
    }
  }
}
