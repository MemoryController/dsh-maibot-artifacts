export declare class SafetyError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Same path grammar as maibot-dsh-artifacts v0.2.0, safe_files._parts. */
export declare function validateRelativePath(path: string): void;
/**
 * Hash bounded bytes through descriptor-anchored Linux traversal. No pathname
 * supplied by the caller is passed to a shell or reopened through an absolute
 * unchecked ancestor. This is a checked read, not an immutable filesystem snapshot.
 */
export declare function hashArtifact(root: string, relative: string, maxBytes: number): Promise<{
    path: string;
    size: number;
    sha256: string;
}>;
