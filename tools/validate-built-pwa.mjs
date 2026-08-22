#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import process from 'node:process';

function buildDirectory(argv) {
  if (argv.length !== 2 || argv[0] !== '--build-dir' || !argv[1]) {
    throw new Error('--build-dir is required');
  }
  return resolve(argv[1]);
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
}

function readJson(path, label) {
  requireFile(path, label);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} must contain valid JSON: ${path}`);
  }
}

function assetPath(root, reference, label) {
  if (
    !reference ||
    reference === '/' ||
    reference.startsWith('#') ||
    reference.startsWith('data:')
  ) {
    return null;
  }
  const url = new URL(reference, 'https://roadmap2u.invalid/');
  if (url.origin !== 'https://roadmap2u.invalid') return null;
  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes the build directory: ${reference}`);
  }
  return candidate;
}

function validateAsset(root, reference, label) {
  const path = assetPath(root, reference, label);
  if (path) requireFile(path, `${label} ${reference}`);
}

function validateBuild(root) {
  const indexPath = resolve(root, 'index.html');
  requireFile(indexPath, 'index.html');
  const indexHtml = readFileSync(indexPath, 'utf8');
  if (!/<base\b[^>]*\bhref=["']\/["'][^>]*>/i.test(indexHtml)) {
    throw new Error('index.html must contain a root <base href="/">');
  }

  const indexedReferences = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of indexHtml.matchAll(indexedReferences)) {
    validateAsset(root, match[1], 'index.html asset');
  }

  const manifestPath = resolve(root, 'manifest.webmanifest');
  const manifest = readJson(manifestPath, 'manifest.webmanifest');
  for (const field of ['id', 'scope']) {
    if (manifest[field] !== '/') throw new Error(`manifest ${field} must be "/"`);
  }
  if (manifest.start_url !== '/ahora') {
    throw new Error('manifest start_url must be "/ahora"');
  }
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    throw new Error('manifest must declare at least one icon');
  }
  for (const icon of manifest.icons) {
    if (!icon?.src) throw new Error('every manifest icon must declare src');
    validateAsset(root, icon.src, 'manifest icon');
  }

  const serviceWorkerPath = resolve(root, 'sw.js');
  requireFile(serviceWorkerPath, 'sw.js');
  requireFile(resolve(root, 'ngsw-worker.js'), 'ngsw-worker.js');
  const serviceWorker = readFileSync(serviceWorkerPath, 'utf8');
  for (const call of serviceWorker.matchAll(/importScripts\s*\(([^)]*)\)/g)) {
    for (const imported of call[1].matchAll(/["']([^"']+)["']/g)) {
      validateAsset(root, imported[1], 'service-worker import');
    }
  }
  const ngsw = readJson(resolve(root, 'ngsw.json'), 'ngsw.json');
  if (!ngsw.hashTable || typeof ngsw.hashTable !== 'object' || Array.isArray(ngsw.hashTable)) {
    throw new Error('ngsw.json must contain a hashTable object');
  }
  for (const reference of Object.keys(ngsw.hashTable)) {
    validateAsset(root, reference, 'ngsw.json asset');
  }
}

try {
  const directory = buildDirectory(process.argv.slice(2));
  validateBuild(directory);
  console.log(`PWA build passed local validation: ${directory}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
