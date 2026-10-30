import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ArtifactService } from './core.js';
import { createDispatcher } from './dispatch.js';
export const name = 'maibot-artifacts';
export const inject = ['tools'];
export const Config = z.object({
    workspaceRoot: z.string(),
    stateDir: z.string(),
    maxFileBytes: z.number().default(50 * 1024 * 1024),
    maxBatchFiles: z.number().default(8),
    notificationTimeoutMs: z.number().default(30_000),
});
function owner(exec) {
    if (!exec.agent?.id)
        throw new Error('An actual DSH agent scope is required');
    return exec.agent.id;
}
function json(value) {
    // Materialize the core's serializable records at the official tool boundary.
    return JSON.parse(JSON.stringify(value));
}
function closed(tool) {
    // defineTool deliberately leaves the parameter root open. Its validator and
    // public schema share this JSON Schema object; close both before registration.
    tool.parameters['additionalProperties'] = false;
    return tool;
}
/** Cordis owns registration effects and removes them when this plugin unloads. */
export function apply(ctx, config) {
    const artifacts = new ArtifactService(config);
    ctx.tools.register(closed(defineTool({
        name: 'maibot_artifact_prepare',
        description: 'Prepare a local manifest for finished outbox files. Does not notify, upload or send files. Reuse the returned task_id; never retry unknown tasks with a new ID.',
        parameters: { paths: { type: 'array', items: { type: 'string' }, required: true } },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
            return json(await artifacts.prepare(args.paths, owner(exec), ctx.get('maibotArtifactTarget')?.resolve(exec)));
        },
    })));
    ctx.tools.register(closed(defineTool({
        name: 'maibot_artifact_publish',
        description: 'Attempt one handoff notification for a prepared task, only with a trusted original Host reply target. A queue receipt is not file import proof. Never retries an uncertain operation.',
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
        description: 'Read local preparation and notification records only. Does not query a MaiBot file library, retry notifications or prove import/delivery.',
        parameters: { task_id: { type: 'string', required: true } },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
            return json(await artifacts.localStatus(args.task_id, owner(exec)));
        },
    })));
}
export { TrustedTargetBindings } from './targets.js';
