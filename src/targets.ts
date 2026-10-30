import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { TrustedTarget } from './core.js';
import type { TrustedTargetResolver } from './index.js';

type Agent = NonNullable<ToolRunContext['agent']>;

/**
 * Optional, in-process Host adapter helper. A binding must originate in a
 * verified Host task, not text parsing, model arguments, file data or a task ID.
 * Matching uses the actual Agent object plus that tool execution's root call.
 */
export class TrustedTargetBindings implements TrustedTargetResolver {
  private entries = new WeakMap<Agent, Map<ToolRunContext['rootCallId'], Readonly<TrustedTarget>>>();
  private disposed = false;

  bind(agent: Agent, rootCallId: ToolRunContext['rootCallId'], target: TrustedTarget): () => void {
    if (this.disposed) throw new Error('Target bindings have been disposed');
    if (!agent || typeof agent !== 'object' || typeof rootCallId !== 'string' || !rootCallId) {
      throw new Error('An actual Agent and root call identity are required');
    }
    if (typeof target.originId !== 'string' || !target.originId.trim()
      || Array.from(target.originId).length > 2048
      || Array.from(target.originId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || typeof target.target !== 'string' || !target.target.trim()
      || Array.from(target.target).length > 2048
      || Array.from(target.target).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || !/^mcp__[A-Za-z0-9_-]+__agent_talk$/u.test(target.toolName)) {
      throw new Error('Invalid trusted target binding');
    }
    let calls = this.entries.get(agent);
    if (!calls) { calls = new Map(); this.entries.set(agent, calls); }
    if (calls.has(rootCallId)) throw new Error('A target is already bound for this root call');
    const binding = Object.freeze({ originId: target.originId, target: target.target, toolName: target.toolName });
    calls.set(rootCallId, binding);
    return () => { if (calls.get(rootCallId) === binding) calls.delete(rootCallId); };
  }

  resolve(exec: ToolRunContext): TrustedTarget | undefined {
    if (this.disposed || !exec.agent) return undefined;
    const binding = this.entries.get(exec.agent)?.get(exec.rootCallId);
    return binding ? { ...binding } : undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.entries = new WeakMap();
  }
}
