import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecutionInput, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'

export interface DshCapabilities {
  mode: 'rc-single' | 'alpha-batch'
  conditionalAdmission: boolean
  nestedDispatch: 'public-parent' | 'root-batch-only'
}

/** Unsupported or mixed tool surfaces fail before registering plugin tools. */
export class UnsupportedDshToolsError extends Error {
  readonly code = 'unsupported_dsh_tools_api'
  constructor() {
    super('Unsupported DSH tools API: expected the audited 0.2.1-rc.2–rc.5 single-call registry or 0.2.2-alpha.2 batch executor; no tools or policies were bypassed')
    this.name = 'UnsupportedDshToolsError'
  }
}

export class InvalidDshBatchReceiptError extends Error {
  constructor() { super('Invalid DSH batch result correlation'); this.name = 'InvalidDshBatchReceiptError' }
}

// Published rc.2–rc.5 have identical public single-call contracts. They do not
// have step-time admission. This interface describes only that audited public
// subset; internal schedulers and raw ToolDefinition.execute are never used.
interface SingleTools {
  get(name: string, scope?: ToolRunContext['agent']): ToolDefinition | undefined
  execute(input: ToolExecutionInput): Promise<ToolExecutionResult>
  presentAs(mode: 'native' | 'ptc'): () => void
}
type BatchTools = Pick<Context['tools'], 'get' | 'execute' | 'executable' | 'resolve' | 'setExecutor'>
type Tools = { mode: 'rc-single'; service: SingleTools } | { mode: 'alpha-batch'; service: BatchTools }
type DeferredContext = Parameters<ToolRunContext['deferContext']>[0]
interface DispatchInput {
  callId: ToolCallId
  name: string
  arguments: { target: string; text: string }
  signal: AbortSignal
}
export interface CompatibleToolResult {
  result: ToolExecutionResult
  additionalContexts: readonly DeferredContext[]
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
function batch(value: unknown): value is BatchTools {
  return object(value) && ['get', 'execute', 'executable', 'resolve', 'setExecutor'].every(key => typeof value[key] === 'function')
    && value.presentAs === undefined
}
function single(value: unknown): value is SingleTools {
  return object(value) && ['get', 'execute', 'presentAs'].every(key => typeof value[key] === 'function')
    && ['executable', 'resolve', 'setExecutor'].every(key => value[key] === undefined)
}
function tools(ctx: Context): Tools {
  const service: unknown = ctx.tools
  if (batch(service)) return { mode: 'alpha-batch', service }
  if (single(service)) return { mode: 'rc-single', service }
  throw new UnsupportedDshToolsError()
}

/** Public, side-effect-free capability probe, shared by startup and tests. */
export function dshCapabilities(ctx: Context): DshCapabilities {
  const selected = tools(ctx)
  return { mode: selected.mode, conditionalAdmission: selected.mode === 'alpha-batch',
    nestedDispatch: selected.mode === 'rc-single' ? 'public-parent' : 'root-batch-only' }
}

/** Scoped lookup only. The official execution API still owns all admission. */
export function compatibleTool(ctx: Context, exec: ToolRunContext, name: string): ToolDefinition | undefined {
  const selected = tools(ctx)
  if (selected.mode === 'alpha-batch') return selected.service.executable(name, exec.agent, exec.toolSet)
  // A hybrid context must never silently drop a caller's step admission.
  if (exec.toolSet !== undefined) throw new UnsupportedDshToolsError()
  return selected.service.get(name, exec.agent)
}

/** Execute exactly once through the host API, preserving its scope and policy. */
export async function executeCompatibleTool(ctx: Context, exec: ToolRunContext, input: DispatchInput): Promise<CompatibleToolResult> {
  const selected = tools(ctx)
  if (selected.mode === 'rc-single') {
    if (exec.toolSet !== undefined) throw new UnsupportedDshToolsError()
    const result = await selected.service.execute({
      callId: input.callId, name: input.name, arguments: input.arguments, signal: input.signal,
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      // RC's public single-call API supports an actual enclosing execution.
      // Forward that capability unchanged; never mint a token or bypass tools.
      ...(exec.token === undefined ? {} : { parent: exec.token }),
      ...(exec.rootCallId === undefined ? {} : { rootCallId: exec.rootCallId }),
    })
    return { result, additionalContexts: result.additionalContexts ?? [] }
  }
  const batch = await selected.service.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    signal: input.signal,
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    ...(exec.toolSet === undefined ? {} : { toolSet: exec.toolSet }),
  })
  const first = batch.results[0]
  if (batch.results.length !== 1 || first?.callId !== input.callId) throw new InvalidDshBatchReceiptError()
  return { result: first.result, additionalContexts: batch.additionalContexts }
}
