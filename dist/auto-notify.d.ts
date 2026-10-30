import type { ArtifactResult, Dispatch, TaskRecord } from './core.js';
export interface FixedNotificationConfig {
    mode: 'off' | 'fixed';
    target?: string;
    toolName?: string;
    acknowledgeSingleChat?: boolean;
}
export interface NotificationStatus {
    state: 'disabled' | 'ready' | 'needs_target' | 'not_dispatched' | 'queued' | 'unknown';
    code: string;
    policy?: 'fixed_single_chat';
    target_hash?: string;
}
interface Options {
    stateDir: string;
    notificationTimeoutMs?: number;
    confirmationMode: 'manifest' | 'request';
}
/**
 * Optional fixed-single-chat notification. This journal is independent of core
 * publication and legacy Host-target state. It never proves import or delivery.
 * Private state, its ancestors and same-UID code remain trusted and retained.
 */
export declare class AutoNotifier {
    private readonly stateDir;
    private readonly timeoutMs;
    private readonly confirmationMode;
    private readonly target?;
    private readonly policyHash?;
    private readonly targetHash?;
    constructor(options: Options, config?: FixedNotificationConfig);
    get enabled(): boolean;
    private path;
    private binding;
    private sameBinding;
    private policy;
    private attempt;
    private receipt;
    private confirmation;
    private optional;
    private legacy;
    private journal;
    private result;
    private observed;
    /** Inspect private evidence only; changing settings never erases old receipts. */
    status(record: TaskRecord): Promise<NotificationStatus>;
    /** Bind only the newly prepared record; old/deduplicated tasks are never adopted. */
    bind(record: TaskRecord & {
        duplicate?: boolean;
    }): Promise<NotificationStatus>;
    private syncDir;
    private exclusive;
    /** One optional notification after positive local submission; never resend. */
    notify(result: ArtifactResult, dispatch: Dispatch, signal?: AbortSignal): Promise<NotificationStatus>;
}
export {};
