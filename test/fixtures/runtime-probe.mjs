/** Official-host isolated runtime checks. Agent objects here are scope doubles;
 * scripts/test-acp.mjs separately verifies actual ACP-created Agent sessions. */
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as pause } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'artifact-published-runtime-probe'
export const inject = ['tools']
const { AbortController } = globalThis
const names = ['maibot_artifact_prepare', 'maibot_artifact_publish', 'maibot_artifact_local_status']
const mcpName = 'mcp__runtime-probe__agent_talk'
const target = 'runtime-single-receiver'

export async function apply(profileCtx, config) {
  const checks = []
  const report = { status: 'NOT TESTED', version: config.version, node: process.version,
    scope: 'official CLI/profile; actual published Cordis/Tools runtime; Agent scope doubles; simulated MCP callbacks',
    actualAcpAgents: false, actualMaiBot: false, checks }
  let context
  let child
  let abi
  let callIndex = 0
  const scopes = new Map()
  const agentA = { id: 'runtime-probe-agent-A' }
  const agentB = { id: 'runtime-probe-agent-B' }
  const agents = [agentA, agentB]
  const bodies = { A: 0, B: 0 }
  let mcpMode = 'queue'
  let drained = false
  async function check(name, run) {
    const start = performance.now()
    try { checks.push({ name, status: 'PASS', detail: await run(), durationMs: Math.round(performance.now() - start) }) }
    catch (error) { checks.push({ name, status: 'FAIL', detail: String(error?.stack ?? error).slice(-5000), durationMs: Math.round(performance.now() - start) }) }
  }
  async function execute(name, args, agent, signal = new AbortController().signal, toolSet) {
    const id = ToolCallId(`runtime-probe-${callIndex++}`)
    if (abi === 'alpha-batch') {
      const batch = await context.tools.execute({ calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }], signal,
        ...(agent === undefined ? {} : { agent }), ...(toolSet === undefined ? {} : { toolSet }) })
      assert.equal(batch.results.length, 1)
      assert.equal(batch.results[0].callId, id)
      return batch.results[0].result
    }
    return context.tools.execute({ callId: id, name, arguments: args, signal, ...(agent === undefined ? {} : { agent }) })
  }
  function value(result) { assert.equal(result.isError, false, JSON.stringify(result)); return result.value }
  function code(result) { assert.equal(result.isError, true); return result.error?.info?.code }
  async function artifact(agent, suffix) {
    const relative = `outbox/${suffix}.bin`
    await writeFile(join(config.workspaceRoot, relative), new Uint8Array([0, 128, 255, 10]))
    return value(await execute('maibot_artifact_prepare', { paths: [relative] }, agent))
  }
  function registerMcp(scope, key) {
    return scope.ctx.tools.register(defineTool({ name: mcpName, description: 'Isolated scoped fake MaiBot MCP callback',
      parameters: { target: { type: 'string', required: true }, text: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: () => [] },
      async execute(args, exec) {
        bodies[key]++
        assert.equal(exec.agent, key === 'A' ? agentA : agentB)
        assert.equal(args.target, target)
        if (mcpMode === 'throw') throw new HarnessError('Isolated simulated remote rejection', 'PROBE_REMOTE_REJECTED')
        if (mcpMode === 'drain') {
          await new Promise(resolve => {
            exec.signal.addEventListener('abort', () => { pause(5).then(() => { drained = true; resolve() }) }, { once: true })
          })
        }
        return { content: [{ type: 'text', text: JSON.stringify({ delivered: true, target: args.target, relay_id: 'd'.repeat(32) }) }] }
      },
    }))
  }
  try {
    await check('published_runtime_cohort', async () => {
      const versions = {}
      for (const pkg of ['@deepseek-ai/dsh', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-system-prompt']) {
        versions[pkg] = JSON.parse(await readFile(fileURLToPath(import.meta.resolve(`${pkg}/package.json`)), 'utf8')).version
      }
      assert.equal(versions['@deepseek-ai/dsh'], config.version)
      assert.equal(versions['@deepseek-ai/dsh-tools'], config.version)
      assert.equal(versions['@deepseek-ai/dsh-llm'], config.version)
      report.runtimePackages = versions
      return versions
    })
    await check('official_profile_bundle_registration', async () => {
      for (let attempts = 0; attempts < 100 && !names.every(name => profileCtx.tools.get(name)); attempts++) await pause(20)
      for (const name of names) assert.equal(typeof profileCtx.tools.get(name)?.execute, 'function', name)
      return { registered: names }
    })
    await check('isolated_published_runtime_initialization', async () => {
      context = new Context()
      await context.plugin(SystemPrompt)
      const batchHost = config.version === '0.2.2-alpha.2'
      await context.plugin(ToolsService, batchHost ? {} : { mode: 'native' })
      abi = typeof context.tools.executable === 'function' ? 'alpha-batch' : 'rc-single'
      assert.equal(abi, batchHost ? 'alpha-batch' : 'rc-single')
      if (batchHost) await context.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))
      const plugin = await import(config.pluginEntry)
      assert.equal(plugin.dshCapabilities(context).mode, abi)
      child = await context.plugin(plugin, { workspaceRoot: config.workspaceRoot, stateDir: config.stateDir,
        notificationTimeoutMs: 20, autoNotify: { mode: 'fixed', target, toolName: mcpName, acknowledgeSingleChat: true } })
      for (const name of names) assert.equal(typeof context.tools.get(name)?.execute, 'function')
      for (const agent of agents) await context.plugin(Object.assign(inner => { scopes.set(agent, createScope(inner, agent)) }, { inject: ['tools', 'systemPrompt'] }))
      return { abi, agents: 'two Agent identity doubles; not actual ACP Agent instances' }
    })
    if (!child || !context) throw new Error('Published runtime initialization failed; dependent checks cannot execute')
    await check('closed_arguments_missing_agent_and_error_codes', async () => {
      const bad = await execute('maibot_artifact_prepare', { paths: ['outbox/seed.bin'], target: 'forged-target' }, agentA)
      assert.equal(code(bad), 'INVALID_ARGS')
      const anonymous = await execute('maibot_artifact_prepare', { paths: ['outbox/seed.bin'] })
      assert.equal(anonymous.isError, true)
      assert.match(anonymous.error.message, /actual DSH agent scope/u)
      const unknown = await execute('nonexistent_runtime_fixture_tool', {}, agentA)
      assert.equal(code(unknown), 'UNKNOWN_TOOL')
      return { extraTarget: 'INVALID_ARGS', unknownTool: 'UNKNOWN_TOOL', missingAgent: 'denied before preparation' }
    })
    await check('concurrent_agent_scope_ownership_isolation', async () => {
      const [a, b] = await Promise.all([artifact(agentA, 'concurrent-A'), artifact(agentB, 'concurrent-B')])
      assert.notEqual(a.manifest.task_id, b.manifest.task_id)
      const [wrongA, wrongB] = await Promise.all([
        execute('maibot_artifact_local_status', { task_id: a.manifest.task_id }, agentB),
        execute('maibot_artifact_local_status', { task_id: b.manifest.task_id }, agentA),
      ])
      assert.equal(wrongA.isError, true)
      assert.equal(wrongB.isError, true)
      assert.equal('value' in wrongA, false)
      assert.equal('value' in wrongB, false)
      assert.equal(value(await execute('maibot_artifact_local_status', { task_id: a.manifest.task_id }, agentA)).state, 'prepared')
      return { concurrentPreparations: 2, crossScopeReadsDenied: 2 }
    })
    const removeA = registerMcp(scopes.get(agentA), 'A')
    await check('scoped_native_mcp_admission_and_queue_only', async () => {
      assert.equal(code(await execute(mcpName, { target, text: 'isolated request' }, agentB)), 'UNKNOWN_TOOL')
      const a = await artifact(agentA, 'scope-notify-A')
      const queued = value(await execute('maibot_artifact_publish', { task_id: a.manifest.task_id }, agentA))
      assert.equal(queued.result, 'submitted')
      assert.equal(queued.automatic_notification.state, 'queued')
      assert.equal(queued.maibot_registration, 'unconfirmed')
      assert.equal('file_ref' in queued, false)
      const count = bodies.A
      await execute('maibot_artifact_publish', { task_id: a.manifest.task_id }, agentA)
      assert.equal(bodies.A, count)
      return { registeredOnlyForA: true, notification: 'queued only; no real MaiBot or file API' }
    })
    await check('official_scope_guard_denies_before_mcp', async () => {
      const stop = scopes.get(agentA).ctx.tools.guard(exec => exec.name === mcpName ? 'isolated Host guard refusal' : undefined)
      try {
        const before = bodies.A
        const a = await artifact(agentA, 'guarded-A')
        const outcome = value(await execute('maibot_artifact_publish', { task_id: a.manifest.task_id }, agentA))
        assert.equal(outcome.automatic_notification.state, 'not_dispatched')
        assert.equal(bodies.A, before)
      } finally { stop() }
      return { guard: 'scope-local denial honored by composite dispatch' }
    })
    if (abi === 'rc-single') await check('rc_public_parent_preserves_ptc_scope_and_guards', async () => {
      const composite = 'runtime_legitimate_parent_probe'
      const stop = context.tools.register(defineTool({ name: composite, description: 'Public RC nested dispatch capability probe', parameters: {},
        output: { schema: { type: 'json' }, render: () => [] },
        async execute(_args, exec) {
          // The token is minted by a real accepted execution. This isolated
          // API check is not a claim that an ACP run_code program was run.
          const stopMode = scopes.get(agentA).ctx.tools.presentAs('ptc')
          let guard
          try {
            const before = bodies.A
            assert.equal(code(await execute(mcpName, { target, text: 'parentless root' }, agentA)), 'UNKNOWN_TOOL')
            assert.equal(bodies.A, before)
            const nested = () => context.tools.execute({ callId: ToolCallId(`runtime-nested-${callIndex++}`), name: mcpName,
              arguments: { target, text: 'legitimate scoped nested call' }, agent: exec.agent, rootCallId: exec.rootCallId, parent: exec.token, signal: exec.signal })
            value(await nested())
            assert.equal(bodies.A, before + 1)
            guard = scopes.get(agentA).ctx.tools.guard(call => call.name === mcpName ? 'deny nested call' : undefined)
            assert.equal((await nested()).isError, true)
            assert.equal(bodies.A, before + 1)
            return { parentlessRefused: true, officialExistingParentAccepted: true, nestedGuardHonored: true }
          } finally { guard?.(); stopMode() }
        },
      }))
      try { return value(await execute(composite, {}, agentA)) } finally { stop() }
    })
    else checks.push({ name: 'rc_public_parent_preserves_ptc_scope_and_guards', status: 'NOT TESTED', applicable: false,
      detail: 'Published alpha batch API has no public parent field; actual ACP PTC root-batch refusal is tested separately' })
    if (abi === 'alpha-batch') await check('conditional_step_admission', async () => {
      let allowed = false
      let calls = 0
      const stop = scopes.get(agentA).ctx.tools.register(defineTool({ name: 'runtime_conditional', description: 'Conditional admission probe', parameters: {},
        output: { schema: { type: 'json' }, render: () => [] }, async execute() { calls++; return { ok: true } } }), { when: () => allowed })
      try {
        assert.equal(code(await execute('runtime_conditional', {}, agentA)), 'UNKNOWN_TOOL')
        const denied = await context.tools.resolve({ agent: agentA, modelSelection: { provider: 'fixture', model: 'fixture' }, signal: new AbortController().signal })
        try { assert.equal(code(await execute('runtime_conditional', {}, agentA, new AbortController().signal, denied)), 'UNKNOWN_TOOL') } finally { denied.dispose() }
        allowed = true
        const admitted = await context.tools.resolve({ agent: agentA, modelSelection: { provider: 'fixture', model: 'fixture' }, signal: new AbortController().signal })
        try { assert.deepEqual(value(await execute('runtime_conditional', {}, agentA, new AbortController().signal, admitted)), { ok: true }) } finally { admitted.dispose() }
        assert.equal(calls, 1)
      } finally { stop() }
      return { unsupportedWithoutAdmission: true, admittedExecutionCount: 1 }
    })
    else checks.push({ name: 'conditional_step_admission', status: 'NOT TESTED', applicable: false, detail: 'Published RC ToolsRuntime has no conditional-registration/resolve API; scope guards remain tested' })
    await check('tool_error_identity_and_no_automatic_retry', async () => {
      mcpMode = 'throw'
      try {
        assert.equal(code(await execute(mcpName, { target, text: 'fixture error' }, agentA)), 'PROBE_REMOTE_REJECTED')
        const a = await artifact(agentA, 'remote-error-A')
        const result = value(await execute('maibot_artifact_publish', { task_id: a.manifest.task_id }, agentA))
        assert.equal(result.automatic_notification.state, 'unknown')
        const before = bodies.A
        await execute('maibot_artifact_publish', { task_id: a.manifest.task_id }, agentA)
        assert.equal(bodies.A, before)
      } finally { mcpMode = 'queue' }
      return { error: 'PROBE_REMOTE_REJECTED preserved', notification: 'unknown, never retried' }
    })
    await check('pre_cancelled_native_call_does_not_invoke_body', async () => {
      const controller = new AbortController()
      controller.abort()
      const before = bodies.A
      assert.equal(code(await execute(mcpName, { target, text: 'cancelled' }, agentA, controller.signal)), 'ABORTED_BEFORE_DISPATCH')
      assert.equal(bodies.A, before)
      return { code: 'ABORTED_BEFORE_DISPATCH' }
    })
    await check('notification_timeout_aborts_and_drains_before_unknown', async () => {
      mcpMode = 'drain'
      drained = false
      try {
        const a = await artifact(agentA, 'timeout-drain-A')
        const result = value(await execute('maibot_artifact_publish', { task_id: a.manifest.task_id }, agentA))
        assert.equal(drained, true)
        assert.equal(result.automatic_notification.state, 'unknown')
        const before = bodies.A
        const read = value(await execute('maibot_artifact_local_status', { task_id: a.manifest.task_id }, agentA))
        assert.equal(read.automatic_notification.state, 'unknown')
        await execute('maibot_artifact_publish', { task_id: a.manifest.task_id }, agentA)
        assert.equal(bodies.A, before)
      } finally { mcpMode = 'queue' }
      return { cooperativeAbort: true, ownedDispatchDrained: true, lateQueueIgnored: true }
    })
    await check('cordis_event_and_tool_effects_dispose', async () => {
      let observed = 0
      const tool = defineTool({ name: 'runtime_lifecycle_probe', description: 'Disposable lifecycle probe', parameters: {},
        output: { schema: { type: 'json' }, render: () => [] }, async execute() { return { ok: true } } })
      const disposable = await context.plugin(Object.assign(inner => {
        inner.on('tools/execute', (exec, next) => { if (exec.name === tool.name) observed++; return next() })
        inner.tools.register(tool)
      }, { inject: ['tools'] }))
      value(await execute(tool.name, {}, agentA))
      assert.equal(observed, 1)
      await disposable.dispose()
      assert.equal(context.tools.get(tool.name), undefined)
      const remove = context.tools.register(tool)
      try { value(await execute(tool.name, {}, agentA)); assert.equal(observed, 1) } finally { remove() }
      return { registeredToolRemoved: true, disposedEventNoLongerRuns: true }
    })
    await check('maibot_plugin_unload_removes_three_tools', async () => {
      await child.dispose()
      child = undefined
      for (const name of names) assert.equal(context.tools.get(name), undefined, name)
      assert.equal(code(await execute('maibot_artifact_prepare', { paths: ['outbox/seed.bin'] }, agentA)), 'UNKNOWN_TOOL')
      removeA()
      return { removed: names }
    })
  } catch (error) {
    checks.push({ name: 'probe_completion', status: 'FAIL', detail: String(error?.stack ?? error).slice(-5000) })
  } finally {
    try { if (context) { await context.fiber.dispose(); checks.push({ name: 'runtime_context_cleanup', status: 'PASS', detail: 'All isolated runtime fibers disposed before writing results' }) } }
    catch (error) { checks.push({ name: 'runtime_context_cleanup', status: 'FAIL', detail: String(error) }) }
    report.status = checks.some(item => item.status === 'FAIL') ? 'FAIL' : 'PASS'
    report.passed = checks.filter(item => item.status === 'PASS').length
    report.notApplicable = checks.filter(item => item.applicable === false).length
    await mkdir(join(config.resultFile, '..'), { recursive: true })
    await writeFile(`${config.resultFile}.tmp`, JSON.stringify(report, null, 2))
    await rename(`${config.resultFile}.tmp`, config.resultFile)
    console.error(`ARTIFACT_RUNTIME_PROBE_${report.status.toUpperCase()}`)
  }
}
