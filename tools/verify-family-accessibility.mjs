import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BASE, launchPage, signInAs, ok } from './lib/harness.mjs';

const output = pathToFileURL(resolve('tools/battery-logs/' + 'family-accessibility') + '/');
await mkdir(output, { recursive: true });
const { browser, page } = await launchPage({ width: 375, height: 812 });
const results = [];
const measure = async (selector) =>
  page.locator(selector).evaluateAll((elements) => {
    const rgb = (value) => {
      const match = value.match(/^rgba?\(([^)]+)\)$/);
      if (!match) throw new Error('Unsupported contrast color: ' + value);
      return match[1].split(',').map(Number);
    };
    const luminance = (color) => {
      const channels = color.slice(0, 3).map((value) => {
        value /= 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    return elements
      .filter((el) => el.textContent.trim() && el.getBoundingClientRect().width > 0)
      .map((el) => {
        let parent = el,
          background;
        while (parent) {
          const color = rgb(getComputedStyle(parent).backgroundColor);
          if (color.length === 3 || color[3] === 1) {
            background = color;
            break;
          }
          parent = parent.parentElement;
        }
        if (!background) throw new Error('Missing opaque contrast background');
        const style = getComputedStyle(el),
          foreground = rgb(style.color);
        const a = luminance(foreground),
          b = luminance(background);
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const large =
          parseFloat(style.fontSize) >= 24 ||
          (parseFloat(style.fontSize) >= 18.66 && parseInt(style.fontWeight) >= 700);
        return {
          selector: el.className,
          text: el.textContent.trim().slice(0, 100),
          foreground: style.color,
          background,
          ratio,
          required: large ? 3 : 4.5,
        };
      });
  });
try {
  await signInAs(page, 'rocio', 'Bosque123');
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
  await page.locator('.fam-create').waitFor();
  for (const theme of ['organic', 'terminal']) {
    if (theme === 'terminal') await page.getByRole('button', { name: /Retro terminal/ }).click();
    await page.waitForFunction(
      (expected) => document.documentElement.getAttribute('data-theme') === expected,
      theme,
    );
    const rows = await measure('.fam-kicker,.fam-handle,.amigos-kicker,.amigos-handle');
    await page.locator('.familia').scrollIntoViewIfNeeded();
    await page.screenshot({ path: fileURLToPath(new URL(theme + '-household.png', output)) });
    await page.locator('.fam-open', { hasText: 'Nico' }).click();
    rows.push(...(await measure('.familia-sheet .hint,.familia-sheet .fam-handle')));
    await page.screenshot({ path: fileURLToPath(new URL(theme + '-child.png', output)) });
    results.push({ theme, rows });
    const failed = rows.filter((row) => row.ratio < row.required);
    ok(
      'family and friend small text contrast ' + theme,
      rows.length > 0 && failed.length === 0,
      JSON.stringify(
        failed.map((row) => ({
          selector: row.selector,
          ratio: Number(row.ratio.toFixed(2)),
          required: row.required,
        })),
      ),
    );
    await page.keyboard.press('Escape');
    await page.locator('.familia-sheet').waitFor({ state: 'detached' });
  }
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  const largeText = await page.locator('.familia,.amigos').evaluateAll((elements) =>
    elements.map((el) => {
      const bounds = el.getBoundingClientRect();
      return {
        selector: el.className,
        width: el.clientWidth,
        scrollWidth: el.scrollWidth,
        overflowingChildren: [...el.querySelectorAll('*')]
          .filter((child) => {
            const r = child.getBoundingClientRect();
            return r.right > bounds.right + 1 || r.left < bounds.left - 1;
          })
          .map((child) => ({
            selector: child.className,
            tag: child.tagName,
            text: child.textContent.trim().slice(0, 70),
            width: child.clientWidth,
          })),
      };
    }),
  );
  await page.locator('.amigos').scrollIntoViewIfNeeded();
  await page.screenshot({ path: fileURLToPath(new URL('friends-text-200.png', output)) });
  results.push({ largeText });
  ok(
    'family and friends fit at 200 percent text on mobile',
    largeText.length === 2 && largeText.every((el) => el.scrollWidth <= el.width + 1),
    JSON.stringify(largeText),
  );
  const navigation = await page.locator('.tabbar .label').evaluateAll((elements) =>
    elements.map((el) => {
      const label = el.getBoundingClientRect(),
        tab = el.closest('.tab').getBoundingClientRect();
      return {
        text: el.textContent.trim(),
        fits: label.left >= tab.left - 1 && label.right <= tab.right + 1,
      };
    }),
  );
  const skipLinkHidden = await page
    .locator('.skip-link')
    .evaluate((el) => el.getBoundingClientRect().bottom <= 0);
  results.push({ navigation, skipLinkHidden });
  ok(
    'navigation labels fit at 200 percent text',
    navigation.length === 5 && navigation.every((row) => row.fits),
    JSON.stringify(navigation),
  );
  ok('unfocused skip link stays off screen at 200 percent text', skipLinkHidden);
} finally {
  await writeFile(
    new URL('result.json', output),
    JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) + '\n',
    'utf8',
  );
  await browser.close();
}
