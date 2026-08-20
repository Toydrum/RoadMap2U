#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function rewriteLegacyPagesManifest(artifactDirectory) {
  const manifestPath = resolve(artifactDirectory, 'manifest.webmanifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.id = '/RoadMap2U/';
  manifest.scope = '/RoadMap2U/';
  manifest.start_url = '/RoadMap2U/ahora';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifactDirectory = process.argv[2];
  if (!artifactDirectory) {
    throw new Error('Usage: node tools/prepare-pages-artifact.mjs <artifact-directory>');
  }
  rewriteLegacyPagesManifest(artifactDirectory);
}
