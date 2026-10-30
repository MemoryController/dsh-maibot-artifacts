import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { ArtifactService } from '../dist/core.js'

const BASELINE = 'ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8'

/** Default manifest confirmation against the actual original peer, no request.py extension. */
async function main() {
  const peer = process.argv[2] && resolve(process.argv[2])
  const expected = process.argv[3]
  assert(peer && expected, 'Usage: node scripts/test-legacy-peer.mjs <peer-checkout> <baseline-commit-sha>')
  assert.equal(expected, BASELINE, 'Legacy compatibility verifier requires the exact reviewed original peer baseline')
  assert.equal(execFileSync('git', ['-C', peer, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' }).trim(), expected)
  const peerStatus = () => execFileSync('git', ['--no-optional-locks', '-C', peer, 'status', '--porcelain'], { encoding: 'utf8' })
  const originalPeerStatus = peerStatus()
  const peerSources = {}
  for (const name of ['handoff.py', 'safe_files.py']) {
    const bytes = await readFile(join(peer, name))
    assert.deepEqual(bytes, execFileSync('git', ['-C', peer, 'show', `${expected}:${name}`]), `${name} must contain the actual baseline bytes`)
    peerSources[name] = createHash('sha256').update(bytes).digest('hex')
  }
  const temp = await mkdtemp(join(tmpdir(), 'dsh-legacy-peer-'))
  try {
    const workspaceRoot = join(temp, 'shared')
    await mkdir(join(workspaceRoot, 'outbox'), { recursive: true })
    // Deliberately omit confirmationMode: this test exercises the shipped default.
    const config = { workspaceRoot, stateDir: join(temp, 'dsh-state') }
    const service = new ArtifactService(config)
    assert.equal(service.config.confirmationMode, 'manifest')
    const files = [
      ['报告 原版.txt', Buffer.from('默认 manifest 交接，兼容原版 MaiBot 插件。\n')],
      ['像素.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')],
      ['empty.bin', Buffer.alloc(0)],
    ]
    const paths = []
    for (const [name, bytes] of files) {
      const relative = `outbox/${name}`
      await writeFile(join(workspaceRoot, relative), bytes)
      paths.push(relative)
    }
    const owner = 'actual-default-manifest-agent'
    const prepared = await service.prepare(paths, owner)
    const submitted = await service.publish(prepared.manifest.task_id, owner)
    assert.equal(submitted.result, 'submitted')
    assert.equal(submitted.state, 'prepared')
    assert.equal(submitted.notification, undefined)
    assert.equal(submitted.maibot_registration, 'unconfirmed')
    assert.deepEqual(submitted.confirmation, { tool: 'dsh_import_handoff', arguments: { manifest: prepared.manifest, send: false } })
    const confirmation = join(temp, 'manifest-confirmation.json')
    await writeFile(confirmation, JSON.stringify(submitted.confirmation), { mode: 0o600 })
    const result = spawnSync('python3', ['-B', fileURLToPath(new URL('../test/fixtures/legacy-import.py', import.meta.url)), peer, workspaceRoot, confirmation], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error) throw result.error
    if (result.status !== 0) { process.exitCode = result.status ?? 1; return }
    const report = JSON.parse(result.stdout)
    assert.equal(report.passed, 4)
    assert.equal(report.failed, 0)
    assert.equal(report.real_host_network_qq, false)
    assert.equal(report.simulated_uploads, files.length)
    assert.equal(report.simulated_sends, 0)
    const restarted = new ArtifactService(config)
    const status = await restarted.localStatus(prepared.manifest.task_id, owner)
    assert.equal(status.state, 'prepared')
    assert.equal(status.notification, undefined)
    assert.equal('file_ref' in status, false)
    assert.deepEqual((await restarted.publish(prepared.manifest.task_id, owner)).confirmation, submitted.confirmation)
    assert.equal(peerStatus(), originalPeerStatus, 'Verifier must not modify the original peer checkout')
    console.log(JSON.stringify({
      producer: 'actual built DSH default manifest confirmation', consumer: 'actual baseline Handoff.import_manifest',
      peer_commit: expected, peer_source_sha256: peerSources, peer_checks: report.passed,
      real_host_network_qq: false, result: 'passed with simulated scoped Files API; no real Host/ACP/QQ claim',
    }, null, 2))
  } finally { await rm(temp, { recursive: true, force: true }) }
}

await main()
