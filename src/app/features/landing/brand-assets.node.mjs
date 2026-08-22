// Node-only asset contract; kept outside Angular's browser-test discovery.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();

const asset = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const binaryAsset = (path) => readFileSync(resolve(ROOT, path));

function viewBox(svg) {
  const match = svg.match(/viewBox="([\d. -]+)"/);
  assert.ok(match, 'SVG without viewBox');
  const values = match[1].trim().split(/\s+/).map(Number);
  assert.equal(values.length, 4, 'Invalid viewBox');
  assert.equal(values.some(Number.isNaN), false, 'Invalid viewBox');
  return values;
}

function artBounds(svg) {
  const match = svg.match(/data-art-bounds="([\d. -]+)"/);
  assert.ok(match, 'SVG without measured art bounds');
  const values = match[1].trim().split(/\s+/).map(Number);
  assert.equal(values.length, 4, 'Invalid art bounds');
  assert.equal(values.some(Number.isNaN), false, 'Invalid art bounds');
  return values;
}

function scaledMargins(svg, outputSize) {
  const [vx, vy, vw, vh] = viewBox(svg);
  const [x, y, width, height] = artBounds(svg);
  const scale = outputSize / Math.max(vw, vh);
  return [x - vx, y - vy, vx + vw - (x + width), vy + vh - (y + height)].map(
    (margin) => margin * scale,
  );
}

describe('C6C-B v2 brand assets', () => {
  const paths = [
    'public/icons/logo.svg',
    'public/icons/favicon.svg',
    'public/brand/roadmap2u-lockup.svg',
    'public/brand/roadmap2u-lockup-dark.svg',
    'public/brand/roadmap2u-mark-mono.svg',
  ];

  it('ships the master, favicon, horizontal, dark and mono variants', () => {
    for (const path of paths) assert.match(asset(path), /<svg/, path);
  });

  it('keeps the green 2 separate from the brown U whose right arm is the trunk', () => {
    const master = asset('public/icons/logo.svg');
    assert.match(master, /data-part="two"[^>]+fill="#4e7d4a"/);
    assert.match(master, /data-part="u-trunk"[^>]+fill="#6f5640"/);
    assert.equal(master.match(/data-part="u-trunk"/g)?.length, 1);
    assert.match(master, /data-detail="flower"/);
    assert.match(master, /data-detail="bud"/);
  });

  it('pins the lockup wordmark width across platform fallback fonts', () => {
    for (const path of [
      'public/brand/roadmap2u-lockup.svg',
      'public/brand/roadmap2u-lockup-dark.svg',
    ]) {
      const lockup = asset(path);
      assert.match(lockup, /<text[\s\S]*?textLength="296"/);
      assert.match(lockup, /<text[\s\S]*?lengthAdjust="spacingAndGlyphs"/);
    }
  });

  for (const size of [120, 72, 32]) {
    it(`preserves an internal margin and clips nothing at ${size}px`, () => {
      const margins = scaledMargins(asset('public/icons/logo.svg'), size);
      assert.ok(Math.min(...margins) >= size / 30, `${size}px margins: ${margins.join(', ')}`);
    });
  }

  it('keeps the real header lockup artwork inside its image and link at desktop and mobile sizes', async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage();
      for (const path of [
        'public/brand/roadmap2u-lockup.svg',
        'public/brand/roadmap2u-lockup-dark.svg',
      ]) {
        const lockup = asset(path);
        const declaredBounds = artBounds(lockup);
        for (const width of [188, 120]) {
          await page.setContent(
            `<style>
              body { margin: 0; }
              .brand { display: inline-flex; align-items: center; min-height: 48px; }
              .brand svg { display: block; width: ${width}px; height: auto; }
            </style><a class="brand">${lockup}</a>`,
          );
          const metrics = await page.locator('.brand').evaluate((brand, declared) => {
            const svg = brand.querySelector('svg');
            const linkRect = brand.getBoundingClientRect();
            const imageRect = svg.getBoundingClientRect();
            const art = svg.getBBox();
            const branch = svg.querySelector('[data-part="branch"]');
            const branchBox = branch.getBBox();
            const viewBox = svg.viewBox.baseVal;
            const scale = imageRect.width / viewBox.width;
            return {
              linkRight: linkRect.right,
              imageRight: imageRect.right,
              artRight: imageRect.left + (art.x + art.width - viewBox.x) * scale,
              declaredArtRight: imageRect.left + (declared[0] + declared[2] - viewBox.x) * scale,
              branchWidth: branchBox.width * scale,
              branchHeight: branchBox.height * scale,
              branchFill: getComputedStyle(branch).fill,
            };
          }, declaredBounds);
          assert.ok(
            metrics.imageRight <= metrics.linkRight + 0.5,
            `${path} ${width}px image exceeds link: ${JSON.stringify(metrics)}`,
          );
          assert.ok(
            metrics.artRight <= metrics.imageRight - 1,
            `${path} ${width}px lockup lacks a safe art inset: ${JSON.stringify(metrics)}`,
          );
          assert.ok(
            metrics.artRight <= metrics.declaredArtRight + 0.5,
            `${path} ${width}px measured bounds understate the artwork: ${JSON.stringify(metrics)}`,
          );
          assert.ok(
            metrics.branchWidth >= 2 && metrics.branchHeight >= 2 && metrics.branchFill !== 'none',
            `${path} ${width}px branch collapses to a stroke: ${JSON.stringify(metrics)}`,
          );
        }
      }
    } finally {
      await browser.close();
    }
  });

  it('confirms the rendered getBBox remains inside the viewBox at 120, 72 and 32px', async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage();
      const master = asset('public/icons/logo.svg');
      for (const size of [120, 72, 32]) {
        await page.setContent(
          `<body style="margin:0"><div style="width:${size}px;height:${size}px">${master}</div></body>`,
        );
        const box = await page.locator('svg').evaluate((svg) => {
          const bounds = svg.getBBox();
          return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        });
        const [vx, vy, vw, vh] = viewBox(master);
        const margins = [
          box.x - vx,
          box.y - vy,
          vx + vw - (box.x + box.width),
          vy + vh - (box.y + box.height),
        ];
        assert.ok(
          margins.every((margin) => margin >= 0),
          `${size}px clips: ${margins.join(', ')}`,
        );
        assert.ok(
          Math.min(...margins) * (size / vw) >= size / 30,
          `${size}px margin: ${margins.join(', ')}`,
        );
      }
    } finally {
      await browser.close();
    }
  });

  it('keeps the favicon simplified and every SVG inert', () => {
    assert.doesNotMatch(asset('public/icons/favicon.svg'), /data-part="map-line"/);
    for (const path of paths) {
      assert.doesNotMatch(asset(path), /<script|<foreignObject|(?:href|src)="https?:/i);
    }
  });

  it('generates a 32 by 32 PNG favicon', () => {
    const path = 'public/icons/favicon-32x32.png';
    assert.ok(existsSync(resolve(ROOT, path)), `${path} is missing`);
    const png = binaryAsset(path);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 32);
    assert.equal(png.readUInt32BE(20), 32);
  });

  it('keeps the generated favicon transparent and away from the canvas edge', async () => {
    const path = 'public/icons/favicon-32x32.png';
    assert.ok(existsSync(resolve(ROOT, path)), `${path} is missing`);
    const dataUrl = `data:image/png;base64,${binaryAsset(path).toString('base64')}`;
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage();
      const pixels = await page.evaluate(async (src) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return [...context.getImageData(0, 0, canvas.width, canvas.height).data];
      }, dataUrl);
      const alpha = pixels.filter((_, index) => index % 4 === 3);
      const filled = alpha.filter((value) => value > 0).length;
      const transparent = alpha.filter((value) => value === 0).length;
      const edge = alpha.filter((_, index) => {
        const x = index % 32;
        const y = Math.floor(index / 32);
        return x === 0 || x === 31 || y === 0 || y === 31;
      });
      assert.ok(filled > 100, `favicon content is unexpectedly sparse: ${filled} pixels`);
      assert.ok(
        transparent > 100,
        `favicon is unexpectedly opaque: ${transparent} transparent pixels`,
      );
      assert.ok(
        edge.every((value) => value === 0),
        'favicon reaches the canvas edge',
      );
    } finally {
      await browser.close();
    }
  });

  it('renders the PNG favicon from the simplified SVG variant', () => {
    const generator = asset('tools/gen-icons.mjs');
    assert.match(generator, /public\/icons\/favicon\.svg/);
    assert.match(generator, /public\/icons\/favicon-32x32\.png/);
  });
});
