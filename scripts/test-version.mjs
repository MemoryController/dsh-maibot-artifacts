import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const temporary = await mkdtemp(join(tmpdir(), 'artifact-version-'))
try {
  const cli = resolve('node_modules/@deepseek-ai/dsh/lib/bin.js')
  const env = { ...process.env, DSH_HOME: join(temporary, 'home'), PATH: `${resolve('node_modules/.bin')}${delimiter}${process.env.PATH}` }
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
  assert.match(`${checked.stdout}${checked.stderr}`, /0\.2\.2-alpha\.2/u)
  console.log('Official DSH rejected mismatched engines.dsh and reported required and running versions')
} finally { await rm(temporary, { recursive: true, force: true }) }
