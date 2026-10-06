import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { rewriteLegacyPagesManifest } from './prepare-pages-artifact.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

test('each AWS workflow expires stable public assets before its smoke and release marker', () => {
  const stepName = 'Invalidate public assets without hashed filenames';
  for (const workflowPath of ['.github/workflows/deploy-aws-dev.yml', '.github/workflows/promote-aws.yml', '.github/workflows/rollback-aws.yml']) {
    const workflow = read(workflowPath), start = workflow.indexOf(`      - name: ${stepName}`);
    assert.ok(start >= 0, `${workflowPath} must expire public icons after publication`);
    const next = workflow.indexOf('\n      - name:', start + 1);
    const step = workflow.slice(start, next < 0 ? undefined : next);
    const run = step.match(/        run: \|\n([\s\S]*)/);
    assert.ok(run, 'the cache operation must be an executable workflow step');
    const shell = run[1].replace(/^          /gm, '');
    assert.ok(workflow.indexOf('publish-aws-site.sh') < start);
    assert.match(workflow.slice(next), /Smoke/);
    const temp = mkdtempSync(join(tmpdir(), 'roadmap-cache-workflow-'));
    const unix = path => process.platform === 'win32' ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : path;
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const log = join(temp, 'aws.log');
    try {
      writeFileSync(join(temp, 'aws'), '#!/usr/bin/env bash\nprintf "%s\\0" "$@" >> "$QA_AWS_LOG"\nprintf "\\n" >> "$QA_AWS_LOG"\ncase "$1 $2" in\n  "cloudfront create-invalidation") printf "CACHEINV123\\n" ;;\n  "cloudfront wait") exit 0 ;;\n  *) printf "Unexpected AWS call\\n" >&2; exit 1 ;;\nesac\n', { mode: 0o700 });
      execFileSync(bash, ['-c', 'export PATH="$QA_SHIM_DIR:$PATH"\n' + shell], {
        encoding: 'utf8', timeout: 10000, windowsHide: true,
        env: { ...process.env, QA_SHIM_DIR: unix(temp), QA_AWS_LOG: unix(log), DISTRIBUTION_ID: 'DISTTEST123' },
      });
      const calls = readFileSync(log, 'utf8').trimEnd().split('\n').map(line => line.split('\0').filter(Boolean));
      assert.equal(calls.length, 2, 'one invalidation followed by its completion wait');
      const create = calls[0], wait = calls[1];
      assert.deepEqual(create.slice(0, 2), ['cloudfront', 'create-invalidation']);
      assert.equal(create[create.indexOf('--distribution-id') + 1], 'DISTTEST123');
      const paths = create.slice(create.indexOf('--paths') + 1, create.indexOf('--query'));
      for (const asset of ['/icons/icon-192x192.png', '/icons/logo.svg', '/favicon.ico']) {
        assert.ok(paths.some(path => path === asset || path.endsWith('*') && asset.startsWith(path.slice(0, -1))), `${workflowPath}: stale ${asset} must be evicted`);
      }
      assert.ok(!paths.includes('/*'), 'hashed bundles keep their cache');
      assert.deepEqual(wait, ['cloudfront', 'wait', 'invalidation-completed', '--distribution-id', 'DISTTEST123', '--id', 'CACHEINV123']);
    } finally {
      assert.equal(dirname(temp), tmpdir());
      rmSync(temp, { recursive: true, force: true });
    }
  }
});

test('the installable PWA is rooted at the canonical domain', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(manifest.id, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.start_url, '/ahora');
});

test('the Cognito client signs in with username only', () => {
  const provider = read('src/app/core/auth/cognito-auth.provider.ts');
  assert.match(provider, /loginWith:\s*\{\s*username:\s*true\s*\}/);
  assert.doesNotMatch(provider, /loginWith:[^\n]*email:\s*true/);
});

test('the legacy Pages deployment is manual-only', () => {
  const workflow = read('.github/workflows/deploy.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s{2}push:/m);
  assert.match(workflow, /prepare-pages-artifact\.mjs/);
});

test('the legacy Pages artifact receives its historical subpath scope only after build', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roadmap2u-pages-'));
  try {
    const path = join(directory, 'manifest.webmanifest');
    writeFileSync(
      path,
      JSON.stringify({ id: '/', scope: '/', start_url: '/ahora', name: 'RoadMap2U' }),
      'utf8',
    );
    rewriteLegacyPagesManifest(directory);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(manifest.id, '/RoadMap2U/');
    assert.equal(manifest.scope, '/RoadMap2U/');
    assert.equal(manifest.start_url, '/RoadMap2U/ahora');
    assert.equal(manifest.name, 'RoadMap2U');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AWS workflows are gated and consume every field from an immutable backend manifest', () => {
  const workflows = [
    read('.github/workflows/deploy-aws-dev.yml'),
    read('.github/workflows/promote-aws.yml'),
    read('.github/workflows/rollback-aws.yml'),
  ].join('\n');
  const reader = read('tools/read-backend-release.sh');
  assert.match(workflows, /AWS_DEPLOY_ENABLED/);
  assert.match(workflows, /read-backend-release\.sh/);
  assert.match(reader, /backend-release-manifests\/\$BACKEND_RELEASE_SHA/);
  for (const field of [
    'region',
    'userPoolId',
    'userPoolClientId',
    'apiBaseUrl',
    'frontendBucket',
    'cloudFrontDistributionId',
    'frontendUrl',
    'contractHash',
  ]) {
    assert.match(reader, new RegExp(`\\.${field}`));
  }
});

test('deploy and rollback mutations are guarded by mutually exclusive repository gates', () => {
  const dev = read('.github/workflows/deploy-aws-dev.yml');
  assert.match(
    dev,
    /if: \$\{\{ vars\.AWS_DEPLOY_ENABLED == 'true' && vars\.AWS_ROLLBACK_ENABLED == 'false' && github\.ref == 'refs\/heads\/main' \}\}/,
  );

  const promotion = read('.github/workflows/promote-aws.yml');
  assert.match(
    promotion,
    /if: \$\{\{ vars\.AWS_DEPLOY_ENABLED == 'true' && vars\.AWS_ROLLBACK_ENABLED == 'false' \}\}/,
  );

  const rollback = read('.github/workflows/rollback-aws.yml');
  assert.match(
    rollback,
    /if: \$\{\{ vars\.AWS_DEPLOY_ENABLED == 'false' && vars\.AWS_ROLLBACK_ENABLED == 'true' \}\}/,
  );
});

test('the OIDC preflight is identity-only and never checks out or mutates AWS', () => {
  const workflow = read('.github/workflows/oidc-preflight.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /configure-aws-credentials@/);
  assert.match(workflow, /aws sts get-caller-identity/);
  assert.doesNotMatch(workflow, /contents:/);
  assert.doesNotMatch(workflow, /actions\/checkout@/);
  assert.doesNotMatch(workflow, /aws (?!sts get-caller-identity)/);
  assert.doesNotMatch(workflow, /uses:\s+\S+@v\d/);
});

test('frontend publication proves the active backend release before build or upload', () => {
  const reader = read('tools/read-backend-release.sh');
  assert.match(reader, /backend-release-sha/);
  assert.match(reader, /backend-releases\/\$BACKEND_RELEASE_SHA/);
  assert.match(reader, /backend-release-manifests\/\$BACKEND_RELEASE_SHA/);
  assert.match(reader, /BACKEND_RELEASE_SHA.*\^\[0-9a-f\]\{40\}\$/s);
  assert.match(reader, /test "\$BACKEND_RELEASE_MARKER" = "\$BACKEND_RELEASE_SHA"/);
  assert.match(reader, /schemaVersion == 1/);
  assert.match(reader, /\.backendReleaseSha == \$sha/);
  assert.match(reader, /\.stage == \$stage/);

  for (const path of [
    '.github/workflows/deploy-aws-dev.yml',
    '.github/workflows/promote-aws.yml',
    '.github/workflows/rollback-aws.yml',
  ]) {
    const workflow = read(path);
    const markerPosition = workflow.indexOf('read-backend-release.sh');
    assert.ok(markerPosition >= 0, `${path} must load a versioned backend release manifest`);
    assert.ok(markerPosition < workflow.indexOf('npm run generate:config'));
    assert.ok(markerPosition < workflow.indexOf('publish-aws-site.sh'));
    assert.ok(
      workflow.lastIndexOf('/backend-release-sha') > workflow.indexOf('npm run generate:config'),
      `${path} must revalidate the backend pointer after building`,
    );
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /Backend SHA/);
    assert.match(workflow, /Frontend SHA/);
    assert.match(workflow, /Contract hash/);
  }
});

test('every AWS workflow pins the account and validates STS before SSM or publication', () => {
  for (const path of [
    '.github/workflows/deploy-aws-dev.yml',
    '.github/workflows/promote-aws.yml',
    '.github/workflows/rollback-aws.yml',
  ]) {
    const workflow = read(path);
    assert.match(workflow, /allowed-account-ids: \$\{\{ vars\.AWS_ACCOUNT_ID \}\}/);
    const stsPosition = workflow.indexOf('aws sts get-caller-identity');
    assert.ok(stsPosition >= 0, `${path} must validate the assumed AWS identity`);
    const ssmPosition = workflow.indexOf('aws ssm ');
    const publishPosition = workflow.indexOf('publish-aws-site.sh');
    assert.ok(ssmPosition < 0 || stsPosition < ssmPosition, `${path} must validate STS before SSM`);
    assert.ok(
      publishPosition < 0 || stsPosition < publishPosition,
      `${path} must validate STS before publishing`,
    );
  }
});

test('AWS publication preserves release entrypoints, uploads index last, and invalidates only mutable paths', () => {
  const publisher = read('tools/publish-aws-site.sh');
  assert.match(publisher, /releases\/current/);
  assert.match(publisher, /releases\/previous/);
  assert.match(publisher, /releases\/\$\{?RELEASE_SHA\}?/);
  assert.match(publisher, /worker-basic\.min\.js/);
  assert.match(publisher, /max-age=31536000,immutable/);
  assert.match(publisher, /--include 'media\/\*'/);
  for (const contentType of [
    'application/manifest+json',
    'application/json',
    'text/javascript',
    'text/html; charset=utf-8',
  ]) {
    assert.match(publisher, new RegExp(contentType.replace(/[+.]/g, '\\$&')));
  }
  const syncPosition = publisher.lastIndexOf('aws s3 sync');
  const indexPosition = publisher.lastIndexOf("publish_mutable index.html ''");
  assert.ok(syncPosition >= 0, 'asset sync is missing');
  assert.ok(indexPosition > syncPosition, 'index.html must be uploaded after assets');
  assert.match(publisher, /create-invalidation/);
  assert.doesNotMatch(publisher, /["']\/\*["']/);
});

test('CloudFront binding validation requires an origin access control', () => {
  const validator = read('tools/validate-aws-binding.sh');
  assert.match(validator, /OriginAccessControlId/);
  assert.match(validator, /expected_origin/);
});

test('promotion requires an exact SHA with a successful previous-stage release marker', () => {
  const workflow = read('.github/workflows/promote-aws.yml');
  assert.match(workflow, /source_sha:/);
  assert.doesNotMatch(workflow, /default:\s*main/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /SOURCE_STAGE=.*dev.*test/s);
  assert.match(workflow, /frontend-releases\/\$SOURCE_SHA/);
  assert.ok(
    workflow.indexOf('frontend-releases/$SOURCE_SHA') < workflow.indexOf('actions/checkout@'),
    'the prior-stage release marker must be checked before checkout',
  );
});

test('deployment markers are written only after smoke and rollback requires a same-stage marker', () => {
  for (const path of [
    '.github/workflows/deploy-aws-dev.yml',
    '.github/workflows/promote-aws.yml',
  ]) {
    const workflow = read(path);
    assert.ok(
      workflow.indexOf('smoke-frontend.mjs') < workflow.indexOf('frontend-releases/$RELEASE_SHA'),
    );
    assert.match(workflow, /frontend-release-sha/);
  }

  const rollback = read('.github/workflows/rollback-aws.yml');
  assert.match(rollback, /release_sha:/);
  assert.match(rollback, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(rollback, /roadmap2u\/\$\{STAGE\}\/frontend-releases\/\$RELEASE_SHA/);
  assert.ok(
    rollback.indexOf('frontend-releases/$RELEASE_SHA') < rollback.indexOf('actions/checkout@'),
    'the same-stage release marker must be checked before checkout',
  );
  assert.ok(rollback.indexOf('smoke-frontend.mjs') < rollback.indexOf('frontend-release-sha'));
});

test('workflows pin third-party actions and suppress dependency lifecycle scripts', () => {
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/deploy.yml',
    '.github/workflows/deploy-aws-dev.yml',
    '.github/workflows/oidc-preflight.yml',
    '.github/workflows/promote-aws.yml',
    '.github/workflows/rollback-aws.yml',
  ]) {
    const workflow = read(path);
    assert.doesNotMatch(workflow, /uses:\s+\S+@v\d/);
    if (path !== '.github/workflows/oidc-preflight.yml') {
      assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/);
    }
  }
});

test('AWS builds reject every forbidden provider signature in the initial bundle', () => {
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/deploy-aws-dev.yml',
    '.github/workflows/promote-aws.yml',
    '.github/workflows/rollback-aws.yml',
  ]) {
    const workflow = read(path);
    assert.match(workflow, /grep -E/i);
    for (const signature of ['cognito-idp', 'amazonaws', 'aws-amplify', 'Cognito']) {
      assert.match(workflow, new RegExp(signature, 'i'));
    }
  }
});

test('prod smoke uses the CloudFront hostname before canonical DNS cutover', () => {
  for (const path of ['.github/workflows/promote-aws.yml', '.github/workflows/rollback-aws.yml']) {
    const workflow = read(path);
    assert.match(workflow, /Distribution\.DomainName/);
    assert.match(workflow, /STAGE.*prod/s);
    assert.match(workflow, /SMOKE_FRONTEND_URL/);
    assert.match(workflow, /--cors-origin/);
    assert.match(workflow, /url: \$\{\{ steps\.ssm\.outputs\.frontend_url \}\}/);
  }
});

test('CI and every AWS workflow validate the built PWA before publication', () => {
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/deploy-aws-dev.yml',
    '.github/workflows/promote-aws.yml',
    '.github/workflows/rollback-aws.yml',
  ]) {
    const workflow = read(path);
    const validationPosition = workflow.indexOf('validate-built-pwa.mjs');
    assert.ok(validationPosition >= 0, `${path} must validate the local PWA build`);
    const publicationPosition = workflow.indexOf('publish-aws-site.sh');
    assert.ok(
      publicationPosition < 0 || validationPosition < publicationPosition,
      `${path} must validate before publishing`,
    );
  }
});

test('only rollback passes its selected recovery mode to PWA validation and public smoke', () => {
  const workflow = read('.github/workflows/rollback-aws.yml');
  assert.match(workflow, /RECOVERY_MODE: \$\{\{ inputs\.recovery_mode \}\}/);
  assert.match(workflow, /validate-built-pwa\.mjs[^\n]+--recovery-mode "\$RECOVERY_MODE"/);
  assert.match(workflow, /smoke-frontend\.mjs[\s\S]+--recovery-mode "\$RECOVERY_MODE"/);
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/deploy-aws-dev.yml',
    '.github/workflows/promote-aws.yml',
  ]) {
    assert.doesNotMatch(read(path), /--recovery-mode/);
  }
});

test('pull requests run config tests, app tests, and a root build', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /npm run test:config/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /--base-href \/(?:\s|$)/);
});
