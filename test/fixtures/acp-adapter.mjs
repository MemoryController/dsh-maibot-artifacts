/** Test-only deterministic model. Loaded exclusively by scripts/test-acp.mjs. */
import { appendFileSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'artifact-acp-test-adapter'
export const inject = ['llm', 'tools']

function toolReply(message) {
  if (message.isError) throw new Error(`ACP fixture tool failed: ${JSON.stringify(message.content)}`)
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  // PTC console output is one JSON line; a sandbox diagnostic may follow it.
  return JSON.parse(text.split('\n')[0])
}

function fixedResult(value, config) {
  const notification = config.mode === 'native' || config.hostVersion.startsWith('0.2.1-rc.') ? 'queued' : 'not_dispatched'
  assert.deepEqual(value.stages, { publication: 'submitted', notification, registration: 'unconfirmed' })
  assert.equal(value.automatic_notification.state, notification)
  assert.equal(value.automatic_notification.policy, 'fixed_single_chat')
  assert.equal(value.automatic_notification.target_hash, createHash('sha256').update(config.fixedTarget).digest('hex'))
  assert.equal(value.maibot_registration, 'unconfirmed')
  assert.equal('file_ref' in value, false)
}

function *finishText(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

class ScriptedAdapter extends LlmAdapter {
  constructor(config) { super(); this.config = config }
  providerInfo(provider) { return { id: provider, name: 'Isolated ACP fixture' } }
  listModels(provider) { return Promise.resolve([{ provider, id: 'artifact-fixture', name: 'Artifact fixture', inputModalities: ['text'] }]) }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: 'Artifact fixture', inputModalities: ['text'], context: { contextWindow: 131072 } }) }

  async *stream(options) {
    // Fresh ACP sessions may append instruction contexts after the actual user
    // message. Select fixture scenarios from the real user producer's message.
    const originalUser = options.messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'user')
    const user = originalUser < 0 ? options.messages.findLastIndex(message => message.role === 'user') : originalUser
    const userText = (options.messages[user]?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
    const rawReplies = options.messages.slice(user + 1).filter(message => message.role === 'tool')
    const probe = userText.includes('ACP_FIXTURE_ERROR_PROBE') ? 'error'
      : userText.includes('ACP_FIXTURE_CONCURRENCY_PROBE') ? 'concurrent'
        : userText.includes('ACP_FIXTURE_CANCEL_PROBE') ? 'cancel' : undefined
    const stage = rawReplies.length
    const probeToken = userText.trim().split(/\s+/u).at(-1)
    const replies = probe === 'error' ? [] : rawReplies.map(toolReply)
    if (probe && stage) {
      if (probe === 'error') assert.equal(rawReplies[0].isError, true)
      if (probe === 'concurrent') {
        assert.equal(replies[0].done, true)
        assert.equal(replies[0].token, probeToken)
      }
      yield *finishText(`ACP_${probe.toUpperCase()}_PROBE_COMPLETE`)
      return
    }
    if (!probe && this.config.fixedNotification && stage >= 2) {
      assert.equal(replies[1].result, 'submitted')
      fixedResult(replies[1], this.config)
      if (stage >= 3) fixedResult(replies[2], this.config)
      if (stage >= 4) fixedResult(replies[3], this.config)
    }
    const paths = ['outbox/acp/中文说明.txt', 'outbox/acp/结果.png', 'outbox/acp/空文件.bin']
    let tool, args
    if (probe) {
      tool = `mcp__maibot-agent__fixture_${probe === 'error' ? 'error' : probe === 'concurrent' ? 'delay' : 'wait'}`
      if (probe === 'concurrent') assert(['left', 'right', 'survivor'].includes(probeToken))
      args = probe === 'concurrent' ? { token: probeToken } : {}
    }
    else if (stage === 0) { tool = 'maibot_artifact_prepare'; args = { paths } }
    else if (stage === 1 || stage === 3) { tool = 'maibot_artifact_publish'; args = { task_id: replies[0].manifest.task_id } }
    else if (stage === 2) { tool = 'maibot_artifact_local_status'; args = { task_id: replies[0].manifest.task_id } }
    else if (stage === 4) { tool = 'mcp__maibot-agent__fixture_ping'; args = {} }
    else {
      yield *finishText('ACP_ARTIFACT_SCENARIO_COMPLETE')
      return
    }
    const modelName = this.config.mode === 'ptc' ? 'run_code' : tool
    const parameters = this.config.mode === 'ptc'
      ? { code: `console.log(JSON.stringify(await tools[${JSON.stringify(tool)}](${JSON.stringify(args)})))`, description: `ACP fixture ${tool}` }
      : args
    if (!options.tools.some(candidate => candidate.name === modelName)) throw new Error(`ACP fixture cannot see ${modelName}`)
    const id = ToolCallId(`acp-${this.config.mode}-${stage}`)
    const arguments_ = JSON.stringify(parameters)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: modelName, argumentsDelta: arguments_ }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: modelName, arguments: arguments_ } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export function apply(ctx, config) {
  // This fixture lives under the chosen DSH installation. These native Node
  // resolutions are evidence against accidentally using repository alpha peers.
  const require = createRequire(import.meta.url)
  const llmPath = require.resolve('@deepseek-ai/dsh-llm/package.json')
  const toolsPath = require.resolve('@deepseek-ai/dsh-tools/package.json')
  appendFileSync(config.eventsPath, JSON.stringify({ event: 'fixture_runtime',
    llmVersion: JSON.parse(readFileSync(llmPath, 'utf8')).version,
    toolsVersion: JSON.parse(readFileSync(toolsPath, 'utf8')).version,
    llmPath, toolsPath, contract: 'official LlmAdapter/GenerateOptions/StreamChunk unchanged across selected versions' }) + '\n')
  ctx.effect(() => ctx.llm.registerAdapter(['artifact-fixture'], new ScriptedAdapter(config)))
  ctx.on('tools/result', (exec, result) => {
    appendFileSync(config.eventsPath, JSON.stringify({ event: 'tool', name: exec.name, agent: exec.agent?.id, isError: result.isError, value: result.value, content: result.content }) + '\n')
  })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    appendFileSync(config.eventsPath, JSON.stringify({ event: 'inbox', agent: agent.id, source: message.source }) + '\n')
    // Just observe; no target resolver is installed by this fixture.
  })
}
