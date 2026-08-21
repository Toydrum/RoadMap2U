import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('disables the Node Web Storage global for browser-like unit tests', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));

  assert.match(packageJson.scripts.test, /node --no-experimental-webstorage .*ng\.js test/);
});
