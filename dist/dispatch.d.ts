import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Dispatch } from './core.js';
/** Accept only the pinned MaiBot queue receipt, never generic MCP success. */
export declare function isQueueReceipt(value: unknown, target: string): boolean;
/** Invoke through the official registry, including scope, admission and guards. */
export declare function createDispatcher(ctx: Context, exec: ToolRunContext): Dispatch;
