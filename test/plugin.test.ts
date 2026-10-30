import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import * as Plugin from '../src/index.js';

test('real Cordis plugin registers lifecycle-owned tools and requires an actual agent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'workspace', 'outbox'), { recursive: true });
  await writeFile(join(root, 'workspace', 'outbox', '结果.txt'), '结果');
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  await ctx.plugin(NativeExecutor);
  const plugin = await ctx.plugin(Plugin, { workspaceRoot: join(root, 'workspace'), stateDir: join(root, 'state') });
  assert.deepEqual(ctx.tools.definitions().map(tool => tool.name).sort(), [
    'maibot_artifact_local_status', 'maibot_artifact_prepare', 'maibot_artifact_publish',
  ]);
  const agent = { id: SessionId('actual-test-agent') } as Agent;
  let call = 0;
  const execute = async (name: string, args: unknown, withAgent = true) => {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(`test-${call++}`), name, arguments: JSON.stringify(args) }],
      signal: new AbortController().signal,
      ...(withAgent ? { agent } : {}),
    });
    const first = batch.results[0];
    assert.ok(first);
    return first.result;
  };
  assert.equal((await execute('maibot_artifact_prepare', { paths: ['outbox/结果.txt'] }, false)).isError, true);
  assert.equal((await execute('maibot_artifact_prepare', { paths: ['outbox/结果.txt'], target: 'forged' })).isError, true);
  const prepared = await execute('maibot_artifact_prepare', { paths: ['outbox/结果.txt'] });
  assert.equal(prepared.isError, false);
  assert.ok(!prepared.isError && typeof prepared.value === 'object' && prepared.value !== null && !Array.isArray(prepared.value));
  const data = prepared.value as { task_id?: string; manifest?: { task_id: string } };
  const taskId = data.task_id ?? data.manifest?.task_id;
  assert.match(taskId ?? '', /^[0-9a-f]{32}$/);
  const published = await execute('maibot_artifact_publish', { task_id: taskId });
  assert.equal(published.isError, false);
  assert.match(JSON.stringify(published), /"result":"submitted"/);
  assert.match(JSON.stringify(published), /"tool":"dsh_import_request"/);
  assert.doesNotMatch(JSON.stringify(published), /"(?:status|state)":"(?:queued|imported)"/);
  const status = await execute('maibot_artifact_local_status', { task_id: taskId });
  assert.equal(status.isError, false);
  assert.doesNotMatch(JSON.stringify(status), /"(?:status|state)":"imported"/);
  const bindings = new Plugin.TrustedTargetBindings();
  ctx.provide('maibotArtifactTarget', bindings);
  let notifications = 0;
  const removeMcp = ctx.tools.register(defineTool({
    name: 'mcp__maibot-agent__agent_talk', description: 'Isolated MaiBot queue mock',
    parameters: { target: { type: 'string' }, text: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: () => [] },
    async execute(args) {
      notifications++;
      assert.match(args.text, /"send":false/);
      return { content: [{ type: 'text', text: JSON.stringify({ delivered: true, target: args.target, relay_id: 'b'.repeat(32) }) }] };
    },
  }));
  const trusted = { originId: 'authentic-host-task', target: 'original-host-chat', toolName: 'mcp__maibot-agent__agent_talk' };
  const lateBinding = bindings.bind(agent, ToolCallId(`test-${call}`), trusted);
  const stillManual = await execute('maibot_artifact_publish', { task_id: taskId });
  lateBinding();
  assert.equal(stillManual.isError, false);
  assert.match(JSON.stringify(stillManual), /"result":"submitted"/);
  assert.equal(notifications, 0);
  await writeFile(join(root, 'workspace', 'outbox', '绑定产物.txt'), '可信任务产物');
  const unbindPrepare = bindings.bind(agent, ToolCallId(`test-${call}`), trusted);
  const boundPreparation = await execute('maibot_artifact_prepare', { paths: ['outbox/绑定产物.txt'] });
  unbindPrepare();
  assert.equal(boundPreparation.isError, false);
  assert.ok(!boundPreparation.isError);
  const boundTaskId = (boundPreparation.value as { manifest: { task_id: string } }).manifest.task_id;
  const unbind = bindings.bind(agent, ToolCallId(`test-${call}`), trusted);
  const queued = await execute('maibot_artifact_publish', { task_id: boundTaskId });
  unbind();
  assert.equal(queued.isError, false);
  assert.match(JSON.stringify(queued), /"state":"queued"/);
  assert.doesNotMatch(JSON.stringify(queued), /"(?:status|state)":"imported"/);
  await execute('maibot_artifact_publish', { task_id: boundTaskId });
  assert.equal(notifications, 1);
  removeMcp();
  bindings.dispose();
  await plugin.dispose();
  assert.deepEqual(ctx.tools.definitions(), []);
});
