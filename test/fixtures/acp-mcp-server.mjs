/** Minimal legacy MCP fixture. No network service and no real MaiBot actions. */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import process from 'node:process'

const eventsPath = process.argv[2]
const input = createInterface({ input: process.stdin })
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
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
        { name: 'agent_talk', description: 'Mock queue only; must not be called by default artifact submission.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
        { name: 'fixture_ping', description: 'Test transport connectivity.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ] })
      break
    case 'tools/call':
      appendFileSync(eventsPath, JSON.stringify({ event: 'mcp_call', name: request.params.name, arguments: request.params.arguments }) + '\n')
      reply({ content: [{ type: 'text', text: JSON.stringify(request.params.name === 'fixture_ping' ? { pong: true } : { delivered: true, relay_id: 'a'.repeat(32), target: request.params.arguments.target }) }] })
      break
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unsupported fixture method ${request.method}` } }) + '\n')
  }
})
