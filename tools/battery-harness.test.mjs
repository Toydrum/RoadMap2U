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
  assert.match(harness, /return newProbePage\(browser/);
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
