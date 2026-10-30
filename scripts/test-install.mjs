import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const temp = await mkdtemp(join(tmpdir(), 'artifact-install-'))
const offline = process.argv.includes('--offline')
const environment = { ...process.env, npm_config_cache: offline ? process.env.npm_config_cache : join(temp, 'npm-cache') }
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { encoding: 'utf8', env: environment }))[0]
  assert(packed.files.some(file => file.path === 'dist/index.js'))
  assert(packed.files.some(file => file.path === 'cordis.patch.yml'))
  // npm ci caches locked tarballs, but need not cache registry packuments.
  // A fresh standalone consumer must be allowed to resolve exact peer metadata.
  // --offline remains an explicit additional test for a fully populated cache.
  execFileSync('npm', ['install', '--prefix', temp, '--ignore-scripts', ...(offline ? ['--offline'] : []), '--no-audit', '--no-fund', join(temp, packed.filename)], { stdio: 'inherit', env: environment })
  const root = join(temp, 'node_modules/dsh-maibot-artifacts')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.scripts.prepare, undefined)
  assert.equal(pkg.scripts.install, undefined)
  assert.equal(pkg.scripts.postinstall, undefined)
  const plugin = await import(pathToFileURL(join(root, 'dist/index.js')).href)
  assert.equal(plugin.name, 'maibot-artifacts')
  assert.equal(typeof plugin.apply, 'function')
  assert(plugin.inject.includes('tools'))
  console.log(`Prebuilt tarball installed${offline ? ' offline' : ''} with lifecycle scripts disabled; official plugin entry loaded`)
} finally { await rm(temp, { recursive: true, force: true }) }
