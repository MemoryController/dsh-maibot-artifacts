import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

const fixed = { mode: 'fixed' as const, target: 'private:123:qq', acknowledgeSingleChat: true };
async function harness(t: { after(callback: () => Promise<unknown>): void }, options: { guard?: boolean; installed?: boolean; wrongReceipt?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-plugin-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const workspaceRoot = join(root, 'workspace');
  const stateDir = join(root, 'state');
  await mkdir(join(workspaceRoot, 'outbox'), { recursive: true });
  await writeFile(join(workspaceRoot, 'outbox', '测试 图片.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  await ctx.plugin(NativeExecutor);
  await ctx.plugin(Plugin, { workspaceRoot, stateDir, confirmationMode: 'request', autoNotify: fixed });
  let count = 0;
  let message = '';
  if (options.installed !== false) ctx.tools.register(defineTool({
    name: 'mcp__maibot-agent__agent_talk', description: 'Isolated queue double',
    parameters: { target: { type: 'string' }, text: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: () => [] },
    async execute(args, exec) {
      count++;
      assert.equal(exec.agent?.id, 'actual-auto-agent');
      assert.equal(args.target, fixed.target);
      message = args.text;
      return { content: [{ type: 'text', text: JSON.stringify({ delivered: true, target: options.wrongReceipt ? 'private:456:qq' : args.target, relay_id: 'a'.repeat(32) }) }] };
    },
  }));
  if (options.guard) ctx.tools.guard(exec => exec.name === 'mcp__maibot-agent__agent_talk' ? 'Operator policy denied notification' : undefined);
  let call = 0;
  const agent = { id: SessionId('actual-auto-agent') } as Agent;
  const execute = async (name: string, args: unknown, current = agent) => {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(`auto-test-${call++}`), name, arguments: JSON.stringify(args) }],
      agent: current, signal: new AbortController().signal,
    });
    const first = batch.results[0];
    assert.ok(first);
    return first.result;
  };
  const success = async (name: string, args: unknown) => {
    const result = await execute(name, args);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.ok(!result.isError);
    return result.value as unknown as { result: string; manifest: { task_id: string }; confirmation: unknown; automatic_notification: { state: string }; stages: { publication: string; notification: string; registration: string } };
  };
  return { root, workspaceRoot, stateDir, execute, success, count: () => count, message: () => message };
}

test('opt-in fixed notification uses official Native executor once after durable local publication', async t => {
  const h = await harness(t);
  assert.equal((await h.execute('maibot_artifact_prepare', { paths: ['outbox/测试 图片.png'], target: 'forged' })).isError, true);
  const prepared = await h.success('maibot_artifact_prepare', { paths: ['outbox/测试 图片.png'] });
  assert.equal(prepared.automatic_notification.state, 'ready');
  assert.equal(h.count(), 0);
  const id = prepared.manifest.task_id;
  const published = await h.success('maibot_artifact_publish', { task_id: id });
  assert.equal(published.result, 'submitted');
  assert.deepEqual(published.stages, { publication: 'submitted', notification: 'queued', registration: 'unconfirmed' });
  assert.deepEqual(JSON.parse(h.message().split('\n').at(-1)!), published.confirmation);
  assert.equal(h.count(), 1);
  assert.equal((await h.success('maibot_artifact_publish', { task_id: id })).stages.notification, 'queued');
  assert.equal((await h.success('maibot_artifact_local_status', { task_id: id })).stages.notification, 'queued');
  assert.equal(h.count(), 1);
  assert.doesNotMatch(JSON.stringify(published), /"file_ref"|"registration":"imported"/);
  const request = JSON.parse(await readFile(join(h.workspaceRoot, 'outbox', '.dsh-handoffs', `${id}.json`), 'utf8'));
  assert.deepEqual(request, prepared.manifest);
  const disk = JSON.parse(await readFile(join(h.stateDir, `${id}.json`), 'utf8'));
  assert.equal(disk.state, 'prepared');
  assert.equal(disk.notification, undefined);
  assert.ok(disk.submission);
  assert.ok((await readdir(h.stateDir)).includes(`${id}.notify-attempt`));
  const forged = await h.execute('maibot_artifact_local_status', { task_id: id }, { id: SessionId('other-agent') } as Agent);
  assert.equal(forged.isError, true);
});

for (const [label, options, state] of [
  ['guard rejection', { guard: true }, 'not_dispatched'],
  ['absent agent_talk', { installed: false }, 'not_dispatched'],
  ['wrong-target receipt', { wrongReceipt: true }, 'unknown'],
] as const) test(`fixed notification preserves manual confirmation after ${label}`, async t => {
  const h = await harness(t, options);
  const prepared = await h.success('maibot_artifact_prepare', { paths: ['outbox/测试 图片.png'] });
  const id = prepared.manifest.task_id;
  const published = await h.success('maibot_artifact_publish', { task_id: id });
  assert.deepEqual(published.stages, { publication: 'submitted', notification: state, registration: 'unconfirmed' });
  assert.deepEqual(published.confirmation, { tool: 'dsh_import_request', arguments: { task_id: id, request_sha256: (JSON.parse(await readFile(join(h.stateDir, `${id}.json`), 'utf8')) as { submission: { sha256: string } }).submission.sha256 } });
  await h.success('maibot_artifact_publish', { task_id: id });
  assert.equal(h.count(), state === 'unknown' ? 1 : 0);
});

test('failed local publication never starts notification and keeps prepared safety checks', async t => {
  const h = await harness(t);
  const prepared = await h.success('maibot_artifact_prepare', { paths: ['outbox/测试 图片.png'] });
  await writeFile(join(h.workspaceRoot, 'outbox', '测试 图片.png'), 'changed');
  const published = await h.success('maibot_artifact_publish', { task_id: prepared.manifest.task_id });
  assert.equal(published.result, 'prepared_only');
  assert.notEqual(published.automatic_notification.state, 'queued');
  assert.equal(h.count(), 0);
  assert.equal((await readdir(h.stateDir)).some(path => path.endsWith('.notify-attempt')), false);
});
