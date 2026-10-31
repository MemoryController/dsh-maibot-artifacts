/** Unsupported or mixed tool surfaces fail before registering plugin tools. */
export class UnsupportedDshToolsError extends Error {
    code = 'unsupported_dsh_tools_api';
    constructor() {
        super('Unsupported DSH tools API: expected the audited 0.2.1-rc.2–rc.5 single-call registry or 0.2.2-alpha.2 batch executor; no tools or policies were bypassed');
        this.name = 'UnsupportedDshToolsError';
    }
}
export class InvalidDshBatchReceiptError extends Error {
    constructor() { super('Invalid DSH batch result correlation'); this.name = 'InvalidDshBatchReceiptError'; }
}
function object(value) {
    return value !== null && typeof value === 'object';
}
function batch(value) {
    return object(value) && ['get', 'execute', 'executable', 'resolve', 'setExecutor'].every(key => typeof value[key] === 'function')
        && value.presentAs === undefined;
}
function single(value) {
    return object(value) && ['get', 'execute', 'presentAs'].every(key => typeof value[key] === 'function')
        && ['executable', 'resolve', 'setExecutor'].every(key => value[key] === undefined);
}
function tools(ctx) {
    const service = ctx.tools;
    if (batch(service))
        return { mode: 'alpha-batch', service };
    if (single(service))
        return { mode: 'rc-single', service };
    throw new UnsupportedDshToolsError();
}
/** Public, side-effect-free capability probe, shared by startup and tests. */
export function dshCapabilities(ctx) {
    const selected = tools(ctx);
    return { mode: selected.mode, conditionalAdmission: selected.mode === 'alpha-batch',
        nestedDispatch: selected.mode === 'rc-single' ? 'public-parent' : 'root-batch-only' };
}
/** Scoped lookup only. The official execution API still owns all admission. */
export function compatibleTool(ctx, exec, name) {
    const selected = tools(ctx);
    if (selected.mode === 'alpha-batch')
        return selected.service.executable(name, exec.agent, exec.toolSet);
    // A hybrid context must never silently drop a caller's step admission.
    if (exec.toolSet !== undefined)
        throw new UnsupportedDshToolsError();
    return selected.service.get(name, exec.agent);
}
/** Execute exactly once through the host API, preserving its scope and policy. */
export async function executeCompatibleTool(ctx, exec, input) {
    const selected = tools(ctx);
    if (selected.mode === 'rc-single') {
        if (exec.toolSet !== undefined)
            throw new UnsupportedDshToolsError();
        const result = await selected.service.execute({
            callId: input.callId, name: input.name, arguments: input.arguments, signal: input.signal,
            ...(exec.agent === undefined ? {} : { agent: exec.agent }),
            // RC's public single-call API supports an actual enclosing execution.
            // Forward that capability unchanged; never mint a token or bypass tools.
            ...(exec.token === undefined ? {} : { parent: exec.token }),
            ...(exec.rootCallId === undefined ? {} : { rootCallId: exec.rootCallId }),
        });
        return { result, additionalContexts: result.additionalContexts ?? [] };
    }
    const batch = await selected.service.execute({
        calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
        signal: input.signal,
        ...(exec.agent === undefined ? {} : { agent: exec.agent }),
        ...(exec.toolSet === undefined ? {} : { toolSet: exec.toolSet }),
    });
    const first = batch.results[0];
    if (batch.results.length !== 1 || first?.callId !== input.callId)
        throw new InvalidDshBatchReceiptError();
    return { result: first.result, additionalContexts: batch.additionalContexts };
}
