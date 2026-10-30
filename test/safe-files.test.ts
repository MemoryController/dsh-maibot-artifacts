import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, link, symlink, open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { hashArtifact, SafetyError, validateRelativePath } from '../src/safe-files.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'artifact-files-'));
  await mkdir(join(root, 'outbox'));
  return root;
}

test('Chinese filename and binary bytes hash exactly; empty file is allowed', async () => {
  const root = await fixture();
  try {
    const bytes = Buffer.from([0, 255, 128, 10, 195, 0]);
    await writeFile(join(root, 'outbox/结果.bin'), bytes);
    assert.deepEqual(await hashArtifact(root, 'outbox/结果.bin', 100), {
      path: 'outbox/结果.bin', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    await writeFile(join(root, 'outbox/empty'), '');
    assert.equal((await hashArtifact(root, 'outbox/empty', 1)).sha256,
      createHash('sha256').digest('hex'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reject traversal, absolute paths, invalid components, controls and invalid names', () => {
  for (const path of ['/outbox/file', '../outbox/file', 'outbox/../secret', 'outbox/./x',
    'outbox//x', 'inbox/file', 'outbox', 'outbox/', 'outbox/ x', 'outbox/x ',
    'outbox/x\\y', 'outbox/x\n', 'outbox/\u0085x', 'outbox/x\u0085', 'outbox/\ud800',
    `outbox/${'x'.repeat(256)}`, `outbox/${'x/'.repeat(32)}file`]) {
    assert.throws(() => validateRelativePath(path), SafetyError, path);
  }
  assert.doesNotThrow(() => validateRelativePath('outbox/业务目录/中文文件.bin'));
  assert.doesNotThrow(() => validateRelativePath('outbox/😀.bin'));
});

test('reject over-limit bytes, directory, symlink leaf/ancestor and hardlinks', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'outbox/data'), 'abcd');
    await assert.rejects(hashArtifact(root, 'outbox/data', 3), { code: 'too_large' });
    await mkdir(join(root, 'outbox/dir'));
    await assert.rejects(hashArtifact(root, 'outbox/dir', 100), { code: 'unsafe_file' });
    await symlink('data', join(root, 'outbox/alias'));
    await assert.rejects(hashArtifact(root, 'outbox/alias', 100));
    await symlink('outbox', join(root, 'aliasbox'));
    await assert.rejects(hashArtifact(join(root, 'aliasbox'), 'outbox/data', 100));
    await symlink('.', join(root, 'outbox/linked-dir'));
    await assert.rejects(hashArtifact(root, 'outbox/linked-dir/data', 100));
    await link(join(root, 'outbox/data'), join(root, 'outbox/hard'));
    await assert.rejects(hashArtifact(root, 'outbox/data', 100), { code: 'unsafe_file' });
    await assert.rejects(hashArtifact(root, 'outbox/hard', 100), { code: 'unsafe_file' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FIFO is rejected without waiting for a writer', { timeout: 2000 }, async () => {
  const root = await fixture();
  try {
    execFileSync('mkfifo', [join(root, 'outbox/pipe')]);
    await assert.rejects(hashArtifact(root, 'outbox/pipe', 100), { code: 'unsafe_file' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reject invalid root, unsupported file limit and missing source', async () => {
  for (const root of ['relative', '/', '/tmp/../x', '/tmp//x', '/tmp/x/']) {
    await assert.rejects(hashArtifact(root, 'outbox/file', 100), { code: 'invalid_root' });
  }
  const root = await fixture();
  try {
    await assert.rejects(hashArtifact(root, 'outbox/no-file', 100), { code: 'ENOENT' });
    for (const limit of [0, -1, 1.5, Infinity]) {
      await assert.rejects(hashArtifact(root, 'outbox/no-file', limit), { code: 'invalid_limit' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a write during hashing is detected rather than emitting a manifest hash', async t => {
  const root = await fixture();
  const path = join(root, 'outbox/data');
  await writeFile(path, Buffer.alloc(1024 * 1024, 5));
  const probe = await open(path, 'r');
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.read;
  await probe.close();
  let changed = false;
  t.mock.method(prototype, 'read', async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args);
    if (!changed && result.bytesRead > 0) {
      changed = true;
      await writeFile(path, Buffer.alloc(1024 * 1024, 9));
    }
    return result;
  });
  try {
    await assert.rejects(hashArtifact(root, 'outbox/data', 2 * 1024 * 1024), { code: 'source_changed' });
    assert.equal(changed, true);
  } finally {
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('replacement of a pathname during hashing is rejected', async t => {
  const root = await fixture();
  const path = join(root, 'outbox/data');
  await writeFile(path, Buffer.alloc(1024, 5));
  const probe = await open(path, 'r');
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.read;
  await probe.close();
  let changed = false;
  t.mock.method(prototype, 'read', async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args);
    if (!changed && result.bytesRead > 0) {
      changed = true;
      await rename(path, `${path}.old`);
      await writeFile(path, Buffer.alloc(1024, 5));
    }
    return result;
  });
  try {
    await assert.rejects(hashArtifact(root, 'outbox/data', 2048), { code: 'source_changed' });
  } finally {
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});
