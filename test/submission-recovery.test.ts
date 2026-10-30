import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ArtifactService, type TaskRecord } from '../src/core.js'
import { publishSharedRequest } from '../src/shared-request.js'

const owner = 'actual-agent-submission-recovery'
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const ioFailure = () => Object.assign(new Error('injected local I/O failure'), { code: 'EIO' })
interface PrivateService {
  load(id: string, owner: string): Promise<TaskRecord>
  save(record: TaskRecord): Promise<void>
  exclusive(path: string, value: unknown): Promise<void>
}

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-submission-recovery-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspaceRoot = join(base, 'workspace')
  const stateDir = join(base, 'state')
  await mkdir(join(workspaceRoot, 'outbox'), { recursive: true })
  const artifact = join(workspaceRoot, 'outbox/产物 final.bin')
  await writeFile(artifact, Buffer.from([0, 255, 128, 1, 2, 3]))
  const config = { workspaceRoot, stateDir }
  const service = new ArtifactService(config)
  const prepared = await service.prepare(['outbox/产物 final.bin'], owner)
  const taskId = prepared.manifest.task_id
  const record = await service.localStatus(taskId, owner)
  const bytes = Buffer.from(JSON.stringify(record.manifest))
  return {
    base, config, service, record, artifact, taskId, bytes,
    primary: join(stateDir, `${taskId}.json`),
    intent: join(stateDir, `${taskId}.submission-intent`),
    complete: join(stateDir, `${taskId}.submission-complete`),
    request: join(workspaceRoot, `outbox/.dsh-handoffs/${taskId}.json`),
    async intentOnly() {
      await writeFile(join(stateDir, `${taskId}.submission-intent`), JSON.stringify({
        version: 1, record, requestSha256: sha(bytes), startedAt: new Date().toISOString(),
      }), { mode: 0o600, flag: 'wx' })
    },
  }
}

async function assertAbsent(path: string) {
  await assert.rejects(lstat(path), { code: 'ENOENT' })
}

async function assertPrivateMarker(path: string) {
  const info = await lstat(path)
  assert.equal(info.isFile(), true)
  assert.equal(info.nlink, 1)
  assert.equal(info.mode & 0o777, 0o600)
}

test('submission intent and completion are durable private evidence with exact request digest and single-link shared bytes', async t => {
  const f = await fixture(t)
  const result = await f.service.publish(f.taskId, owner)
  assert.equal(result.result, 'submitted')
  const intent = JSON.parse(await readFile(f.intent, 'utf8'))
  const complete = JSON.parse(await readFile(f.complete, 'utf8'))
  assert.equal(intent.version, 1)
  assert.deepEqual(intent.record, f.record)
  assert.equal(intent.requestSha256, sha(f.bytes))
  assert.equal(Number.isNaN(Date.parse(intent.startedAt)), false)
  assert.equal(complete.version, 1)
  assert.equal(complete.owner, f.record.owner)
  assert.equal(complete.task_id, f.taskId)
  assert.equal(complete.request.sha256, sha(f.bytes))
  assert.equal(complete.request.path, `outbox/.dsh-handoffs/${f.taskId}.json`)
  await assertPrivateMarker(f.intent)
  await assertPrivateMarker(f.complete)
  assert.deepEqual(await readFile(f.request), f.bytes)
  const shared = await lstat(f.request)
  assert.equal(shared.nlink, 1)
  assert.equal(shared.mode & 0o777, 0o640)
  assert.equal((await f.service.localStatus(f.taskId, owner)).submission?.sha256, sha(f.bytes))
})

test('artifact validation failure before intent remains prepared_only and leaves no journal or shared request', async t => {
  const f = await fixture(t)
  await writeFile(f.artifact, 'changed before submission')
  const result = await f.service.publish(f.taskId, owner)
  assert.equal(result.result, 'prepared_only')
  assert.equal(result.error, 'source_changed')
  await assertAbsent(f.intent)
  await assertAbsent(f.complete)
  await assertAbsent(f.request)
})

test('definite pre-link writer failure is prepared_only once but its intent blocks later automatic recreation', async t => {
  const f = await fixture(t)
  const original = fs.open
  let failed = false
  const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('.tmp')) {
      failed = true
      throw ioFailure()
    }
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    const result = await f.service.publish(f.taskId, owner)
    assert.equal(failed, true)
    assert.equal(result.result, 'prepared_only')
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
  await assertPrivateMarker(f.intent)
  await assertAbsent(f.complete)
  await assertAbsent(f.request)
  const restarted = new ArtifactService(f.config)
  assert.equal((await restarted.localStatus(f.taskId, owner)).state, 'unknown')
  assert.equal((await restarted.publish(f.taskId, owner)).result, 'unknown')
  await assertAbsent(f.request)
})

test('an ambiguous link error is unknown even when the request is not visible and never attempts another link', async t => {
  const f = await fixture(t)
  const original = fs.link
  let attempts = 0
  const mock = t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    if (String(args[1]).startsWith('/proc/self/fd/') && String(args[1]).endsWith(`/${f.taskId}.json`)) {
      attempts++
      throw ioFailure()
    }
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    assert.equal((await f.service.publish(f.taskId, owner)).result, 'unknown')
    assert.equal((await new ArtifactService(f.config).publish(f.taskId, owner)).result, 'unknown')
    assert.equal(attempts, 1)
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
  await assertPrivateMarker(f.intent)
  await assertAbsent(f.complete)
  await assertAbsent(f.request)
})

test('link side effect followed by an error leaves exact bytes but unknown without any automatic repair', async t => {
  const f = await fixture(t)
  const original = fs.link
  let attempts = 0
  const mock = t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    await original(...args)
    if (String(args[1]).startsWith('/proc/self/fd/') && String(args[1]).endsWith(`/${f.taskId}.json`)) {
      attempts++
      throw ioFailure()
    }
  })
  syncBuiltinESMExports()
  try {
    const result = await f.service.publish(f.taskId, owner)
    assert.equal(result.result, 'unknown')
    assert.notEqual(result.result, 'prepared_only')
    assert.deepEqual(await readFile(f.request), f.bytes)
    assert.equal((await lstat(f.request)).nlink, 1)
    assert.equal((await new ArtifactService(f.config).publish(f.taskId, owner)).result, 'unknown')
    assert.equal(attempts, 1)
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
  await assertAbsent(f.complete)
})

test('request-directory fsync failure after link reports unknown and retains visible request without completion proof', async t => {
  const f = await fixture(t)
  const probe = await open(f.config.workspaceRoot, 'r')
  const prototype = Object.getPrototypeOf(probe)
  const originalSync = prototype.sync as () => Promise<void>
  await probe.close()
  const originalLink = fs.link
  let linked = false
  let failed = false
  const linkMock = t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    await originalLink(...args)
    if (String(args[1]).startsWith('/proc/self/fd/') && String(args[1]).endsWith(`/${f.taskId}.json`)) linked = true
  })
  const syncMock = t.mock.method(prototype, 'sync', async function (this: unknown) {
    if (linked && !failed) { failed = true; throw ioFailure() }
    return originalSync.call(this)
  })
  syncBuiltinESMExports()
  try {
    assert.equal((await f.service.publish(f.taskId, owner)).result, 'unknown')
    assert.equal(failed, true)
  } finally { linkMock.mock.restore(); syncMock.mock.restore(); syncBuiltinESMExports() }
  assert.deepEqual(await readFile(f.request), f.bytes)
  assert.equal((await lstat(f.request)).nlink, 1)
  await assertAbsent(f.complete)
  assert.equal((await new ArtifactService(f.config).publish(f.taskId, owner)).result, 'unknown')
})

test('completion-marker persistence failure after successful writer is unknown and cannot be mistaken for prepared_only', async t => {
  const f = await fixture(t)
  const internals = f.service as unknown as PrivateService
  const original = internals.exclusive.bind(f.service)
  const mock = t.mock.method(internals, 'exclusive', async (path: string, value: unknown) => {
    if (path.endsWith('.submission-complete')) throw ioFailure()
    return original(path, value)
  })
  try {
    assert.equal((await f.service.publish(f.taskId, owner)).result, 'unknown')
  } finally { mock.mock.restore() }
  assert.deepEqual(await readFile(f.request), f.bytes)
  await assertPrivateMarker(f.intent)
  await assertAbsent(f.complete)
  assert.equal((await new ArtifactService(f.config).localStatus(f.taskId, owner)).state, 'unknown')
})

test('main-record save failure is initially unknown, then validated completion recovers submitted evidence read-only', async t => {
  const f = await fixture(t)
  const internals = f.service as unknown as PrivateService
  const mock = t.mock.method(internals, 'save', async () => { throw ioFailure() })
  try { assert.equal((await f.service.publish(f.taskId, owner)).result, 'unknown') }
  finally { mock.mock.restore() }
  await assertPrivateMarker(f.intent)
  await assertPrivateMarker(f.complete)
  assert.equal(JSON.parse(await readFile(f.primary, 'utf8')).submission, undefined)
  const before = await readFile(f.request)
  const names = (await readdir(f.config.stateDir)).sort()
  const restarted = new ArtifactService(f.config)
  const status = await restarted.localStatus(f.taskId, owner)
  assert.equal(status.state, 'prepared')
  assert.equal(status.submission?.sha256, sha(f.bytes))
  assert.equal((await restarted.publish(f.taskId, owner)).result, 'submitted')
  assert.deepEqual(await readFile(f.request), before)
  assert.deepEqual((await readdir(f.config.stateDir)).sort(), names)
})

test('child-process crash before completion remains unknown; crash after completion before main save recovers submitted', async t => {
  for (const phase of ['before-complete', 'before-main-save']) {
    const f = await fixture(t)
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/recovery-crash.mjs', import.meta.url)),
      JSON.stringify({ config: f.config, taskId: f.taskId, owner, phase })], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, phase === 'before-complete' ? 74 : 73, result.stdout + result.stderr)
    await assertPrivateMarker(f.intent)
    assert.deepEqual(await readFile(f.request), f.bytes)
    assert.equal((await lstat(f.request)).nlink, 1)
    assert.equal(JSON.parse(await readFile(f.primary, 'utf8')).submission, undefined)
    const restarted = new ArtifactService(f.config)
    if (phase === 'before-complete') {
      await assertAbsent(f.complete)
      assert.equal((await restarted.localStatus(f.taskId, owner)).state, 'unknown')
      assert.equal((await restarted.publish(f.taskId, owner)).result, 'unknown')
    } else {
      await assertPrivateMarker(f.complete)
      assert.equal((await restarted.localStatus(f.taskId, owner)).submission?.sha256, sha(f.bytes))
      assert.equal((await restarted.publish(f.taskId, owner)).result, 'submitted')
    }
    assert.deepEqual(await readdir(join(f.config.workspaceRoot, 'outbox/.dsh-handoffs')), [`${f.taskId}.json`])
  }
})

test('validated intent and completion recover missing or corrupt primary records without rewriting them', async t => {
  for (const damage of ['missing', 'corrupt', 'empty-object', 'invalid-manifest']) {
    const f = await fixture(t)
    assert.equal((await f.service.publish(f.taskId, owner)).result, 'submitted')
    if (damage === 'missing') await unlink(f.primary)
    else if (damage === 'corrupt') await writeFile(f.primary, '{broken JSON')
    else if (damage === 'empty-object') await writeFile(f.primary, '{}')
    else await writeFile(f.primary, JSON.stringify({ ...f.record, manifest: { ...f.record.manifest, version: 2 } }))
    const damagedBytes = damage === 'missing' ? undefined : await readFile(f.primary)
    const restarted = new ArtifactService(f.config)
    const status = await restarted.localStatus(f.taskId, owner)
    assert.deepEqual(status.manifest, f.record.manifest)
    assert.equal(status.record_recovery, damage === 'missing' ? 'missing' : 'corrupt')
    assert.equal(status.submission?.sha256, sha(f.bytes))
    assert.equal((await restarted.publish(f.taskId, owner)).result, 'submitted')
    if (damage === 'missing') await assertAbsent(f.primary)
    else assert.deepEqual(await readFile(f.primary), damagedBytes)
    assert.deepEqual(await readFile(f.request), f.bytes)
  }
})

test('intent alone stays unknown for matching, absent, conflicting or unreadable shared bytes, including with primary record missing', async t => {
  for (const observed of ['matching', 'absent', 'conflicting', 'unreadable']) {
    const f = await fixture(t)
    await f.intentOnly()
    if (observed !== 'absent') {
      await publishSharedRequest(f.config.workspaceRoot, f.record.manifest)
      if (observed === 'conflicting') await writeFile(f.request, 'unexpected existing request')
      if (observed === 'unreadable') await chmod(f.request, 0)
    }
    await unlink(f.primary)
    const restarted = new ArtifactService(f.config)
    assert.equal((await restarted.localStatus(f.taskId, owner)).state, 'unknown')
    assert.equal((await restarted.publish(f.taskId, owner)).result, 'unknown')
    await assertAbsent(f.complete)
    await assertAbsent(f.primary)
    if (observed === 'matching') assert.deepEqual(await readFile(f.request), f.bytes)
    if (observed === 'conflicting') assert.equal(await readFile(f.request, 'utf8'), 'unexpected existing request')
    if (observed === 'absent') await assertAbsent(f.request)
    if (observed === 'unreadable') assert.equal((await lstat(f.request)).mode & 0o777, 0)
  }
})

test('same-task concurrent submissions have one publisher and one immutable completed request', async t => {
  const f = await fixture(t)
  const original = fs.link
  let publications = 0
  const mock = t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    if (String(args[1]).startsWith('/proc/self/fd/') && String(args[1]).endsWith(`/${f.taskId}.json`)) publications++
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => new ArtifactService(f.config).publish(f.taskId, owner)))
    assert.equal(results.some(result => result.result === 'submitted'), true)
    assert.equal(results.every(result => ['submitted', 'unknown'].includes(result.result)), true)
    assert.equal(publications, 1)
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
  await assertPrivateMarker(f.intent)
  await assertPrivateMarker(f.complete)
  assert.deepEqual(await readFile(f.request), f.bytes)
  assert.equal((await lstat(f.request)).nlink, 1)
})

test('a conflicting shared request freezes the same task unknown and cannot be recreated after someone deletes the conflict', async t => {
  const f = await fixture(t)
  await mkdir(join(f.config.workspaceRoot, 'outbox/.dsh-handoffs'), { mode: 0o750 })
  await writeFile(f.request, 'conflicting shared data', { mode: 0o640 })
  assert.equal((await f.service.publish(f.taskId, owner)).result, 'unknown')
  assert.equal(await readFile(f.request, 'utf8'), 'conflicting shared data')
  await assertPrivateMarker(f.intent)
  await assertAbsent(f.complete)
  await unlink(f.request)
  assert.equal((await new ArtifactService(f.config).publish(f.taskId, owner)).result, 'unknown')
  await assertAbsent(f.request)
})

test('unsafe or inconsistent private intents fail closed and never create a shared request', async t => {
  for (const invalid of ['permissions', 'symlink', 'hardlink', 'schema', 'digest', 'owner']) {
    const f = await fixture(t)
    await f.intentOnly()
    if (invalid === 'permissions') await chmod(f.intent, 0o644)
    if (invalid === 'symlink' || invalid === 'hardlink') {
      const backup = join(f.base, 'original-intent')
      await writeFile(backup, await readFile(f.intent), { mode: 0o600 })
      await unlink(f.intent)
      if (invalid === 'symlink') await symlink(backup, f.intent)
      else await link(backup, f.intent)
    }
    if (['schema', 'digest', 'owner'].includes(invalid)) {
      const value = JSON.parse(await readFile(f.intent, 'utf8'))
      if (invalid === 'schema') value.version = 2
      if (invalid === 'digest') value.requestSha256 = '0'.repeat(64)
      if (invalid === 'owner') value.record.owner = sha('other-agent')
      await writeFile(f.intent, JSON.stringify(value))
    }
    await unlink(f.primary)
    const restarted = new ArtifactService(f.config)
    const result = await restarted.publish(f.taskId, owner).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
    if (result.ok) {
      assert.equal(result.value.result, 'unknown')
      assert.equal(result.value.submission, undefined)
    }
    await assertAbsent(f.request)
    await assertAbsent(f.complete)
    await assertAbsent(f.primary)
  }
})

test('validated recovery still requires the original execution owner and never exposes another owner manifest', async t => {
  const f = await fixture(t)
  await f.service.publish(f.taskId, owner)
  await unlink(f.primary)
  const restarted = new ArtifactService(f.config)
  await assert.rejects(restarted.localStatus(f.taskId, 'another-agent'))
  await assert.rejects(restarted.publish(f.taskId, 'another-agent'))
  assert.deepEqual(await readFile(f.request), f.bytes)
  // A structurally valid primary record naming another owner is an explicit
  // scope denial, not damaged JSON that can justify bypassing ownership.
  const changedOwner = await fixture(t)
  await changedOwner.service.publish(changedOwner.taskId, owner)
  await writeFile(changedOwner.primary, JSON.stringify({ ...changedOwner.record, owner: sha('another-agent') }))
  const denied = new ArtifactService(changedOwner.config)
  await assert.rejects(denied.localStatus(changedOwner.taskId, owner), { code: 'task_not_found_in_scope' })
  await assert.rejects(denied.publish(changedOwner.taskId, owner), { code: 'task_not_found_in_scope' })
  assert.deepEqual(await readFile(changedOwner.request), changedOwner.bytes)
})

test('historical error markers do not override newer completed submission or notification evidence', async t => {
  const f = await fixture(t)
  await writeFile(join(f.config.stateDir, `${f.taskId}.error`), JSON.stringify({ code: 'old_source_changed' }), { mode: 0o600 })
  const result = await f.service.publish(f.taskId, owner)
  assert.equal(result.result, 'submitted')
  const status = await new ArtifactService(f.config).localStatus(f.taskId, owner)
  assert.equal(status.error, undefined)
  assert.equal((status as TaskRecord & { historical_error?: string }).historical_error, 'old_source_changed')
  assert.equal(status.submission?.sha256, sha(f.bytes))
  const target = { target: 'authentic-chat', originId: 'authentic-task', toolName: 'mcp__maibot-agent__agent_talk' }
  const bound = await f.service.prepare(['outbox/产物 final.bin'], owner, target)
  await writeFile(join(f.config.stateDir, `${bound.manifest.task_id}.error`), JSON.stringify({ code: 'older_validation_error' }), { mode: 0o600 })
  const queued = await f.service.publish(bound.manifest.task_id, owner, target, async () => ({ kind: 'queued', code: 'verified_queue_receipt' }))
  assert.equal(queued.result, 'queued')
  const notified = await new ArtifactService(f.config).localStatus(bound.manifest.task_id, owner)
  assert.equal(notified.error, undefined)
  assert.equal((notified as TaskRecord & { historical_error?: string }).historical_error, 'older_validation_error')
  assert.equal(notified.notification?.code, 'verified_queue_receipt')
})

test('post-publication private reload failure returns unknown while durable completion permits restart recovery', async t => {
  const f = await fixture(t)
  const internals = f.service as unknown as PrivateService
  const original = internals.load.bind(f.service)
  let loads = 0
  const mock = t.mock.method(internals, 'load', async (id: string, scope: string) => {
    loads++
    if (loads === 2) throw ioFailure()
    return original(id, scope)
  })
  try {
    const result = await f.service.publish(f.taskId, owner)
    assert.equal(loads, 2)
    assert.equal(result.result, 'unknown')
    assert.equal(result.state, 'unknown')
    assert.equal(result.submission, undefined)
  } finally { mock.mock.restore() }
  await assertPrivateMarker(f.intent)
  await assertPrivateMarker(f.complete)
  assert.deepEqual(await readFile(f.request), f.bytes)
  assert.equal((await lstat(f.request)).nlink, 1)
  assert.equal(JSON.parse(await readFile(f.primary, 'utf8')).submission, undefined)
  const restarted = new ArtifactService(f.config)
  assert.equal((await restarted.localStatus(f.taskId, owner)).submission?.sha256, sha(f.bytes))
  assert.equal((await restarted.publish(f.taskId, owner)).result, 'submitted')
})

test('secondary diagnostic persistence failure cannot mask an unknown main-record save outcome', async t => {
  const f = await fixture(t)
  const internals = f.service as unknown as PrivateService
  const exclusive = internals.exclusive.bind(f.service)
  let diagnosticAttempts = 0
  const diagnosticMock = t.mock.method(internals, 'exclusive', async (path: string, value: unknown) => {
    if (path.endsWith('.error')) {
      diagnosticAttempts++
      throw ioFailure()
    }
    return exclusive(path, value)
  })
  const saveMock = t.mock.method(internals, 'save', async () => { throw ioFailure() })
  try {
    const result = await f.service.publish(f.taskId, owner)
    assert.equal(result.result, 'unknown')
    assert.equal(result.state, 'unknown')
    assert.equal(diagnosticAttempts, 1)
  } finally { diagnosticMock.mock.restore(); saveMock.mock.restore() }
  await assertPrivateMarker(f.intent)
  await assertPrivateMarker(f.complete)
  await assertAbsent(join(f.config.stateDir, `${f.taskId}.error`))
  assert.deepEqual(await readFile(f.request), f.bytes)
  assert.equal((await lstat(f.request)).nlink, 1)
  assert.equal((await new ArtifactService(f.config).publish(f.taskId, owner)).result, 'submitted')
})

test('orphan completion without intent blocks a reverted prepared record and never rewrites or recreates the request', async t => {
  const f = await fixture(t)
  assert.equal((await f.service.publish(f.taskId, owner)).result, 'submitted')
  const completionBytes = await readFile(f.complete)
  const requestIdentity = await lstat(f.request)
  await unlink(f.intent)
  await writeFile(f.primary, JSON.stringify(f.record))
  const originalLink = fs.link
  let sharedWrites = 0
  const mock = t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    if (String(args[1]).startsWith('/proc/self/fd/') && String(args[1]).endsWith(`/${f.taskId}.json`)) sharedWrites++
    return originalLink(...args)
  })
  syncBuiltinESMExports()
  try {
    const restarted = new ArtifactService(f.config)
    const status = await restarted.localStatus(f.taskId, owner)
    assert.equal(status.state, 'unknown')
    assert.equal(status.error, 'submission_intent_unavailable')
    assert.equal(status.submission, undefined)
    assert.equal((await restarted.publish(f.taskId, owner)).result, 'unknown')
    assert.deepEqual(await readFile(f.request), f.bytes)
    assert.equal((await lstat(f.request)).ino, requestIdentity.ino)
    await unlink(f.request)
    assert.equal((await new ArtifactService(f.config).publish(f.taskId, owner)).result, 'unknown')
    await assertAbsent(f.request)
    assert.equal(sharedWrites, 0)
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
  await assertAbsent(f.intent)
  assert.deepEqual(await readFile(f.complete), completionBytes)
  assert.deepEqual(JSON.parse(await readFile(f.primary, 'utf8')), f.record)
})

test('legacy missing or corrupt primary without a private intent rejects recovery and never synthesizes a task or request', async t => {
  for (const damage of ['missing', 'broken-json', 'empty-object', 'invalid-manifest']) {
    const f = await fixture(t)
    if (damage === 'missing') await unlink(f.primary)
    if (damage === 'broken-json') await writeFile(f.primary, '{broken JSON')
    if (damage === 'empty-object') await writeFile(f.primary, '{}')
    if (damage === 'invalid-manifest') await writeFile(f.primary, JSON.stringify({ ...f.record, manifest: { ...f.record.manifest, version: 2 } }))
    const beforeNames = (await readdir(f.config.stateDir)).sort()
    const beforePrimary = damage === 'missing' ? undefined : await readFile(f.primary)
    const restarted = new ArtifactService(f.config)
    await assert.rejects(restarted.localStatus(f.taskId, owner), { code: 'local_record_unavailable' })
    await assert.rejects(restarted.publish(f.taskId, owner), { code: 'local_record_unavailable' })
    assert.deepEqual((await readdir(f.config.stateDir)).sort(), beforeNames)
    await assertAbsent(f.intent)
    await assertAbsent(f.complete)
    await assertAbsent(f.request)
    if (damage === 'missing') await assertAbsent(f.primary)
    else assert.deepEqual(await readFile(f.primary), beforePrimary)
  }
})

test('legacy prepared record with matching shared bytes is unknown; publish fences it without republishing and deletion cannot make it fresh', async t => {
  const f = await fixture(t)
  // Simulate v0.2.0 completing the public write but losing its primary save.
  await publishSharedRequest(f.config.workspaceRoot, f.record.manifest)
  await assertAbsent(f.intent)
  await assertAbsent(f.complete)
  const privateNames = (await readdir(f.config.stateDir)).sort()
  const primaryBytes = await readFile(f.primary)
  const identity = await lstat(f.request, { bigint: true })
  const originalLink = fs.link
  let publicWrites = 0
  let notifications = 0
  const mock = t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    if (String(args[1]).startsWith('/proc/self/fd/') && String(args[1]).endsWith(`/${f.taskId}.json`)) publicWrites++
    return originalLink(...args)
  })
  syncBuiltinESMExports()
  try {
    const restarted = new ArtifactService(f.config)
    const status = await restarted.localStatus(f.taskId, owner)
    assert.equal(status.state, 'unknown')
    assert.equal(status.error, 'legacy_submission_unconfirmed')
    assert.equal(status.submission_check?.kind, 'matching')
    assert.equal(status.submission, undefined)
    assert.deepEqual(status.manifest, f.record.manifest)
    assert.deepEqual((await readdir(f.config.stateDir)).sort(), privateNames)
    await assertAbsent(f.intent) // A read-only query cannot write a recovery journal.
    const result = await restarted.publish(f.taskId, owner, undefined, async () => {
      notifications++
      return { kind: 'queued', code: 'must_not_be_called' }
    })
    assert.equal(result.result, 'unknown')
    assert.equal(result.submission, undefined)
    await assertPrivateMarker(f.intent)
    const intent = await readFile(f.intent)
    assert.deepEqual(JSON.parse(intent.toString()).record, f.record)
    assert.equal(JSON.parse(intent.toString()).requestSha256, sha(f.bytes))
    await assertAbsent(f.complete)
    assert.deepEqual(await readFile(f.primary), primaryBytes)
    assert.deepEqual(await readFile(f.request), f.bytes)
    const after = await lstat(f.request, { bigint: true })
    assert.equal(after.ino, identity.ino)
    assert.equal(after.mtimeNs, identity.mtimeNs)
    assert.equal(after.nlink, 1n)
    assert.equal(publicWrites, 0)
    assert.equal(notifications, 0)
    await unlink(f.request)
    const afterDeletion = new ArtifactService(f.config)
    assert.equal((await afterDeletion.localStatus(f.taskId, owner)).state, 'unknown')
    assert.equal((await afterDeletion.publish(f.taskId, owner)).result, 'unknown')
    await assertAbsent(f.request)
    await assertAbsent(f.complete)
    assert.deepEqual(await readFile(f.intent), intent)
    assert.deepEqual(await readFile(f.primary), primaryBytes)
    assert.equal(publicWrites, 0)
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
})

test('legacy prepared record with conflicting shared bytes is unknown and preserves the conflict without invoking the shared writer', async t => {
  const f = await fixture(t)
  await mkdir(join(f.config.workspaceRoot, 'outbox/.dsh-handoffs'), { mode: 0o750 })
  const conflictingBytes = Buffer.from('legacy public request does not match the prepared manifest')
  await writeFile(f.request, conflictingBytes, { mode: 0o640 })
  const privateNames = (await readdir(f.config.stateDir)).sort()
  const primaryBytes = await readFile(f.primary)
  const identity = await lstat(f.request, { bigint: true })
  const originalLink = fs.link
  let publicWrites = 0
  const mock = t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    if (String(args[1]).startsWith('/proc/self/fd/') && String(args[1]).endsWith(`/${f.taskId}.json`)) publicWrites++
    return originalLink(...args)
  })
  syncBuiltinESMExports()
  try {
    const restarted = new ArtifactService(f.config)
    const status = await restarted.localStatus(f.taskId, owner)
    assert.equal(status.state, 'unknown')
    assert.equal(status.error, 'legacy_submission_unconfirmed')
    assert.equal(status.submission_check?.kind, 'conflict')
    assert.equal(status.submission, undefined)
    assert.deepEqual((await readdir(f.config.stateDir)).sort(), privateNames)
    await assertAbsent(f.intent)
    assert.equal((await restarted.publish(f.taskId, owner)).result, 'unknown')
    await assertPrivateMarker(f.intent)
    await assertAbsent(f.complete)
    const again = new ArtifactService(f.config)
    assert.equal((await again.localStatus(f.taskId, owner)).submission_check?.kind, 'conflict')
    assert.equal((await again.publish(f.taskId, owner)).result, 'unknown')
    assert.deepEqual(await readFile(f.request), conflictingBytes)
    const after = await lstat(f.request, { bigint: true })
    assert.equal(after.ino, identity.ino)
    assert.equal(after.mtimeNs, identity.mtimeNs)
    assert.equal(after.nlink, 1n)
    assert.deepEqual(await readFile(f.primary), primaryBytes)
    assert.equal(publicWrites, 0)
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
})
