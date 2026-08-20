// Render the master mark into the PWA icon set and the simplified mark into
// the 32px browser favicon. Usage: node tools/gen-icons.mjs
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const svg = readFileSync(resolve('public/icons/logo.svg'), 'utf-8');
const faviconSvg = readFileSync(resolve('public/icons/favicon.svg'), 'utf-8');

const browser = await chromium.launch({ channel: 'msedge', headless: true });

for (const size of sizes) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // ~4% breathing room inside the canvas so round masks never kiss the stroke
  const pad = Math.round(size * 0.02);
  await page.setContent(
    `<body style="margin:0;display:grid;place-items:center;width:${size}px;height:${size}px">` +
      `<div style="width:${size - pad * 2}px;height:${size - pad * 2}px">${svg}</div></body>`,
  );
  await page.screenshot({
    path: `public/icons/icon-${size}x${size}.png`,
    omitBackground: true,
  });
  await page.close();
  console.log(`icon-${size}x${size}.png`);
}

const faviconSize = 32;
const faviconPage = await browser.newPage({
  viewport: { width: faviconSize, height: faviconSize },
});
await faviconPage.setContent(
  `<body style="margin:0;width:${faviconSize}px;height:${faviconSize}px">` +
    `<div style="width:${faviconSize}px;height:${faviconSize}px">${faviconSvg}</div></body>`,
);
await faviconPage.screenshot({
  path: 'public/icons/favicon-32x32.png',
  omitBackground: true,
});
await faviconPage.close();
console.log('favicon-32x32.png');

await browser.close();
