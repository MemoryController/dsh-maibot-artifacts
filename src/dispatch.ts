import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Dispatch, DispatchOutcome, TrustedTarget } from './core.js';
import { compatibleTool, executeCompatibleTool, InvalidDshBatchReceiptError } from './dsh-compat.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Accept only the pinned MaiBot queue receipt, never generic MCP success. */
export function isQueueReceipt(value: unknown, target: string): boolean {
  if (!record(value) || value['isError'] === true || !Array.isArray(value['content'])) return false;
  const blocks: unknown[] = value['content'];
  // MaiBot's MCP server serializes one JSON result into one text block.
  if (blocks.length !== 1) return false;
  const block = blocks[0];
  if (!record(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') return false;
  try {
    const receipt: unknown = JSON.parse(block['text']);
    return record(receipt) && receipt['delivered'] === true && receipt['target'] === target
      && typeof receipt['relay_id'] === 'string' && /^[0-9a-f]{32}$/.test(receipt['relay_id']);
  } catch {
    return false;
  }
}

/** Invoke through the official registry, including scope, admission and guards. */
export function createDispatcher(ctx: Context, exec: ToolRunContext): Dispatch {
  return async (target: Pick<TrustedTarget, 'target' | 'toolName'>, text: string, signal: AbortSignal): Promise<DispatchOutcome> => {
    if (!/^mcp__[A-Za-z0-9_-]+__agent_talk$/.test(target.toolName)) {
      return { kind: 'not_dispatched', code: 'invalid_agent_talk_name' };
    }
    const tool = compatibleTool(ctx, exec, target.toolName);
    if (tool === undefined) return { kind: 'not_dispatched', code: 'agent_talk_unavailable' };
    const schema = tool.parameters;
    if (!record(schema) || !record(schema['properties'])) {
      return { kind: 'not_dispatched', code: 'incompatible_agent_talk_schema' };
    }
    const properties = schema['properties'];
    if (!record(properties['target']) || properties['target']['type'] !== 'string'
      || !record(properties['text']) || properties['text']['type'] !== 'string'
      || (Array.isArray(schema['required']) && schema['required'].some((key: unknown) => key !== 'target' && key !== 'text'))) {
      return { kind: 'not_dispatched', code: 'incompatible_agent_talk_schema' };
    }
    const id = ToolCallId(`maibot-artifact-${randomUUID()}`);
    let reachedDispatch = false;
    // Official event runs after admission, policy and guards, before the body.
    // Do not classify a tool-thrown UNKNOWN_TOOL as a safe pre-dispatch refusal.
    const stop = ctx.on('tools/execute', (nested, next) => {
      if (nested.callId === id) reachedDispatch = true;
      return next();
    }, { prepend: true });
    try {
      const completed = await executeCompatibleTool(ctx, exec, {
        callId: id, name: target.toolName, arguments: { target: target.target, text }, signal,
      });
      for (const context of completed.additionalContexts) exec.deferContext(context);
      if (completed.result.isError) {
        return { kind: reachedDispatch ? 'unknown' : 'not_dispatched', code: reachedDispatch ? 'agent_talk_failed' : 'dispatch_refused' };
      }
      if (!reachedDispatch || !isQueueReceipt(completed.result.value, target.target)) {
        return { kind: 'unknown', code: 'unconfirmed_queue_receipt' };
      }
      return { kind: 'queued', code: 'maibot_queue_receipt' };
    } catch (error) {
      if (error instanceof InvalidDshBatchReceiptError) return { kind: 'unknown', code: 'invalid_batch_receipt' };
      // A rejected batch can contain committed partial results. Never retry it.
      return { kind: 'unknown', code: 'dispatch_exception' };
    } finally {
      stop();
    }
  };
}
