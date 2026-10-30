/** Test-only deterministic model. Loaded exclusively by scripts/test-acp.mjs. */
import { appendFileSync } from 'node:fs'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'artifact-acp-test-adapter'
export const inject = ['llm', 'tools']

function toolReply(message) {
  if (message.isError) throw new Error(`ACP fixture tool failed: ${JSON.stringify(message.content)}`)
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  // PTC console output is one JSON line; a sandbox diagnostic may follow it.
  return JSON.parse(text.split('\n')[0])
}

class ScriptedAdapter extends LlmAdapter {
  constructor(config) { super(); this.config = config }
  providerInfo(provider) { return { id: provider, name: 'Isolated ACP fixture' } }
  listModels(provider) { return Promise.resolve([{ provider, id: 'artifact-fixture', name: 'Artifact fixture', inputModalities: ['text'] }]) }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: 'Artifact fixture', inputModalities: ['text'], context: { contextWindow: 131072 } }) }

  async *stream(options) {
    const user = options.messages.findLastIndex(message => message.role === 'user')
    const replies = options.messages.slice(user + 1).filter(message => message.role === 'tool').map(toolReply)
    const stage = replies.length
    const paths = ['outbox/acp/中文说明.txt', 'outbox/acp/结果.png', 'outbox/acp/空文件.bin']
    let tool, args
    if (stage === 0) { tool = 'maibot_artifact_prepare'; args = { paths } }
    else if (stage === 1 || stage === 3) { tool = 'maibot_artifact_publish'; args = { task_id: replies[0].manifest.task_id } }
    else if (stage === 2) { tool = 'maibot_artifact_local_status'; args = { task_id: replies[0].manifest.task_id } }
    else if (stage === 4) { tool = 'mcp__maibot-agent__fixture_ping'; args = {} }
    else {
      const text = 'ACP_ARTIFACT_SCENARIO_COMPLETE'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
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
  ctx.effect(() => ctx.llm.registerAdapter(['artifact-fixture'], new ScriptedAdapter(config)))
  ctx.on('tools/result', (exec, result) => {
    appendFileSync(config.eventsPath, JSON.stringify({ event: 'tool', name: exec.name, agent: exec.agent?.id, isError: result.isError, value: result.value, content: result.content }) + '\n')
  })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    appendFileSync(config.eventsPath, JSON.stringify({ event: 'inbox', agent: agent.id, source: message.source }) + '\n')
    // Just observe; no target resolver is installed by this fixture.
  })
}
