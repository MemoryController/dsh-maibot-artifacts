import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService, { defineTool, type ToolDefinition, type ToolExecutionInput, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { compatibleTool, dshCapabilities, executeCompatibleTool } from '../src/dsh-compat.js'
import { createDispatcher } from '../src/dispatch.js'
import { apply } from '../src/index.js'

// These structural doubles test rejection boundaries, not RC execution. The
// isolated published-host runtime/profile/ACP matrix exercises real RC APIs.
const unsupported = () => { throw new Error('An unsupported host method must not be called') }
function context(tools: object): Context { return { tools } as unknown as Context }

test('unsupported and mixed public tool surfaces fail startup before registration', () => {
  const unknownSurfaces = [
    {},
    { get: unsupported, execute: unsupported },
    { get: unsupported, execute: unsupported, presentAs: unsupported, executable: unsupported },
    { get: unsupported, execute: unsupported, presentAs: unsupported, executable: unsupported, resolve: unsupported, setExecutor: unsupported },
  ]
  for (const surface of unknownSurfaces) {
    let registrations = 0
    const ctx = context({ ...surface, register() { registrations++ } })
    assert.throws(() => apply(ctx, { workspaceRoot: '/unused/shared', stateDir: '/unused/private' }), { code: 'unsupported_dsh_tools_api' })
    assert.equal(registrations, 0)
  }
})

test('RC single-call context cannot silently discard an unexpected step admission', async () => {
  let lookups = 0
  let calls = 0
  const ctx = context({
    get() { lookups++; return undefined },
    async execute() { calls++; throw new Error('must not dispatch a hybrid context') },
    presentAs: unsupported,
  })
  assert.deepEqual(dshCapabilities(ctx), { mode: 'rc-single', conditionalAdmission: false, nestedDispatch: 'public-parent' })
  const exec = { toolSet: { dispose() {}, view() { return new Map<string, ToolDefinition>() } } } as unknown as ToolRunContext
  assert.throws(() => compatibleTool(ctx, exec, 'mcp__maibot-agent__agent_talk'), { code: 'unsupported_dsh_tools_api' })
  await assert.rejects(executeCompatibleTool(ctx, exec, {
    callId: ToolCallId('hybrid'), name: 'mcp__maibot-agent__agent_talk', arguments: { target: 'receiver', text: 'data' }, signal: new AbortController().signal,
  }), { code: 'unsupported_dsh_tools_api' })
  assert.equal(lookups, 0)
  assert.equal(calls, 0)
})

test('an official batch executor with a mismatched call ID cannot turn a forged receipt into queued', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolsService)
  const name = 'mcp__maibot-agent__agent_talk'
  const value = { content: [{ type: 'text', text: JSON.stringify({ delivered: true, relay_id: 'a'.repeat(32), target: 'receiver' }) }] }
  let providerCalls = 0
  let bodies = 0
  ctx.tools.register(defineTool({
    name, description: 'Boundary-only MCP definition',
    parameters: { target: { type: 'string' }, text: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: () => [] },
    async execute() { bodies++; return value },
  }))
  ctx.tools.setExecutor({
    describe() { return { schemas: [] } },
    async execute() {
      providerCalls++
      return { results: [{ callId: ToolCallId('wrong-correlation'), result: { isError: false, value, content: [] } }], additionalContexts: [], concluded: false }
    },
  })
  assert.deepEqual(dshCapabilities(ctx), { mode: 'alpha-batch', conditionalAdmission: true, nestedDispatch: 'root-batch-only' })
  const signal = new AbortController().signal
  const exec = { signal, deferContext() {}, concludeTurn() {} } as unknown as ToolRunContext
  const result = await createDispatcher(ctx, exec)({ target: 'receiver', toolName: name }, 'data', signal)
  assert.deepEqual(result, { kind: 'unknown', code: 'invalid_batch_receipt' })
  assert.equal(providerCalls, 1)
  assert.equal(bodies, 0)
})

test('RC boundary forwards an existing parent capability and root identity unchanged, and never invents them', async () => {
  const captured: ToolExecutionInput[] = []
  const ctx = context({
    get: unsupported,
    presentAs: unsupported,
    async execute(input: ToolExecutionInput) {
      captured.push(input)
      return { isError: false, value: null, content: [] }
    },
  })
  // This opaque placeholder tests transport only. The published-host PTC matrix
  // supplies framework-owned execution tokens and proves actual policy behavior.
  const token = Symbol('structural-boundary-only') as ToolRunContext['token']
  const rootCallId = ToolCallId('existing-root')
  const signal = new AbortController().signal
  const input = { callId: ToolCallId('nested'), name: 'mcp__maibot-agent__agent_talk', arguments: { target: 'receiver', text: 'data' }, signal }
  await executeCompatibleTool(ctx, { token, rootCallId } as ToolRunContext, input)
  assert.equal(captured[0]?.parent, token)
  assert.equal(captured[0]?.rootCallId, rootCallId)
  assert.equal(captured[0]?.signal, signal)
  await executeCompatibleTool(ctx, {} as ToolRunContext, input)
  assert.equal('parent' in captured[1]!, false)
  assert.equal('rootCallId' in captured[1]!, false)
})
