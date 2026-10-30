import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { type ArtifactConfig, type TrustedTarget } from './core.js';
export declare const name = "maibot-artifacts";
export declare const inject: string[];
/** Only trusted Host code may provide this service. It is not a model tool. */
export interface TrustedTargetResolver {
    resolve(exec: ToolRunContext): TrustedTarget | undefined;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        maibotArtifactTarget: TrustedTargetResolver;
    }
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    workspaceRoot: z<string, string, "plain">;
    stateDir: z<string, string, "plain">;
    maxFileBytes: z<number, number, "defined">;
    maxBatchFiles: z<number, number, "defined">;
    notificationTimeoutMs: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    workspaceRoot: z<string, string, "plain">;
    stateDir: z<string, string, "plain">;
    maxFileBytes: z<number, number, "defined">;
    maxBatchFiles: z<number, number, "defined">;
    notificationTimeoutMs: z<number, number, "defined">;
}>>, "plain">;
export type Config = ArtifactConfig;
/** Cordis owns registration effects and removes them when this plugin unloads. */
export declare function apply(ctx: Context, config: Config): void;
export type { TrustedTarget, Dispatch, DispatchOutcome } from './core.js';
export { TrustedTargetBindings } from './targets.js';
