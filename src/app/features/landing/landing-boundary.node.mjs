// Node-only source boundary; kept outside Angular's browser-test discovery.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const HERE = import.meta.dirname;
const source = (name) => readFileSync(resolve(HERE, name), 'utf8');

describe('public landing isolation', () => {
  it('does not import the product canvas, repositories, storage, boot or sync', () => {
    const files = ['landing.ts', 'marketing-tree.ts', 'marketing-locale.service.ts'];
    const joined = files.map(source).join('\n');
    assert.doesNotMatch(
      joined,
      /TreeCanvas|Repo(?:sitory)?|IndexedDB|openDb|BootService|SyncService|Reminder|Accompaniment|BackupService/,
    );
    assert.doesNotMatch(joined, /import\s+(?!type)[^;]*core\/db/);
  });

  it('uses the real pure tree modules and never adds requests or trackers', () => {
    const tree = source('marketing-tree.ts');
    assert.match(tree, /tree-layout/);
    assert.match(tree, /tree-silhouette/);
    assert.match(tree, /tree-forms/);
    assert.match(tree, /flora/);

    const all = [tree, source('landing.ts'), source('landing.html')].join('\n');
    assert.doesNotMatch(all, /fetch\(|XMLHttpRequest|sendBeacon|analytics|gtag|pixel/i);
  });

  it('keeps user-facing copy in the bilingual dictionaries', () => {
    const html = source('landing.html');
    assert.doesNotMatch(html, /Haz visible el camino|Crear mi bosque|Próximamente|See the path/);
    assert.match(html, /copy\(\)\.landing/);
  });
});
