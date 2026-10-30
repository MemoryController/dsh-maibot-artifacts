import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { SafetyError, validateRelativePath } from './safe-files.js';
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_BYTES = 64 * 1024;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function child(parent, name) { return `/proc/self/fd/${parent.fd}/${name}`; }
function validate(manifest) {
    const exact = (value, keys) => Object.keys(value).sort().join(',') === keys.sort().join(',');
    if (!manifest || typeof manifest !== 'object' || !exact(manifest, ['type', 'version', 'task_id', 'files'])
        || manifest.type !== 'dsh_artifacts' || manifest.version !== 1 || typeof manifest.task_id !== 'string' || !/^[0-9a-f]{32}$/u.test(manifest.task_id)
        || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 32)
        throw new SafetyError('invalid_manifest', 'Expected strict manifest v1');
    const paths = new Set();
    for (const file of manifest.files) {
        if (!file || typeof file !== 'object' || !exact(file, ['path', 'size', 'sha256']) || !Number.isSafeInteger(file.size)
            || file.size < 0 || file.size > 1024 ** 3 || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(file.sha256))
            throw new SafetyError('invalid_manifest', 'Invalid manifest file metadata');
        validateRelativePath(file.path);
        if (paths.has(file.path))
            throw new SafetyError('invalid_manifest', 'Duplicate file paths');
        paths.add(file.path);
    }
}
/** Publish only strict manifest bytes; a request grants no chat identity or permission. */
export async function publishSharedRequest(root, manifest) {
    if (process.platform !== 'linux' || !root.startsWith('/') || root === '/' || /[\u0000-\u001f\u007f\\\ud800-\udfff]/u.test(root)
        || root.slice(1).split('/').some(part => !part || part === '.' || part === '..'))
        throw new SafetyError('invalid_root', 'Expected canonical Linux workspace');
    validate(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.byteLength > MAX_BYTES)
        throw new SafetyError('manifest_too_large', 'Request exceeds 64 KiB');
    const handles = [];
    let temporary;
    try {
        let directory = await open('/', DIR);
        handles.push(directory);
        for (const name of [...root.slice(1).split('/'), 'outbox']) {
            directory = await open(child(directory, name), DIR);
            handles.push(directory);
        }
        const requestDir = child(directory, '.dsh-handoffs');
        let created = false;
        try {
            await mkdir(requestDir, { mode: 0o750 });
            created = true;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        if (created)
            await directory.sync(); // Persist outbox's new child entry before claiming submission.
        directory = await open(requestDir, DIR);
        handles.push(directory);
        if (created)
            await directory.chmod(((await directory.stat()).mode & 0o2000) | 0o750);
        const info = await directory.stat();
        if (info.uid !== process.getuid?.() || (info.mode & 0o027) !== 0)
            throw new SafetyError('unsafe_request_directory', 'Request directory must be owned by DSH, at most 0750');
        const final = child(directory, `${manifest.task_id}.json`);
        temporary = child(directory, `.${manifest.task_id}.${randomUUID()}.tmp`);
        const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
        try {
            // Shared request metadata is intentionally group-readable, never group-writable.
            await output.chmod(0o640);
            await output.writeFile(bytes);
            await output.sync();
        }
        finally {
            await output.close();
        }
        try {
            await link(temporary, final);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const existing = await open(final, READ);
            try {
                const before = await existing.stat({ bigint: true });
                if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_BYTES))
                    throw new SafetyError('unsafe_file', 'Invalid existing request');
                const buffer = Buffer.alloc(MAX_BYTES + 1);
                let length = 0;
                while (length < buffer.length) {
                    const { bytesRead } = await existing.read(buffer, length, buffer.length - length, null);
                    if (!bytesRead)
                        break;
                    length += bytesRead;
                }
                const value = buffer.subarray(0, length);
                const after = await existing.stat({ bigint: true });
                if (value.byteLength > MAX_BYTES || before.size !== after.size || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
                    || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n || !bytes.equals(value))
                    throw new SafetyError('request_conflict', 'Existing request differs; never overwrite or allocate a replacement task');
            }
            finally {
                await existing.close();
            }
        }
        await unlink(temporary);
        temporary = undefined;
        await directory.sync();
        return { path: `outbox/.dsh-handoffs/${manifest.task_id}.json`, sha256: sha(bytes), submittedAt: new Date().toISOString() };
    }
    finally {
        if (temporary)
            await unlink(temporary).catch(() => { });
        await Promise.allSettled(handles.reverse().map(handle => handle.close()));
    }
}
