import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { TrustedTargetBindings } from '../src/targets.js';

test('trusted target bindings require actual Agent identity and exact root call', () => {
  const bindings = new TrustedTargetBindings();
  const a = { id: SessionId('same-id') } as Agent;
  const b = { id: SessionId('same-id') } as Agent;
  const root = ToolCallId('original-root');
  const target = { originId: 'authentic-host-task', target: 'original-host-chat', toolName: 'mcp__maibot-agent__agent_talk' };
  const stop = bindings.bind(a, root, target);
  const exec = (agent: Agent | undefined, rootCallId = root) => ({ agent, rootCallId }) as ToolRunContext;
  assert.deepEqual(bindings.resolve(exec(a)), target);
  assert.equal(bindings.resolve(exec(b)), undefined);
  assert.equal(bindings.resolve(exec(a, ToolCallId('other-root'))), undefined);
  assert.equal(bindings.resolve(exec(undefined)), undefined);
  assert.throws(() => bindings.bind(a, root, target));
  target.target = 'mutated-outside';
  assert.equal(bindings.resolve(exec(a))?.target, 'original-host-chat');
  stop();
  stop();
  assert.equal(bindings.resolve(exec(a)), undefined);
  bindings.bind(b, root, target);
  bindings.dispose();
  assert.equal(bindings.resolve(exec(b)), undefined);
  assert.throws(() => bindings.bind(a, root, target));
});

test('trusted target bindings reject control characters and non-agent_talk tools', () => {
  const bindings = new TrustedTargetBindings();
  const a = { id: SessionId('a') } as Agent;
  for (const target of [
    { originId: 'authentic-host-task', target: 'host\nchat', toolName: 'mcp__maibot-agent__agent_talk' },
    { originId: 'authentic-host-task', target: '', toolName: 'mcp__maibot-agent__agent_talk' },
    { originId: 'authentic-host-task', target: 'host', toolName: 'dsh_import_handoff' },
    { originId: '', target: 'host', toolName: 'mcp__maibot-agent__agent_talk' },
    { originId: 'task\nforged', target: 'host', toolName: 'mcp__maibot-agent__agent_talk' },
  ]) assert.throws(() => bindings.bind(a, ToolCallId('root'), target));
});
