/** Minimal legacy MCP fixture. No network service and no real MaiBot actions. */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import process from 'node:process'
import { setTimeout, clearTimeout } from 'node:timers'

const eventsPath = process.argv[2]
const fixedNotification = process.env.ARTIFACT_FIXED_NOTIFICATION_FIXTURE === '1'
const pending = new Map()
const input = createInterface({ input: process.stdin })
const processEvent = (phase, details = {}) => appendFileSync(eventsPath, JSON.stringify({ event: 'mcp_process', phase,
  pid: process.pid, ppid: process.ppid, at: Date.now(), ...details }) + '\n')
processEvent('started')
input.on('close', () => {
  processEvent('stdin_closed')
  for (const { timer } of pending.values()) clearTimeout(timer)
  pending.clear()
})
process.on('exit', code => processEvent('exit', { code }))
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) {
    if (request.method === 'notifications/cancelled') {
      const record = pending.get(request.params.requestId)
      if (record) { clearTimeout(record.timer); pending.delete(request.params.requestId) }
      appendFileSync(eventsPath, JSON.stringify({ event: 'mcp_cancel', pid: process.pid, requestId: request.params.requestId, at: Date.now() }) + '\n')
    }
    return
  }
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  switch (request.method) {
    case 'server/discover':
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Legacy MCP test fixture' } }) + '\n')
      break
    case 'initialize':
      reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'isolated-maibot-mock', version: '1.0.0' } })
      break
    case 'tools/list':
      reply({ tools: [
        { name: 'agent_talk', description: 'Mock queue enabled only for the explicit fixed-notification scenario.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
        { name: 'fixture_ping', description: 'Test transport connectivity.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'fixture_error', description: 'Return an explicit isolated tool failure.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'fixture_delay', description: 'Delay a harmless response to observe independent ACP sessions.', inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false } },
        { name: 'fixture_wait', description: 'Wait for the ACP cancellation probe.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ] })
      break
    case 'tools/call':
      appendFileSync(eventsPath, JSON.stringify({ event: 'mcp_call', pid: process.pid, name: request.params.name, arguments: request.params.arguments, at: Date.now() }) + '\n')
      if (request.params.name === 'fixture_ping') reply({ content: [{ type: 'text', text: JSON.stringify({ pong: true }) }] })
      else if (request.params.name === 'agent_talk' && fixedNotification) {
        reply({ content: [{ type: 'text', text: JSON.stringify({ delivered: true, relay_id: 'a'.repeat(32), target: request.params.arguments.target }) }] })
      } else if (request.params.name === 'fixture_error') reply({ isError: true, content: [{ type: 'text', text: 'Expected isolated MCP error' }] })
      else if (request.params.name === 'fixture_delay' || request.params.name === 'fixture_wait') {
        const timer = setTimeout(() => {
          pending.delete(request.id)
          appendFileSync(eventsPath, JSON.stringify({ event: 'mcp_done', pid: process.pid, name: request.params.name, arguments: request.params.arguments, at: Date.now() }) + '\n')
          reply({ content: [{ type: 'text', text: JSON.stringify({ done: true, token: request.params.arguments.token ?? 'wait' }) }] })
        }, request.params.name === 'fixture_delay' ? request.params.arguments.token === 'survivor' ? 1500 : 500 : 5000)
        pending.set(request.id, { timer })
      } else reply({ isError: true, content: [{ type: 'text', text: 'Queue fixture disabled without explicit fixed notification mode' }] })
      break
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unsupported fixture method ${request.method}` } }) + '\n')
  }
})
