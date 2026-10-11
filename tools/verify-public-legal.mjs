import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BASE, launchPage, ok } from './lib/harness.mjs';
import { loadPrivacyDocuments } from './validate-individual-publication.mjs';

const documents = await loadPrivacyDocuments();
async function verifyCanonicalText(page, path, language, width) {
  const document =
    path === 'privacy'
      ? documents[language].notice
      : path === 'terms'
        ? documents[language].terms
        : null;
  if (!document) return;
  const actual = await page.locator('main').evaluate((main) => ({
    intro: main.querySelector('.intro').textContent.trim(),
    sections: [...main.querySelectorAll('section')].map((section) => ({
      title: section.querySelector('h2').textContent.trim(),
      paragraphs: [...section.querySelectorAll('p')].map((p) => p.textContent.trim()),
    })),
  }));
  ok(
    `${width} /${path} ${language} exact canonical text`,
    JSON.stringify(actual) ===
      JSON.stringify({ intro: document.intro, sections: document.sections }),
  );
}

const output = resolve(process.env.RM_LEGAL_SCREENSHOTS ?? 'tools/battery-logs/public-legal');
await mkdir(output, { recursive: true });
for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  const { browser, page } = await launchPage(viewport, {
    commercialAccess: false,
    contextOptions: { serviceWorkers: 'block', reducedMotion: 'reduce' },
  });
  const errors = [],
    apiRequests = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/\/v1(?:\/|$)/.test(url.pathname) || url.hostname.includes('amazonaws'))
      apiRequests.push(request.url());
  });
  await page.addInitScript(() => {
    const activity = (window.__publicLegalActivity = {
      databaseOpens: 0,
      storageWrites: 0,
      serviceWorkerRegistrations: 0,
    });
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      activity.databaseOpens++;
      return open(...args);
    };
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (...args) {
      activity.storageWrites++;
      return set.apply(this, args);
    };
    if (navigator.serviceWorker) {
      const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = (...args) => {
        activity.serviceWorkerRegistrations++;
        return register(...args);
      };
    }
  });
  try {
    const width = viewport.width;
    for (const [path, title, english] of [
      ['privacy', documents.es.notice.title, documents.en.notice.title],
      ['terms', documents.es.terms.title, documents.en.terms.title],
      ['support', 'Soporte y cuidado', 'Support and care'],
    ]) {
      await page.goto(`${BASE}/${path}`, { waitUntil: 'networkidle' });
      ok(
        `${width} /${path} public heading`,
        (await page.locator('app-legal-page h1').textContent()) === title,
      );
      ok(
        `${width} /${path} data choices guidance`,
        await page
          .locator('[data-review-status]')
          .innerText()
          .then((t) => t.includes('Tus decisiones sobre tus datos') && !t.includes('Borrador')),
      );
      ok(`${width} /${path} one main`, (await page.locator('main').count()) === 1);
      ok(
        `${width} /${path} current document`,
        (await page.locator(`footer a[href="/${path}"]`).getAttribute('aria-current')) === 'page',
      );
      ok(
        `${width} /${path} confirmed support contact`,
        (await page.locator('main').innerText()).includes('overseer@roadmap2u.com') &&
          (await page
            .locator('a[href^="mailto:"]')
            .evaluateAll((links) =>
              links.every((link) => link.getAttribute('href') === 'mailto:overseer@roadmap2u.com'),
            )),
      );
      await verifyCanonicalText(page, path, 'es', width);
      ok(
        `${width} /${path} no overflow`,
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      );
      await page.locator('[data-lang="en"]').click();
      await page.locator('h1', { hasText: english }).waitFor();
      ok(
        `${width} /${path} English heading and lang`,
        (await page.locator('h1').textContent()) === english &&
          (await page.locator('html').getAttribute('lang')) === 'en',
      );
      await verifyCanonicalText(page, path, 'en', width);
      const activity = await page.evaluate(() => window.__publicLegalActivity);
      ok(
        `${width} /${path} no storage or SW startup`,
        Object.values(activity).every((v) => v === 0),
        JSON.stringify(activity),
      );
      await page.locator('[data-lang="es"]').click();
      await page.locator('h1', { hasText: title }).waitFor();
      await page.screenshot({ path: resolve(output, `${path}-${width}.png`), fullPage: true });
    }
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    ok(
      `${width} landing family invitation`,
      (await page.locator('.key-section h2').textContent()) === 'Familias por invitación',
    );
    ok(
      `${width} landing no redemption promise`,
      !(await page.locator('.key-section').innerText()).includes('canjear'),
    );
    ok(
      `${width} landing no purchase form`,
      (await page.locator('form,[href*="stripe"],[href*="checkout"]').count()) === 0,
    );
    for (const path of ['privacy', 'terms', 'support']) {
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      await page.locator(`.site-footer a[href="/${path}"]`).first().click();
      await page.locator('app-legal-page h1').waitFor();
      ok(`${width} footer /${path} navigation`, new URL(page.url()).pathname === '/' + path);
      await page.locator('[data-home]').click();
      await page.locator('app-landing h1').waitFor();
    }
    await page.goto(BASE + '/privacy', { waitUntil: 'networkidle' });
    await page.keyboard.press('Tab');
    ok(
      `${width} keyboard skip link`,
      await page.locator('.skip-link').evaluate((e) => document.activeElement === e),
    );
    await page.keyboard.press('Enter');
    ok(
      `${width} keyboard main destination`,
      await page.locator('main').evaluate((e) => document.activeElement === e),
    );
    ok(`${width} public pages zero API requests`, apiRequests.length === 0);
    ok(`${width} public pages zero page errors`, errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }
}
