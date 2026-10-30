import assert from 'node:assert/strict'
import crypto, { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ArtifactService, relayText, type ArtifactConfig, type Dispatch, type DispatchOutcome } from '../src/core.js'

const owner = 'real-dsh-agent-scope-A'
const target = { target: 'trusted-original-chat', toolName: 'mcp__maibot-agent__agent_talk', originId: 'trusted-original-host-task' }
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

async function fixture(t: TestContext, overrides: Partial<ArtifactConfig> = {}) {
  const base = await mkdtemp(join(tmpdir(), 'artifacts-core-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspaceRoot = join(base, 'workspace')
  const stateDir = join(base, 'state')
  await mkdir(join(workspaceRoot, 'outbox'), { recursive: true })
  const config = { workspaceRoot, stateDir, ...overrides }
  const service = new ArtifactService(config)
  const put = async (path: string, value: string | Buffer) => {
    await writeFile(join(workspaceRoot, path), value)
    return path
  }
  return { base, workspaceRoot, stateDir, config, service, put }
}

test('prepare emits exact v1 manifest for Chinese, binary and empty files without notification', async t => {
  const { service, put } = await fixture(t)
  const text = '你好，文件产物。\n'
  const binary = Buffer.from([0, 255, 127, 16, 0, 222])
  const paths = [await put('outbox/中文报告.txt', text), await put('outbox/image.bin', binary), await put('outbox/empty', '')]
  const prepared = await service.prepare(paths, owner, target)
  assert.equal(prepared.state, 'prepared')
  assert.equal(prepared.duplicate, false)
  assert.equal(prepared.notification, undefined)
  assert.match(prepared.manifest.task_id, /^[0-9a-f]{32}$/u)
  assert.deepEqual(Object.keys(prepared.manifest).sort(), ['files', 'task_id', 'type', 'version'])
  assert.deepEqual(prepared.manifest, {
    type: 'dsh_artifacts', version: 1, task_id: prepared.manifest.task_id,
    files: [
      { path: paths[0], size: Buffer.byteLength(text), sha256: sha(text) },
      { path: paths[1], size: binary.length, sha256: sha(binary) },
      { path: paths[2], size: 0, sha256: sha('') },
    ],
  })
  for (const file of prepared.manifest.files) assert.deepEqual(Object.keys(file).sort(), ['path', 'sha256', 'size'])
  const message = JSON.parse(relayText(prepared.manifest).split('\n').at(-1)!)
  assert.deepEqual(message, { tool: 'dsh_import_handoff', arguments: { manifest: prepared.manifest, send: false } })
  assert.equal(JSON.stringify(prepared.manifest).includes('send'), false)
})

test('defaults match MaiBot and configured limits cannot exceed peer ceilings', async t => {
  const { service, config } = await fixture(t)
  assert.equal(service.config.maxFileBytes, 50 * 1024 ** 2)
  assert.equal(service.config.maxBatchFiles, 8)
  assert.equal(service.config.notificationTimeoutMs, 30_000)
  assert.doesNotThrow(() => new ArtifactService({ ...config, maxFileBytes: 1024 ** 3, maxBatchFiles: 32 }))
  for (const maxFileBytes of [0, -1, 1.5, 1024 ** 3 + 1, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new ArtifactService({ ...config, maxFileBytes }), /invalid_limit/u)
  }
  for (const maxBatchFiles of [0, -1, 1.5, 33]) {
    assert.throws(() => new ArtifactService({ ...config, maxBatchFiles }), /invalid_limit/u)
  }
})

test('rejects empty, duplicated and over-limit batches and oversized file', async t => {
  const { service, put } = await fixture(t, { maxFileBytes: 2, maxBatchFiles: 2 })
  const small = await put('outbox/small', 'ok')
  const large = await put('outbox/large', 'big')
  await assert.rejects(service.prepare([], owner, target), /invalid_batch/u)
  await assert.rejects(service.prepare([small, small], owner, target), /invalid_batch/u)
  await assert.rejects(service.prepare([small, large, 'outbox/third'], owner, target), /invalid_batch/u)
  await assert.rejects(service.prepare([large], owner, target), /size limit/u)
  await assert.rejects(service.prepare([small], ''), /invalid_batch/u)
})

test('same paths and content deduplicate independent of order and survive restart', async t => {
  const { service, config, put } = await fixture(t)
  const paths = [await put('outbox/a', 'A'), await put('outbox/b', 'B')]
  const first = await service.prepare(paths, owner, target)
  const second = await service.prepare([...paths].reverse(), owner, target)
  const restarted = await new ArtifactService(config).prepare(paths, owner, target)
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  assert.equal(restarted.duplicate, true)
  assert.equal(second.manifest.task_id, first.manifest.task_id)
  assert.equal(restarted.manifest.task_id, first.manifest.task_id)
  assert.deepEqual(await new ArtifactService(config).localStatus(first.manifest.task_id, owner), {
    manifest: first.manifest, owner: first.owner, originHash: first.originHash, state: 'prepared', createdAt: first.createdAt,
  })
})

test('concurrent distinct tasks get distinct random identifiers', async t => {
  const { service, put } = await fixture(t)
  const paths = await Promise.all(Array.from({ length: 8 }, (_, index) => put(`outbox/task-${index}`, String(index))))
  const records = await Promise.all(paths.map(path => service.prepare([path], owner, target)))
  assert.equal(new Set(records.map(record => record.manifest.task_id)).size, records.length)
  for (const record of records) assert.equal(record.state, 'prepared')
})

test('concurrent identical preparation returns the same existing task', async t => {
  const { service, put } = await fixture(t)
  const path = await put('outbox/shared-result', 'same content')
  const records = await Promise.all(Array.from({ length: 6 }, () => service.prepare([path], owner, target)))
  assert.equal(new Set(records.map(record => record.manifest.task_id)).size, 1)
  assert.equal(records.filter(record => !record.duplicate).length, 1)
})

test('random task_id collision fails without overwriting previous record', async t => {
  const { service, put, stateDir } = await fixture(t)
  const paths = [await put('outbox/one', 'one'), await put('outbox/two', 'two')]
  const mock = t.mock.method(crypto, 'randomBytes', ((size: number) => Buffer.alloc(size, 0xab)) as typeof crypto.randomBytes)
  syncBuiltinESMExports()
  try {
    const first = await service.prepare([paths[0]!], owner, target)
    assert.equal(first.manifest.task_id, 'ab'.repeat(16))
    const original = await readFile(join(stateDir, `${first.manifest.task_id}.json`), 'utf8')
    await assert.rejects(service.prepare([paths[1]!], owner, target), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST')
    assert.equal(await readFile(join(stateDir, `${first.manifest.task_id}.json`), 'utf8'), original)
  } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
})

test('missing trusted target fails closed and does not dispatch', async t => {
  const { service, put } = await fixture(t)
  const prepared = await service.prepare([await put('outbox/file', 'payload')], owner, target)
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'queued', code: 'queued' } }
  const result = await service.publish(prepared.manifest.task_id, owner, undefined, dispatch)
  assert.equal(result.result, 'needs_target')
  assert.equal(result.state, 'prepared')
  assert.equal(calls, 0)
  assert.equal((await service.localStatus(prepared.manifest.task_id, owner)).notification, undefined)
})

test('missing callable API or pre-aborted caller leaves prepared_only without notification', async t => {
  const { service, put } = await fixture(t)
  const prepared = await service.prepare([await put('outbox/file', 'payload')], owner, target)
  const result = await service.publish(prepared.manifest.task_id, owner, target)
  assert.equal(result.result, 'prepared_only')
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'queued', code: 'queued' } }
  const controller = new AbortController()
  controller.abort()
  const cancelled = await service.publish(prepared.manifest.task_id, owner, target, dispatch, controller.signal)
  assert.equal(cancelled.result, 'prepared_only')
  assert.equal(calls, 0)
})

test('a queue acknowledgement is queued only; repeated publish and status never resend', async t => {
  const { service, config, put } = await fixture(t)
  const prepared = await service.prepare([await put('outbox/file', 'payload')], owner, target)
  let calls = 0
  const dispatch: Dispatch = async (actualTarget, text) => {
    calls++
    assert.deepEqual(actualTarget, target)
    assert.deepEqual(JSON.parse(text.split('\n').at(-1)!).arguments.manifest, prepared.manifest)
    return { kind: 'queued', code: 'queue_receipt_verified' }
  }
  const queued = await service.publish(prepared.manifest.task_id, owner, target, dispatch)
  assert.equal(queued.state, 'queued')
  assert.equal(queued.result, 'queued')
  assert.equal(queued.notification?.kind, 'queued')
  assert.equal('imported' in queued, false)
  assert.equal('file_ref' in queued, false)
  assert.equal('sent' in queued, false)
  const restarted = new ArtifactService(config)
  assert.equal((await restarted.localStatus(prepared.manifest.task_id, owner)).state, 'queued')
  assert.equal((await restarted.publish(prepared.manifest.task_id, owner, target, dispatch)).result, 'queued')
  assert.equal(calls, 1)
})

test('one-shot publish latch prevents concurrent duplicate notification across service instances', async t => {
  const { service, config, put } = await fixture(t)
  const prepared = await service.prepare([await put('outbox/file', 'payload')], owner, target)
  let calls = 0
  const dispatch: Dispatch = async () => {
    calls++
    await new Promise(resolve => setTimeout(resolve, 25))
    return { kind: 'queued', code: 'queue_receipt_verified' }
  }
  const results = await Promise.all(Array.from({ length: 6 }, () => new ArtifactService(config).publish(prepared.manifest.task_id, owner, target, dispatch)))
  assert.equal(calls, 1)
  assert.equal(results.filter(result => result.result === 'queued').length >= 1, true)
  assert.equal((await service.localStatus(prepared.manifest.task_id, owner)).state, 'queued')
})

test('known non-dispatch records prepared_only and never silently retries', async t => {
  const { service, config, put } = await fixture(t)
  const prepared = await service.prepare([await put('outbox/file', 'payload')], owner, target)
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'not_dispatched', code: 'tool_unavailable' } }
  const result = await service.publish(prepared.manifest.task_id, owner, target, dispatch)
  assert.equal(result.result, 'prepared_only')
  assert.equal(result.state, 'prepared')
  assert.equal(result.notification?.kind, 'not_dispatched')
  await new ArtifactService(config).publish(prepared.manifest.task_id, owner, target, dispatch)
  assert.equal(calls, 1)
})

test('dispatch exceptions stay unknown across restart; duplicate prepare preserves unknown task', async t => {
  const { service, config, put } = await fixture(t)
  const path = await put('outbox/file', 'payload')
  const prepared = await service.prepare([path], owner, target)
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; throw new Error('network lost after remote write') }
  const result = await service.publish(prepared.manifest.task_id, owner, target, dispatch)
  assert.equal(result.result, 'unknown')
  assert.equal(result.state, 'unknown')
  const restarted = new ArtifactService(config)
  assert.equal((await restarted.localStatus(prepared.manifest.task_id, owner)).state, 'unknown')
  const duplicate = await restarted.prepare([path], owner, target)
  assert.equal(duplicate.manifest.task_id, prepared.manifest.task_id)
  assert.equal(duplicate.state, 'unknown')
  await restarted.publish(prepared.manifest.task_id, owner, target, dispatch)
  assert.equal(calls, 1)
})

test('timeout records unknown, aborts request and ignores late successful completion', async t => {
  const { service, config, put } = await fixture(t, { notificationTimeoutMs: 10 })
  const prepared = await service.prepare([await put('outbox/file', 'payload')], owner, target)
  let finish!: (outcome: DispatchOutcome) => void
  let signal!: AbortSignal
  let calls = 0
  const dispatch: Dispatch = async (_target, _text, actualSignal) => {
    calls++; signal = actualSignal
    return new Promise(resolve => { finish = resolve })
  }
  const result = await service.publish(prepared.manifest.task_id, owner, target, dispatch)
  assert.equal(result.result, 'unknown')
  assert.equal(signal.aborted, true)
  finish({ kind: 'queued', code: 'late_receipt' })
  await new Promise(resolve => setTimeout(resolve, 15))
  const restarted = new ArtifactService(config)
  assert.equal((await restarted.localStatus(prepared.manifest.task_id, owner)).state, 'unknown')
  await restarted.publish(prepared.manifest.task_id, owner, target, dispatch)
  assert.equal(calls, 1)
})

test('malformed runtime dispatch outcome is unknown rather than invented success', async t => {
  const { service, put } = await fixture(t)
  const prepared = await service.prepare([await put('outbox/file', 'payload')], owner, target)
  const dispatch: Dispatch = async () => undefined as unknown as DispatchOutcome
  const result = await service.publish(prepared.manifest.task_id, owner, target, dispatch)
  assert.equal(result.result, 'unknown')
  assert.equal((await service.localStatus(prepared.manifest.task_id, owner)).state, 'unknown')
})

test('status does not expose another execution scope and task ids cannot traverse paths', async t => {
  const { service, put } = await fixture(t)
  const prepared = await service.prepare([await put('outbox/file', 'payload')], owner, target)
  await assert.rejects(service.localStatus(prepared.manifest.task_id, 'other-agent'), /task_not_found_in_scope/u)
  for (const id of ['../secret', '/etc/passwd', 'AB'.repeat(16), '00'.repeat(15)]) {
    await assert.rejects(service.localStatus(id, owner), /invalid_task_id/u)
  }
})

test('source change after prepare is caught before dispatch', async t => {
  const { service, put } = await fixture(t)
  const path = await put('outbox/file', 'original')
  const prepared = await service.prepare([path], owner, target)
  await put(path, 'modified')
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'queued', code: 'queued' } }
  const result = await service.publish(prepared.manifest.task_id, owner, target, dispatch)
  assert.equal(result.result, 'prepared_only')
  assert.equal(result.error, 'source_changed')
  assert.equal(result.state, 'prepared')
  assert.equal(calls, 0)
  assert.equal((await service.localStatus(prepared.manifest.task_id, owner)).error, 'source_changed')
})

test('prepare binds original Host task provenance; another original task cannot take over the same Agent task', async t => {
  const { service, put } = await fixture(t)
  const path = await put('outbox/file', 'payload')
  const prepared = await service.prepare([path], owner, target)
  assert.match(prepared.originHash!, /^[0-9a-f]{64}$/u)
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'queued', code: 'queued' } }
  for (const changedTarget of [
    { ...target, originId: 'different-original-host-task' },
    { ...target, target: 'another-real-chat' },
    { ...target, toolName: 'mcp__other-agent__agent_talk' },
  ]) {
    const result = await service.publish(prepared.manifest.task_id, owner, changedTarget, dispatch)
    assert.equal(result.result, 'needs_target')
    assert.equal(result.state, 'prepared')
    assert.equal(result.notification, undefined)
  }
  assert.equal(calls, 0)
  assert.equal((await service.publish(prepared.manifest.task_id, owner, target, dispatch)).result, 'queued')
  assert.equal(calls, 1)
})

test('an unbound prepare cannot be upgraded to automatic notification by a later trusted target', async t => {
  const { service, put } = await fixture(t)
  const path = await put('outbox/file', 'payload')
  const unbound = await service.prepare([path], owner)
  assert.equal(unbound.originHash, undefined)
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'queued', code: 'queued' } }
  const result = await service.publish(unbound.manifest.task_id, owner, target, dispatch)
  assert.equal(result.result, 'needs_target')
  assert.equal(result.notification, undefined)
  assert.equal(calls, 0)
  assert.equal((await service.localStatus(unbound.manifest.task_id, owner)).originHash, undefined)
})

test('deduplication keeps identical content from different original Host tasks separate', async t => {
  const { service, put } = await fixture(t)
  const path = await put('outbox/file', 'payload')
  const first = await service.prepare([path], owner, target)
  const otherOrigin = { ...target, originId: 'second-original-host-task' }
  const second = await service.prepare([path], owner, otherOrigin)
  const unbound = await service.prepare([path], owner)
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, false)
  assert.equal(unbound.duplicate, false)
  assert.equal(new Set([first.manifest.task_id, second.manifest.task_id, unbound.manifest.task_id]).size, 3)
  assert.notEqual(first.originHash, second.originHash)
})

test('stale concurrent file-validation failure preserves a newer verified queue receipt', async t => {
  const { service, config, workspaceRoot, put } = await fixture(t)
  const path = await put('outbox/file', 'original bytes')
  const prepared = await service.prepare([path], owner, target)
  const probe = await open(join(workspaceRoot, path), 'r')
  const prototype = Object.getPrototypeOf(probe)
  const originalRead = prototype.read as (...args: unknown[]) => Promise<{ bytesRead: number }>
  await probe.close()
  let releaseRead!: () => void
  let signalReadStarted!: () => void
  const readBlocked = new Promise<void>(resolve => { releaseRead = resolve })
  const readStarted = new Promise<void>(resolve => { signalReadStarted = resolve })
  let firstRead = true
  const mock = t.mock.method(prototype, 'read', async function (this: unknown, ...args: unknown[]) {
    const result = await originalRead.apply(this, args)
    if (firstRead && result.bytesRead > 0) {
      firstRead = false
      signalReadStarted()
      await readBlocked
    }
    return result
  })
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'queued', code: 'verified_receipt' } }
  try {
    const stale = service.publish(prepared.manifest.task_id, owner, target, dispatch)
    await readStarted
    const fresh = await new ArtifactService(config).publish(prepared.manifest.task_id, owner, target, dispatch)
    assert.equal(fresh.result, 'queued')
    await put(path, 'changed bytes!')
    releaseRead()
    const staleResult = await stale
    assert.equal(staleResult.result, 'queued')
    assert.equal(staleResult.error, 'source_changed')
    const final = await service.localStatus(prepared.manifest.task_id, owner)
    assert.equal(final.state, 'queued')
    assert.equal(final.notification?.code, 'verified_receipt')
    assert.equal(final.error, 'source_changed')
    assert.equal(calls, 1)
  } finally {
    releaseRead()
    mock.mock.restore()
  }
})

test('crash gap with persisted attempt latch is exposed as unknown without retry', async t => {
  const { service, config, put, stateDir } = await fixture(t)
  const prepared = await service.prepare([await put('outbox/file', 'payload')], owner, target)
  await writeFile(join(stateDir, `${prepared.manifest.task_id}.attempt`), '{"at":"interrupted"}', { flag: 'wx', mode: 0o600 })
  const restarted = new ArtifactService(config)
  assert.equal((await restarted.localStatus(prepared.manifest.task_id, owner)).state, 'unknown')
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'queued', code: 'queued' } }
  assert.equal((await restarted.publish(prepared.manifest.task_id, owner, target, dispatch)).result, 'unknown')
  assert.equal(calls, 0)
})

test('private state directory is outside shared workspace and rejects broad permissions', async t => {
  const { service, workspaceRoot, stateDir, config, put } = await fixture(t)
  assert.throws(() => new ArtifactService({ ...config, stateDir: join(workspaceRoot, 'state') }), /state_must_be_outside_workspace/u)
  await mkdir(stateDir, { mode: 0o700 })
  await chmod(stateDir, 0o755)
  await assert.rejects(service.prepare([await put('outbox/file', 'payload')], owner, target), /unsafe_state_permissions/u)
})

test('local status is read-only and does not create notification attempts', async t => {
  const { service, put, stateDir } = await fixture(t)
  const prepared = await service.prepare([await put('outbox/file', 'payload')], owner, target)
  const before = (await readdir(stateDir)).sort()
  for (let index = 0; index < 3; index++) assert.equal((await service.localStatus(prepared.manifest.task_id, owner)).state, 'prepared')
  assert.deepEqual((await readdir(stateDir)).sort(), before)
})
