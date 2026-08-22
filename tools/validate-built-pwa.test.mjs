import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'validate-built-pwa.mjs');

function validBuild() {
  const directory = mkdtempSync(join(tmpdir(), 'roadmap2u-pwa-'));
  const files = {
    'index.html': `<!doctype html><html><head><base href="/"><link rel="manifest" href="manifest.webmanifest"><link rel="stylesheet" href="styles-HASH.css"></head><body><script src="main-HASH.js"></script></body></html>`,
    'manifest.webmanifest': JSON.stringify({
      id: '/',
      scope: '/',
      start_url: '/ahora',
      icons: [{ src: 'icon.png' }],
    }),
    'ngsw.json': JSON.stringify({
      hashTable: {
        '/main-HASH.js': 'hash',
        '/styles-HASH.css': 'hash',
        '/icon.png': 'hash',
      },
    }),
    'sw.js': 'importScripts("./ngsw-worker.js"); self.addEventListener("fetch", () => {});',
    'ngsw-worker.js': '',
    'main-HASH.js': '',
    'styles-HASH.css': '',
    'icon.png': 'png',
  };
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }
  return directory;
}

function validate(directory) {
  return spawnSync(process.execPath, [script, '--build-dir', directory], { encoding: 'utf8' });
}

test('accepts a complete root-hosted PWA build', () => {
  const directory = validBuild();
  try {
    const result = validate(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /build passed/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a missing asset referenced by index.html', () => {
  const directory = validBuild();
  try {
    rmSync(join(directory, 'main-HASH.js'));
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /main-HASH\.js.*missing/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects non-root manifest metadata and missing manifest icons', () => {
  const directory = validBuild();
  try {
    writeFileSync(
      join(directory, 'manifest.webmanifest'),
      JSON.stringify({
        id: '/RoadMap2U/',
        scope: '/',
        start_url: '/ahora',
        icons: [{ src: 'missing.png' }],
      }),
    );
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest id must be "\/"/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects files listed by ngsw.json that are absent from the build', () => {
  const directory = validBuild();
  try {
    writeFileSync(
      join(directory, 'ngsw.json'),
      JSON.stringify({ hashTable: { '/lazy-HASH.js': 'hash' } }),
    );
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lazy-HASH\.js.*missing/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a manifest that installs into the marketing landing', () => {
  const directory = validBuild();
  try {
    writeFileSync(
      join(directory, 'manifest.webmanifest'),
      JSON.stringify({ id: '/', scope: '/', start_url: '/', icons: [{ src: 'icon.png' }] }),
    );
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest start_url must be "\/ahora"/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a service-worker import that is absent from the build', () => {
  const directory = validBuild();
  try {
    rmSync(join(directory, 'ngsw-worker.js'));
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ngsw-worker\.js.*missing/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
