import { type SharedRequest, type SharedRequestInspection } from './shared-request.js';
export interface ArtifactConfig {
    workspaceRoot: string;
    stateDir?: string;
    maxFileBytes?: number;
    maxBatchFiles?: number;
    notificationTimeoutMs?: number;
    confirmationMode?: 'manifest' | 'request';
}
export interface TrustedTarget {
    target: string;
    toolName: string;
    originId: string;
}
export interface DispatchOutcome {
    kind: 'queued' | 'not_dispatched' | 'unknown';
    code: string;
}
export type Dispatch = (target: Pick<TrustedTarget, 'target' | 'toolName'>, text: string, signal: AbortSignal) => Promise<DispatchOutcome>;
export interface ArtifactFile {
    path: string;
    size: number;
    sha256: string;
}
export interface Manifest {
    type: 'dsh_artifacts';
    version: 1;
    task_id: string;
    files: ArtifactFile[];
}
interface Notification {
    kind: 'queued' | 'not_dispatched' | 'unknown';
    code: string;
    at: string;
    toolName: string;
    targetHash: string;
}
export interface TaskRecord {
    manifest: Manifest;
    owner: string;
    originHash?: string;
    state: 'prepared' | 'queued' | 'unknown';
    createdAt: string;
    notification?: Notification;
    submission?: SharedRequest;
    error?: string;
    historical_error?: string;
    record_recovery?: 'missing' | 'corrupt';
    submission_check?: SharedRequestInspection;
}
interface SubmittedResult extends TaskRecord {
    result: 'submitted';
    shared_request: SharedRequest;
    confirmation: {
        tool: 'dsh_import_handoff';
        arguments: {
            manifest: Manifest;
            send: false;
        };
    } | {
        tool: 'dsh_import_request';
        arguments: {
            task_id: string;
            request_sha256: string;
        };
    };
    maibot_registration: 'unconfirmed';
    next: string;
}
export type ArtifactResult = SubmittedResult | (TaskRecord & {
    result: 'prepared' | 'queued' | 'unknown' | 'prepared_only' | 'needs_target';
    next?: string;
    relay_text?: string;
    observed_request?: SharedRequest;
    maibot_registration?: 'unconfirmed';
});
export declare function relayText(manifest: Manifest): string;
/** Local preparation/publication/notification evidence never proves MaiBot registration. */
export declare class ArtifactService {
    readonly config: Required<ArtifactConfig>;
    private initialized?;
    constructor(config: ArtifactConfig);
    private init;
    private file;
    private exclusive;
    private syncDir;
    private save;
    private load;
    private history;
    private noteError;
    private intent;
    prepare(paths: string[], owner: string, origin?: TrustedTarget): Promise<TaskRecord & {
        duplicate: boolean;
    }>;
    localStatus(id: string, owner: string): Promise<TaskRecord>;
    private submissionResult;
    private submit;
    publish(id: string, owner: string, target?: TrustedTarget, dispatch?: Dispatch, signal?: AbortSignal): Promise<ArtifactResult>;
}
export {};
