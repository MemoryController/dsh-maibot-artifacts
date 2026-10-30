import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { SafetyError } from './safe-files.js'
import { validateManifest, type SharedRequest } from './shared-request.js'
import type { TaskRecord } from './core.js'

export interface SubmissionIntent {
  version: 1
  record: TaskRecord
  requestSha256: string
  startedAt: string
}
export interface SubmissionComplete {
  version: 1
  owner: string
  task_id: string
  request: SharedRequest
}
export const manifestDigest = (record: TaskRecord) => createHash('sha256').update(JSON.stringify(record.manifest)).digest('hex')
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: object, keys: string[]) { return Object.keys(value).sort().join(',') === [...keys].sort().join(',') }
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function invalid(): never { throw new SafetyError('invalid_local_record', 'Private task evidence is invalid; do not recreate the task') }

/** Bounded, no-follow reads of OS-private, single-link JSON evidence. */
export async function readPrivateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid?.() ?? -1)
      || (before.mode & 0o777n) !== 0o600n || before.size > 128n * 1024n) invalid()
    const bytes = Buffer.alloc(128 * 1024 + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await file.stat({ bigint: true })
    if (BigInt(length) !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) invalid()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    const value: unknown = JSON.parse(text)
    // Our writers emit compact JSON. This also rejects duplicate keys and
    // noncanonical edits instead of silently accepting an ambiguous journal.
    if (JSON.stringify(value) !== text) invalid()
    return value
  } finally { await file.close() }
}
export function validateRecord(value: unknown, id: string, ownerHash: string): TaskRecord {
  if (!object(value)) invalid()
  if (typeof value.owner !== 'string' || !/^[0-9a-f]{64}$/.test(value.owner)) invalid()
  if (value.owner !== ownerHash) throw new SafetyError('task_not_found_in_scope', 'Task is not in this Agent scope')
  validateManifest(value.manifest)
  if (value.manifest.task_id !== id || !timestamp(value.createdAt) || typeof value.state !== 'string' || !['prepared', 'queued', 'unknown'].includes(value.state)) invalid()
  if (value.originHash !== undefined && (typeof value.originHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.originHash))) invalid()
  for (const key of ['error', 'historical_error']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 512)) invalid()
  }
  if (value.notification !== undefined) {
    const note = value.notification
    if (!object(note) || !exact(note, ['kind', 'code', 'at', 'toolName', 'targetHash'])
      || typeof note.kind !== 'string' || !['queued', 'not_dispatched', 'unknown'].includes(note.kind) || !timestamp(note.at)
      || typeof note.code !== 'string' || note.code.length > 512 || typeof note.toolName !== 'string'
      || !/^mcp__[A-Za-z0-9_-]+__agent_talk$/.test(note.toolName) || typeof note.targetHash !== 'string' || !/^[0-9a-f]{64}$/.test(note.targetHash)
      || value.state !== (note.kind === 'queued' ? 'queued' : note.kind === 'not_dispatched' ? 'prepared' : 'unknown')) invalid()
  }
  if (value.submission !== undefined) {
    const request = value.submission
    // A valid v0.2.0 primary submission was written only after the writer
    // returned success. Preserve that private completion evidence on upgrade,
    // but never accept a malformed or unrelated object as a successful request.
    if (!object(request) || !exact(request, ['path', 'sha256', 'submittedAt']) || !timestamp(request.submittedAt)
      || request.path !== `outbox/.dsh-handoffs/${id}.json` || request.sha256 !== manifestDigest(value as unknown as TaskRecord)
      || value.state !== 'prepared' || value.notification !== undefined || value.originHash !== undefined) invalid()
  }
  return value as unknown as TaskRecord
}
export function validateIntent(value: unknown, id: string, ownerHash: string): SubmissionIntent {
  if (!object(value) || !exact(value, ['version', 'record', 'requestSha256', 'startedAt']) || value.version !== 1 || !timestamp(value.startedAt)) invalid()
  const record = validateRecord(value.record, id, ownerHash)
  if (!exact(record, ['manifest', 'owner', 'state', 'createdAt']) || record.state !== 'prepared'
    || Buffer.byteLength(JSON.stringify(record.manifest)) > 64 * 1024 || value.requestSha256 !== manifestDigest(record)) invalid()
  return value as unknown as SubmissionIntent
}
export function validateComplete(value: unknown, intent: SubmissionIntent): SubmissionComplete {
  if (!object(value) || !exact(value, ['version', 'owner', 'task_id', 'request']) || value.version !== 1
    || value.owner !== intent.record.owner || value.task_id !== intent.record.manifest.task_id || !object(value.request)
    || !exact(value.request, ['path', 'sha256', 'submittedAt']) || !timestamp(value.request.submittedAt)
    || value.request.path !== `outbox/.dsh-handoffs/${value.task_id}.json` || value.request.sha256 !== intent.requestSha256) invalid()
  return value as unknown as SubmissionComplete
}
