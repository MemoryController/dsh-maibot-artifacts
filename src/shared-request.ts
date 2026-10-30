import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { link, mkdir, open, unlink, type FileHandle } from 'node:fs/promises'
import { errorCode } from './config.js'
import { SafetyError, validateRelativePath } from './safe-files.js'
import type { Manifest } from './core.js'

const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const MAX_BYTES = 64 * 1024
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export interface SharedRequest { path: string; sha256: string; submittedAt: string }
export type SharedRequestInspection =
  | { kind: 'matching'; request: SharedRequest }
  | { kind: 'missing' | 'conflict' | 'unreadable'; code: string }

/** The phase describes this invocation; it never proves peer acceptance. */
export class SharedRequestPublishError extends SafetyError {
  declare readonly cause?: unknown
  constructor(code: string, readonly publication: 'not_published' | 'unknown', cause?: unknown) {
    super(code, 'Shared request publication could not be confirmed')
    this.name = 'SharedRequestPublishError'
    // Preserve a diagnostic cause without exposing path-bearing native errors in
    // enumerable fields or a public message. Tool results return only the code.
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause, enumerable: false })
  }
}

function child(parent: FileHandle, name: string) { return `/proc/self/fd/${parent.fd}/${name}` }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: object, keys: string[]) {
  return Object.keys(value).sort().join(',') === keys.sort().join(',')
}

/** Validate the complete protocol shape before trusting an on-disk record. */
export function validateManifest(manifest: unknown): asserts manifest is Manifest {
  if (!object(manifest) || !exact(manifest, ['type', 'version', 'task_id', 'files'])
    || manifest.type !== 'dsh_artifacts' || manifest.version !== 1 || typeof manifest.task_id !== 'string' || !/^[0-9a-f]{32}$/u.test(manifest.task_id)
    || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 32) throw new SafetyError('invalid_manifest', 'Expected strict manifest v1')
  const paths = new Set<string>()
  for (const file of manifest.files) {
    if (!object(file) || !exact(file, ['path', 'size', 'sha256']) || typeof file.size !== 'number' || !Number.isSafeInteger(file.size)
      || file.size < 0 || file.size > 1024 ** 3 || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(file.sha256)) throw new SafetyError('invalid_manifest', 'Invalid manifest file metadata')
    if (typeof file.path !== 'string') throw new SafetyError('invalid_manifest', 'Expected an outbox file path')
    validateRelativePath(file.path)
    if (paths.has(file.path)) throw new SafetyError('invalid_manifest', 'Duplicate file paths')
    paths.add(file.path)
  }
}

function validateRoot(root: string) {
  if (process.platform !== 'linux' || typeof root !== 'string' || !root.startsWith('/') || root === '/' || /[\u0000-\u001f\u007f\\\ud800-\udfff]/u.test(root)
    || root.slice(1).split('/').some(part => !part || part === '.' || part === '..')) throw new SafetyError('invalid_root', 'Expected canonical Linux workspace')
}
function requestBytes(manifest: unknown): Buffer {
  validateManifest(manifest)
  const bytes = Buffer.from(JSON.stringify(manifest))
  if (bytes.byteLength > MAX_BYTES) throw new SafetyError('manifest_too_large', 'Request exceeds 64 KiB')
  return bytes
}
function request(manifest: Manifest, bytes: Buffer): SharedRequest {
  return { path: `outbox/.dsh-handoffs/${manifest.task_id}.json`, sha256: sha(bytes), submittedAt: new Date().toISOString() }
}
function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && before.nlink === after.nlink
}
function safeDirectory(info: BigIntStats | { uid: number; mode: number }) {
  if (BigInt(info.uid) !== BigInt(process.getuid?.() ?? -1) || (BigInt(info.mode) & 0o027n) !== 0n) {
    throw new SafetyError('unsafe_request_directory', 'Request directory must be owned by DSH, at most 0750')
  }
}

/** Check bounded bytes and the final directory entry, with every handle pinned. */
async function checkExisting(directory: FileHandle, name: string, bytes: Buffer): Promise<void> {
  const final = child(directory, name)
  const existing = await open(final, READ)
  try {
    const before = await existing.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_BYTES)) throw new SafetyError('unsafe_file', 'Invalid existing request')
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await existing.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await existing.stat({ bigint: true })
    if (length > MAX_BYTES || BigInt(length) !== before.size || !sameFile(before, after) || !bytes.equals(buffer.subarray(0, length))) {
      throw new SafetyError('request_conflict', 'Existing request differs; never overwrite or allocate a replacement task')
    }
    const named = await open(final, READ)
    try {
      const now = await named.stat({ bigint: true })
      if (!now.isFile() || !sameFile(after, now)) throw new SafetyError('request_conflict', 'Request pathname changed while being checked')
    } finally { await named.close() }
  } finally { await existing.close() }
}

/**
 * Observe an existing request without creating, repairing or persisting anything.
 * A matching observation proves current bytes only, not an earlier fsync, peer
 * acceptance, import, delivery or ownership by any original MaiBot chat.
 */
export async function inspectSharedRequest(root: string, manifest: Manifest): Promise<SharedRequestInspection> {
  const handles: FileHandle[] = []
  const directories: { parent: FileHandle; name: string; pinned: BigIntStats }[] = []
  try {
    validateRoot(root)
    const bytes = requestBytes(manifest)
    let directory = await open('/', DIR)
    handles.push(directory)
    for (const name of [...root.slice(1).split('/'), 'outbox', '.dsh-handoffs']) {
      const parent = directory
      directory = await open(child(parent, name), DIR)
      handles.push(directory)
      directories.push({ parent, name, pinned: await directory.stat({ bigint: true }) })
    }
    safeDirectory(await directory.stat({ bigint: true }))
    await checkExisting(directory, `${manifest.task_id}.json`, bytes)
    for (const directory of directories) {
      const named = await open(child(directory.parent, directory.name), DIR)
      try {
        const now = await named.stat({ bigint: true })
        if (now.dev !== directory.pinned.dev || now.ino !== directory.pinned.ino) {
          throw new SafetyError('request_conflict', 'Request directory changed while being checked')
        }
      } finally { await named.close() }
    }
    return { kind: 'matching', request: request(manifest, bytes) }
  } catch (error) {
    const code = errorCode(error)
    if (code === 'not_found') return { kind: 'missing', code }
    if (code === 'request_conflict') return { kind: 'conflict', code }
    return { kind: 'unreadable', code }
  } finally {
    await Promise.allSettled(handles.reverse().map(handle => handle.close()))
  }
}

/** Publish only strict manifest bytes; a request grants no chat identity or permission. */
export async function publishSharedRequest(root: string, manifest: Manifest): Promise<SharedRequest> {
  let linkAttempted = false
  const handles: FileHandle[] = []
  let temporary: string | undefined
  try {
    validateRoot(root)
    const bytes = requestBytes(manifest)
    let directory = await open('/', DIR)
    handles.push(directory)
    for (const name of [...root.slice(1).split('/'), 'outbox']) {
      directory = await open(child(directory, name), DIR)
      handles.push(directory)
    }
    const requestDir = child(directory, '.dsh-handoffs')
    let created = false
    try { await mkdir(requestDir, { mode: 0o750 }); created = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if (created) await directory.sync() // Persist outbox's new child entry before claiming submission.
    directory = await open(requestDir, DIR)
    handles.push(directory)
    if (created) await directory.chmod(((await directory.stat()).mode & 0o2000) | 0o750)
    safeDirectory(await directory.stat())
    const final = child(directory, `${manifest.task_id}.json`)
    temporary = child(directory, `.${manifest.task_id}.${randomUUID()}.tmp`)
    const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640)
    try {
      // Shared request metadata is intentionally group-readable, never group-writable.
      await output.chmod(0o640)
      await output.writeFile(bytes)
      await output.sync()
    } finally { await output.close() }
    linkAttempted = true
    try { await link(temporary, final) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await checkExisting(directory, `${manifest.task_id}.json`, bytes)
    }
    await unlink(temporary)
    temporary = undefined
    await directory.sync()
    return request(manifest, bytes)
  } catch (error) {
    throw new SharedRequestPublishError(errorCode(error), linkAttempted ? 'unknown' : 'not_published', error)
  } finally {
    if (temporary) await unlink(temporary).catch(() => {})
    await Promise.allSettled(handles.reverse().map(handle => handle.close()))
  }
}
