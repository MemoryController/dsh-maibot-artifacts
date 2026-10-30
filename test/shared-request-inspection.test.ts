import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { Manifest } from '../src/core.js'
import { inspectSharedRequest, publishSharedRequest, SharedRequestPublishError, validateManifest } from '../src/shared-request.js'

const task = 'cd'.repeat(16)
const manifest: Manifest = {
  type: 'dsh_artifacts', version: 1, task_id: task,
  files: [{ path: 'outbox/中文.bin', size: 0, sha256: createHash('sha256').digest('hex') }],
}
async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'request-inspection-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'workspace')
  await mkdir(join(root, 'outbox'), { recursive: true })
  const directory = join(root, 'outbox/.dsh-handoffs')
  const final = join(directory, `${task}.json`)
  return { base, root, directory, final }
}

test('request inspection observes missing state without creating any directory or request', async t => {
  const { root } = await fixture(t)
  assert.deepEqual(await inspectSharedRequest(root, manifest), { kind: 'missing', code: 'not_found' })
  assert.deepEqual(await readdir(join(root, 'outbox')), [])
  assert.deepEqual(await inspectSharedRequest(join(root, 'missing-root'), manifest), { kind: 'missing', code: 'not_found' })
  assert.deepEqual(await readdir(root), ['outbox'])
})

test('matching inspection returns exact request evidence without fsync or modifying shared files', async t => {
  const { root, directory, final } = await fixture(t)
  const published = await publishSharedRequest(root, manifest)
  const before = await lstat(final, { bigint: true })
  const bytes = await readFile(final)
  const probe = await open(final, 'r')
  const prototype = Object.getPrototypeOf(probe)
  await probe.close()
  t.mock.method(prototype, 'sync', async () => { throw new Error('Read-only inspection must not fsync') })
  try {
    const inspected = await inspectSharedRequest(root, manifest)
    assert.equal(inspected.kind, 'matching')
    assert.ok(inspected.kind === 'matching')
    assert.equal(inspected.request.path, published.path)
    assert.equal(inspected.request.sha256, published.sha256)
    assert.equal(Number.isNaN(Date.parse(inspected.request.submittedAt)), false)
    const after = await lstat(final, { bigint: true })
    for (const key of ['ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key])
    assert.deepEqual(await readFile(final), bytes)
    assert.deepEqual(await readdir(directory), [`${task}.json`])
  } finally { t.mock.restoreAll() }
})

test('inspection requires exact serialized bytes, including JSON ordering and whitespace', async t => {
  const { root, final } = await fixture(t)
  await publishSharedRequest(root, manifest)
  for (const bytes of [
    `${JSON.stringify(manifest)}\n`,
    JSON.stringify({ version: 1, type: 'dsh_artifacts', task_id: task, files: manifest.files }),
  ]) {
    await writeFile(final, bytes)
    assert.deepEqual(await inspectSharedRequest(root, manifest), { kind: 'conflict', code: 'request_conflict' })
    assert.equal(await readFile(final, 'utf8'), bytes)
  }
})

test('inspection rejects unsafe request leaves and never follows or repairs them', { timeout: 3000 }, async t => {
  for (const kind of ['symlink', 'hardlink', 'directory', 'fifo'] as const) {
    const { base, root, directory, final } = await fixture(t)
    await mkdir(directory, { mode: 0o750 })
    const original = join(base, 'original')
    const bytes = JSON.stringify(manifest)
    await writeFile(original, bytes)
    if (kind === 'symlink') await symlink(original, final)
    if (kind === 'hardlink') await link(original, final)
    if (kind === 'directory') await mkdir(final)
    if (kind === 'fifo') execFileSync('mkfifo', [final])
    const result = await inspectSharedRequest(root, manifest)
    assert.equal(result.kind, 'unreadable')
    assert.deepEqual(await readdir(directory), [`${task}.json`])
    assert.equal(await readFile(original, 'utf8'), bytes)
    assert.equal((await lstat(final)).isSymbolicLink(), kind === 'symlink')
  }
})

test('inspection rejects linked roots and unsafe request directory permissions without chmod', async t => {
  const { base, root, directory } = await fixture(t)
  await publishSharedRequest(root, manifest)
  const alias = join(base, 'alias')
  await symlink(root, alias)
  assert.equal((await inspectSharedRequest(alias, manifest)).kind, 'unreadable')
  await chmod(directory, 0o770)
  assert.deepEqual(await inspectSharedRequest(root, manifest), { kind: 'unreadable', code: 'unsafe_request_directory' })
  assert.equal((await lstat(directory)).mode & 0o777, 0o770)
})

test('pathname replacement during inspection never reports matching stale bytes', async t => {
  const { root, final } = await fixture(t)
  await publishSharedRequest(root, manifest)
  const probe = await open(final, 'r')
  const prototype = Object.getPrototypeOf(probe)
  const original = prototype.read as (...args: unknown[]) => Promise<{ bytesRead: number }>
  await probe.close()
  let replaced = false
  t.mock.method(prototype, 'read', async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args)
    if (!replaced && result.bytesRead > 0) {
      replaced = true
      await rename(final, `${final}.old`)
      await writeFile(final, JSON.stringify(manifest))
    }
    return result
  })
  try {
    assert.deepEqual(await inspectSharedRequest(root, manifest), { kind: 'conflict', code: 'request_conflict' })
    assert.equal(replaced, true)
  } finally { t.mock.restoreAll() }
})

test('request directory replacement during inspection is detected through pinned relationships', async t => {
  const { root, directory, final } = await fixture(t)
  await publishSharedRequest(root, manifest)
  const probe = await open(final, 'r')
  const prototype = Object.getPrototypeOf(probe)
  const original = prototype.read as (...args: unknown[]) => Promise<{ bytesRead: number }>
  await probe.close()
  let replaced = false
  t.mock.method(prototype, 'read', async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args)
    if (!replaced && result.bytesRead > 0) {
      replaced = true
      await rename(directory, `${directory}.old`)
      await mkdir(directory, { mode: 0o750 })
      await writeFile(final, JSON.stringify(manifest))
    }
    return result
  })
  try {
    assert.deepEqual(await inspectSharedRequest(root, manifest), { kind: 'conflict', code: 'request_conflict' })
    assert.equal(replaced, true)
  } finally { t.mock.restoreAll() }
})

test('runtime manifest validation accepts unknown input safely and inspector never writes invalid data', async t => {
  const { root } = await fixture(t)
  for (const invalid of [null, [], false, { ...manifest, send: false }, { ...manifest, task_id: '../x' },
    { ...manifest, files: [{ ...manifest.files[0], path: null }] }]) {
    assert.throws(() => validateManifest(invalid))
    const inspected = await inspectSharedRequest(root, invalid as Manifest)
    assert.equal(inspected.kind, 'unreadable')
  }
  assert.deepEqual(await readdir(join(root, 'outbox')), [])
})

test('publication errors preserve stable codes and phase without leaking native diagnostic text', async t => {
  const { root } = await fixture(t)
  for (const [path, value, code] of [
    ['relative', manifest, 'invalid_root'],
    [join(root, 'missing'), manifest, 'not_found'],
    [root, { ...manifest, send: true }, 'invalid_manifest'],
  ] as const) {
    await assert.rejects(publishSharedRequest(path, value as Manifest), error => {
      assert.ok(error instanceof SharedRequestPublishError)
      assert.equal(error.publication, 'not_published')
      assert.equal(error.code, code)
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'cause'), false)
      assert.doesNotMatch(JSON.stringify(error), /request-inspection-|proc\/self\/fd/u)
      return true
    })
  }
  await publishSharedRequest(root, manifest)
  const conflict = { ...manifest, files: [{ ...manifest.files[0]!, sha256: 'f'.repeat(64) }] }
  await assert.rejects(publishSharedRequest(root, conflict), error => {
    assert.ok(error instanceof SharedRequestPublishError)
    assert.equal(error.publication, 'unknown')
    assert.equal(error.code, 'request_conflict')
    return true
  })
})
