import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ArtifactService, type Dispatch } from '../src/core.js'

const owner = 'real-production-agent'
const target = { originId: 'original-host-task', target: 'original-host-chat', toolName: 'mcp__maibot-agent__agent_talk' }

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'artifact-production-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspaceRoot = join(base, 'shared')
  const stateDir = join(base, 'private')
  await mkdir(join(workspaceRoot, 'outbox'), { recursive: true })
  const relative = 'outbox/result'
  const absolute = join(workspaceRoot, relative)
  await writeFile(absolute, 'prepared original bytes')
  const config = { workspaceRoot, stateDir }
  const service = new ArtifactService(config)
  const prepared = await service.prepare([relative], owner, target)
  return { service, config, prepared, relative, absolute }
}

test('deletion before first publish returns stable not_found and never notifies', async t => {
  const { service, prepared, absolute } = await fixture(t)
  await rm(absolute)
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'queued', code: 'unexpected' } }
  const result = await service.publish(prepared.manifest.task_id, owner, target, dispatch)
  assert.equal(result.result, 'prepared_only')
  assert.equal(result.error, 'not_found')
  assert.equal(result.notification, undefined)
  assert.equal(calls, 0)
  assert.equal((await service.localStatus(prepared.manifest.task_id, owner)).error, 'not_found')
})

test('replacement with different bytes before publish is rejected before any remote call', async t => {
  const { service, prepared, absolute } = await fixture(t)
  await rename(absolute, `${absolute}.old`)
  await writeFile(absolute, 'replacement bytes')
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'queued', code: 'unexpected' } }
  const result = await service.publish(prepared.manifest.task_id, owner, target, dispatch)
  assert.equal(result.result, 'prepared_only')
  assert.equal(result.error, 'source_changed')
  assert.equal(calls, 0)
})

test('symlink and hardlink replacement before publish remain fail closed', async t => {
  for (const replacement of ['symlink', 'hardlink'] as const) {
    const { service, prepared, absolute } = await fixture(t)
    await rename(absolute, `${absolute}.old`)
    if (replacement === 'symlink') await symlink(`${absolute}.old`, absolute)
    else await link(`${absolute}.old`, absolute)
    let calls = 0
    const dispatch: Dispatch = async () => { calls++; return { kind: 'queued', code: 'unexpected' } }
    const result = await service.publish(prepared.manifest.task_id, owner, target, dispatch)
    assert.equal(result.result, 'prepared_only')
    assert.equal(result.error, 'unsafe_file')
    assert.equal(result.notification, undefined)
    assert.equal(calls, 0)
  }
})

test('lost receipt remains unknown across restart even when original source was deleted', async t => {
  const { service, config, prepared, absolute } = await fixture(t)
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; throw new Error('connection lost after remote side effect') }
  assert.equal((await service.publish(prepared.manifest.task_id, owner, target, dispatch)).result, 'unknown')
  await rm(absolute)
  const restarted = new ArtifactService(config)
  assert.equal((await restarted.localStatus(prepared.manifest.task_id, owner)).state, 'unknown')
  assert.equal((await restarted.publish(prepared.manifest.task_id, owner, target, dispatch)).result, 'unknown')
  assert.equal(calls, 1)
})

test('queued is historical evidence after source deletion and never becomes imported or a retry', async t => {
  const { service, config, prepared, absolute } = await fixture(t)
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'queued', code: 'actual_queue_receipt' } }
  assert.equal((await service.publish(prepared.manifest.task_id, owner, target, dispatch)).result, 'queued')
  await rm(absolute)
  const restarted = new ArtifactService(config)
  const status = await restarted.localStatus(prepared.manifest.task_id, owner)
  assert.equal(status.state, 'queued')
  assert.equal(status.notification?.code, 'actual_queue_receipt')
  assert.equal('imported' in status, false)
  assert.equal((await restarted.publish(prepared.manifest.task_id, owner, target, dispatch)).result, 'queued')
  assert.equal(calls, 1)
})
