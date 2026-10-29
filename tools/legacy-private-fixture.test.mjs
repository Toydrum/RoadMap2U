import assert from 'node:assert/strict';
import test from 'node:test';
import { provisionLegacyPrivateFixture } from './lib/legacy-private-fixture.mjs';

for (const url of ['https://roadmap2u.com/account', 'https://localhost/account', 'http://example.test/account']) {
  test(`legacy fixture refuses ${url} before reading or changing browser state`, async () => {
    let accessed = false;
    const page = { url: () => url, locator: () => { accessed = true; throw new Error('unexpected browser access'); }, evaluate: () => { accessed = true; throw new Error('unexpected browser write'); } };
    await assert.rejects(provisionLegacyPrivateFixture(page, { prefix: 'privacy' }), /local legacy mock fixture only/);
    assert.equal(accessed, false);
  });
}
test('legacy fixture refuses arbitrary account namespaces', async () => {
  const page = { url: () => 'http://localhost:8826/account' };
  await assert.rejects(provisionLegacyPrivateFixture(page, { prefix: 'existing_person' }), /synthetic legacy probe namespace required/);
});
