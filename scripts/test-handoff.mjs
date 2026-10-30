import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { ArtifactService } from '../dist/core.js'

/** Real built DSH producer + real pinned Python consumer, simulated scoped Files API. */
async function main() {
  const peer = process.argv[2] && resolve(process.argv[2])
  const expected = process.argv[3]
  assert(peer && expected && /^[0-9a-f]{40}$/u.test(expected), 'Usage: node scripts/test-handoff.mjs <peer-checkout> <exact-peer-commit-sha>')
  const actual = execFileSync('git', ['-C', peer, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' }).trim()
  assert.equal(actual, expected, 'Peer checkout HEAD must equal the explicit reviewed commit')
  const sourceHashes = {}
  for (const name of ['handoff.py', 'request.py', 'safe_files.py']) {
    sourceHashes[name] = createHash('sha256').update(await readFile(join(peer, name))).digest('hex')
  }
  const temp = await mkdtemp(join(tmpdir(), 'dsh-peer-integration-'))
  try {
    const workspaceRoot = join(temp, 'shared')
    await mkdir(join(workspaceRoot, 'outbox'), { recursive: true })
    const config = { workspaceRoot, stateDir: join(temp, 'dsh-state'), confirmationMode: 'request' }
    const service = new ArtifactService(config)
    const owner = 'actual-isolated-dsh-agent'
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
    const inputs = {
      main: [
        ['报告 最终版.txt', Buffer.from('中文与 spaces，原始文件字节。\n')],
        ['像素🧪.png', png],
        ['empty.bin', Buffer.alloc(0)],
        ['binary.bin', Buffer.from([0, 255, 128, 0, 1, 200, 13, 10])],
      ],
      no_scope: [['scope.txt', Buffer.from('Host must supply current scope')]],
      wrong_sha: [['hash.txt', Buffer.from('exact request bytes')]],
      tamper: [['tamper.bin', Buffer.from('original artifact')]],
      file_limit: [['larger-than-peer-limit.bin', Buffer.from('too large for one-byte configured limit')]],
      batch_limit: [['one.txt', Buffer.from('one')], ['two.txt', Buffer.from('two')]],
      unknown_upload: [['uncertain.bin', Buffer.from('remote may already contain this artifact')]],
    }
    const cases = {}
    for (const [name, files] of Object.entries(inputs)) {
      const paths = []
      await mkdir(join(workspaceRoot, 'outbox', name))
      for (const [filename, bytes] of files) {
        const relative = `outbox/${name}/${filename}`
        await writeFile(join(workspaceRoot, relative), bytes)
        paths.push(relative)
      }
      const prepared = await service.prepare(paths, owner)
      assert.equal(prepared.state, 'prepared')
      const submitted = await service.publish(prepared.manifest.task_id, owner)
      assert.equal(submitted.result, 'submitted')
      assert.equal(submitted.state, 'prepared')
      assert.equal(submitted.notification, undefined)
      assert.equal(submitted.maibot_registration, 'unconfirmed')
      assert.equal(submitted.confirmation.tool, 'dsh_import_request')
      assert.deepEqual(JSON.parse(await readFile(join(workspaceRoot, submitted.shared_request.path), 'utf8')), prepared.manifest)
      cases[name] = { confirmation: submitted.confirmation, manifest: prepared.manifest, shared_request: submitted.shared_request }
    }
    const confirmations = join(temp, 'confirmations.json')
    await writeFile(confirmations, JSON.stringify({ version: 1, cases }), { mode: 0o600 })
    const fixture = fileURLToPath(new URL('../test/fixtures/peer-import.py', import.meta.url))
    const result = spawnSync('python3', [fixture, peer, workspaceRoot, confirmations], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error) throw result.error
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1
      return
    }
    const peerReport = JSON.parse(result.stdout)
    assert.equal(peerReport.real_host_network_qq, false)
    assert.equal(peerReport.files_api, 'simulated scoped official-signature API')
    assert.equal(peerReport.failed, 0)
    // Python receiving real peer file_ref values does not confer evidence on the
    // DSH producer's local status. No result is silently upgraded to imported.
    const restarted = new ArtifactService(config)
    for (const [name, item] of Object.entries(cases)) {
      const status = await restarted.localStatus(item.manifest.task_id, owner)
      assert.equal(status.state, 'prepared', `${name}: peer evidence must not mutate DSH state`)
      assert.equal(status.notification, undefined)
      assert.deepEqual(status.submission, item.shared_request)
      assert.equal('file_ref' in status, false)
      assert.equal('imported' in status, false)
    }
    const duplicate = await restarted.prepare(cases.main.manifest.files.map(file => file.path), owner)
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.manifest.task_id, cases.main.manifest.task_id)
    assert.equal((await restarted.publish(duplicate.manifest.task_id, owner)).result, 'submitted')
    console.log(JSON.stringify({
      producer: 'actual built TypeScript ArtifactService', consumer: 'actual pinned peer request.import_request + Handoff',
      peer_commit: actual, peer_source_sha256: sourceHashes,
      dsh_submitted_tasks: Object.keys(cases).length, dsh_status_checks: Object.keys(cases).length,
      peer_checks: peerReport.passed, real_host_network_qq: false,
      result: 'passed; Files API is simulated, no real Host/ACP/network/QQ integration claimed',
    }, null, 2))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

await main()
