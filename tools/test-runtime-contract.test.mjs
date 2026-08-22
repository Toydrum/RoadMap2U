import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('disables the Node Web Storage global for browser-like unit tests', async () => {
  const npmConfig = await readFile(new URL('../.npmrc', import.meta.url), 'utf8');

  assert.match(npmConfig, /^node-options\s*=.*--no-experimental-webstorage\s*$/m);
});
