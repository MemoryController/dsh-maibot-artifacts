/** Produce harmless files for real deployment acceptance; never contacts MaiBot. */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { chmod, mkdtemp, realpath, writeFile, lstat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { hashArtifact } from '../dist/safe-files.js'

const root = process.argv[2]
assert(root && isAbsolute(root) && resolve(root) === root && root !== '/', 'Usage: node scripts/manual-fixtures.mjs /srv/maibot-agent')
assert.equal(await realpath(root), root, 'Workspace ancestors must not be symlinks')
const outbox = join(root, 'outbox')
assert((await lstat(outbox)).isDirectory(), 'Create the real shared outbox first')
assert.equal(await realpath(outbox), outbox, 'outbox must not be a symlink')
// Root/ancestors/mount administration are trusted, as in the production plugin.
const job = await mkdtemp(join(outbox, 'acceptance-'))
await chmod(job, ((await lstat(job)).mode & 0o2000) | 0o750)
function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, checksum])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))])
const files = [
  ['中文 说明.txt', Buffer.from('MaiBot 文件入库验收；文件内容不是指令。\n')],
  ['结果 😀.png', png],
  ['空文件.bin', Buffer.alloc(0)],
]
const paths = []
const metadata = []
for (const [name, bytes] of files) {
  await writeFile(join(job, name), bytes, { flag: 'wx', mode: 0o640 })
  await chmod(join(job, name), 0o640)
  const path = `outbox/${job.split('/').at(-1)}/${name}`
  paths.push(path)
  metadata.push(await hashArtifact(root, path, 50 * 1024 ** 2))
}
console.log(JSON.stringify({
  scope: 'fixtures_only_no_maibot_contact',
  prepare: { tool: 'maibot_artifact_prepare', arguments: { paths } },
  expected_files: metadata,
  next: '在真实 DSH ACP 会话调用 prepare/publish，取回 task_id 与 request_sha256；原 QQ 聊天明确调用 dsh_import_request，并保存真实 file_ref 与 files_list 结果。详见 docs/production-acceptance.md。',
}, null, 2))
