import { type SharedRequest } from './shared-request.js';
import type { TaskRecord } from './core.js';
export interface SubmissionIntent {
    version: 1;
    record: TaskRecord;
    requestSha256: string;
    startedAt: string;
}
export interface SubmissionComplete {
    version: 1;
    owner: string;
    task_id: string;
    request: SharedRequest;
}
export declare const manifestDigest: (record: TaskRecord) => string;
/** Bounded, no-follow reads of OS-private, single-link JSON evidence. */
export declare function readPrivateJson(path: string): Promise<unknown>;
export declare function validateRecord(value: unknown, id: string, ownerHash: string): TaskRecord;
export declare function validateIntent(value: unknown, id: string, ownerHash: string): SubmissionIntent;
export declare function validateComplete(value: unknown, intent: SubmissionIntent): SubmissionComplete;
