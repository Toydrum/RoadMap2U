import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

let implementation;
try {
  implementation = await import('./restore-aws-snapshot.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  implementation = {};
}

const sha = 'a'.repeat(40);
const account = '765932874577';
const bucket = `roadmap2u-dev-${account}`;
const binding = {
  apiBaseUrl: 'https://api.dev.roadmap2u.com',
  userPoolId: 'us-east-1_Test12345',
  userPoolClientId: '0123456789abcdefghijklmnop',
};
const hash = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex');
const etag = (bytes) => '"' + hash(bytes, 'md5') + '"';

async function fixture(run, change = () => {}) {
  const taskDir = mkdtempSync(join(tmpdir(), 'roadmap2u-snapshot-test-'));
  const outputDirectory = join(taskDir, 'restored');
  const objects = new Map();
  const put = (key, text) => objects.set(key, Buffer.from(text));
  const index =
    '<base href="/"><script src="main-old.js"></script><link href="styles-old.css" rel="stylesheet">';
  const main =
    'const api=' +
    JSON.stringify(binding.apiBaseUrl) +
    ';const pool=' +
    JSON.stringify(binding.userPoolId) +
    ';const client=' +
    JSON.stringify(binding.userPoolClientId) +
    ';';
  put('main-old.js', main);
  put('styles-old.css', 'body { color: green }');
  put(`releases/${sha}/index.html`, index);
  put(
    `releases/${sha}/manifest.webmanifest`,
    JSON.stringify({ id: '/', scope: '/', start_url: '/ahora', icons: [{ src: '/icon.svg' }] }),
  );
  put(`releases/${sha}/sw.js`, "importScripts('./ngsw-worker.js');");
  put(`releases/${sha}/ngsw-worker.js`, '/* original worker */');
  put(`releases/${sha}/safety-worker.js`, '/* original safety worker */');
  put(`releases/${sha}/worker-basic.min.js`, '/* original basic worker */');
  put('icon.svg', '<svg></svg>');
  const hashTable = {
    '/index.html': hash(Buffer.from(index), 'sha1'),
    '/main-old.js': hash(Buffer.from(main), 'sha1'),
    '/styles-old.css': hash(objects.get('styles-old.css'), 'sha1'),
    '/icon.svg': hash(objects.get('icon.svg'), 'sha1'),
  };
  put(`releases/${sha}/ngsw.json`, JSON.stringify({ index: '/index.html', hashTable }));
  const calls = [];
  const options = {
    stage: 'dev',
    accountId: account,
    bucket,
    releaseSha: sha,
    outputDirectory,
    workspaceDirectory: taskDir,
    ...binding,
  };
  const state = {
    objects,
    calls,
    options,
    marker: sha,
    identity: account,
    failGet: null,
    failHead: null,
    hashTable,
  };
  change(state);
  state.awsJson = async (args) => {
    calls.push(args);
    const value = (name) => args[args.indexOf(name) + 1];
    if (args[0] === 'sts') return { Account: state.identity };
    if (args[0] === 'ssm') {
      assert.equal(args[1], 'get-parameter');
      assert.equal(value('--name'), `/roadmap2u/dev/frontend-releases/${sha}`);
      return { Parameter: { Value: state.marker } };
    }
    assert.equal(args[0], 's3api');
    assert(['head-object', 'get-object'].includes(args[1]), 'only S3 reads may run');
    assert.equal(value('--bucket'), bucket);
    assert.equal(value('--expected-bucket-owner'), account);
    const key = value('--key');
    if (args[1] === 'head-object' && state.failHead === key) throw new Error('AccessDenied');
    const bytes = objects.get(key);
    if (!bytes) throw new Error('NoSuchKey');
    const metadata = {
      ContentLength: bytes.length,
      ETag: etag(bytes),
      VersionId: 'version-' + key,
    };
    if (args[1] === 'get-object') {
      if (state.failGet === key)
        throw new Error('PreconditionFailed: changed between HEAD and GET');
      assert.equal(value('--if-match'), metadata.ETag, 'every download must be conditional');
      writeFileSync(args.at(-1), bytes);
    }
    return metadata;
  };
  try {
    assert.equal(
      typeof implementation.restoreSnapshot,
      'function',
      'retained artifact recovery is unavailable',
    );
    await run(state);
  } finally {
    const localPath = relative(tmpdir(), taskDir);
    assert(localPath.startsWith('roadmap2u-snapshot-test-') && !localPath.includes(sep));
    rmSync(taskDir, { recursive: true, force: true });
  }
}

test('restores the exact successful artifact without compiling or writing AWS', async () => {
  await fixture(async ({ options, awsJson, calls, objects }) => {
    const receipt = await implementation.restoreSnapshot(options, awsJson);
    assert.equal(receipt.releaseSha, sha);
    assert.equal(receipt.status, 'snapshot_verified');
    assert.equal(receipt.hashedAssets, 4);
    assert.deepEqual(
      readFileSync(join(options.outputDirectory, 'index.html')),
      objects.get(`releases/${sha}/index.html`),
    );
    assert.deepEqual(
      readFileSync(join(options.outputDirectory, 'ngsw-worker.js')),
      objects.get(`releases/${sha}/ngsw-worker.js`),
    );
    assert.equal(receipt.awsWrites, 0);
    assert(
      calls.every((args) =>
        ['get-caller-identity', 'get-parameter', 'head-object', 'get-object'].includes(args[1]),
      ),
    );
    assert(existsSync(options.outputDirectory + '.snapshot.json'));
    assert(
      !existsSync(join(options.outputDirectory, 'snapshot.json')),
      'proof must stay outside the published directory',
    );
  });
});

test('rejects a release without its exact same-stage success marker', async () => {
  await fixture(
    async ({ options, awsJson, calls }) => {
      await assert.rejects(
        implementation.restoreSnapshot(options, awsJson),
        /successful release marker/,
      );
      assert(!calls.some((args) => args[0] === 's3api'));
    },
    (state) => {
      state.marker = 'b'.repeat(40);
    },
  );
});

test('rejects the wrong AWS identity before snapshot reads', async () => {
  await fixture(
    async ({ options, awsJson, calls }) => {
      await assert.rejects(implementation.restoreSnapshot(options, awsJson), /AWS account/);
      assert.equal(calls.length, 1);
    },
    (state) => {
      state.identity = '111111111111';
    },
  );
});

test('rejects a different stage bucket before any AWS operation', async () => {
  await fixture(
    async ({ options, awsJson, calls }) => {
      await assert.rejects(implementation.restoreSnapshot(options, awsJson), /bucket/);
      assert.equal(calls.length, 0);
    },
    (state) => {
      state.options.bucket = `roadmap2u-test-${account}`;
    },
  );
});

test('rejects corrupt immutable assets even when they exist in S3', async () => {
  await fixture(
    async ({ options, awsJson }) => {
      await assert.rejects(implementation.restoreSnapshot(options, awsJson), /hash mismatch/);
      assert(!existsSync(options.outputDirectory + '.snapshot.json'));
    },
    (state) => {
      state.objects.set('styles-old.css', Buffer.from('changed content'));
    },
  );
});

test('fails closed when a snapshot changes between HEAD and GET', async () => {
  await fixture(
    async ({ options, awsJson }) => {
      await assert.rejects(implementation.restoreSnapshot(options, awsJson), /PreconditionFailed/);
      assert(!existsSync(options.outputDirectory + '.snapshot.json'));
    },
    (state) => {
      state.failGet = `releases/${sha}/ngsw.json`;
    },
  );
});

test('does not treat denied optional snapshot reads as an absent file', async () => {
  await fixture(
    async ({ options, awsJson }) => {
      await assert.rejects(implementation.restoreSnapshot(options, awsJson), /AccessDenied/);
    },
    (state) => {
      state.failHead = `releases/${sha}/index.csr.html`;
    },
  );
});

test('rejects path traversal in the retained service worker manifest', async () => {
  await fixture(
    async ({ options, awsJson, calls }) => {
      await assert.rejects(implementation.restoreSnapshot(options, awsJson), /unsafe asset path/);
      assert(!calls.some((args) => args.includes('../escape.js')));
    },
    (state) => {
      state.hashTable['/../escape.js'] = '1'.repeat(40);
      state.objects.set(
        `releases/${sha}/ngsw.json`,
        Buffer.from(JSON.stringify({ index: '/index.html', hashTable: state.hashTable })),
      );
    },
  );
});

test('rejects a missing hashed asset before recovery can publish', async () => {
  await fixture(
    async ({ options, awsJson }) => {
      await assert.rejects(implementation.restoreSnapshot(options, awsJson), /NoSuchKey/);
    },
    (state) => {
      state.objects.delete('styles-old.css');
    },
  );
});

for (const path of ['/dir/.. /escape.js', '/dir./escape.js', '/NUL.js', '/%2e%2e/escape.js']) {
  test(`rejects platform-ambiguous asset path ${path}`, async () => {
    await fixture(
      async ({ options, awsJson }) => {
        await assert.rejects(implementation.restoreSnapshot(options, awsJson), /unsafe asset path/);
        assert(!existsSync(options.outputDirectory + '.snapshot.json'));
      },
      (state) => {
        state.hashTable[path] = '1'.repeat(40);
        state.objects.set(
          `releases/${sha}/ngsw.json`,
          Buffer.from(JSON.stringify({ index: '/index.html', hashTable: state.hashTable })),
        );
      },
    );
  });
}

test('rejects artifacts with a different API or Cognito destination', async () => {
  await fixture(
    async ({ options, awsJson }) => {
      await assert.rejects(implementation.restoreSnapshot(options, awsJson), /runtime binding/);
    },
    (state) => {
      state.options.userPoolClientId = '9876543210ponmlkjihgfedcba';
    },
  );
});

test('refuses to overwrite an existing local recovery directory', async () => {
  await fixture(async ({ options, awsJson, calls }) => {
    writeFileSync(options.outputDirectory, 'preserve');
    await assert.rejects(implementation.restoreSnapshot(options, awsJson), /already exists/);
    assert.equal(readFileSync(options.outputDirectory, 'utf8'), 'preserve');
    assert.equal(calls.length, 0);
  });
});
