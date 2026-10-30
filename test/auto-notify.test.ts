import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { AutoNotifier } from '../src/auto-notify.js'
import { ArtifactService, type ArtifactResult, type Dispatch, type DispatchOutcome, type TaskRecord } from '../src/core.js'

const owner = 'actual-agent-auto-notification'
const fixed = { mode: 'fixed' as const, target: 'single-explicit-receiver', toolName: 'mcp__maibot-agent__agent_talk', acknowledgeSingleChat: true }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
type Options = ConstructorParameters<typeof AutoNotifier>[0]
type NotificationConfig = NonNullable<ConstructorParameters<typeof AutoNotifier>[1]>

async function fixture(t: TestContext, timeout = 1000) {
  const base = await mkdtemp(join(tmpdir(), 'automatic-notification-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspaceRoot = join(base, 'workspace')
  const stateDir = join(base, 'state')
  await mkdir(join(workspaceRoot, 'outbox'), { recursive: true })
  const relative = 'outbox/结果.bin'
  await writeFile(join(workspaceRoot, relative), Buffer.from([0, 128, 255, 5]))
  const coreConfig = { workspaceRoot, stateDir }
  const service = new ArtifactService(coreConfig)
  const prepared = await service.prepare([relative], owner)
  const id = prepared.manifest.task_id
  const options: Options = { stateDir, notificationTimeoutMs: timeout, confirmationMode: 'manifest' }
  const notifier = new AutoNotifier(options, fixed)
  return {
    base, workspaceRoot, stateDir, service, coreConfig, relative, prepared, id, options, notifier,
    policy: join(stateDir, `${id}.notify-policy`), attempt: join(stateDir, `${id}.notify-attempt`),
    resultFile: join(stateDir, `${id}.notify-result`), legacyAttempt: join(stateDir, `${id}.attempt`),
    async publish() {
      const submitted = await service.publish(id, owner)
      assert.equal(submitted.result, 'submitted')
      return submitted
    },
  }
}
async function absent(path: string) { await assert.rejects(lstat(path), { code: 'ENOENT' }) }
async function protectedCoreFiles(f: Awaited<ReturnType<typeof fixture>>) {
  const names = (await readdir(f.stateDir)).filter(name => !name.includes('.notify-')).sort()
  const values: Record<string, string> = {}
  for (const name of names) values[name] = (await readFile(join(f.stateDir, name))).toString('hex')
  const request = join(f.workspaceRoot, `outbox/.dsh-handoffs/${f.id}.json`)
  try { values['shared-request'] = (await readFile(request)).toString('hex') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return values
}
function queueCounter() {
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'queued', code: 'verified_maibot_queue_receipt' } }
  return { dispatch, calls: () => calls }
}

test('automatic notification is disabled without explicit fixed-single-chat authorization', async t => {
  const f = await fixture(t)
  for (const config of [undefined, { mode: 'off' as const }]) {
    const disabled = new AutoNotifier(f.options, config)
    assert.equal(disabled.enabled, false)
    assert.equal((await disabled.bind(f.prepared)).state, 'disabled')
    const counter = queueCounter()
    const result = await disabled.notify(await f.publish(), counter.dispatch)
    assert.equal(result.state, 'disabled')
    assert.equal(counter.calls(), 0)
  }
  await absent(f.policy)
  await absent(f.attempt)
  await absent(f.resultFile)
})

test('fixed notification config rejects missing acknowledgment, invalid tool names and ambiguous targets', async t => {
  const f = await fixture(t)
  const invalid: unknown[] = [
    { ...fixed, acknowledgeSingleChat: undefined }, { ...fixed, acknowledgeSingleChat: false },
    { ...fixed, target: undefined }, { ...fixed, target: '' }, { ...fixed, target: 'receiver\nother' },
    { ...fixed, target: '*'}, { ...fixed, target: 'receiver?' }, { ...fixed, target: 'x'.repeat(2049) },
    { ...fixed, toolName: 'dsh_import_handoff' }, { ...fixed, toolName: 'mcp__*__agent_talk' },
    { ...fixed, mode: 'auto' }, { ...fixed, mode: 'off' },
  ]
  for (const value of invalid) assert.throws(() => new AutoNotifier(f.options, value as NotificationConfig))
  assert.equal(f.notifier.enabled, true)
})

test('a previously prepared task without routing policy cannot gain automatic notification retroactively', async t => {
  const f = await fixture(t)
  const submitted = await f.publish()
  const counter = queueCounter()
  assert.equal((await f.notifier.notify(submitted, counter.dispatch)).state, 'needs_target')
  const duplicate = await f.service.prepare([f.relative], owner)
  assert.equal(duplicate.duplicate, true)
  assert.equal((await f.notifier.bind(duplicate)).state, 'needs_target')
  assert.equal((await f.notifier.notify(submitted, counter.dispatch)).state, 'needs_target')
  assert.equal(counter.calls(), 0)
  await absent(f.policy)
  await absent(f.attempt)
})

test('prepare binds an exact fixed receiver and queues once without changing local submission evidence', async t => {
  const f = await fixture(t)
  assert.equal((await f.notifier.bind(f.prepared)).state, 'ready')
  const submitted = await f.publish()
  const before = await protectedCoreFiles(f)
  let calls = 0
  const dispatch: Dispatch = async (target, text, signal) => {
    calls++
    assert.equal(target.target, fixed.target)
    assert.equal(target.toolName, fixed.toolName)
    assert.equal(signal.aborted, false)
    const instruction = JSON.parse(text.split('\n').at(-1)!)
    assert.deepEqual(instruction, { tool: 'dsh_import_handoff', arguments: { manifest: submitted.manifest, send: false } })
    return { kind: 'queued', code: 'verified_maibot_queue_receipt' }
  }
  const queued = await f.notifier.notify(submitted, dispatch)
  assert.equal(queued.state, 'queued')
  assert.equal(queued.policy, 'fixed_single_chat')
  assert.equal(queued.target_hash, hash(fixed.target))
  assert.equal('imported' in queued, false)
  assert.equal('file_ref' in queued, false)
  assert.equal((await f.notifier.notify(submitted, dispatch)).state, 'queued')
  assert.equal(calls, 1)
  assert.deepEqual(await protectedCoreFiles(f), before)
  assert.equal((await f.service.localStatus(f.id, owner)).state, 'prepared')
  await absent(f.legacyAttempt)
  for (const path of [f.policy, f.attempt, f.resultFile]) {
    const info = await lstat(path)
    assert.equal(info.isFile(), true)
    assert.equal(info.nlink, 1)
    assert.equal(info.mode & 0o777, 0o600)
  }
})

test('receiver, MCP name and confirmation-mode changes cannot reroute a prepared task', async t => {
  const f = await fixture(t)
  await f.notifier.bind(f.prepared)
  const submitted = await f.publish()
  const alternatives = [
    new AutoNotifier(f.options, { ...fixed, target: 'different-receiver' }),
    new AutoNotifier(f.options, { ...fixed, toolName: 'mcp__different-peer__agent_talk' }),
    new AutoNotifier({ ...f.options, confirmationMode: 'request' }, fixed),
  ]
  const counter = queueCounter()
  for (const notifier of alternatives) {
    assert.equal((await notifier.notify(submitted, counter.dispatch)).state, 'needs_target')
  }
  assert.equal(counter.calls(), 0)
  await absent(f.attempt)
  assert.equal((await f.notifier.status(submitted)).state, 'ready')
})

test('owner or manifest conflicts cannot borrow another task routing policy', async t => {
  const f = await fixture(t)
  await f.notifier.bind(f.prepared)
  const submitted = await f.publish()
  const counter = queueCounter()
  const conflicts: ArtifactResult[] = [
    { ...submitted, owner: hash('another-actual-agent') },
    { ...submitted, manifest: { ...submitted.manifest, files: [{ ...submitted.manifest.files[0]!, sha256: 'f'.repeat(64) }] } },
  ]
  for (const record of conflicts) {
    const result = await f.notifier.notify(record, counter.dispatch)
    assert.notEqual(result.state, 'queued')
    assert.notEqual(result.state, 'ready')
  }
  assert.equal(counter.calls(), 0)
  await absent(f.attempt)
})

test('separate notifier instances share a durable one-shot fence for concurrent calls', async t => {
  const f = await fixture(t)
  await f.notifier.bind(f.prepared)
  const submitted = await f.publish()
  let calls = 0
  const dispatch: Dispatch = async () => {
    calls++
    await new Promise(resolve => setTimeout(resolve, 20))
    return { kind: 'queued', code: 'verified_maibot_queue_receipt' }
  }
  const results = await Promise.all(Array.from({ length: 8 }, () => new AutoNotifier(f.options, fixed).notify(submitted, dispatch)))
  assert.equal(calls, 1)
  assert.equal(results.some(result => result.state === 'queued'), true)
  assert.equal((await new AutoNotifier(f.options, fixed).status(submitted)).state, 'queued')
  assert.equal((await f.service.localStatus(f.id, owner)).state, 'prepared')
})

test('notification exception and indeterminate reply stay unknown across repeated calls and restart', async t => {
  for (const kind of ['exception', 'unknown', 'missing-receipt'] as const) {
    const f = await fixture(t)
    await f.notifier.bind(f.prepared)
    const submitted = await f.publish()
    let calls = 0
    const dispatch: Dispatch = async () => {
      calls++
      if (kind === 'exception') throw new Error('Remote result may have happened')
      if (kind === 'missing-receipt') return undefined as unknown as DispatchOutcome
      return { kind: 'unknown', code: 'unconfirmed_queue_receipt' }
    }
    assert.equal((await f.notifier.notify(submitted, dispatch)).state, 'unknown')
    const restarted = new AutoNotifier(f.options, fixed)
    assert.equal((await restarted.status(submitted)).state, 'unknown')
    assert.equal((await restarted.notify(submitted, dispatch)).state, 'unknown')
    assert.equal(calls, 1)
    assert.equal((await f.service.localStatus(f.id, owner)).state, 'prepared')
  }
})

test('timeout aborts the request, persists unknown and ignores late success', async t => {
  const f = await fixture(t, 10)
  await f.notifier.bind(f.prepared)
  const submitted = await f.publish()
  let observedAbort!: () => void
  const aborted = new Promise<void>(resolve => { observedAbort = resolve })
  let signal!: AbortSignal
  let drained = false
  let calls = 0
  const dispatch: Dispatch = async (_target, _text, actualSignal) => {
    calls++
    signal = actualSignal
    return new Promise(resolve => {
      actualSignal.addEventListener('abort', () => {
        observedAbort()
        setTimeout(() => {
          drained = true
          resolve({ kind: 'queued', code: 'late_success' })
        }, 5)
      }, { once: true })
    })
  }
  const pending = f.notifier.notify(submitted, dispatch)
  await aborted
  const concurrent = new AutoNotifier(f.options, fixed)
  assert.equal((await concurrent.status(submitted)).state, 'unknown')
  assert.equal((await concurrent.notify(submitted, dispatch)).state, 'unknown')
  assert.equal((await pending).state, 'unknown')
  assert.equal(drained, true)
  assert.equal(signal.aborted, true)
  const recorded = await readFile(f.resultFile, 'utf8')
  const restarted = new AutoNotifier(f.options, fixed)
  assert.equal((await restarted.status(submitted)).state, 'unknown')
  assert.equal((await restarted.notify(submitted, dispatch)).state, 'unknown')
  assert.equal(await readFile(f.resultFile, 'utf8'), recorded)
  assert.equal(calls, 1)
})

test('a known pre-dispatch refusal is persisted and never automatically tried again', async t => {
  const f = await fixture(t)
  await f.notifier.bind(f.prepared)
  const submitted = await f.publish()
  let calls = 0
  const dispatch: Dispatch = async () => { calls++; return { kind: 'not_dispatched', code: 'agent_talk_unavailable' } }
  assert.equal((await f.notifier.notify(submitted, dispatch)).state, 'not_dispatched')
  assert.equal((await new AutoNotifier(f.options, fixed).notify(submitted, dispatch)).state, 'not_dispatched')
  assert.equal(calls, 1)
})

test('status and disabled historical reads preserve queued evidence without any writes or dispatch', async t => {
  const f = await fixture(t)
  await f.notifier.bind(f.prepared)
  const submitted = await f.publish()
  const counter = queueCounter()
  assert.equal((await f.notifier.notify(submitted, counter.dispatch)).state, 'queued')
  const names = (await readdir(f.stateDir)).sort()
  const journalBytes = await Promise.all([f.policy, f.attempt, f.resultFile].map(path => readFile(path, 'utf8')))
  const disabled = new AutoNotifier(f.options, { mode: 'off' })
  assert.equal(disabled.enabled, false)
  assert.equal((await disabled.status(submitted)).state, 'queued')
  assert.equal((await disabled.notify(submitted, counter.dispatch)).state, 'queued')
  const changed = new AutoNotifier(f.options, { ...fixed, target: 'new-configured-receiver' })
  assert.equal((await changed.status(submitted)).state, 'queued')
  assert.equal((await changed.notify(submitted, counter.dispatch)).state, 'queued')
  assert.deepEqual((await readdir(f.stateDir)).sort(), names)
  assert.deepEqual(await Promise.all([f.policy, f.attempt, f.resultFile].map(path => readFile(path, 'utf8'))), journalBytes)
  assert.equal(counter.calls(), 1)
})

test('missing or damaged private notification evidence never becomes a fresh remote attempt', async t => {
  for (const kind of ['result-missing', 'attempt-missing', 'policy-missing', 'result-corrupt', 'policy-corrupt', 'policy-permissions'] as const) {
    const f = await fixture(t)
    await f.notifier.bind(f.prepared)
    const submitted = await f.publish()
    const counter = queueCounter()
    assert.equal((await f.notifier.notify(submitted, counter.dispatch)).state, 'queued')
    if (kind === 'result-missing') await unlink(f.resultFile)
    if (kind === 'attempt-missing') await unlink(f.attempt)
    if (kind === 'policy-missing') await unlink(f.policy)
    if (kind === 'result-corrupt') await writeFile(f.resultFile, '{invalid JSON')
    if (kind === 'policy-corrupt') await writeFile(f.policy, '{invalid JSON')
    if (kind === 'policy-permissions') await chmod(f.policy, 0o640)
    const names = (await readdir(f.stateDir)).sort()
    const restarted = new AutoNotifier(f.options, fixed)
    assert.equal((await restarted.status(submitted)).state, 'unknown')
    assert.equal((await restarted.notify(submitted, counter.dispatch)).state, 'unknown')
    assert.equal(counter.calls(), 1)
    assert.deepEqual((await readdir(f.stateDir)).sort(), names)
    assert.equal((await f.service.localStatus(f.id, owner)).state, 'prepared')
  }
})

test('losing a policy before any notification cannot be repaired by a duplicate prepare', async t => {
  const f = await fixture(t)
  await f.notifier.bind(f.prepared)
  await unlink(f.policy)
  const duplicate = await f.service.prepare([f.relative], owner)
  const counter = queueCounter()
  assert.equal(duplicate.duplicate, true)
  assert.equal((await f.notifier.bind(duplicate)).state, 'needs_target')
  assert.equal((await f.notifier.notify(await f.publish(), counter.dispatch)).state, 'needs_target')
  assert.equal(counter.calls(), 0)
  await absent(f.policy)
  await absent(f.attempt)
})

test('failed or uncertain local publication is never automatically notified and its evidence stays unchanged', async t => {
  for (const kind of ['prepublication', 'postpublication'] as const) {
    const f = await fixture(t)
    await f.notifier.bind(f.prepared)
    let result: ArtifactResult
    if (kind === 'prepublication') {
      await writeFile(join(f.workspaceRoot, f.relative), 'changed source')
      result = await f.service.publish(f.id, owner)
      assert.equal(result.result, 'prepared_only')
    } else {
      const privateCore = f.service as unknown as { save(record: TaskRecord): Promise<void> }
      const mocked = t.mock.method(privateCore, 'save', async () => { throw Object.assign(new Error('primary persistence failed'), { code: 'EIO' }) })
      try { result = await f.service.publish(f.id, owner) }
      finally { mocked.mock.restore() }
      assert.equal(result.result, 'unknown')
    }
    const before = await protectedCoreFiles(f)
    const counter = queueCounter()
    const notification = await f.notifier.notify(result, counter.dispatch)
    assert.notEqual(notification.state, 'queued')
    assert.equal(counter.calls(), 0)
    assert.deepEqual(await protectedCoreFiles(f), before)
    await absent(f.attempt)
    await absent(f.resultFile)
  }
})

test('an old core notification attempt blocks the new automatic notifier without changing either namespace', async t => {
  const f = await fixture(t)
  await f.notifier.bind(f.prepared)
  const submitted = await f.publish()
  const bytes = JSON.stringify({ at: new Date().toISOString() })
  await writeFile(f.legacyAttempt, bytes, { flag: 'wx', mode: 0o600 })
  const counter = queueCounter()
  const before = await protectedCoreFiles(f)
  assert.equal((await f.notifier.notify(submitted, counter.dispatch)).state, 'unknown')
  assert.equal(counter.calls(), 0)
  assert.deepEqual(await protectedCoreFiles(f), before)
  assert.equal(await readFile(f.legacyAttempt, 'utf8'), bytes)
  await absent(f.attempt)
  await absent(f.resultFile)
})

test('a lost notification-outcome write remains unknown across restart and never resends', async t => {
  const f = await fixture(t)
  await f.notifier.bind(f.prepared)
  const submitted = await f.publish()
  const before = await protectedCoreFiles(f)
  const privateNotifier = f.notifier as unknown as { exclusive(path: string, value: unknown): Promise<void> }
  const original = privateNotifier.exclusive.bind(privateNotifier)
  const mocked = t.mock.method(privateNotifier, 'exclusive', async (path: string, value: unknown) => {
    if (path.endsWith('.notify-result')) throw Object.assign(new Error('receipt persistence failed'), { code: 'EIO' })
    return original(path, value)
  })
  const counter = queueCounter()
  try { assert.equal((await f.notifier.notify(submitted, counter.dispatch)).state, 'unknown') }
  finally { mocked.mock.restore() }
  await absent(f.resultFile)
  assert.equal((await lstat(f.attempt)).isFile(), true)
  const restarted = new AutoNotifier(f.options, fixed)
  assert.equal((await restarted.status(submitted)).state, 'unknown')
  assert.equal((await restarted.notify(submitted, counter.dispatch)).state, 'unknown')
  assert.equal(counter.calls(), 1)
  assert.deepEqual(await protectedCoreFiles(f), before)
})

test('fixed mode cannot adopt a task already bound to a trusted original Host source', async t => {
  const f = await fixture(t)
  const hostTask = await f.service.prepare([f.relative], owner, {
    originId: 'actual-original-host-task', target: 'actual-original-chat', toolName: fixed.toolName,
  })
  assert.equal(hostTask.duplicate, false)
  assert.notEqual((await f.notifier.bind(hostTask)).state, 'ready')
  const local = await f.service.publish(hostTask.manifest.task_id, owner)
  assert.equal(local.result, 'needs_target')
  const counter = queueCounter()
  assert.notEqual((await f.notifier.notify(local, counter.dispatch)).state, 'queued')
  assert.equal(counter.calls(), 0)
  await absent(join(f.stateDir, `${hostTask.manifest.task_id}.notify-policy`))
  await absent(join(f.stateDir, `${hostTask.manifest.task_id}.notify-attempt`))
})
