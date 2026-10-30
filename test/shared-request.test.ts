import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ArtifactService, type Dispatch, type Manifest } from '../src/core.js'
import { publishSharedRequest } from '../src/shared-request.js'

const owner = 'actual-agent-scope-for-shared-request'
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const id = 'ac'.repeat(16)
const requestRelative = `outbox/.dsh-handoffs/${id}.json`
function manifest(taskId = id): Manifest {
  return { type: 'dsh_artifacts', version: 1, task_id: taskId, files: [{ path: 'outbox/结果.txt', size: 4, sha256: digest('data') }] }
}
async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'shared-request-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspaceRoot = join(base, 'workspace')
  await mkdir(join(workspaceRoot, 'outbox'), { recursive: true })
  const stateDir = join(base, 'state')
  const config = { workspaceRoot, stateDir, confirmationMode: 'request' as const }
  const service = new ArtifactService(config)
  const put = async (path: string, bytes: string | Buffer) => {
    await writeFile(join(workspaceRoot, path), bytes)
    return path
  }
  return { base, workspaceRoot, stateDir, config, service, put }
}

test('default core publish submits one strict shared manifest for text, PNG, Unicode and empty files without remote notification', async t => {
  const { workspaceRoot, service, put } = await fixture(t)
  const text = '这是一份中文报告。\n'
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 0])
  const paths = [await put('outbox/报告.txt', text), await put('outbox/图片.png', png), await put('outbox/empty', '')]
  const prepared = await service.prepare(paths, owner)
  let notifications = 0
  const dispatch: Dispatch = async () => { notifications++; return { kind: 'queued', code: 'must_not_be_called' } }
  const submitted = await service.publish(prepared.manifest.task_id, owner, undefined, dispatch)
  assert.equal(submitted.result, 'submitted')
  assert.equal(submitted.state, 'prepared')
  assert.equal(submitted.notification, undefined)
  assert.equal(notifications, 0)
  assert.ok('shared_request' in submitted)
  assert.ok('confirmation' in submitted)
  assert.ok('maibot_registration' in submitted)
  assert.equal(submitted.maibot_registration, 'unconfirmed')
  const request = submitted.shared_request
  assert.equal(request.path, `outbox/.dsh-handoffs/${prepared.manifest.task_id}.json`)
  const bytes = await readFile(join(workspaceRoot, request.path))
  assert.equal(request.sha256, digest(bytes))
  assert.equal(Number.isNaN(Date.parse(request.submittedAt)), false)
  const parsed = JSON.parse(bytes.toString('utf8'))
  assert.deepEqual(parsed, prepared.manifest)
  assert.deepEqual(Object.keys(parsed).sort(), ['files', 'task_id', 'type', 'version'])
  assert.deepEqual(submitted.confirmation, { tool: 'dsh_import_request', arguments: { task_id: prepared.manifest.task_id, request_sha256: digest(bytes) } })
  assert.equal('imported' in submitted, false)
  assert.equal('file_ref' in submitted, false)
  assert.equal('sent' in submitted, false)
  const final = await lstat(join(workspaceRoot, request.path))
  assert.equal(final.isFile(), true)
  assert.equal(final.nlink, 1)
  assert.equal(final.mode & 0o777, 0o640)
  assert.equal((await lstat(join(workspaceRoot, 'outbox/.dsh-handoffs'))).mode & 0o777, 0o750)
  assert.deepEqual(await readdir(join(workspaceRoot, 'outbox/.dsh-handoffs')), [`${prepared.manifest.task_id}.json`])
})

test('submission survives local status, restart and dedup; a late target cannot notify an already-submitted request', async t => {
  const { workspaceRoot, config, service, put } = await fixture(t)
  const path = await put('outbox/data', 'hello')
  const prepared = await service.prepare([path], owner)
  const first = await service.publish(prepared.manifest.task_id, owner)
  assert.ok('shared_request' in first)
  const before = await readFile(join(workspaceRoot, first.shared_request.path))
  const restarted = new ArtifactService(config)
  const status = await restarted.localStatus(prepared.manifest.task_id, owner)
  assert.equal(status.state, 'prepared')
  assert.deepEqual(status.submission, first.shared_request)
  const duplicate = await restarted.prepare([path], owner)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.manifest.task_id, prepared.manifest.task_id)
  assert.deepEqual(duplicate.submission, first.shared_request)
  let notifications = 0
  const again = await restarted.publish(prepared.manifest.task_id, owner,
    { target: 'late-chat', toolName: 'mcp__maibot-agent__agent_talk', originId: 'late-task' },
    async () => { notifications++; return { kind: 'queued', code: 'must_not_be_called' } })
  assert.equal(again.result, 'submitted')
  assert.equal(notifications, 0)
  assert.ok('shared_request' in again)
  assert.deepEqual(again.shared_request, first.shared_request)
  assert.deepEqual(await readFile(join(workspaceRoot, first.shared_request.path)), before)
})

test('changed or deleted source prevents shared submission and never calls a remote tool', async t => {
  for (const action of ['changed', 'deleted'] as const) {
    const { workspaceRoot, service, put } = await fixture(t)
    const path = await put('outbox/data', 'original')
    const prepared = await service.prepare([path], owner)
    if (action === 'changed') await put(path, 'modified')
    else await unlink(join(workspaceRoot, path))
    let notifications = 0
    const result = await service.publish(prepared.manifest.task_id, owner, undefined,
      async () => { notifications++; return { kind: 'queued', code: 'must_not_be_called' } })
    assert.equal(result.result, 'prepared_only')
    assert.equal(result.error, action === 'changed' ? 'source_changed' : 'not_found')
    assert.equal(result.state, 'prepared')
    assert.equal(result.notification, undefined)
    assert.equal(notifications, 0)
    assert.equal((await service.localStatus(prepared.manifest.task_id, owner)).submission, undefined)
    await assert.rejects(lstat(join(workspaceRoot, 'outbox/.dsh-handoffs')), { code: 'ENOENT' })
  }
})

test('a pre-aborted caller leaves the shared outbox untouched', async t => {
  const { workspaceRoot, service, put } = await fixture(t)
  const prepared = await service.prepare([await put('outbox/data', 'original')], owner)
  const controller = new AbortController()
  controller.abort()
  const result = await service.publish(prepared.manifest.task_id, owner, undefined, undefined, controller.signal)
  assert.equal(result.result, 'prepared_only')
  assert.equal(result.error, 'cancelled_before_submission')
  assert.equal(result.notification, undefined)
  await assert.rejects(lstat(join(workspaceRoot, 'outbox/.dsh-handoffs')), { code: 'ENOENT' })
})

test('writer computes exact manifest hash and repeated identical submission preserves existing bytes', async t => {
  const { workspaceRoot } = await fixture(t)
  const value = manifest()
  const first = await publishSharedRequest(workspaceRoot, value)
  const before = await lstat(join(workspaceRoot, requestRelative))
  const second = await publishSharedRequest(workspaceRoot, value)
  const after = await lstat(join(workspaceRoot, requestRelative))
  assert.equal(first.path, requestRelative)
  assert.equal(first.sha256, digest(JSON.stringify(value)))
  assert.equal(second.sha256, first.sha256)
  assert.equal(before.ino, after.ino)
  assert.equal(after.nlink, 1)
  assert.deepEqual(await readdir(join(workspaceRoot, 'outbox/.dsh-handoffs')), [`${id}.json`])
})

test('conflicting existing request is never overwritten', async t => {
  const { workspaceRoot } = await fixture(t)
  const first = manifest()
  await publishSharedRequest(workspaceRoot, first)
  const changed = { ...first, files: [{ ...first.files[0]!, sha256: digest('different') }] }
  await assert.rejects(publishSharedRequest(workspaceRoot, changed), { code: 'request_conflict' })
  assert.deepEqual(JSON.parse(await readFile(join(workspaceRoot, requestRelative), 'utf8')), first)
  assert.deepEqual(await readdir(join(workspaceRoot, 'outbox/.dsh-handoffs')), [`${id}.json`])
})

test('writer rejects symlinked request directory and root ancestors', async t => {
  const { workspaceRoot, base } = await fixture(t)
  const outside = join(base, 'outside')
  await mkdir(outside)
  await symlink(outside, join(workspaceRoot, 'outbox/.dsh-handoffs'))
  await assert.rejects(publishSharedRequest(workspaceRoot, manifest()))
  assert.deepEqual(await readdir(outside), [])
  const alias = join(base, 'workspace-alias')
  await symlink(workspaceRoot, alias)
  await assert.rejects(publishSharedRequest(alias, manifest()))
})

test('writer refuses symlink and hardlink leaves, directories and FIFO without blocking', { timeout: 2000 }, async t => {
  for (const kind of ['symlink', 'hardlink', 'directory', 'fifo'] as const) {
    const { workspaceRoot, base } = await fixture(t)
    const requestDir = join(workspaceRoot, 'outbox/.dsh-handoffs')
    await mkdir(requestDir, { mode: 0o750 })
    const final = join(workspaceRoot, requestRelative)
    const original = join(base, 'original')
    const bytes = JSON.stringify(manifest())
    await writeFile(original, bytes)
    if (kind === 'symlink') await symlink(original, final)
    if (kind === 'hardlink') await link(original, final)
    if (kind === 'directory') await mkdir(final)
    if (kind === 'fifo') execFileSync('mkfifo', [final])
    await assert.rejects(publishSharedRequest(workspaceRoot, manifest()))
    assert.equal(await readFile(original, 'utf8'), bytes)
    assert.deepEqual(await readdir(requestDir), [`${id}.json`])
  }
})

test('writer rejects unsafe shared request directory permissions', async t => {
  const { workspaceRoot } = await fixture(t)
  const requestDir = join(workspaceRoot, 'outbox/.dsh-handoffs')
  await mkdir(requestDir, { mode: 0o750 })
  await chmod(requestDir, 0o770)
  await assert.rejects(publishSharedRequest(workspaceRoot, manifest()), { code: 'unsafe_request_directory' })
  assert.deepEqual(await readdir(requestDir), [])
})

test('writer rejects invalid task IDs, noncanonical roots and UTF-8 manifest size beyond 64 KiB', async t => {
  const { workspaceRoot } = await fixture(t)
  for (const root of ['relative', '/', `${workspaceRoot}/`, `${workspaceRoot}/.`, `${workspaceRoot}/../workspace`, `${workspaceRoot}//x`]) {
    await assert.rejects(publishSharedRequest(root, manifest()), { code: 'invalid_root' })
  }
  for (const taskId of ['../secret', 'AC'.repeat(16), '0'.repeat(31)]) {
    await assert.rejects(publishSharedRequest(workspaceRoot, manifest(taskId)), { code: 'invalid_manifest' })
  }
  const huge = manifest()
  huge.files = Array.from({ length: 32 }, (_, index) => ({ path: `outbox/${`${'中'.repeat(200)}/`.repeat(6)}结果-${index}.txt`, size: 1, sha256: digest('x') }))
  assert.equal(Buffer.byteLength(JSON.stringify(huge)) > 64 * 1024, true)
  await assert.rejects(publishSharedRequest(workspaceRoot, huge), { code: 'manifest_too_large' })
  await assert.rejects(lstat(join(workspaceRoot, 'outbox/.dsh-handoffs')), { code: 'ENOENT' })
})

test('concurrent conflicting writers can publish only one complete request and never overwrite it', async t => {
  const { workspaceRoot } = await fixture(t)
  const values = Array.from({ length: 6 }, (_, index) => ({ ...manifest(), files: [{ path: `outbox/result-${index}.txt`, size: index, sha256: digest(String(index)) }] }))
  const results = await Promise.allSettled(values.map(value => publishSharedRequest(workspaceRoot, value)))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const bytes = await readFile(join(workspaceRoot, requestRelative))
  assert.equal(values.some(value => JSON.stringify(value) === bytes.toString('utf8')), true)
  assert.equal((await lstat(join(workspaceRoot, requestRelative))).nlink, 1)
  assert.deepEqual(await readdir(join(workspaceRoot, 'outbox/.dsh-handoffs')), [`${id}.json`])
})

test('writer fails closed on non-v1 manifest fields rather than publishing target or send permissions', async t => {
  const { workspaceRoot } = await fixture(t)
  const invalid = [
    { ...manifest(), target: 'forged-chat' },
    { ...manifest(), send: true },
    { ...manifest(), version: 2 },
    { ...manifest(), files: [{ ...manifest().files[0]!, size: -1 }] },
    { ...manifest(), files: [{ ...manifest().files[0]!, path: '../escape' }] },
  ]
  for (const value of invalid) await assert.rejects(publishSharedRequest(workspaceRoot, value as Manifest))
  await assert.rejects(lstat(join(workspaceRoot, 'outbox/.dsh-handoffs')), { code: 'ENOENT' })
})
