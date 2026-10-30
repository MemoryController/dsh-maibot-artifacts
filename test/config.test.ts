import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { errorCode, resolveConfig } from '../src/config.js'
import { ArtifactService } from '../src/core.js'
import { SafetyError } from '../src/safe-files.js'
import { Config } from '../src/index.js'

test('state default uses canonical absolute XDG_STATE_HOME and needs no shell expansion', () => {
  const config = resolveConfig({ workspaceRoot: '/srv/maibot-agent' }, {
    stateHome: '/home/普通用户/状态/../state/', home: '/unused-home',
  })
  assert.equal(config.stateDir, '/home/普通用户/state/dsh-maibot-artifacts')
})

test('unset, empty and relative XDG_STATE_HOME fall back to the actual user home', () => {
  for (const stateHome of [undefined, '', 'relative-state', '~/state', '$HOME/state']) {
    const config = resolveConfig({ workspaceRoot: '/srv/maibot-agent' }, {
      stateHome, home: '/home/普通用户 with spaces',
    })
    assert.equal(config.stateDir, '/home/普通用户 with spaces/.local/state/dsh-maibot-artifacts')
  }
  assert.throws(() => resolveConfig({ workspaceRoot: '/srv/shared' }, { stateHome: undefined, home: 'relative-home' }), /absolute path/u)
  assert.equal(Config({ workspaceRoot: '/srv/shared' }).stateDir, undefined)
  assert.equal(new ArtifactService({ workspaceRoot: '/srv/shared' }).config.stateDir,
    resolveConfig({ workspaceRoot: '/srv/shared' }).stateDir)
})

test('explicit stateDir wins and its existing strict validation is preserved', () => {
  const homes = { stateHome: '/unused-state', home: '/unused-home' }
  assert.equal(resolveConfig({ workspaceRoot: '/workspace/shared', stateDir: '/private/state' }, homes).stateDir, '/private/state')
  for (const stateDir of ['', 'relative', '/tmp/private/../state', '/tmp/state/']) {
    const config = resolveConfig({ workspaceRoot: '/workspace/shared', stateDir }, homes)
    assert.equal(config.stateDir, stateDir)
    assert.throws(() => new ArtifactService(config), /invalid_root/u)
  }
  assert.throws(() => new ArtifactService({ workspaceRoot: '/workspace/shared', stateDir: '/workspace/shared/state' }), /state_must_be_outside_workspace/u)
})

test('ordinary-user default directory is created privately and retains state across restart', async t => {
  const base = await mkdtemp(join(tmpdir(), 'artifact-config-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspaceRoot = join(base, 'shared')
  await mkdir(join(workspaceRoot, 'outbox'), { recursive: true })
  await writeFile(join(workspaceRoot, 'outbox/result'), 'data')
  const config = resolveConfig({ workspaceRoot }, { stateHome: undefined, home: join(base, 'home') })
  const first = await new ArtifactService(config).prepare(['outbox/result'], 'real-agent')
  const info = await lstat(config.stateDir)
  assert.equal(info.mode & 0o777, 0o700)
  assert.equal(info.uid, process.getuid?.())
  assert.equal((await new ArtifactService(config).localStatus(first.manifest.task_id, 'real-agent')).state, 'prepared')
})

test('default-state safety rejects pre-existing broad permissions and symlinks without chmod', async t => {
  const base = await mkdtemp(join(tmpdir(), 'artifact-config-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspaceRoot = join(base, 'shared')
  await mkdir(join(workspaceRoot, 'outbox'), { recursive: true })
  await writeFile(join(workspaceRoot, 'outbox/result'), 'data')
  const config = resolveConfig({ workspaceRoot }, { stateHome: join(base, 'state'), home: '/unused' })
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
  await chmod(config.stateDir, 0o755)
  await assert.rejects(new ArtifactService(config).prepare(['outbox/result'], 'real-agent'), /unsafe_state_permissions/u)
  assert.equal((await lstat(config.stateDir)).mode & 0o777, 0o755)
  await rm(config.stateDir, { recursive: true })
  const elsewhere = join(base, 'elsewhere')
  await mkdir(elsewhere, { mode: 0o700 })
  await symlink(elsewhere, config.stateDir)
  await assert.rejects(new ArtifactService(config).prepare(['outbox/result'], 'real-agent'), /unsafe_state_directory/u)
  assert.equal((await lstat(config.stateDir)).isSymbolicLink(), true)
})

test('errno mapping is stable, preserves safety errors and omits diagnostic path text', () => {
  const expected = {
    ENOENT: 'not_found', ELOOP: 'unsafe_file', ENOTDIR: 'unsafe_file', EISDIR: 'unsafe_file',
    EACCES: 'permission_denied', EPERM: 'permission_denied', ENAMETOOLONG: 'invalid_path', EINVAL: 'invalid_path',
  }
  for (const [code, result] of Object.entries(expected)) {
    assert.equal(errorCode(Object.assign(new Error('private path and sensitive diagnostics'), { code })), result)
  }
  assert.equal(errorCode(new SafetyError('source_changed', 'private filename')), 'source_changed')
  for (const error of [undefined, null, 'raw failure', new Error('sensitive text'), { code: 'EIO' }]) {
    assert.equal(errorCode(error), 'local_io_failed')
  }
})
