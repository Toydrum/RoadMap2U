import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const generator = join(here, 'generate-config.mjs');
const contractFiles = [
  ['api/contracts.ts', join(root, 'src/app/core/api/contracts.ts')],
  ['db/schema.ts', join(root, 'src/app/core/db/schema.ts')],
  ['auth/auth-types.ts', join(root, 'src/app/core/auth/auth-types.ts')],
  ['i18n/es.ts', join(root, 'src/app/core/i18n/es.ts')],
  ['i18n/en.ts', join(root, 'src/app/core/i18n/en.ts')],
];
const configEnvKeys = [
  'ROADMAP2U_STAGE',
  'ROADMAP2U_REGION',
  'ROADMAP2U_USER_POOL_ID',
  'ROADMAP2U_USER_POOL_CLIENT_ID',
  'ROADMAP2U_API_BASE_URL',
  'ROADMAP2U_CONTRACT_HASH',
];

function localContractHash() {
  const hash = createHash('sha256');
  for (const [relativePath, source] of contractFiles) {
    hash.update(relativePath, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(source, 'utf8').replaceAll('\r\n', '\n'), 'utf8');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of configEnvKeys) delete env[key];
  return env;
}

function validEnvironment(stage = 'dev') {
  const apiHosts = {
    dev: 'api.dev.roadmap2u.com',
    test: 'api.test.roadmap2u.com',
    prod: 'api.roadmap2u.com',
  };
  return {
    ...cleanEnvironment(),
    ROADMAP2U_STAGE: stage,
    ROADMAP2U_REGION: 'us-east-1',
    ROADMAP2U_USER_POOL_ID: 'us-east-1_AbCdEf123',
    ROADMAP2U_USER_POOL_CLIENT_ID: '0123456789abcdefghijklmnop',
    ROADMAP2U_API_BASE_URL: `https://${apiHosts[stage]}/`,
    ROADMAP2U_CONTRACT_HASH: localContractHash(),
  };
}

function runGenerator(env) {
  const temp = mkdtempSync(join(tmpdir(), 'roadmap2u-config-'));
  const output = join(temp, 'generated-config.ts');
  const result = spawnSync(process.execPath, [generator, '--output', output], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return {
    ...result,
    output,
    source: existsSync(output) ? readFileSync(output, 'utf8') : '',
    cleanup: () => rmSync(temp, { recursive: true, force: true }),
  };
}

test('generates the AWS APP_CONFIG shape for dev with optional auth', () => {
  const run = runGenerator(validEnvironment('dev'));
  try {
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.source, /backend: 'aws' as 'mock' \| 'aws'/);
    assert.match(run.source, /requireAuth: false/);
    assert.match(run.source, /region: 'us-east-1'/);
    assert.match(run.source, /userPoolId: 'us-east-1_AbCdEf123'/);
    assert.match(run.source, /userPoolClientId: '0123456789abcdefghijklmnop'/);
    assert.match(run.source, /apiBaseUrl: 'https:\/\/api\.dev\.roadmap2u\.com'/);
    assert.match(run.source, new RegExp(`BACKEND_CONTRACT_SHA256 = '${localContractHash()}'`));
  } finally {
    run.cleanup();
  }
});

for (const stage of ['test', 'prod']) {
  test(`requires authentication in ${stage}`, () => {
    const run = runGenerator(validEnvironment(stage));
    try {
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.source, /requireAuth: true/);
    } finally {
      run.cleanup();
    }
  });
}

test('reports every missing required input without creating output', () => {
  const run = runGenerator(cleanEnvironment());
  try {
    assert.notEqual(run.status, 0);
    for (const key of configEnvKeys) assert.match(run.stderr, new RegExp(key));
    assert.equal(existsSync(run.output), false);
  } finally {
    run.cleanup();
  }
});

test('rejects an API base URL that already contains /v1', () => {
  const env = validEnvironment('prod');
  env.ROADMAP2U_API_BASE_URL = 'https://api.roadmap2u.example/v1';
  const run = runGenerator(env);
  try {
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /must not include \/v1/i);
  } finally {
    run.cleanup();
  }
});

test('rejects unsupported stages', () => {
  const env = validEnvironment('dev');
  env.ROADMAP2U_STAGE = 'qa';
  const run = runGenerator(env);
  try {
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /must be dev, test, or prod/i);
  } finally {
    run.cleanup();
  }
});

test('rejects malformed or cross-region Cognito identifiers', () => {
  const env = validEnvironment('dev');
  env.ROADMAP2U_REGION = 'not-a-region';
  env.ROADMAP2U_USER_POOL_ID = 'eu-west-1_AbCdEf123';
  env.ROADMAP2U_USER_POOL_CLIENT_ID = 'short';
  const run = runGenerator(env);
  try {
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /must be an AWS region/i);
    assert.match(run.stderr, /must belong to ROADMAP2U_REGION/i);
    assert.match(run.stderr, /not a valid Cognito app client id/i);
  } finally {
    run.cleanup();
  }
});

test('pins all AWS stages to us-east-1', () => {
  const env = validEnvironment('dev');
  env.ROADMAP2U_REGION = 'us-west-2';
  env.ROADMAP2U_USER_POOL_ID = 'us-west-2_AbCdEf123';
  const run = runGenerator(env);
  try {
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /must be us-east-1/i);
  } finally {
    run.cleanup();
  }
});

test('rejects an API hostname from a different stage', () => {
  const env = validEnvironment('test');
  env.ROADMAP2U_API_BASE_URL = 'https://api.dev.roadmap2u.com';
  const run = runGenerator(env);
  try {
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /expected https:\/\/api\.test\.roadmap2u\.com/i);
  } finally {
    run.cleanup();
  }
});

for (const apiBaseUrl of [
  'http://api.roadmap2u.com',
  'https://api.roadmap2u.com/some-path',
  'https://api.roadmap2u.com?debug=true',
]) {
  test(`rejects a non-origin API URL: ${apiBaseUrl}`, () => {
    const env = validEnvironment('prod');
    env.ROADMAP2U_API_BASE_URL = apiBaseUrl;
    const run = runGenerator(env);
    try {
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /ROADMAP2U_API_BASE_URL/);
    } finally {
      run.cleanup();
    }
  });
}

test('rejects a backend contract hash that differs from the frontend contract', () => {
  const env = validEnvironment('prod');
  env.ROADMAP2U_CONTRACT_HASH = 'f'.repeat(64);
  const run = runGenerator(env);
  try {
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /contract hash mismatch/i);
  } finally {
    run.cleanup();
  }
});

test('rejects a contract hash that omits the ES/EN shared dictionaries', () => {
  const incompleteHash = createHash('sha256');
  for (const [relativePath, source] of contractFiles.slice(0, 3)) {
    incompleteHash.update(relativePath, 'utf8');
    incompleteHash.update('\0');
    incompleteHash.update(readFileSync(source, 'utf8').replaceAll('\r\n', '\n'), 'utf8');
    incompleteHash.update('\0');
  }
  const env = validEnvironment();
  env.ROADMAP2U_CONTRACT_HASH = incompleteHash.digest('hex');
  const run = runGenerator(env);
  try {
    assert.notEqual(run.status, 0, 'An incomplete three-file contract must not authorize a deployment');
    assert.match(run.stderr, /contract hash mismatch/i);
    assert.equal(existsSync(run.output), false);
  } finally {
    run.cleanup();
  }
});
