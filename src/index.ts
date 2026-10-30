import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool, type ToolDefinition, type ToolExecutionSuccess, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { ArtifactService, type ArtifactConfig, type TrustedTarget } from './core.js';
import { createDispatcher } from './dispatch.js';

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
});
export type Config = ArtifactConfig;

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
  const artifacts = new ArtifactService(config);
  ctx.tools.register(closed(defineTool({
    name: 'maibot_artifact_prepare',
    description: 'Prepare a strict local manifest for finished outbox files. Next call publish with the returned task_id to submit a shared request for explicit confirmation in the original MaiBot chat. Does not notify, upload or send. Never retry unknown tasks with a new ID.',
    parameters: { paths: { type: 'array', items: { type: 'string' }, required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      return json(await artifacts.prepare(args.paths, owner(exec), ctx.get('maibotArtifactTarget')?.resolve(exec)));
    },
  })));
  ctx.tools.register(closed(defineTool({
    name: 'maibot_artifact_publish',
    description: 'Publish a prepared task as a shared request and return exact original-chat confirmation arguments. Default: dsh_import_handoff(manifest, send=false), compatible with MaiBot plugin v0.2.0. Explicit request mode requires the reviewed newer peer dsh_import_request tool. submitted is local only: MaiBot acceptance and registration remain unconfirmed. Does not select a chat or send files. An optional trusted Host integration may notify once; never retries uncertain remote operations.',
    parameters: { task_id: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const scope = owner(exec);
      const resolver = ctx.get('maibotArtifactTarget');
      const target = resolver?.resolve(exec);
      return json(await artifacts.publish(args.task_id, scope, target, createDispatcher(ctx, exec), exec.signal));
    },
  })));
  ctx.tools.register(closed(defineTool({
    name: 'maibot_artifact_local_status',
    description: 'Read local preparation, publication completion and notification evidence only. Private journals can recover a damaged primary record read-only; matching visible bytes without completion remain unknown. Does not query a MaiBot file library, recreate requests, retry notifications or prove import/delivery.',
    parameters: { task_id: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      return json(await artifacts.localStatus(args.task_id, owner(exec)));
    },
  })));
}

export type { TrustedTarget, Dispatch, DispatchOutcome } from './core.js';
export { TrustedTargetBindings } from './targets.js';
