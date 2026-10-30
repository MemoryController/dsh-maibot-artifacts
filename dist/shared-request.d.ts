import { SafetyError } from './safe-files.js';
import type { Manifest } from './core.js';
export interface SharedRequest {
    path: string;
    sha256: string;
    submittedAt: string;
}
export type SharedRequestInspection = {
    kind: 'matching';
    request: SharedRequest;
} | {
    kind: 'missing' | 'conflict' | 'unreadable';
    code: string;
};
/** The phase describes this invocation; it never proves peer acceptance. */
export declare class SharedRequestPublishError extends SafetyError {
    readonly publication: 'not_published' | 'unknown';
    readonly cause?: unknown;
    constructor(code: string, publication: 'not_published' | 'unknown', cause?: unknown);
}
/** Validate the complete protocol shape before trusting an on-disk record. */
export declare function validateManifest(manifest: unknown): asserts manifest is Manifest;
/**
 * Observe an existing request without creating, repairing or persisting anything.
 * A matching observation proves current bytes only, not an earlier fsync, peer
 * acceptance, import, delivery or ownership by any original MaiBot chat.
 */
export declare function inspectSharedRequest(root: string, manifest: Manifest): Promise<SharedRequestInspection>;
/** Publish only strict manifest bytes; a request grants no chat identity or permission. */
export declare function publishSharedRequest(root: string, manifest: Manifest): Promise<SharedRequest>;
