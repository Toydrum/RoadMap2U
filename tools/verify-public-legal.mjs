import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { BASE, launchPage, ok } from './lib/harness.mjs';
import { loadPrivacyDocuments } from './validate-individual-publication.mjs';

const documents = await loadPrivacyDocuments('common');
// Golden digests of the exact retained accepted texts; a versioned reader must
// never substitute the current text for an older accepted contract.
const subscriptionDocuments = [
  { version: 'individual-subscription-2026-10-29-v2', hashes: { es: 'fa6a70fa00efb678cbca133e4b00983f9fb762c9b7df2ba6708a7376eedca415', en: '65f96bad7dfa5b18bb0a1008425b690b34bd49af9e1d16924e9c511a87b43dde' } },
  { version: 'individual-subscription-2026-10-28-v1', hashes: { es: '13543a806aa2af12f357d0c6c0ba1dcecbe08574533915fad1c9e30a222d9899', en: '0cb10b9e1bdb4a753198e7a9fd738507264963958745e4697e3075a104bb5a36' } },
];
async function verifySubscriptionText(page, expected, language, width) {
  const actual = (await page.locator('main section p').textContent()).trim();
  ok(`${width} ${expected.version} ${language} exact retained text`,
    createHash('sha256').update(actual).digest('hex') === expected.hashes[language] &&
    (await page.locator('main section h2').textContent()).trim() === expected.version);
}
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
        (await page.locator(`footer a[href^="/${path}?"]`).getAttribute('aria-current')) === 'page',
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
    await page.goto(`${BASE}/subscription-terms?lang=en`, { waitUntil: 'networkidle' });
    await verifySubscriptionText(page, subscriptionDocuments[0], 'en', width);
    for (const expected of subscriptionDocuments) {
      await page.goto(`${BASE}/subscription-terms?lang=es&version=${expected.version}`, { waitUntil: 'networkidle' });
      await verifySubscriptionText(page, expected, 'es', width);
      await page.locator('[data-lang="en"]').click();
      await page.waitForURL((url) => url.searchParams.get('lang') === 'en');
      await page.getByRole('heading', { name: 'Subscription terms', exact: true }).waitFor();
      await verifySubscriptionText(page, expected, 'en', width);
      const query = new URL(page.url()).searchParams;
      ok(`${width} ${expected.version} locale preserves exact selected version`, query.get('version') === expected.version);
      const footer = new URL(await page.locator('footer a[href^="/subscription-terms?"]').getAttribute('href'), BASE);
      ok(`${width} ${expected.version} footer preserves language and version`, footer.searchParams.get('lang') === 'en' && footer.searchParams.get('version') === expected.version);
      ok(`${width} ${expected.version} no overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: resolve(output, `subscription-${expected.version}-${width}.png`), fullPage: true });
    }
    await page.goto(`${BASE}/subscription-terms?lang=en&version=unlisted-subscription-version`, { waitUntil: 'networkidle' });
    ok(`${width} unknown version is explicitly unavailable without another contract`,
      (await page.locator('main [role="alert"]').innerText()).includes('not available') &&
      (await page.locator('main section').count()) === 0);
    await page.locator('[data-lang="es"]').click();
    await page.waitForURL((url) => url.searchParams.get('lang') === 'es');
    await page.getByRole('heading', { name: 'Condiciones de suscripción', exact: true }).waitFor();
    ok(`${width} unknown version remains unavailable across a locale change`,
      new URL(page.url()).searchParams.get('version') === 'unlisted-subscription-version' &&
      (await page.locator('main [role="alert"]').innerText()).includes('no está disponible') &&
      (await page.locator('main section').count()) === 0);
    const subscriptionActivity = await page.evaluate(() => window.__publicLegalActivity);
    ok(`${width} historical and unavailable readers start no storage or SW`, Object.values(subscriptionActivity).every((value) => value === 0));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    ok(
      `${width} landing has no unreleased family invitation`,
      (await page.locator('.key-section').count()) === 0,
    );
    ok(
      `${width} landing no purchase form`,
      (await page.locator('form,[href*="stripe"],[href*="checkout"]').count()) === 0,
    );
    for (const path of ['privacy', 'terms', 'support']) {
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      await page.locator(`.site-footer a[href^="/${path}?"]`).first().click();
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
