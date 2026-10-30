import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
export class SafetyError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SafetyError';
    }
}
const CONTROL = /[\u0000-\u001f\u007f\\]/u;
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CHUNK = 256 * 1024;
/** Same path grammar as maibot-dsh-artifacts v0.2.0, safe_files._parts. */
export function validateRelativePath(path) {
    if (typeof path !== 'string' || !path || Array.from(path).length > 4096 ||
        path.startsWith('/') || CONTROL.test(path)) {
        throw new SafetyError('invalid_path', 'Expected a relative outbox file path');
    }
    const parts = path.split('/');
    if (parts.length < 2 || parts.length > 32 || parts[0] !== 'outbox' ||
        parts.some(part => !part || part === '.' || part === '..')) {
        throw new SafetyError('invalid_path', 'Expected outbox/ without dot or empty segments');
    }
    const name = parts.at(-1);
    if (name !== name.trim() || Array.from(name).length > 255) {
        throw new SafetyError('invalid_name', 'Invalid final filename');
    }
}
function rootParts(root) {
    if (typeof root !== 'string' || !root.startsWith('/') || root === '/' || CONTROL.test(root)) {
        throw new SafetyError('invalid_root', 'Workspace must be a non-root absolute path');
    }
    const parts = root.slice(1).split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) {
        throw new SafetyError('invalid_root', 'Workspace must not have dot or empty segments');
    }
    return parts;
}
function child(parent, name) {
    // Only validated single components enter this path. The fd is held open until
    // all work finishes; O_NOFOLLOW applies to the actual child, not the fd link.
    return `/proc/self/fd/${parent.fd}/${name}`;
}
function regular(info) {
    if (!info.isFile() || info.nlink !== 1n) {
        throw new SafetyError('unsafe_file', 'Only ordinary files with one hard link are accepted');
    }
}
function sameFile(a, b) {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
        a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}
function changed() {
    throw new SafetyError('source_changed', 'Source changed during hashing; finish writing before preparing');
}
/**
 * Hash bounded bytes through descriptor-anchored Linux traversal. No pathname
 * supplied by the caller is passed to a shell or reopened through an absolute
 * unchecked ancestor. This is a checked read, not an immutable filesystem snapshot.
 */
export async function hashArtifact(root, relative, maxBytes) {
    if (process.platform !== 'linux') {
        throw new SafetyError('unsupported_platform', 'Descriptor-anchored access requires Linux /proc');
    }
    validateRelativePath(relative);
    const ancestors = rootParts(root);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new SafetyError('invalid_limit', 'File limit must be a positive safe integer');
    }
    const handles = [];
    const directories = [];
    try {
        let parent = await open('/', DIR);
        handles.push(parent);
        const parts = relative.split('/');
        for (const name of [...ancestors, ...parts.slice(0, -1)]) {
            const next = await open(child(parent, name), DIR);
            handles.push(next);
            directories.push({ parent, name, pinned: await next.stat({ bigint: true }) });
            parent = next;
        }
        const leaf = parts.at(-1);
        const file = await open(child(parent, leaf), READ);
        handles.push(file);
        const before = await file.stat({ bigint: true });
        regular(before);
        if (before.size > BigInt(maxBytes)) {
            throw new SafetyError('too_large', 'File exceeds configured size limit');
        }
        const buffer = Buffer.allocUnsafe(CHUNK);
        const hash = createHash('sha256');
        let size = 0;
        for (;;) {
            const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK, maxBytes - size + 1), null);
            if (!bytesRead)
                break;
            size += bytesRead;
            if (size > maxBytes)
                throw new SafetyError('too_large', 'File exceeds configured size limit');
            hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await file.stat({ bigint: true });
        regular(after);
        if (BigInt(size) !== before.size || !sameFile(before, after))
            changed();
        // Confirm that every parent-child relationship still names the descriptor
        // pinned at traversal time, and the final filename still names these bytes.
        for (const directory of directories) {
            const check = await open(child(directory.parent, directory.name), DIR);
            try {
                const now = await check.stat({ bigint: true });
                if (now.dev !== directory.pinned.dev || now.ino !== directory.pinned.ino)
                    changed();
            }
            finally {
                await check.close();
            }
        }
        const check = await open(child(parent, leaf), READ);
        try {
            const now = await check.stat({ bigint: true });
            regular(now);
            if (!sameFile(after, now))
                changed();
        }
        finally {
            await check.close();
        }
        return { path: relative, size, sha256: hash.digest('hex') };
    }
    finally {
        // Closing all pinned ancestors prevents fd leaks even when a later open fails.
        await Promise.allSettled(handles.reverse().map(handle => handle.close()));
    }
}
