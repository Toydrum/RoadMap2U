import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd();
const source = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

test('the config suite always runs the battery harness contract', () => {
  const pkg = JSON.parse(source('package.json'));
  assert.match(pkg.scripts['test:config'], /tools\/battery-harness\.test\.mjs/);
});

test('the harness provides one deterministic Premium lease for mutation probes', async () => {
  const { commercialAccessFixture } = await import('./lib/harness.mjs');
  const now = 1_800_000_000_000;
  const fixture = commercialAccessFixture(now);

  assert.equal(fixture.identity.key, 'auth.identity');
  assert.equal(fixture.identity.user.userId, 'battery-probe-adult');
  assert.equal(fixture.cache.key, 'commercial.access:battery-probe-adult');
  assert.equal(fixture.cache.userId, fixture.identity.user.userId);
  assert.equal(fixture.cache.summary.effectivePlanKey, 'premium');
  assert.equal(fixture.cache.summary.catalogVersion, '2026-09-family-v1');
  assert.equal(fixture.cache.summary.status, 'active');
  assert.equal(fixture.cache.summary.activeSources[0].kind, 'sponsored');
  assert.equal(fixture.cache.summary.limits.maxActiveTrees, null);
  assert.equal(fixture.cache.summary.limits.maxVisibleBranchesPerTree, null);
  assert.equal(fixture.cache.summary.offlineValidUntil, now + 24 * 60 * 60 * 1000);
});

test('launchPage provisions access without intercepting mock authentication', () => {
  const harness = source('tools/lib/harness.mjs');
  assert.match(harness, /commercialAccess\s*=\s*true/);
  assert.match(harness, /provisionCommercialAccess/);
  assert.match(harness, /export async function newProbePage/);
  assert.doesNotMatch(harness, /Storage\.prototype\.getItem\s*=/);
  assert.doesNotMatch(harness, /skip only the first token read/i);
  const provisioner = harness.slice(
    harness.indexOf('export async function provisionCommercialAccess'),
    harness.indexOf('/** Give the identity'),
  );
  assert.match(provisioner, /`\$\{BASE\}\/account`/);
  assert.doesNotMatch(provisioner, /goto\(`\$\{BASE\}\/forest/);
});

test('the sign-in helper preserves challenge and expected-error probe paths', () => {
  const harness = source('tools/lib/harness.mjs');
  assert.match(harness, /expect\s*=\s*'profile'/);
  assert.match(harness, /expect === 'challenge'/);
  assert.match(harness, /expect === 'error'/);
  assert.match(harness, /export async function provisionSignedInAccess/);
});

test('the auth probe waits for durable sign-out before booting another route', () => {
  const harness = source('tools/lib/harness.mjs');
  const auth = source('tools/verify-auth.mjs');
  assert.match(harness, /export async function waitForAuthIdentityCleared/);
  const firstSignOut = auth.indexOf("hasText: 'Cerrar sesión'");
  const guestSettings = auth.indexOf('// G2 — Settings card back to the guest invitation.');
  assert.ok(firstSignOut > 0 && guestSettings > firstSignOut);
  assert.match(auth.slice(firstSignOut, guestSettings), /await waitForAuthIdentityCleared\(page\)/);
});

test('a virgin-state probe can provision access only after its migration assertions', async () => {
  const { provisionCommercialAccessForNextBoot } = await import('./lib/harness.mjs');
  const calls = [];
  const page = {
    addInitScript: async () => calls.push('guard'),
    goto: async (url) => calls.push(`goto:${url}`),
    locator: (selector) => ({ waitFor: async () => calls.push(`wait:${selector}`) }),
    evaluate: async () => calls.push('write'),
  };

  await provisionCommercialAccessForNextBoot(page);
  assert.deepEqual(calls, [
    `goto:http://localhost:8826/account`,
    'wait:app-account',
    'write',
  ]);

  const migration = source('tools/verify-migration.mjs');
  const afterCopy = migration.indexOf('// C — a later write');
  assert.ok(afterCopy > 0);
  assert.match(migration.slice(0, afterCopy), /await provisionCommercialAccessForNextBoot\(page\)/);
});

test('home-route probes assert the landing before entering the real Ahora deep link', () => {
  for (const script of ['tools/verify-ahora.mjs', 'tools/verify-checkin2.mjs']) {
    const probe = source(script);
    assert.match(probe, /app-landing/);
    assert.match(probe, /`\$\{BASE\}\/ahora`/);
  }
});

test('the public-shell probe can reuse an already reachable battery server', async () => {
  const { ensureProbeServer } = await import('./lib/probe-server.mjs');
  let listened = false;
  const close = await ensureProbeServer({
    base: 'http://battery.test:8826',
    server: { listen: () => (listened = true) },
    fetchImpl: async () => ({ ok: true }),
  });

  assert.equal(listened, false);
  assert.equal(close, null);
});

function individualFixturePage({ instance = 'current', type = 'adult', url = 'http://localhost:8826/account' } = {}) {
  const deletes = [], stores = [];
  const owner = { userId: 'synthetic-buyer', accountInstanceId: instance, accountType: type };
  const token = 'synthetic.' + Buffer.from(JSON.stringify({ sub: owner.userId, accountInstanceId: 'current' })).toString('base64') + '.mock';
  const page = {
    url: () => url,
    evaluate: async fn => vm.runInNewContext('(' + fn.toString() + ')()', {
      atob: value => Buffer.from(value, 'base64').toString(),
      localStorage: { getItem: key => { assert.equal(key, 'rm2u.mock.idToken'); return token; } },
      indexedDB: { open: name => {
        assert.equal(name, 'roadmap2u-mockcloud'); const request = {};
        queueMicrotask(() => { request.result = { close() {}, transaction(names, mode) {
          assert.equal(mode, 'readwrite'); assert.deepEqual(Array.from(names), ['users', 'coverages']);
          const tx = { objectStore(store) {
            stores.push(store);
            return { get(key) { assert.equal(store, 'users'); assert.equal(key, owner.userId); const read = {}; queueMicrotask(() => { read.result = owner; read.onsuccess(); }); return read; },
              delete(key) { assert.equal(store, 'coverages'); deletes.push([store,key]); queueMicrotask(() => tx.oncomplete()); } };
          }, abort() { queueMicrotask(() => tx.onabort()); } }; return tx;
        } }; request.onsuccess(); }); return request;
      } },
    }),
  };
  return { page, deletes, stores };
}
test('individual fixture removes only its own synthetic legacy coverage and leaves financial stores untouched', async () => {
  const { isolateIndividualBillingFixture } = await import('./lib/individual-probe-fixture.mjs');
  const f = individualFixturePage(); await isolateIndividualBillingFixture(f.page);
  assert.deepEqual(f.deletes, [['coverages', 'synthetic-buyer']]); assert.deepEqual(f.stores, ['users', 'coverages']);
});
test('individual fixture rejects another incarnation before deleting a coverage', async () => {
  const { isolateIndividualBillingFixture } = await import('./lib/individual-probe-fixture.mjs');
  const f = individualFixturePage({ instance: 'retired' });
  await assert.rejects(() => isolateIndividualBillingFixture(f.page), /CURRENT_SYNTHETIC_ADULT_REQUIRED/); assert.equal(f.deletes.length,0);
});
test('individual fixture rejects a minor before deleting a coverage', async () => {
  const { isolateIndividualBillingFixture } = await import('./lib/individual-probe-fixture.mjs');
  const f = individualFixturePage({ type: 'minor' });
  await assert.rejects(() => isolateIndividualBillingFixture(f.page), /CURRENT_SYNTHETIC_ADULT_REQUIRED/); assert.equal(f.deletes.length,0);
});
test('individual fixture rejects a nonlocal origin without evaluating browser storage', async () => {
  const { isolateIndividualBillingFixture } = await import('./lib/individual-probe-fixture.mjs'); let calls=0;
  await assert.rejects(() => isolateIndividualBillingFixture({url:()=> 'https://dev.roadmap2u.com/account',evaluate:async()=>{calls++;}}), /LOCAL_INDIVIDUAL_FIXTURE_REQUIRED/); assert.equal(calls,0);
});

function retiringIdentityPage({
  clearAfter = Infinity,
  openError = false,
  readError = false,
  missingMeta = false,
} = {}) {
  const facts = { opens: 0, reads: 0, closes: 0 };
  const evaluate = async (fn) =>
    vm.runInNewContext('(' + fn.toString() + ')()', {
      indexedDB: {
        open(name) {
          assert.equal(name, 'roadmap2u');
          facts.opens++;
          const request = {};
          queueMicrotask(() => {
            if (openError) {
              request.onerror();
              return;
            }
            request.result = {
              close() {
                facts.closes++;
              },
              objectStoreNames: { contains: (name) => name === 'meta' && !missingMeta },
              transaction(name, mode) {
                assert.equal(name, 'meta');
                assert.equal(mode, 'readonly');
                return {
                  objectStore(name) {
                    assert.equal(name, 'meta');
                    return {
                      get(key) {
                        assert.equal(key, 'auth.identity');
                        facts.reads++;
                        const read = {};
                        queueMicrotask(() => {
                          if (readError) {
                            read.onerror();
                            return;
                          }
                          read.result =
                            facts.reads >= clearAfter
                              ? undefined
                              : { key, user: { userId: 'retiring-synthetic-user' } };
                          read.onsuccess();
                        });
                        return read;
                      },
                    };
                  },
                };
              },
            };
            request.onsuccess();
          });
          return request;
        },
      },
    });
  // Reproduce the observed browser contract: an asynchronous callback can
  // resolve false once; that is not proof that the stored identity is gone.
  return { facts, page: { evaluate, waitForFunction: evaluate } };
}

test('durable sign-out never completes while the stored identity remains', async () => {
  const { waitForAuthIdentityCleared } = await import('./lib/harness.mjs');
  const fixture = retiringIdentityPage();
  await assert.rejects(
    () => waitForAuthIdentityCleared(fixture.page, 50),
    /AUTH_IDENTITY_NOT_CLEARED/,
  );
  assert.ok(fixture.facts.reads >= 1);
});

test('durable sign-out waits through false reads until identity cleanup completes', async () => {
  const { waitForAuthIdentityCleared } = await import('./lib/harness.mjs');
  const fixture = retiringIdentityPage({ clearAfter: 3 });
  await waitForAuthIdentityCleared(fixture.page, 500);
  assert.equal(fixture.facts.reads, 3);
  assert.equal(fixture.facts.closes, fixture.facts.opens);
});

for (const failure of ['openError', 'readError'])
  test('unreadable identity storage cannot pass sign-out: ' + failure, async () => {
    const { waitForAuthIdentityCleared } = await import('./lib/harness.mjs');
    const fixture = retiringIdentityPage({ [failure]: true });
    await assert.rejects(
      () => waitForAuthIdentityCleared(fixture.page, 100),
      /AUTH_IDENTITY_STORAGE_UNAVAILABLE/,
    );
    assert.equal(fixture.facts.opens, 1);
  });

test('a readable database without an identity store is already clear', async () => {
  const { waitForAuthIdentityCleared } = await import('./lib/harness.mjs');
  const fixture = retiringIdentityPage({ missingMeta: true });
  await waitForAuthIdentityCleared(fixture.page, 100);
  assert.equal(fixture.facts.opens, 1);
  assert.equal(fixture.facts.reads, 0);
  assert.equal(fixture.facts.closes, 1);
});

test('a stalled browser read still stops at the sign-out deadline', { timeout: 500 }, async () => {
  const { waitForAuthIdentityCleared } = await import('./lib/harness.mjs');
  let reads = 0;
  const page = {
    evaluate() {
      reads++;
      return new Promise(() => {});
    },
  };
  await assert.rejects(() => waitForAuthIdentityCleared(page, 30), /AUTH_IDENTITY_NOT_CLEARED/);
  assert.equal(reads, 1);
});

function probeBrowserFixture({ setupError } = {}) {
  const events = [];
  const pages = [];
  let contextOptions;
  const context = {
    async newPage() {
      const number = pages.length + 1;
      events.push(`page:${number}`);
      const page = {
        async goto(url) {
          events.push(`goto:${number}:${url}`);
          if (setupError) throw setupError;
        },
        locator(selector) {
          return { async waitFor() { events.push(`wait:${number}:${selector}`); } };
        },
        async evaluate() { events.push(`write:${number}`); },
        async close() { events.push(`page-close:${number}`); },
      };
      pages.push(page);
      return page;
    },
    async close() { events.push('context-close'); },
  };
  const browser = {
    async newContext(options) {
      contextOptions = options;
      events.push('context');
      return context;
    },
    async close() { events.push('browser-close'); },
  };
  return { browser, context, events, pages, contextOptions: () => contextOptions };
}

test('context preparation is awaited before the default setup page and actual probe page', async () => {
  const { newProbePage } = await import('./lib/harness.mjs');
  const f = probeBrowserFixture();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const loading = newProbePage(f.browser, { width: 321, height: 654 }, {
    contextOptions: { serviceWorkers: 'block' },
    async prepareContext(context) {
      assert.equal(context, f.context);
      f.events.push('prepare-start');
      await barrier;
      f.events.push('prepare-end');
    },
  });
  let result;
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.events, ['context', 'prepare-start']);
    assert.equal(f.pages.length, 0);
  } finally {
    release();
    result = await loading;
  }
  assert.equal(result.browser, f.browser);
  assert.equal(result.context, f.context);
  assert.equal(result.page, f.pages[1]);
  assert.deepEqual(f.contextOptions(), {
    viewport: { width: 321, height: 654 }, serviceWorkers: 'block',
  });
  assert.deepEqual(f.events, [
    'context', 'prepare-start', 'prepare-end', 'page:1',
    'goto:1:http://localhost:8826/account', 'wait:1:app-account', 'write:1',
    'page-close:1', 'page:2',
  ]);
});

test('context preparation also precedes the only page when commercial setup is disabled', async () => {
  const { newProbePage } = await import('./lib/harness.mjs');
  const f = probeBrowserFixture();
  const result = await newProbePage(f.browser, undefined, {
    commercialAccess: false,
    async prepareContext(context) {
      assert.equal(context, f.context);
      await Promise.resolve();
      f.events.push('prepared');
    },
  });
  assert.deepEqual(f.events, ['context', 'prepared', 'page:1']);
  assert.equal(result.page, f.pages[0]);
  assert.deepEqual(f.contextOptions(), { viewport: { width: 900, height: 800 } });
});

test('failed asynchronous context preparation closes its context without creating a page', async () => {
  const { newProbePage } = await import('./lib/harness.mjs');
  const f = probeBrowserFixture();
  const failure = Error('synthetic preparation failed');
  await assert.rejects(() => newProbePage(f.browser, undefined, {
    async prepareContext() { await Promise.resolve(); throw failure; },
  }), error => error === failure);
  assert.deepEqual(f.events, ['context', 'context-close']);
  assert.equal(f.pages.length, 0);
});

test('launch failure closes the owned browser after the failed context is closed', async () => {
  const { chromium } = await import('playwright-core');
  const { launchPage } = await import('./lib/harness.mjs');
  const originalLaunch = chromium.launch;
  const f = probeBrowserFixture();
  const failure = Error('synthetic context gate failed');
  let launchOptions;
  chromium.launch = async options => { launchOptions = options; return f.browser; };
  try {
    await assert.rejects(() => launchPage(undefined, {
      async prepareContext() { await Promise.resolve(); throw failure; },
    }), error => error === failure);
    assert.deepEqual(launchOptions, { channel: 'msedge', headless: true });
    assert.deepEqual(f.events, ['context', 'context-close', 'browser-close']);
  } finally {
    chromium.launch = originalLaunch;
  }
});

test('failed commercial setup closes the context rather than leaving its setup page alive', async () => {
  const { newProbePage } = await import('./lib/harness.mjs');
  const failure = Error('synthetic setup navigation failed');
  const f = probeBrowserFixture({ setupError: failure });
  await assert.rejects(() => newProbePage(f.browser), error => error === failure);
  assert.deepEqual(f.events, [
    'context', 'page:1', 'goto:1:http://localhost:8826/account', 'context-close',
  ]);
  assert.equal(f.pages.length, 1);
});
