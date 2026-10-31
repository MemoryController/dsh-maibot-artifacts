import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const temporary = await mkdtemp(join(tmpdir(), 'artifact-version-'))
const option = name => {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return value
}
try {
  const prefix = option('--host-prefix')
  const host = prefix ? resolve(prefix, 'node_modules') : resolve('node_modules')
  const cli = join(host, '@deepseek-ai/dsh/lib/bin.js')
  const { readFile } = await import('node:fs/promises')
  const version = JSON.parse(await readFile(join(host, '@deepseek-ai/dsh/package.json'), 'utf8')).version
  const plugin = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  // Use the selected official host's public semver package. Check both ordinary
  // npm matching and DSH's documented includePrerelease boot semantics.
  const { satisfies } = createRequire(join(host, 'compatibility-probe.cjs'))('semver')
  for (const includePrerelease of [false, true]) {
    for (const candidate of ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.2']) {
      assert(satisfies(candidate, plugin.engines.dsh, { includePrerelease }), `DSH range rejected ${candidate}`)
      for (const peer of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm']) {
        assert(satisfies(candidate, plugin.peerDependencies[peer], { includePrerelease }), `${peer} rejected ${candidate}`)
      }
    }
    for (const candidate of ['0.2.0', '0.2.1-rc.1', '0.2.2-alpha.0', '0.2.2-alpha.1', '0.3.0-alpha.1', '0.3.0', '1.0.0']) {
      assert(!satisfies(candidate, plugin.engines.dsh, { includePrerelease }), `DSH range unexpectedly admitted ${candidate}`)
    }
    for (const [peer, good, bad] of [
      ['@deepseek-ai/cordis', ['4.0.5', '4.0.6-alpha.1'], ['4.0.4', '4.1.0-alpha.1', '4.1.0', '5.0.0']],
      ['@deepseek-ai/schemastery', ['3.18.5', '3.18.6-alpha.1'], ['3.18.4', '3.19.0-alpha.1', '3.19.0', '4.0.0']],
    ]) {
      for (const candidate of good) assert(satisfies(candidate, plugin.peerDependencies[peer], { includePrerelease }))
      for (const candidate of bad) assert(!satisfies(candidate, plugin.peerDependencies[peer], { includePrerelease }))
    }
  }
  assert(satisfies(process.version, plugin.engines.node), 'Test Node must satisfy the plugin engine')
  const expected = option('--dsh-version')
  if (expected) assert.equal(version, expected, 'Wrong official runtime version')
  const env = { ...process.env, DSH_HOME: join(temporary, 'home'),
    XDG_CACHE_HOME: join(temporary, 'cache'), XDG_DATA_HOME: join(temporary, 'data'),
    npm_config_cache: join(temporary, 'npm-cache'), PATH: `${join(host, '.bin')}${delimiter}${process.env.PATH}` }
  await writeFile(join(temporary, 'package.json'), JSON.stringify({
    name: 'dsh-incompatible-artifact-fixture', version: '0.0.0', type: 'module',
    engines: { dsh: '0.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(temporary, 'cordis.patch.yml'), '[]\n')
  execFileSync(process.execPath, [cli, '--profile', 'verify', '--from-default-profile', 'acp', '--help'], { env })
  const installed = spawnSync(process.execPath, [cli, 'plugin', '--profile', 'verify', 'add', temporary, '--ignore-scripts'], { env, encoding: 'utf8' })
  const checked = installed.status === 0
    ? spawnSync(process.execPath, [cli, '--profile', 'verify', '--dump-config'], { env, encoding: 'utf8' }) : installed
  assert.notEqual(checked.status, 0, 'Official DSH must refuse an incompatible bundle')
  assert.match(`${checked.stdout}${checked.stderr}`, /0\.0\.0/u)
  assert(`${checked.stdout}${checked.stderr}`.includes(version), 'Error must identify the actual DSH version')
  console.log(`PASS ${version}: npm/DSH prerelease ranges admit all five targets and reject excluded versions; official CLI rejected mismatched engines.dsh with required and running versions`)
} finally { await rm(temporary, { recursive: true, force: true }) }
