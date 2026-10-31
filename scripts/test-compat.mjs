/** Published DSH runtimes, isolated homes, actual ACP and public runtime probes. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const versions = ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.2']
function option(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  assert(value && !value.startsWith('--'), `${name} requires a value`)
  return value
}
const selected = option('--dsh-version') ? [option('--dsh-version')] : versions
assert(selected.every(version => versions.includes(version)), 'Only the five explicitly audited runtimes may be marked tested')
const hostPrefix = option('--host-prefix')
assert(!hostPrefix || selected.length === 1, '--host-prefix selects exactly one --dsh-version')
const hostRoot = option('--host-root')
const requirePtc = process.argv.includes('--require-ptc')
const resultPath = resolve(option('--result-file') ?? join(tmpdir(), 'dsh-compat-results.json'))
const work = await mkdtemp(join(tmpdir(), 'artifact-compat-matrix-'))
const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
const report = { format: 1, generatedAt: new Date().toISOString(), pluginVersion: pkg.version,
  node: process.version, status: 'NOT TESTED', scope: 'Official published DSH runtime and ACP; model, MCP transport peer and Host Files API are isolated fixtures. No production MaiBot/QQ claim.', versions: [] }

async function run(command, args, logPath, env = {}) {
  let output = ''
  const code = await new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      npm_config_cache: join(tmpdir(), 'dsh-compat-npm-cache'), ...env } })
    child.stdout.on('data', bytes => { output += bytes })
    child.stderr.on('data', bytes => { output += bytes })
    child.once('error', reject)
    child.once('exit', (code, signal) => accept(code ?? `signal:${signal}`))
  })
  await writeFile(logPath, output)
  return { status: code === 0 ? 'PASS' : 'FAIL', exitCode: code, output }
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function scenario(version, name, script, flags, logDir) {
  const result = join(logDir, `${name}.json`)
  const log = join(logDir, `${name}.log`)
  const runResult = await run(process.execPath, [script, ...flags, '--result-file', result], log)
  let evidence
  try { evidence = await json(result) } catch { /* A missing report is a failure, never a fake PASS. */ }
  if (runResult.status !== 'PASS' || !evidence) {
    console.error(runResult.output.slice(-8000))
    return { name, status: 'FAIL', log, evidence, error: `Scenario ${version}/${name} failed or produced no structured evidence` }
  }
  return { name, status: evidence.status, log, evidence }
}
try {
  for (const version of selected) {
    const logDir = join(dirname(resultPath), `dsh-compat-${version}`)
    await mkdir(logDir, { recursive: true })
    const row = { dshVersion: version, status: 'NOT TESTED', checks: [] }
    report.versions.push(row)
    try {
      const prefix = hostPrefix ? resolve(hostPrefix) : hostRoot ? resolve(hostRoot, version) : join(work, version)
      if (!hostPrefix && !hostRoot) {
        const installed = await run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact',
          `@deepseek-ai/dsh@${version}`, 'pnpm@11.25.0'], join(logDir, 'official-install.log'))
        row.checks.push({ name: 'official-npm-install', status: installed.status })
        assert.equal(installed.status, 'PASS', 'Official npm installation failed')
      }
      const manifest = await json(join(prefix, 'node_modules/@deepseek-ai/dsh/package.json'))
      assert.equal(manifest.version, version, 'Host prefix contains the wrong runtime')
      row.runtime = { version: manifest.version, nodeRequirement: manifest.engines?.node ?? 'not declared in CLI package', prefix }
      row.checks.push({ name: 'exact-published-host', status: 'PASS' })
      const flags = ['--dsh-version', version, '--host-prefix', prefix]
      for (const [name, extra] of [['acp-manifest', []], ['acp-request', ['--request-confirmation']], ['acp-fixed-notification', ['--fixed-notification']]]) {
        row.checks.push(await scenario(version, name, 'scripts/test-acp.mjs', [...flags, ...extra], logDir))
      }
      row.checks.push(await scenario(version, 'runtime-safety-lifecycle', 'scripts/test-runtime.mjs', flags, logDir))
      const versionLog = join(logDir, 'version-refusal.log')
      const refused = await run(process.execPath, ['scripts/test-version.mjs', ...flags], versionLog)
      row.checks.push({ name: 'official-engine-refusal', status: refused.status, log: versionLog })
      if (refused.status !== 'PASS') console.error(refused.output.slice(-4000))
      row.status = row.checks.some(item => item.status === 'FAIL') ? 'FAIL'
        : row.checks.some(item => item.status === 'BLOCKED') ? 'BLOCKED'
          : row.checks.some(item => item.status !== 'PASS') ? 'NOT TESTED' : 'PASS'
    } catch (error) {
      row.status = 'FAIL'
      row.error = String(error)
      console.error(`${version}: ${error}`)
    }
    console.log(`${version}: ${row.status}; ${row.checks.map(item => `${item.name}=${item.status}`).join(', ')}`)
  }
  report.status = report.versions.some(row => row.status === 'FAIL') ? 'FAIL'
    : report.versions.some(row => row.status === 'BLOCKED') ? 'BLOCKED'
      : report.versions.every(row => row.status === 'PASS') ? 'PASS' : 'NOT TESTED'
} finally {
  await mkdir(dirname(resultPath), { recursive: true })
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n')
  await rm(work, { recursive: true, force: true })
  console.log(`Compatibility evidence: ${resultPath}`)
}
if (report.status === 'FAIL' || report.status === 'NOT TESTED' || (requirePtc && report.status === 'BLOCKED')) process.exitCode = 1
