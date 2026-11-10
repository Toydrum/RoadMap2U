import { LEVEL_H, LayoutPoint } from './tree-layout';

/**
 * Pure label field: every branch name, always visible, never overlapping.
 *
 * Replaces the old shelf system, whose three failure modes the owner rejected:
 * labels popped in/out with zoom (k>=0.55 gate), hid entirely when a band
 * saturated, and truncated to 20/9 chars. Here every eligible node gets a
 * multi-line wrapped block packed into ONE global occupancy field. Nothing in
 * this module reads the zoom — labels are world-space and simply scale with
 * the tree, so visibility is identical at every k by construction.
 *
 * Physics honesty (agreed with the owner): 80-char titles in a 9-sibling fan
 * are geometrically impossible to show whole. Typical titles (≤25 chars) fit
 * fully even in dense fans; only very long titles inside saturated fans get
 * `clipped: true`, which the renderer paints as a soft gradient fade on the
 * tail — never an ellipsis, never a hidden name. The full title always lives
 * in the focused cartouche, the tablita, the node sheet and the aria-label.
 *
 * Deterministic throughout: same layout in → byte-identical field out.
 */

/** Fallback glyph advance while the canvas font is loading. */
export const CHAR_W = 8.1;
export const LINE_H = 13.5;
export const LABEL_FONT_SIZE = 12.5;
/** Base wrap width budget (world px) for a tier-1 line. */
const LINE_BUDGET = 118;
/** Horizontal breathing room reserved around every block. */
const MARGIN = 8;
/** Vertical lane quantum of the occupancy field. */
const LANE_H = 12;
/** First line's baseline offset below the node's row line (matches the old
 *  shelf-0 baseline so the tree's look stays familiar). */
export const LABEL_BASELINE = 27;
/** A block may not extend below this offset — the next row's glyphs start
 *  living there (focus ring r=24 + breathing room). */
const MAX_DEPTH_BELOW_ROW = 74;
/** Covers the title stroke and the outer edge of priority pills. */
const PAINT_PAD = 4;

/** Crowding tiers — a whole neighborhood shares one, so smaller text reads as
 *  intentional typography, never as one name being punished. */
const TIERS = [1, 0.88, 0.76] as const;
const FLOOR_TIER = 0.76;

export interface LabelBlock {
  id: string;
  /** Wrapped lines, longest-first estimation already applied. When clipped,
   *  the LAST line has its final characters moved into `tail`. */
  lines: string[];
  /** Ghosted continuation characters of a clipped title (renderer fades
   *  them) — empty when the whole title fit. */
  tail: string;
  /** World x of the block's center (node x + packer-chosen dx). */
  cx: number;
  /** World y of the FIRST line's baseline. */
  y0: number;
  /** Font factor (tier × per-node emphasis) — multiply 12.5px by this. */
  factor: number;
  /** True when even the floor tier couldn't fit the whole title — the
   *  renderer fades the tail of the last line instead of cutting. */
  clipped: boolean;
  /** Painted bounds, including the halo or priority pill. */
  width: number;
  top: number;
  height: number;
}

export type MeasureLabel = (line: string, fontSize: number) => {
  width: number;
  ascent: number;
  descent: number;
};

/** Move the last few characters of a clipped block's final line into `tail`
 *  so the renderer can ghost them (a soft "continues" cue, never an "…"). */
function withFadeTail(block: LabelBlock): LabelBlock {
  if (!block.clipped || !block.lines.length) return block;
  const last = block.lines[block.lines.length - 1];
  const cut = Math.min(4, Math.max(1, last.length - 1));
  return {
    ...block,
    lines: [...block.lines.slice(0, -1), last.slice(0, last.length - cut)],
    tail: last.slice(last.length - cut),
  };
}

export interface LabelInput {
  id: string;
  title: string;
  x: number;
  /** Visual row line (pre-jitter, lift included) — rowY of the LayoutPoint. */
  rowY: number;
  /** Per-node emphasis multiplier (priority hook — 1 when absent). */
  emphasis: number;
  /** Extra width reserved left of line 1 (e.g. a small glyph). */
  leadGlyphW: number;
  /** Packs first (the 📍 place). */
  pinned: boolean;
  /** Hard cap on wrapped lines. Chain links live only CHAIN_H=46px apart —
   *  the 74px downward label budget was derived for 100px rows, so a
   *  2+ line chain label paints across the glyph of the link below it.
   *  Capped labels end in the fade-tail; the full name lives in the
   *  cartouche/tablita as always. */
  maxLines?: number;
}

/** Greedy word wrap. A single word longer than the line hard-breaks with a
 *  hyphen (no word is ever silently dropped). */
export function wrapTitle(
  title: string,
  maxChars: number,
  maxLines: number,
  fitsWidth?: (line: string) => boolean,
): { lines: string[]; clipped: boolean } {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  let clipped = false;
  const fits = (candidate: string): boolean =>
    candidate.length <= maxChars && (fitsWidth?.(candidate) ?? true);
  const push = (): void => {
    if (line) lines.push(line);
    line = '';
  };
  for (let w = 0; w < words.length; w++) {
    let word = words[w];
    while (word.length > 1 && !fits(word)) {
      // Oversized single word: hard-break with a hyphen.
      push();
      if (lines.length >= maxLines) {
        clipped = true;
        break;
      }
      let cut = Math.max(1, Math.min(word.length - 1, maxChars - 1));
      while (cut > 1 && !fits(word.slice(0, cut) + '-')) cut--;
      lines.push(word.slice(0, cut) + '-');
      word = word.slice(cut);
    }
    if (lines.length >= maxLines) {
      clipped = true;
      break;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    push();
    if (lines.length >= maxLines) {
      clipped = true;
      break;
    }
    line = word;
  }
  if (!clipped && line) {
    if (lines.length >= maxLines) clipped = true;
    else lines.push(line);
  }
  if (!lines.length) lines.push(title.slice(0, maxChars));
  return { lines: lines.slice(0, maxLines), clipped };
}

/** Local-crowding tier: how many labeled neighbors share this node's visual
 *  neighborhood. Layout-only, zoom-free — a fan reads as one type size. */
export function labelTier(point: LabelInput, all: LabelInput[]): number {
  let near = 0;
  for (const other of all) {
    if (other.id === point.id) continue;
    if (Math.abs(other.x - point.x) <= 150 && Math.abs(other.rowY - point.rowY) <= 36) near++;
  }
  if (near <= 4) return TIERS[0];
  if (near <= 7) return TIERS[1];
  return TIERS[2];
}

/** Regional smoothing: everyone adopts the smallest tier in their own
 *  neighborhood, so a crowded fan reads as ONE deliberate type size instead
 *  of one name looking singled out among bigger siblings. */
export function smoothedTiers(all: LabelInput[]): Map<string, number> {
  const raw = new Map<string, number>();
  for (const p of all) raw.set(p.id, labelTier(p, all));
  const out = new Map<string, number>();
  for (const p of all) {
    let tier = raw.get(p.id) ?? TIERS[0];
    for (const other of all) {
      if (other.id === p.id) continue;
      if (Math.abs(other.x - p.x) <= 150 && Math.abs(other.rowY - p.rowY) <= 36) {
        tier = Math.min(tier, raw.get(other.id) ?? TIERS[0]);
      }
    }
    out.set(p.id, tier);
  }
  return out;
}

interface Lane {
  /** Sorted, disjoint occupied x-intervals. */
  spans: { x0: number; x1: number }[];
}

function laneFree(lane: Lane, x0: number, x1: number): boolean {
  for (const s of lane.spans) {
    if (x0 < s.x1 && x1 > s.x0) return false;
  }
  return true;
}

function laneMark(lane: Lane, x0: number, x1: number): void {
  lane.spans.push({ x0, x1 });
}

function blockOf(
  input: LabelInput,
  factor: number,
  maxLines: number,
  measure: MeasureLabel,
  maxCharsOverride?: number,
  lineBudget = LINE_BUDGET,
): { lines: string[]; clipped: boolean; w: number; ascent: number; h: number } {
  const cappedLines = Math.min(maxLines, input.maxLines ?? Number.POSITIVE_INFINITY);
  const size = LABEL_FONT_SIZE * factor;
  const { lines, clipped } = wrapTitle(
    input.title,
    maxCharsOverride ?? Number.POSITIVE_INFINITY,
    cappedLines,
    (line) => measure(line, size).width <= lineBudget,
  );
  let width = 0;
  let ascent = 0;
  let descent = 0;
  for (const line of lines) {
    const measured = measure(line, size);
    width = Math.max(width, measured.width);
    ascent = Math.max(ascent, measured.ascent);
    descent = Math.max(descent, measured.descent);
  }
  // The ray sits beside centered text; reserve its space on both sides.
  const w = width + 2 * (PAINT_PAD + input.leadGlyphW);
  const h = ascent + descent + (lines.length - 1) * LINE_H * factor + 2 * PAINT_PAD;
  return { lines, clipped, w, ascent: ascent + PAINT_PAD, h };
}

const fallbackMeasure: MeasureLabel = (line, size) => ({
  width: line.length * CHAR_W * size / LABEL_FONT_SIZE,
  ascent: size,
  descent: size * 0.3,
});

/**
 * Pack every label into one global field. Deterministic placement order:
 * pinned (📍) first, then rowY descending (trunk-near names get stable
 * spots), then x ascending. Prefer positions within 28px of the branch.
 */
export function packLabels(
  inputs: LabelInput[],
  measure: MeasureLabel = fallbackMeasure,
  anchors: readonly Pick<LayoutPoint, 'x' | 'y'>[] = [],
): Map<string, LabelBlock> {
  const out = new Map<string, LabelBlock>();
  const lanes = new Map<number, Lane>();

  const free = (x0: number, y0: number, w: number, h: number): boolean => {
    const l0 = Math.floor(y0 / LANE_H);
    const l1 = Math.floor((y0 + h - 0.01) / LANE_H);
    for (let l = l0; l <= l1; l++) {
      const lane = lanes.get(l);
      if (lane && !laneFree(lane, x0, x0 + w)) return false;
    }
    return true;
  };
  const mark = (x0: number, y0: number, w: number, h: number): void => {
    const l0 = Math.floor(y0 / LANE_H);
    const l1 = Math.floor((y0 + h - 0.01) / LANE_H);
    for (let l = l0; l <= l1; l++) {
      let lane = lanes.get(l);
      if (!lane) {
        lane = { spans: [] };
        lanes.set(l, lane);
      }
      laneMark(lane, x0, x0 + w);
    }
  };
  // Leave room for branch tips, including the unlabelled links of a chain.
  for (const { x, y } of anchors) mark(x - 9, y - 8, 18, 16);

  const ordered = [...inputs].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.rowY !== b.rowY) return b.rowY - a.rowY;
    return a.x - b.x;
  });

  const dys = [0, 13, 26, 39];
  const dxs = [0, 14, -14, 28, -28];
  const pocketDxs = [...dxs, 42, -42];
  const outerDxs = [42, -42, 56, -56, 70, -70, 84, -84];
  const tiers = smoothedTiers(inputs);

  for (const input of ordered) {
    const tier = tiers.get(input.id) ?? TIERS[0];
    // Whole-title placements first (own tier, then the floor tier — smaller
    // and whole beats big and cut). If neither fits, a GRID-CHECKED shrink
    // ladder of clipped blocks: every rung still refuses to overlap, so
    // "never overlap" stays a hard invariant all the way down.
    const floor = FLOOR_TIER * input.emphasis;
    const attempts: {
      factor: number;
      maxLines: number;
      acceptClipped: boolean;
      maxChars?: number;
    }[] = [
      { factor: tier * input.emphasis, maxLines: tier === 1 ? 3 : 4, acceptClipped: false },
    ];
    if (tier !== FLOOR_TIER) {
      attempts.push({ factor: floor, maxLines: 4, acceptClipped: false });
    }
    attempts.push(
      { factor: floor, maxLines: 2, acceptClipped: true },
      { factor: floor, maxLines: 1, acceptClipped: true },
      { factor: floor, maxLines: 1, acceptClipped: true, maxChars: 12 },
      { factor: floor, maxLines: 1, acceptClipped: true, maxChars: 8 },
      { factor: floor, maxLines: 1, acceptClipped: true, maxChars: 5 },
    );

    const place = (
      shape: ReturnType<typeof blockOf>,
      factor: number,
      dx: number,
      dy: number,
    ): LabelBlock | undefined => {
      const cx = input.x + dx;
      const y0 = input.rowY + LABEL_BASELINE + dy;
      const top = y0 - shape.ascent;
      const left = cx - shape.w / 2 - MARGIN;
      const width = shape.w + 2 * MARGIN;
      if (!free(left, top, width, shape.h)) return undefined;
      mark(left, top, width, shape.h);
      return withFadeTail({
        id: input.id,
        lines: shape.lines,
        tail: '',
        cx,
        y0,
        factor,
        clipped: shape.clipped,
        width: shape.w,
        top,
        height: shape.h,
      });
    };

    const tryBelow = (attempt: (typeof attempts)[number]): LabelBlock | undefined => {
      const shape = blockOf(input, attempt.factor, attempt.maxLines, measure, attempt.maxChars);
      if (shape.clipped && !attempt.acceptClipped) return undefined;
      for (const dy of dys) {
        if (LABEL_BASELINE + dy - shape.ascent + shape.h > MAX_DEPTH_BELOW_ROW) break;
        for (const dx of dxs) {
          const block = place(shape, attempt.factor, dx, dy);
          if (block) return block;
        }
      }
      return undefined;
    };

    let placed: LabelBlock | undefined;
    for (const attempt of attempts) {
      if (attempt.acceptClipped) break;
      placed = tryBelow(attempt);
      if (placed) break;
    }

    // Try the open pockets around the branch before shortening its title.
    // A narrower block can tuck between neighbors, or a wider one can fit
    // into a shallow pocket. The same occupied grid protects every glyph.
    if (!placed && input.maxLines === undefined) {
      const shapes = [LINE_BUDGET, 94, 142, 76]
        .map((budget) => blockOf(input, floor, 6, measure, undefined, budget))
        .filter((shape) => !shape.clipped);
      pocket: for (const distance of [0, 12, 24, 36, 48, 60]) {
        for (const shape of shapes) {
          const above = shape.ascent - shape.h - LABEL_BASELINE - 15 - distance;
          for (const dy of [distance, above]) {
            for (const dx of pocketDxs) {
              placed = place(shape, floor, dx, dy);
              if (placed) break pocket;
            }
          }
        }
      }
    }

    for (const attempt of attempts) {
      if (placed) break;
      if (attempt.acceptClipped) placed = tryBelow(attempt);
    }

    if (!placed) {
      const shape = blockOf(input, floor, 1, measure, 5);
      for (const dy of dys) {
        for (const dx of outerDxs) {
          placed = place(shape, floor, dx, dy);
          if (placed) break;
        }
        if (placed) break;
      }
      // If the row is saturated, extend it vertically. Every placement
      // still goes through the occupancy check, even for stacked anchors.
      for (let dy = MAX_DEPTH_BELOW_ROW; !placed; dy += LANE_H) {
        placed = place(shape, floor, 0, dy);
      }
    }
    out.set(input.id, placed);
  }
  return out;
}

/** Convenience used by the canvas: LayoutPoint[] → LabelInput[] with the
 *  chain doctrine applied (chain links label only via `labeledChainIds`). */
export function labelInputsFrom(
  points: LayoutPoint[],
  opts: {
    currentNodeId: string | null;
    labeledChainIds: ReadonlySet<string>;
    emphasisOf: (p: LayoutPoint) => number;
    leadGlyphOf: (p: LayoutPoint) => number;
  },
): LabelInput[] {
  const out: LabelInput[] = [];
  for (const p of points) {
    // Chain doctrine: links stay quiet except the NEXT open step — but the
    // 📍 place always speaks its name, chain link or not.
    const isPinned = opts.currentNodeId === p.node.id;
    if (p.chain && !opts.labeledChainIds.has(p.node.id) && !isPinned) continue;
    out.push({
      id: p.node.id,
      title: p.node.title,
      x: p.x,
      rowY: p.rowY ?? -p.depth * LEVEL_H,
      emphasis: opts.emphasisOf(p),
      leadGlyphW: opts.leadGlyphOf(p),
      pinned: isPinned,
      // Chain links sit CHAIN_H apart — a wrapped label would paint across
      // the glyph below. One line + fade-tail; the cartouche says it all.
      maxLines: p.chain ? 1 : undefined,
    });
  }
  return out;
}
