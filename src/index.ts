import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool, type ToolDefinition, type ToolExecutionSuccess, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { ArtifactService, type ArtifactConfig, type ArtifactResult, type TaskRecord, type TrustedTarget } from './core.js';
import { createDispatcher } from './dispatch.js';
import { AutoNotifier, type FixedNotificationConfig, type NotificationStatus } from './auto-notify.js';
import { dshCapabilities } from './dsh-compat.js';

export const name = 'maibot-artifacts';
export const inject = ['tools'];

/** Only trusted Host code may provide this service. It is not a model tool. */
export interface TrustedTargetResolver {
  resolve(exec: ToolRunContext): TrustedTarget | undefined;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    maibotArtifactTarget: TrustedTargetResolver;
  }
}

export const Config = z.object({
  workspaceRoot: z.string(),
  // Schemastery strings are optional unless .required() is set; defaults are
  // resolved in JavaScript so $HOME is never interpreted by a user's shell.
  stateDir: z.string(),
  maxFileBytes: z.number().default(50 * 1024 * 1024),
  maxBatchFiles: z.number().default(8),
  notificationTimeoutMs: z.number().default(30_000),
  confirmationMode: z.union(['manifest', 'request']).default('manifest'),
  autoNotify: z.object({
    mode: z.union(['off', 'fixed']).default('off'),
    target: z.string(),
    toolName: z.string(),
    acknowledgeSingleChat: z.boolean(),
  }),
});
export type Config = ArtifactConfig & { autoNotify?: FixedNotificationConfig };

function owner(exec: ToolRunContext): string {
  if (!exec.agent?.id) throw new Error('An actual DSH agent scope is required');
  return exec.agent.id;
}

function json(value: unknown): ToolExecutionSuccess['value'] {
  // Materialize the core's serializable records at the official tool boundary.
  return JSON.parse(JSON.stringify(value)) as ToolExecutionSuccess['value'];
}

function closed(tool: ToolDefinition): ToolDefinition {
  // defineTool deliberately leaves the parameter root open. Its validator and
  // public schema share this JSON Schema object; close both before registration.
  tool.parameters['additionalProperties'] = false;
  return tool;
}

/** Cordis owns registration effects and removes them when this plugin unloads. */
export function apply(ctx: Context, config: Config): void {
  dshCapabilities(ctx);
  const artifacts = new ArtifactService(config);
  const notifier = new AutoNotifier(artifacts.config, config.autoNotify);
  function stages<T extends TaskRecord>(record: T, notification: NotificationStatus): T | (T & {
    automatic_notification: NotificationStatus;
    stages: { publication: string; notification: string; registration: 'unconfirmed' };
    maibot_registration: 'unconfirmed';
    next: string;
  }) {
    if (notification.state === 'disabled') return record;
    return {
      ...record, automatic_notification: notification,
      stages: {
        publication: record.state === 'unknown' ? 'unknown' : record.submission ? 'submitted' : 'prepared',
        notification: notification.state, registration: 'unconfirmed',
      },
      maibot_registration: 'unconfirmed',
      next: 'submitted 仅为共享请求发布；queued 仅为传话入队。固定接收方不是原聊天身份证明。MaiBot 须在合法当前聊天实际调用 confirmation 并返回 file_ref；没有真实工具结果不得声称入库。通知尝试只读核对，禁止重发或换 task_id；保留 manifest/request 人工确认路径。',
    };
  }
  ctx.tools.register(closed(defineTool({
    name: 'maibot_artifact_prepare',
    description: 'Prepare a strict local manifest for finished outbox files. Next call publish with the returned task_id to submit a shared request. Optional operator-authorized fixed-single-chat notification binds here; target is never a model argument. Does not notify, upload or send. Never retry unknown tasks with a new ID.',
    parameters: { paths: { type: 'array', items: { type: 'string' }, required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const prepared = await artifacts.prepare(args.paths, owner(exec), notifier.enabled ? undefined : ctx.get('maibotArtifactTarget')?.resolve(exec));
      return json(stages(prepared, notifier.enabled ? await notifier.bind(prepared) : await notifier.status(prepared)));
    },
  })));
  ctx.tools.register(closed(defineTool({
    name: 'maibot_artifact_publish',
    description: 'Publish a prepared task as a shared request and return exact MaiBot confirmation arguments. Default dsh_import_handoff(manifest, send=false); request mode requires MaiBot plugin v0.2.1 dsh_import_request. submitted is local only. Explicit fixed-single-chat mode may notify once through the actual official executor; automatic_notification=queued means text queued, never imported. Refusal/unknown retains manual confirmation; never retries notifications. No chat/target/send model arguments.',
    parameters: { task_id: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const scope = owner(exec);
      const resolver = ctx.get('maibotArtifactTarget');
      const dispatch = createDispatcher(ctx, exec);
      const published: ArtifactResult = await artifacts.publish(args.task_id, scope, notifier.enabled ? undefined : resolver?.resolve(exec), dispatch, exec.signal);
      const notification = notifier.enabled ? await notifier.notify(published, dispatch, exec.signal) : await notifier.status(published);
      return json(stages(published, notification));
    },
  })));
  ctx.tools.register(closed(defineTool({
    name: 'maibot_artifact_local_status',
    description: 'Read local preparation, publication completion and notification evidence only. Private journals can recover a damaged primary record read-only; matching visible bytes without completion remain unknown. Does not query a MaiBot file library, recreate requests, retry notifications or prove import/delivery.',
    parameters: { task_id: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const record = await artifacts.localStatus(args.task_id, owner(exec));
      return json(stages(record, await notifier.status(record)));
    },
  })));
}

export type { TrustedTarget, Dispatch, DispatchOutcome } from './core.js';
export { TrustedTargetBindings } from './targets.js';
export { dshCapabilities } from './dsh-compat.js';
export type { DshCapabilities } from './dsh-compat.js';
