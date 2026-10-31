import type { Context } from '@deepseek-ai/cordis';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools';
export interface DshCapabilities {
    mode: 'rc-single' | 'alpha-batch';
    conditionalAdmission: boolean;
    nestedDispatch: 'public-parent' | 'root-batch-only';
}
/** Unsupported or mixed tool surfaces fail before registering plugin tools. */
export declare class UnsupportedDshToolsError extends Error {
    readonly code = "unsupported_dsh_tools_api";
    constructor();
}
export declare class InvalidDshBatchReceiptError extends Error {
    constructor();
}
type DeferredContext = Parameters<ToolRunContext['deferContext']>[0];
interface DispatchInput {
    callId: ToolCallId;
    name: string;
    arguments: {
        target: string;
        text: string;
    };
    signal: AbortSignal;
}
export interface CompatibleToolResult {
    result: ToolExecutionResult;
    additionalContexts: readonly DeferredContext[];
}
/** Public, side-effect-free capability probe, shared by startup and tests. */
export declare function dshCapabilities(ctx: Context): DshCapabilities;
/** Scoped lookup only. The official execution API still owns all admission. */
export declare function compatibleTool(ctx: Context, exec: ToolRunContext, name: string): ToolDefinition | undefined;
/** Execute exactly once through the host API, preserving its scope and policy. */
export declare function executeCompatibleTool(ctx: Context, exec: ToolRunContext, input: DispatchInput): Promise<CompatibleToolResult>;
export {};
