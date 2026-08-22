#!/usr/bin/env node

import process from 'node:process';

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value) {
      throw new Error(`Expected a value after ${flag ?? 'an option'}`);
    }
    values.set(flag, value);
  }

  const frontendUrl = values.get('--frontend-url');
  const apiBaseUrl = values.get('--api-base-url');
  const corsOrigin = values.get('--cors-origin');
  if (!frontendUrl || !apiBaseUrl || !corsOrigin) {
    throw new Error('--frontend-url, --api-base-url, and --cors-origin are required');
  }

  return {
    frontendUrl: new URL(frontendUrl),
    apiBaseUrl: new URL(apiBaseUrl),
    corsOrigin: new URL(corsOrigin),
  };
}

function rootUrl(url) {
  const root = new URL(url);
  root.pathname = '/';
  root.search = '';
  root.hash = '';
  return root;
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status < 500 || attempt === 5) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === 5) break;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw lastError;
}

async function requireSuccess(url, description, contentType) {
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw new Error(`${description} returned ${response.status}: ${url}`);
  }
  if (contentType && !response.headers.get('content-type')?.toLowerCase().includes(contentType)) {
    throw new Error(`${description} has an unexpected content type: ${url}`);
  }
  return response;
}

function indexedAssets(indexHtml, baseUrl) {
  const assets = new Set();
  const attributePattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of indexHtml.matchAll(attributePattern)) {
    const value = match[1];
    if (!value || value.startsWith('#') || value.startsWith('data:')) continue;
    const assetUrl = new URL(value, baseUrl);
    if (assetUrl.origin === baseUrl.origin) assets.add(assetUrl.href);
  }
  return assets;
}

function requireCorsOrigin(response, expectedOrigin, description) {
  const allowedOrigin = response.headers.get('access-control-allow-origin');
  if (allowedOrigin !== expectedOrigin) {
    throw new Error(
      `${description} CORS allow-origin must be ${expectedOrigin}, received ${allowedOrigin ?? 'none'}`,
    );
  }
}

function commaSeparatedHeader(response, name) {
  return (response.headers.get(name) ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

async function smokeFrontend(frontendUrl, apiBaseUrl, corsOrigin) {
  const frontendRoot = rootUrl(frontendUrl);
  const apiRoot = rootUrl(apiBaseUrl);
  const expectedCorsOrigin = rootUrl(corsOrigin).origin;

  const indexResponse = await requireSuccess(frontendRoot, 'frontend root', 'text/html');
  const indexHtml = await indexResponse.text();
  if (!/<base\s+href=["']\/["'][^>]*>/i.test(indexHtml)) {
    throw new Error('index.html must contain <base href="/">');
  }

  await requireSuccess(new URL('/account', frontendRoot), 'frontend deep link', 'text/html');
  await requireSuccess(new URL('/ahora', frontendRoot), 'installed product deep link', 'text/html');

  for (const assetUrl of indexedAssets(indexHtml, frontendRoot)) {
    await requireSuccess(assetUrl, 'asset referenced by index.html');
  }

  const manifestUrl = new URL('/manifest.webmanifest', frontendRoot);
  const manifestResponse = await requireSuccess(manifestUrl, 'web app manifest');
  let manifest;
  try {
    manifest = await manifestResponse.json();
  } catch {
    throw new Error('web app manifest must be valid JSON');
  }
  for (const field of ['id', 'scope']) {
    if (manifest[field] !== '/') {
      throw new Error(`manifest ${field} must be "/"`);
    }
  }
  if (manifest.start_url !== '/ahora') {
    throw new Error('manifest start_url must be "/ahora"');
  }
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    throw new Error('manifest must declare at least one icon');
  }
  for (const icon of manifest.icons) {
    if (!icon?.src) throw new Error('every manifest icon must declare src');
    await requireSuccess(new URL(icon.src, manifestUrl), 'manifest icon', 'image/');
  }

  await requireSuccess(new URL('/sw.js', frontendRoot), 'service worker');
  const ngswResponse = await requireSuccess(
    new URL('/ngsw.json', frontendRoot),
    'Angular service worker manifest',
  );
  try {
    await ngswResponse.json();
  } catch {
    throw new Error('ngsw.json must be valid JSON');
  }

  const meUrl = new URL('/v1/me', apiRoot);
  const preflightResponse = await fetchWithRetry(meUrl, {
    method: 'OPTIONS',
    headers: {
      Origin: expectedCorsOrigin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  if (!preflightResponse.ok) {
    throw new Error(`/v1/me CORS preflight returned ${preflightResponse.status}`);
  }
  requireCorsOrigin(preflightResponse, expectedCorsOrigin, '/v1/me preflight');
  if (!commaSeparatedHeader(preflightResponse, 'access-control-allow-methods').includes('get')) {
    throw new Error('/v1/me CORS preflight must allow GET');
  }
  if (!commaSeparatedHeader(preflightResponse, 'access-control-allow-headers').includes('authorization')) {
    throw new Error('/v1/me CORS preflight must allow the authorization header');
  }

  const meResponse = await fetchWithRetry(meUrl, {
    headers: { Origin: expectedCorsOrigin },
  });
  if (meResponse.status !== 401) {
    throw new Error(`/v1/me must return 401, received ${meResponse.status}`);
  }
  requireCorsOrigin(meResponse, expectedCorsOrigin, '/v1/me 401 response');
  if (!meResponse.headers.get('content-type')?.toLowerCase().includes('json')) {
    throw new Error('/v1/me 401 response must be JSON');
  }
  try {
    await meResponse.json();
  } catch {
    throw new Error('/v1/me 401 response must contain valid JSON');
  }
}

try {
  const { frontendUrl, apiBaseUrl, corsOrigin } = readArguments(process.argv.slice(2));
  await smokeFrontend(frontendUrl, apiBaseUrl, corsOrigin);
  console.log('Frontend and API smoke passed.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
