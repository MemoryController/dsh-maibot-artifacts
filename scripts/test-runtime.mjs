/** Boot a selected published DSH host and run version-local isolated runtime checks. */
import assert from 'node:assert/strict'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as pause } from 'node:timers/promises'
import { setTimeout, clearTimeout } from 'node:timers'

const { values } = parseArgs({ options: { 'host-prefix': { type: 'string' }, 'dsh-version': { type: 'string' }, 'result-file': { type: 'string' } } })
const root = process.cwd()
const hostRoot = values['host-prefix'] ? resolve(values['host-prefix'], 'node_modules') : resolve('node_modules')
const cli = join(hostRoot, '@deepseek-ai/dsh/lib/bin.js')
const version = JSON.parse(await readFile(join(hostRoot, '@deepseek-ai/dsh/package.json'), 'utf8')).version
if (values['dsh-version']) assert.equal(version, values['dsh-version'], 'Selected host must match the requested published version')
const temporary = await mkdtemp(join(tmpdir(), 'artifact-published-runtime-'))
const probeDir = await mkdtemp(join(hostRoot, '.artifact-runtime-probe-'))
const home = join(temporary, 'home')
const resultFile = join(temporary, 'runtime-results.json')
const environment = { ...process.env, DSH_HOME: home, XDG_CACHE_HOME: join(temporary, 'cache'), XDG_DATA_HOME: join(temporary, 'data'),
  npm_config_cache: join(temporary, 'npm-cache'), PATH: `${join(hostRoot, '.bin')}${delimiter}${process.env.PATH}` }
const run = args => execFileSync(process.execPath, [cli, ...args], { cwd: root, env: environment, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
let child
let report
let operationError
try {
  await copyFile(resolve('test/fixtures/runtime-probe.mjs'), join(probeDir, 'runtime-probe.mjs'))
  await writeFile(join(probeDir, 'package.json'), JSON.stringify({ name: 'artifact-version-local-runtime-probe', type: 'module', private: true }))
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
    cwd: root, env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  }))[0]
  assert.ok(packed.files.some(file => file.path === 'dist/index.js'))
  run(['plugin', '--profile', 'runtime', 'add', join(temporary, packed.filename), '--ignore-scripts'])
  const workspaceRoot = join(temporary, 'workspace')
  const stateDir = join(temporary, 'state')
  await mkdir(join(workspaceRoot, 'outbox'), { recursive: true })
  await writeFile(join(workspaceRoot, 'outbox/seed.bin'), new Uint8Array([0, 128, 255]))
  const pluginEntry = pathToFileURL(join(home, 'profiles/runtime/node_modules/dsh-maibot-artifacts/dist/index.js')).href
  const patch = join(temporary, 'runtime.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'maibot-artifacts', config: { workspaceRoot, stateDir } },
    { insert: [{ id: 'published-runtime-probe', name: join(probeDir, 'runtime-probe.mjs'), config: { version, workspaceRoot, stateDir, pluginEntry, resultFile } }] },
  ]))
  const tree = run(['--profile', 'runtime', '--patch', patch, '--dump-config'])
  assert.match(tree, /dsh-maibot-artifacts/u)
  assert.match(tree, /published-runtime-probe/u)
  child = spawn(process.execPath, [cli, '--profile', 'runtime', '--patch', patch], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-12000) })
  let spawnError
  child.once('error', error => { spawnError = error })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try { report = JSON.parse(await readFile(resultFile, 'utf8')); break }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (spawnError) throw spawnError
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Published host exited before writing runtime results: ${diagnostics}`)
    await pause(25)
  }
  if (!report) throw new Error(`Published runtime probe timed out: ${diagnostics}`)
  assert.equal(report.version, version)
  assert.equal(report.status, 'PASS', `Published DSH ${version} runtime checks failed`)
} catch (error) {
  operationError = error
  report ??= { status: 'FAIL', version, node: process.version,
    checks: [{ name: 'official_profile_boot', status: 'FAIL', detail: String(error?.stack ?? error).slice(-6000) }] }
  if (report.status !== 'FAIL') report.checks.push({ name: 'profile_report_validation', status: 'FAIL', detail: String(error?.stack ?? error).slice(-6000) })
  report.status = 'FAIL'
} finally {
  if (child?.exitCode === null && child?.signalCode === null) {
    child.kill('SIGTERM')
    await new Promise(resolveStop => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      child.once('exit', () => { clearTimeout(timer); resolveStop() })
    })
  }
  if (child && report) {
    const cleanExit = child.exitCode === 0 || child.signalCode === 'SIGTERM'
    report.checks.push({ name: 'published_host_process_cleanup', status: cleanExit ? 'PASS' : 'FAIL',
      detail: { exitCode: child.exitCode, signal: child.signalCode, stoppedBeforeReport: true } })
    if (!cleanExit) {
      report.status = 'FAIL'
      operationError ??= new Error('Published host failed or required forced termination after the runtime probe')
    }
  }
  await rm(probeDir, { recursive: true, force: true })
  await rm(temporary, { recursive: true, force: true })
}

report.passed = report.checks.filter(check => check.status === 'PASS').length
report.notApplicable = report.checks.filter(check => check.applicable === false).length
if (values['result-file']) {
  const destination = resolve(values['result-file'])
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, JSON.stringify(report, null, 2))
}
console.log(JSON.stringify(report))
if (operationError) throw operationError
