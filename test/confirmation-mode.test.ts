import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ArtifactService, type ArtifactConfig, type Dispatch } from '../src/core.js'
import { Config } from '../src/index.js'

const owner = 'actual-confirmation-agent'
async function fixture(t: TestContext, confirmationMode?: ArtifactConfig['confirmationMode']) {
  const base = await mkdtemp(join(tmpdir(), 'confirmation-mode-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspaceRoot = join(base, 'shared')
  await mkdir(join(workspaceRoot, 'outbox'), { recursive: true })
  await writeFile(join(workspaceRoot, 'outbox', '结果.bin'), Buffer.from([0, 255, 128, 9]))
  const config = { workspaceRoot, stateDir: join(base, 'private'), ...(confirmationMode === undefined ? {} : { confirmationMode }) }
  const service = new ArtifactService(config)
  const prepared = await service.prepare(['outbox/结果.bin'], owner)
  return { workspaceRoot, config, service, prepared }
}

for (const mode of [undefined, 'manifest'] as const) {
  test(`${mode === undefined ? 'omitted' : 'explicit manifest'} mode returns the existing v0.2.0 import tool with send=false`, async t => {
    const { workspaceRoot, service, prepared } = await fixture(t, mode)
    let remoteCalls = 0
    const dispatch: Dispatch = async () => { remoteCalls++; throw new Error('remote calls are forbidden in local submission') }
    const submitted = await service.publish(prepared.manifest.task_id, owner, undefined, dispatch)
    assert.equal(service.config.confirmationMode, 'manifest')
    assert.equal(submitted.result, 'submitted')
    assert.ok('confirmation' in submitted)
    assert.deepEqual(submitted.confirmation, {
      tool: 'dsh_import_handoff', arguments: { manifest: prepared.manifest, send: false },
    })
    assert.deepEqual(Object.keys(submitted.confirmation.arguments).sort(), ['manifest', 'send'])
    assert.deepEqual(Object.keys(prepared.manifest).sort(), ['files', 'task_id', 'type', 'version'])
    assert.equal(submitted.maibot_registration, 'unconfirmed')
    assert.equal(submitted.state, 'prepared')
    assert.equal(submitted.notification, undefined)
    assert.equal('file_ref' in submitted, false)
    assert.equal(remoteCalls, 0)
    const saved = JSON.parse(await readFile(join(workspaceRoot, submitted.shared_request.path), 'utf8'))
    assert.deepEqual(saved, prepared.manifest)
  })
}

test('explicit request mode returns only task ID and request hash for the reviewed newer peer', async t => {
  const { workspaceRoot, service, prepared } = await fixture(t, 'request')
  let remoteCalls = 0
  const dispatch: Dispatch = async () => { remoteCalls++; throw new Error('must not dispatch') }
  const submitted = await service.publish(prepared.manifest.task_id, owner, undefined, dispatch)
  assert.ok('confirmation' in submitted)
  const bytes = await readFile(join(workspaceRoot, submitted.shared_request.path))
  const requestSha256 = createHash('sha256').update(bytes).digest('hex')
  assert.deepEqual(submitted.confirmation, {
    tool: 'dsh_import_request', arguments: { task_id: prepared.manifest.task_id, request_sha256: requestSha256 },
  })
  assert.equal(submitted.result, 'submitted')
  assert.equal(submitted.maibot_registration, 'unconfirmed')
  assert.equal(remoteCalls, 0)
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), prepared.manifest)
})

test('invalid confirmation modes fail clearly before filesystem operations', () => {
  for (const mode of ['', 'auto', 'REQUEST', true, 1, null]) {
    assert.throws(() => new ArtifactService({
      workspaceRoot: '/unused/shared', stateDir: '/unused/private', confirmationMode: mode,
    } as unknown as ArtifactConfig), { code: 'invalid_confirmation_mode' })
  }
})

test('actual Schemastery config defaults to manifest and accepts only the two explicit choices', () => {
  assert.equal(Config({ workspaceRoot: '/unused/shared' }).confirmationMode, 'manifest')
  for (const mode of ['manifest', 'request'] as const) {
    assert.equal(Config({ workspaceRoot: '/unused/shared', confirmationMode: mode }).confirmationMode, mode)
  }
  assert.throws(() => Config({ workspaceRoot: '/unused/shared', confirmationMode: 'auto' } as never))
})

test('changing confirmation mode after restart only changes instructions, leaving the shared request untouched', async t => {
  const { workspaceRoot, config, service, prepared } = await fixture(t)
  const first = await service.publish(prepared.manifest.task_id, owner)
  assert.ok('confirmation' in first)
  const requestPath = join(workspaceRoot, first.shared_request.path)
  const before = await lstat(requestPath, { bigint: true })
  const bytes = await readFile(requestPath)
  const restarted = new ArtifactService({ ...config, confirmationMode: 'request' })
  const second = await restarted.publish(prepared.manifest.task_id, owner)
  assert.ok('confirmation' in second)
  assert.equal(first.confirmation.tool, 'dsh_import_handoff')
  assert.equal(second.confirmation.tool, 'dsh_import_request')
  assert.deepEqual(second.shared_request, first.shared_request)
  const after = await lstat(requestPath, { bigint: true })
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeNs, before.mtimeNs)
  assert.deepEqual(await readFile(requestPath), bytes)
  assert.equal((await restarted.localStatus(prepared.manifest.task_id, owner)).notification, undefined)
})
