import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { TrustedTarget } from './core.js';
import type { TrustedTargetResolver } from './index.js';
type Agent = NonNullable<ToolRunContext['agent']>;
/**
 * Optional, in-process Host adapter helper. A binding must originate in a
 * verified Host task, not text parsing, model arguments, file data or a task ID.
 * Matching uses the actual Agent object plus that tool execution's root call.
 */
export declare class TrustedTargetBindings implements TrustedTargetResolver {
    private entries;
    private disposed;
    bind(agent: Agent, rootCallId: ToolRunContext['rootCallId'], target: TrustedTarget): () => void;
    resolve(exec: ToolRunContext): TrustedTarget | undefined;
    dispose(): void;
}
export {};
