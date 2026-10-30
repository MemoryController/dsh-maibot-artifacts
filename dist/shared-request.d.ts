import type { Manifest } from './core.js';
export interface SharedRequest {
    path: string;
    sha256: string;
    submittedAt: string;
}
/** Publish only strict manifest bytes; a request grants no chat identity or permission. */
export declare function publishSharedRequest(root: string, manifest: Manifest): Promise<SharedRequest>;
