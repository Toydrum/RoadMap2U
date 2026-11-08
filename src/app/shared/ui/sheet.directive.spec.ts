import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SheetDirective } from './sheet.directive';

@Component({
  imports: [SheetDirective],
  template: `
    <button id="open">Open</button>
    @if (open()) {
      <section appSheet appSheetSwipeToClose (sheetClose)="open.set(false)">
        <div data-sheet-scroll>
          <p>Content</p>
          <input aria-label="Edit" />
        </div>
      </section>
    }
    @if (nested()) {
      <section appSheet id="nested" (sheetClose)="nested.set(false)">Confirmation</section>
    }
  `,
})
class TestSheets {
  readonly open = signal(false);
  readonly nested = signal(false);
}

function setup() {
  const fixture = TestBed.createComponent(TestSheets);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const opener = host.querySelector<HTMLElement>('#open')!;
  opener.focus();
  fixture.componentInstance.open.set(true);
  fixture.detectChanges();
  const scroller = host.querySelector<HTMLElement>('[data-sheet-scroll]')!;
  const content = scroller.querySelector('p')!;
  return { fixture, opener, scroller, content };
}

function contact(clientX: number, clientY: number, identifier = 1) {
  return { clientX, clientY, identifier };
}

function dispatchTouch(
  target: Element,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  point: ReturnType<typeof contact>,
  touches = type === 'touchend' || type === 'touchcancel' ? [] : [point],
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: [point] } });
  target.dispatchEvent(event);
  return event;
}

describe('opt-in sheet swipe', () => {
  it('closes on release after a downward swipe from the top and restores focus', () => {
    const { fixture, opener, content } = setup();
    dispatchTouch(content, 'touchstart', contact(100, 100));
    expect(dispatchTouch(content, 'touchmove', contact(103, 215)).defaultPrevented).toBe(false);
    expect(fixture.componentInstance.open()).toBe(true);

    dispatchTouch(content, 'touchend', contact(103, 215));
    fixture.detectChanges();

    expect(fixture.componentInstance.open()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('keeps a scroll gesture that reaches the top open until a new touch', () => {
    const { fixture, scroller, content } = setup();
    scroller.scrollTop = 80;
    dispatchTouch(content, 'touchstart', contact(100, 100));
    scroller.scrollTop = 0;
    dispatchTouch(content, 'touchend', contact(100, 230));
    expect(fixture.componentInstance.open()).toBe(true);
  });

  it('does not dismiss after an upward scroll reverses direction in the same touch', () => {
    const { fixture, content } = setup();
    dispatchTouch(content, 'touchstart', contact(100, 150));
    dispatchTouch(content, 'touchmove', contact(100, 115));
    dispatchTouch(content, 'touchend', contact(100, 275));
    expect(fixture.componentInstance.open()).toBe(true);
  });

  it.each([
    ['short', 100, 130],
    ['horizontal', 260, 185],
    ['upward', 100, 10],
  ])('ignores a %s swipe', (_name, x, y) => {
    const { fixture, content } = setup();
    dispatchTouch(content, 'touchstart', contact(100, 100));
    dispatchTouch(content, 'touchend', contact(x, y));
    expect(fixture.componentInstance.open()).toBe(true);
  });

  it('ignores a second touch even when it is released before the first', () => {
    const { fixture, content, opener } = setup();
    dispatchTouch(content, 'touchstart', contact(100, 100));
    dispatchTouch(opener, 'touchstart', contact(170, 105, 2), [contact(100, 100), contact(170, 105, 2)]);
    dispatchTouch(opener, 'touchend', contact(170, 105, 2), [contact(100, 100)]);
    dispatchTouch(content, 'touchend', contact(100, 230));
    expect(fixture.componentInstance.open()).toBe(true);
  });

  it('ignores a cancelled gesture or a swipe from a form control', () => {
    const { fixture, scroller, content } = setup();
    dispatchTouch(content, 'touchstart', contact(100, 100));
    dispatchTouch(content, 'touchcancel', contact(100, 130));
    dispatchTouch(content, 'touchend', contact(100, 230));
    const input = scroller.querySelector('input')!;
    dispatchTouch(input, 'touchstart', contact(100, 100));
    dispatchTouch(input, 'touchend', contact(100, 230));
    expect(fixture.componentInstance.open()).toBe(true);
  });

  it('leaves the underlying sheet open beneath a nested dialog and preserves Escape', () => {
    const { fixture, content } = setup();
    dispatchTouch(content, 'touchstart', contact(100, 100));
    fixture.componentInstance.nested.set(true);
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    dispatchTouch(content, 'touchend', contact(100, 230));

    expect(fixture.componentInstance.nested()).toBe(false);
    expect(fixture.componentInstance.open()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(fixture.componentInstance.open()).toBe(false);
  });
});
