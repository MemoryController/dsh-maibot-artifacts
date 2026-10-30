import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ArtifactService, type TaskRecord } from '../src/core.js'
import { publishSharedRequest } from '../src/shared-request.js'
import { validateRecord } from '../src/submission-state.js'

const owner = 'real-agent-legacy-record-review'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'submission-record-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspaceRoot = join(base, 'workspace')
  const stateDir = join(base, 'state')
  await mkdir(join(workspaceRoot, 'outbox'), { recursive: true })
  await writeFile(join(workspaceRoot, 'outbox/产物.bin'), Buffer.from([0, 128, 255, 1]))
  const config = { workspaceRoot, stateDir }
  const service = new ArtifactService(config)
  const prepared = await service.prepare(['outbox/产物.bin'], owner)
  const id = prepared.manifest.task_id
  const record = await service.localStatus(id, owner)
  const primary = join(stateDir, `${id}.json`)
  const intent = join(stateDir, `${id}.submission-intent`)
  const complete = join(stateDir, `${id}.submission-complete`)
  return { base, config, service, id, record, primary, intent, complete }
}
function validRequest(record: TaskRecord) {
  return {
    path: `outbox/.dsh-handoffs/${record.manifest.task_id}.json`,
    sha256: digest(JSON.stringify(record.manifest)), submittedAt: new Date().toISOString(),
  }
}
function corruptions(record: TaskRecord): Record<string, unknown>[] {
  const request = validRequest(record)
  const notification = {
    kind: 'queued', code: 'maibot_queue_receipt', at: new Date().toISOString(),
    toolName: 'mcp__maibot-agent__agent_talk', targetHash: digest('actual-original-target'),
  }
  const otherHash = `${request.sha256[0] === 'a' ? 'b' : 'a'}${request.sha256.slice(1)}`
  return [
    { ...record, submission: {} },
    { ...record, submission: null },
    { ...record, submission: { ...request, path: '/tmp/forged.json' } },
    { ...record, submission: { ...request, path: `outbox/.dsh-handoffs/${'f'.repeat(32)}.json` } },
    { ...record, submission: { ...request, sha256: otherHash } },
    { ...record, submission: { ...request, submittedAt: '2026-10-30' } },
    { ...record, submission: { ...request, send: true } },
    { ...record, notification: {} },
    { ...record, notification: { ...notification, kind: 'imported' } },
    { ...record, notification: { ...notification, targetHash: 'not-a-sha256' } },
    { ...record, notification: { ...notification, at: 'invalid-time' } },
    { ...record, originHash: 'malformed' },
    { ...record, originHash: null },
  ]
}

async function assertAbsent(path: string) {
  await assert.rejects(lstat(path), { code: 'ENOENT' })
}

test('primary validator rejects malformed optional publication, notification and origin fields', async t => {
  const f = await fixture(t)
  for (const bad of corruptions(f.record)) {
    assert.throws(() => validateRecord(bad, f.id, f.record.owner), JSON.stringify(bad))
  }
})

test('malformed optional primary fields without private intent never become submitted or start recovery writes', async t => {
  const f = await fixture(t)
  const beforeNames = (await readdir(f.config.stateDir)).sort()
  for (const bad of corruptions(f.record)) {
    const bytes = JSON.stringify(bad)
    await writeFile(f.primary, bytes)
    const restarted = new ArtifactService(f.config)
    await assert.rejects(restarted.localStatus(f.id, owner), /missing or corrupt|recovery evidence|record is invalid/u)
    await assert.rejects(restarted.publish(f.id, owner))
    assert.equal(await readFile(f.primary, 'utf8'), bytes)
    assert.deepEqual((await readdir(f.config.stateDir)).sort(), beforeNames)
    await assertAbsent(f.intent)
    await assertAbsent(f.complete)
    await assertAbsent(join(f.config.workspaceRoot, 'outbox/.dsh-handoffs'))
  }
})

test('valid intent and completion recover malformed optional primary fields without rewriting them', async t => {
  const f = await fixture(t)
  assert.equal((await f.service.publish(f.id, owner)).result, 'submitted')
  const beforeNames = (await readdir(f.config.stateDir)).sort()
  const requestPath = join(f.config.workspaceRoot, validRequest(f.record).path)
  const requestBytes = await readFile(requestPath)
  for (const bad of corruptions(f.record)) {
    const bytes = JSON.stringify(bad)
    await writeFile(f.primary, bytes)
    const restarted = new ArtifactService(f.config)
    const status = await restarted.localStatus(f.id, owner)
    assert.equal(status.record_recovery, 'corrupt')
    assert.equal(status.submission?.sha256, digest(JSON.stringify(f.record.manifest)))
    assert.equal(status.notification, undefined)
    assert.equal(status.originHash, undefined)
    assert.equal((await restarted.publish(f.id, owner)).result, 'submitted')
    assert.equal(await readFile(f.primary, 'utf8'), bytes)
    assert.deepEqual((await readdir(f.config.stateDir)).sort(), beforeNames)
    assert.deepEqual(await readFile(requestPath), requestBytes)
  }
})

test('unsafe primary hardlink cannot serve as legacy completion evidence without private intent', async t => {
  const f = await fixture(t)
  const request = await publishSharedRequest(f.config.workspaceRoot, f.record.manifest)
  await writeFile(f.primary, JSON.stringify({ ...f.record, submission: request }))
  await link(f.primary, join(f.base, 'unexpected-primary-hardlink'))
  assert.equal((await lstat(f.primary)).nlink, 2)
  await assert.rejects(new ArtifactService(f.config).localStatus(f.id, owner))
  await assert.rejects(new ArtifactService(f.config).publish(f.id, owner))
  await assertAbsent(f.intent)
  await assertAbsent(f.complete)
})

test('unsafe primary permissions cannot serve as legacy completion evidence', async t => {
  const f = await fixture(t)
  const request = await publishSharedRequest(f.config.workspaceRoot, f.record.manifest)
  await writeFile(f.primary, JSON.stringify({ ...f.record, submission: request }))
  await chmod(f.primary, 0o640)
  await assert.rejects(new ArtifactService(f.config).localStatus(f.id, owner))
  await assert.rejects(new ArtifactService(f.config).publish(f.id, owner))
  assert.equal((await lstat(f.primary)).mode & 0o777, 0o640)
  await assertAbsent(f.intent)
  await assertAbsent(f.complete)
})

test('valid version-0.2 markerless completion remains submitted through read-only upgrade', async t => {
  const f = await fixture(t)
  // The legacy writer saved this primary only after this real shared writer
  // completed. No new-version intent or completion markers existed then.
  const request = await publishSharedRequest(f.config.workspaceRoot, f.record.manifest)
  const legacy = { ...f.record, submission: request }
  const primaryBytes = JSON.stringify(legacy)
  await writeFile(f.primary, primaryBytes)
  const beforeNames = (await readdir(f.config.stateDir)).sort()
  const requestPath = join(f.config.workspaceRoot, request.path)
  const sharedBytes = await readFile(requestPath)
  const beforeInfo = await lstat(requestPath, { bigint: true })
  const restarted = new ArtifactService(f.config)
  const status = await restarted.localStatus(f.id, owner)
  assert.deepEqual(status.submission, request)
  assert.equal(status.record_recovery, undefined)
  let remoteCalls = 0
  const result = await restarted.publish(f.id, owner, undefined, async () => {
    remoteCalls++
    throw new Error('Legacy record recovery must never notify')
  })
  assert.equal(result.result, 'submitted')
  assert.equal(result.state, 'prepared')
  assert.ok('confirmation' in result)
  assert.deepEqual(result.confirmation, { tool: 'dsh_import_handoff', arguments: { manifest: f.record.manifest, send: false } })
  assert.equal(result.maibot_registration, 'unconfirmed')
  assert.equal('imported' in result, false)
  assert.equal(remoteCalls, 0)
  assert.equal(await readFile(f.primary, 'utf8'), primaryBytes)
  assert.deepEqual((await readdir(f.config.stateDir)).sort(), beforeNames)
  assert.deepEqual(await readFile(requestPath), sharedBytes)
  const afterInfo = await lstat(requestPath, { bigint: true })
  for (const key of ['ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'] as const) assert.equal(afterInfo[key], beforeInfo[key])
  await assertAbsent(f.intent)
  await assertAbsent(f.complete)
})

test('valid legacy completion cannot be claimed by another real Agent scope', async t => {
  const f = await fixture(t)
  const request = await publishSharedRequest(f.config.workspaceRoot, f.record.manifest)
  await writeFile(f.primary, JSON.stringify({ ...f.record, submission: request }))
  const restarted = new ArtifactService(f.config)
  await assert.rejects(restarted.localStatus(f.id, 'other-agent'), /not in this Agent scope/u)
  await assert.rejects(restarted.publish(f.id, 'other-agent'), /not in this Agent scope/u)
  await assertAbsent(f.intent)
  await assertAbsent(f.complete)
})
