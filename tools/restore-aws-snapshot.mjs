import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex');
const entrypoints = [
  'index.html',
  'ngsw.json',
  'sw.js',
  'ngsw-worker.js',
  'manifest.webmanifest',
  'index.csr.html',
  'safety-worker.js',
  'worker-basic.min.js',
];
const required = new Set(entrypoints.slice(0, 5));
const inside = (root, path) => {
  const part = relative(root, path);
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
};
const absent = (error) =>
  error.message === 'NoSuchKey' || /\((404|NoSuchKey)\)/.test(error.stderr ?? '');
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function awsJson(args) {
  const { stdout } = await execute(
    process.env.ROADMAP2U_AWS_CLI ?? 'aws',
    [...args, '--region', 'us-east-1', '--output', 'json', '--no-cli-pager'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2_000_000 },
  );
  return JSON.parse(stdout);
}

async function eachWithLimit(items, work) {
  let cursor = 0;
  let failure;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length && !failure) {
        const item = items[cursor++];
        try {
          await work(item);
        } catch (error) {
          failure ??= error;
        }
      }
    }),
  );
  if (failure) throw failure;
}

export async function restoreSnapshot(options, readAws = awsJson) {
  const { stage, accountId, bucket, releaseSha, apiBaseUrl, userPoolId, userPoolClientId } =
    options;
  requireValue(['dev', 'test', 'prod'].includes(stage), 'invalid snapshot stage');
  requireValue(/^[0-9]{12}$/.test(accountId), 'invalid AWS account');
  requireValue(
    bucket === `roadmap2u-${stage}-${accountId}`,
    'snapshot bucket must belong to the selected stage and account',
  );
  requireValue(/^[0-9a-f]{40}$/.test(releaseSha), 'release must be an exact lowercase SHA');
  const expectedApi =
    stage === 'prod' ? 'https://api.roadmap2u.com' : `https://api.${stage}.roadmap2u.com`;
  requireValue(
    apiBaseUrl === expectedApi &&
      /^us-east-1_[A-Za-z0-9]{8,12}$/.test(userPoolId) &&
      /^[a-z0-9]{20,64}$/.test(userPoolClientId),
    'invalid expected runtime binding',
  );
  requireValue(
    typeof options.outputDirectory === 'string' && options.outputDirectory.length > 0,
    'output directory is required',
  );
  const workspace = realpathSync(options.workspaceDirectory ?? process.cwd());
  const output = resolve(options.outputDirectory);
  requireValue(inside(workspace, output), 'output must stay inside the workspace');
  let ancestor = dirname(output);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  requireValue(
    realpathSync(ancestor) === workspace || inside(workspace, realpathSync(ancestor)),
    'output parent escapes the workspace',
  );
  requireValue(
    !existsSync(output) && !existsSync(output + '.snapshot.json'),
    'recovery output already exists',
  );

  const identity = await readAws(['sts', 'get-caller-identity']);
  requireValue(identity.Account === accountId, 'unexpected AWS account');
  const marker = await readAws([
    'ssm',
    'get-parameter',
    '--name',
    `/roadmap2u/${stage}/frontend-releases/${releaseSha}`,
  ]);
  requireValue(
    marker.Parameter?.Value === releaseSha,
    'exact same-stage successful release marker is required',
  );
  mkdirSync(output, { recursive: true });
  const prefix = `releases/${releaseSha}/`;
  const files = new Map();
  const get = async (key, name, optional = false) => {
    const parameters = ['--bucket', bucket, '--key', key, '--expected-bucket-owner', accountId];
    let head;
    try {
      head = await readAws(['s3api', 'head-object', ...parameters]);
    } catch (error) {
      if (optional && absent(error)) return;
      throw error;
    }
    requireValue(
      Number.isInteger(head.ContentLength) &&
        head.ContentLength > 0 &&
        head.ContentLength <= 32_000_000 &&
        typeof head.ETag === 'string' &&
        head.ETag.length > 0,
      `invalid object metadata: ${key}`,
    );
    const path = resolve(output, name);
    requireValue(inside(output, path), 'unsafe asset path');
    mkdirSync(dirname(path), { recursive: true });
    const downloaded = await readAws([
      's3api',
      'get-object',
      ...parameters,
      '--if-match',
      head.ETag,
      path,
    ]);
    const bytes = readFileSync(path);
    requireValue(
      bytes.length === head.ContentLength &&
        downloaded.ETag === head.ETag &&
        (!head.VersionId || downloaded.VersionId === head.VersionId),
      `object changed during download: ${key}`,
    );
    files.set(name, {
      name,
      key,
      etag: head.ETag,
      versionId: downloaded.VersionId,
      bytes: bytes.length,
      sha256: digest(bytes, 'sha256'),
    });
  };
  await get(prefix + 'ngsw.json', 'ngsw.json');
  const ngsw = JSON.parse(readFileSync(resolve(output, 'ngsw.json'), 'utf8'));
  requireValue(
    ngsw.index === '/index.html' &&
      ngsw.hashTable &&
      typeof ngsw.hashTable === 'object' &&
      !Array.isArray(ngsw.hashTable),
    'invalid retained PWA hash table',
  );
  const assets = Object.entries(ngsw.hashTable);
  requireValue(
    assets.length > 0 && assets.length <= 2000 && ngsw.hashTable['/index.html'],
    'invalid retained PWA asset count or index',
  );
  for (const [path, hash] of assets) {
    requireValue(
      /^\/(?!\/)[^%?#\\\x00-\x1f\x7f:<>|*]+$/.test(path) &&
        path
          .slice(1)
          .split('/')
          .every(
            (part) =>
              part &&
              !/[. ]$/.test(part) &&
              part !== 'releases' &&
              !/^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(\.|$)/i.test(part),
          ),
      `unsafe asset path: ${path}`,
    );
    requireValue(/^[0-9a-f]{40}$/.test(hash), `invalid PWA hash: ${path}`);
  }
  await eachWithLimit(
    entrypoints.filter((name) => name !== 'ngsw.json'),
    (name) => get(prefix + name, name, !required.has(name)),
  );
  await eachWithLimit(
    assets.filter(([path]) => !files.has(path.slice(1))),
    ([path]) => get(path.slice(1), path.slice(1)),
  );
  for (const [path, expected] of assets) {
    requireValue(
      digest(readFileSync(resolve(output, path.slice(1))), 'sha1') === expected,
      `PWA hash mismatch: ${path}`,
    );
  }
  let javascript = '';
  for (const name of files.keys())
    if (name.endsWith('.js')) javascript += readFileSync(resolve(output, name), 'utf8') + '\n';
  for (const value of [apiBaseUrl, userPoolId, userPoolClientId]) {
    requireValue(
      [JSON.stringify(value), "'" + value + "'", '`' + value + '`'].some((literal) =>
        javascript.includes(literal),
      ),
      'snapshot runtime binding does not match the current stage',
    );
  }
  await eachWithLimit(
    [...files.values()].filter((row) => row.key.startsWith(prefix)),
    async (row) => {
      const head = await readAws([
        's3api',
        'head-object',
        '--bucket',
        bucket,
        '--key',
        row.key,
        '--expected-bucket-owner',
        accountId,
      ]);
      requireValue(
        head.ETag === row.etag && (!row.versionId || head.VersionId === row.versionId),
        `snapshot changed during verification: ${row.name}`,
      );
    },
  );
  const receipt = {
    schemaVersion: 1,
    status: 'snapshot_verified',
    checkedAt: new Date().toISOString(),
    stage,
    accountId,
    bucket,
    releaseSha,
    hashedAssets: assets.length,
    entrypoints: [...files.keys()].filter((name) => entrypoints.includes(name)).length,
    runtimeBinding: { apiBaseUrl, userPoolId, userPoolClientId },
    files: [...files.values()].sort((a, b) => a.name.localeCompare(b.name)),
    awsWrites: 0,
  };
  writeFileSync(output + '.snapshot.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    requireValue(args.length === 2 && args[0] === '--output' && args[1], '--output is required');
    const receipt = await restoreSnapshot({
      stage: process.env.STAGE,
      accountId: process.env.AWS_ACCOUNT_ID,
      bucket: process.env.SITE_BUCKET,
      releaseSha: process.env.RELEASE_SHA,
      apiBaseUrl: process.env.API_BASE_URL,
      userPoolId: process.env.USER_POOL_ID,
      userPoolClientId: process.env.USER_POOL_CLIENT_ID,
      outputDirectory: args[1],
    });
    console.log(
      `Retained frontend ${receipt.releaseSha} verified: ${receipt.hashedAssets} hashed assets, ${receipt.entrypoints} entrypoints, zero AWS writes.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
