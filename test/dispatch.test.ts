import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm';
import { createScope, type Scope } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolsService, { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import { createDispatcher, isQueueReceipt } from '../src/dispatch.js';

const toolName = 'mcp__maibot-agent__agent_talk';
const target = { originId: 'authentic-host-task', toolName, target: 'original-host-chat' };
function mcpReceipt(destination = target.target) {
  return { content: [{ type: 'text', text: JSON.stringify({ delivered: true, relay_id: 'a'.repeat(32), target: destination }) }] };
}

async function harness(t: { after(callback: () => Promise<unknown>): void }) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  await ctx.plugin(NativeExecutor);
  const agent = { id: SessionId(randomUUID()) } as Agent;
  let scope!: Scope;
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent); }, { inject: ['tools', 'systemPrompt'] }));
  const exec = {
    agent, callId: ToolCallId('outer'), rootCallId: ToolCallId('outer'), signal: new AbortController().signal,
    deferContext() {}, concludeTurn() {},
  } as unknown as ToolRunContext;
  let calls = 0;
  let received: unknown;
  const register = (body = async () => mcpReceipt(), conditional = false) => scope.ctx.tools.register(defineTool({
    name: toolName, description: 'Isolated fake MCP server',
    parameters: { target: { type: 'string' }, text: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: () => [] },
    async execute(args, nested) {
      calls++;
      received = { args, agent: nested.agent, toolSet: nested.toolSet, signal: nested.signal };
      return body();
    },
  }), conditional ? { when: () => true } : {});
  return { ctx, agent, scope, exec, register, calls: () => calls, received: () => received };
}

test('queue parser accepts only pinned MaiBot queue evidence', () => {
  assert.equal(isQueueReceipt(mcpReceipt(), target.target), true);
  for (const value of [{ delivered: true }, { content: [] }, { content: [{ type: 'text', text: 'success' }] },
    mcpReceipt('another-chat'), { ...mcpReceipt(), isError: true },
    { content: [{ type: 'text', text: JSON.stringify({ delivered: true, target: target.target, relay_id: 'invalid' }) }] }]) {
    assert.equal(isQueueReceipt(value, target.target), false);
  }
});

test('official native execution calls scoped fake MCP and only reports queued', async t => {
  const h = await harness(t);
  h.register();
  const result = await createDispatcher(h.ctx, h.exec)(target, 'manifest data', h.exec.signal);
  assert.deepEqual(result, { kind: 'queued', code: 'maibot_queue_receipt' });
  assert.equal(h.calls(), 1);
  const received = h.received() as { args: unknown; agent: Agent; signal: AbortSignal };
  assert.deepEqual(received.args, { target: target.target, text: 'manifest data' });
  assert.equal(received.agent, h.agent);
  assert.equal(received.signal.aborted, false);
});

test('missing MCP and wrong agent scope fail before tool execution', async t => {
  const h = await harness(t);
  const dispatch = createDispatcher(h.ctx, h.exec);
  assert.equal((await dispatch(target, 'text', h.exec.signal)).kind, 'not_dispatched');
  h.register();
  const other = { ...h.exec, agent: { id: SessionId('other') } as Agent };
  assert.equal((await createDispatcher(h.ctx, other)(target, 'text', h.exec.signal)).kind, 'not_dispatched');
  assert.equal(h.calls(), 0);
});

test('official guard denial stays not_dispatched without bypass', async t => {
  const h = await harness(t);
  h.register();
  h.scope.ctx.tools.guard(() => 'Host denied this operation');
  assert.equal((await createDispatcher(h.ctx, h.exec)(target, 'text', h.exec.signal)).kind, 'not_dispatched');
  assert.equal(h.calls(), 0);
});

test('conditional admission is required and forwarded to nested dispatch', async t => {
  const h = await harness(t);
  h.register(undefined, true);
  assert.equal((await createDispatcher(h.ctx, h.exec)(target, 'text', h.exec.signal)).kind, 'not_dispatched');
  const toolSet = await h.ctx.tools.resolve({ agent: h.agent, modelSelection: { provider: 'test', model: 'test' }, signal: h.exec.signal });
  const admitted = { ...h.exec, toolSet };
  assert.equal((await createDispatcher(h.ctx, admitted)(target, 'text', h.exec.signal)).kind, 'queued');
  assert.equal((h.received() as { toolSet: unknown }).toolSet, toolSet);
  toolSet.dispose();
});

test('tool-thrown UNKNOWN_TOOL is unknown after invocation and is never retried', async t => {
  const h = await harness(t);
  h.register(async () => { throw new HarnessError('indeterminate remote result', 'UNKNOWN_TOOL'); });
  assert.equal((await createDispatcher(h.ctx, h.exec)(target, 'text', h.exec.signal)).kind, 'unknown');
  assert.equal(h.calls(), 1);
});

test('generic success and mismatching queue target are unknown', async t => {
  const h = await harness(t);
  h.register(async () => mcpReceipt('unrelated-chat'));
  assert.equal((await createDispatcher(h.ctx, h.exec)(target, 'text', h.exec.signal)).kind, 'unknown');
  assert.equal(h.calls(), 1);
});

test('aborted-before-dispatch stays not_dispatched', async t => {
  const h = await harness(t);
  h.register();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await createDispatcher(h.ctx, h.exec)(target, 'text', controller.signal)).kind, 'not_dispatched');
  assert.equal(h.calls(), 0);
});

test('real official PTC executor rejects nested raw batches without calling MCP', async t => {
  const h = await harness(t);
  h.register();
  h.scope.ctx.tools.setExecutor(new PtcExecutor(h.scope.ctx));
  const result = await createDispatcher(h.ctx, h.exec)(target, 'text', h.exec.signal);
  assert.deepEqual(result, { kind: 'not_dispatched', code: 'dispatch_refused' });
  assert.equal(h.calls(), 0);
});

test('official MCP bridge converts raw MaiBot JSON content into a queue receipt', async t => {
  const h = await harness(t);
  let calls = 0;
  h.scope.ctx.tools.register(createMcpToolDefinition(h.scope.ctx, {
    name: toolName, rawName: 'agent_talk', description: 'Isolated raw MCP callback',
    inputSchema: {
      type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } },
      required: ['text'], additionalProperties: false,
    },
    async call(args, execution) {
      calls++;
      assert.deepEqual(args, { target: target.target, text: 'handoff data' });
      assert.equal(execution.agent, h.agent);
      return mcpReceipt();
    },
  }));
  assert.equal((await createDispatcher(h.ctx, h.exec)(target, 'handoff data', h.exec.signal)).kind, 'queued');
  assert.equal(calls, 1);
});

test('official MCP bridge isError after raw invocation remains unknown', async t => {
  const h = await harness(t);
  let calls = 0;
  h.scope.ctx.tools.register(createMcpToolDefinition(h.scope.ctx, {
    name: toolName, rawName: 'agent_talk', description: 'Isolated raw MCP error',
    inputSchema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['text'] },
    async call() { calls++; return { isError: true, content: [{ type: 'text', text: 'upstream failed' }] }; },
  }));
  assert.equal((await createDispatcher(h.ctx, h.exec)(target, 'text', h.exec.signal)).kind, 'unknown');
  assert.equal(calls, 1);
});
