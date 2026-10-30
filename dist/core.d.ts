export interface ArtifactConfig {
    workspaceRoot: string;
    stateDir: string;
    maxFileBytes?: number;
    maxBatchFiles?: number;
    notificationTimeoutMs?: number;
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
export type Dispatch = (target: TrustedTarget, text: string, signal: AbortSignal) => Promise<DispatchOutcome>;
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
    error?: string;
}
export declare function relayText(manifest: Manifest): string;
/** Local state is evidence of preparation/notification only, never file registration. */
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
    prepare(paths: string[], owner: string, origin?: TrustedTarget): Promise<TaskRecord & {
        duplicate: boolean;
    }>;
    localStatus(id: string, owner: string): Promise<TaskRecord>;
    publish(id: string, owner: string, target?: TrustedTarget, dispatch?: Dispatch, signal?: AbortSignal): Promise<{
        result: string;
        relay_text: string;
        next: string;
        manifest: Manifest;
        owner: string;
        originHash?: string;
        state: "prepared" | "queued" | "unknown";
        createdAt: string;
        notification?: Notification;
        error?: string;
    } | {
        state: string;
        result: string;
        next: string;
        manifest: Manifest;
        owner: string;
        originHash?: string;
        createdAt: string;
        notification?: Notification;
        error?: string;
    }>;
}
export {};
