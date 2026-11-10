import { describe, expect, it } from 'vitest';
import { hash } from './tree-layout';
import {
  CHAR_W,
  LINE_H,
  LabelBlock,
  LabelInput,
  packLabels,
  wrapTitle,
} from './tree-labels';

function input(partial: Partial<LabelInput> & { id: string }): LabelInput {
  return {
    title: partial.id,
    x: 0,
    rowY: -100,
    emphasis: 1,
    leadGlyphW: 0,
    pinned: false,
    ...partial,
  };
}

/** Visual rect of a placed block (what actually paints). */
function rectOf(b: LabelBlock): { x0: number; x1: number; y0: number; y1: number } {
  return {
    x0: b.cx - b.width / 2,
    x1: b.cx + b.width / 2,
    y0: b.top,
    y1: b.top + b.height,
  };
}

function overlaps(a: LabelBlock, b: LabelBlock): boolean {
  const ra = rectOf(a);
  const rb = rectOf(b);
  return ra.x0 < rb.x1 && ra.x1 > rb.x0 && ra.y0 < rb.y1 && ra.y1 > rb.y0;
}

describe('wrapTitle', () => {
  it('wraps on word boundaries and keeps every word', () => {
    const { lines, clipped } = wrapTitle('Conseguir una guitarra criolla', 14, 3);
    expect(clipped).toBe(false);
    expect(lines.join(' ')).toBe('Conseguir una guitarra criolla');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(14);
  });

  it('hard-breaks an oversized single word with a hyphen', () => {
    const word = 'x'.repeat(40);
    const { lines } = wrapTitle(word, 14, 4);
    expect(lines[0].endsWith('-')).toBe(true);
    expect(lines.join('').replace(/-/g, '')).toBe(word);
  });

  it('counts accented Spanish characters as ordinary characters', () => {
    const { lines, clipped } = wrapTitle('Añoranza según cañón', 12, 3);
    expect(clipped).toBe(false);
    expect(lines.join(' ')).toBe('Añoranza según cañón');
  });

  it('flags clipping when maxLines cannot hold the title', () => {
    const { clipped } = wrapTitle('uno dos tres cuatro cinco seis siete ocho', 8, 2);
    expect(clipped).toBe(true);
  });
});

describe('packLabels', () => {
  it('never lets two placed blocks overlap (hash-seeded crowd)', () => {
    // Mirrors the layout precondition: same-row anchors sit ≥48px apart
    // (layoutTree's slot spans are disjoint — stacked anchors cannot occur).
    const inputs: LabelInput[] = [];
    const cursor = new Map<number, number>();
    for (let i = 0; i < 40; i++) {
      const h = hash(`crowd:${i}`);
      const row = 1 + ((h >> 8) % 5);
      const x = (cursor.get(row) ?? -450) + 48 + (h % 40);
      cursor.set(row, x);
      inputs.push(
        input({
          id: `n${i}`,
          title: `Rama número ${i} con un nombre bastante largo de verdad`.slice(
            0,
            20 + (h % 50),
          ),
          x,
          rowY: -100 * row,
        }),
      );
    }
    const placed = [...packLabels(inputs).values()];
    expect(placed.length).toBe(40); // every name places — none hidden
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlaps(placed[i], placed[j])).toBe(false);
      }
    }
  });

  it('never clips when there is room', () => {
    const lonely = packLabels([
      input({ id: 'a', title: 'Practicar guitarra todos los días un ratito' }),
    ]).get('a')!;
    expect(lonely.clipped).toBe(false);
    expect(lonely.tail).toBe('');
    expect(lonely.lines.join(' ')).toBe('Practicar guitarra todos los días un ratito');
  });

  it('checks even the last fallback with measured tall glyphs and stacked anchors', () => {
    const inputs = Array.from({ length: 40 }, (_, i) => input({
      id: String(i), title: 'WWW wide title', x: 10,
    }));
    const labels = [...packLabels(inputs, (line) => ({
      width: line.length * 14, ascent: 17, descent: 7,
    })).values()];
    expect(labels).toHaveLength(40);
    expect(labels.every((a, i) => labels.slice(i + 1).every((b) => !overlaps(a, b)))).toBe(true);
  });

  it('keeps the pinned (📍) label whole even inside a crowd', () => {
    const inputs: LabelInput[] = [
      input({ id: 'pin', title: 'La rama donde estoy parada ahora mismo', x: 0, pinned: true }),
    ];
    for (let i = 0; i < 8; i++) {
      inputs.push(
        input({ id: `s${i}`, title: `Hermana apretada número ${i} con nombre largo`, x: (i - 4) * 48 }),
      );
    }
    const pin = packLabels(inputs).get('pin')!;
    expect(pin.clipped).toBe(false);
    expect(pin.lines.join(' ')).toBe('La rama donde estoy parada ahora mismo');
  });

  it('is deterministic — same input, byte-identical field', () => {
    const inputs = [
      input({ id: 'a', title: 'Primera rama', x: -60 }),
      input({ id: 'b', title: 'Segunda rama con más texto', x: 20 }),
      input({ id: 'c', title: 'Tercera', x: 90, rowY: -200 }),
    ];
    const one = packLabels(inputs);
    const two = packLabels(inputs);
    expect([...one.entries()]).toEqual([...two.entries()]);
  });

  it('marks impossible fits as clipped with a fade tail, never hides', () => {
    // Nine 80-char siblings on one row — the agreed physics-impossible case.
    const inputs: LabelInput[] = [];
    for (let i = 0; i < 9; i++) {
      inputs.push(
        input({
          id: `t${i}`,
          title: ('palabra ventisiete letras más '.repeat(4)).slice(0, 80),
          x: i * 48,
        }),
      );
    }
    const placed = [...packLabels(inputs).values()];
    expect(placed.length).toBe(9); // all present
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlaps(placed[i], placed[j])).toBe(false);
      }
    }
    // Long titles in saturation clip with a tail (the honest floor).
    const clipped = placed.filter((p) => p.clipped);
    expect(clipped.length).toBeGreaterThan(0);
    for (const c of clipped) expect(c.tail.length).toBeGreaterThan(0);
  });

  it('emphasis reserves real width (the luz hook cannot cause overlap)', () => {
    const a = packLabels([input({ id: 'a', title: 'Rama con énfasis' })]).get('a')!;
    const b = packLabels([input({ id: 'a', title: 'Rama con énfasis', emphasis: 1.12 })]).get('a')!;
    expect(b.width).toBeGreaterThan(a.width);
    expect(Math.abs(b.width / a.width - 1.12)).toBeLessThan(0.08 + (14 / a.width));
  });
});

describe('width convention', () => {
  it('CHAR_W stays the arithmetic the packer promised the renderer', () => {
    expect(CHAR_W).toBeCloseTo(8.1);
    expect(LINE_H).toBeCloseTo(13.5);
  });
});
