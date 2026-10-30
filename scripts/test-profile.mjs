import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { setTimeout, clearTimeout } from 'node:timers'

const home = await mkdtemp(join(tmpdir(), 'artifact-profile-'))
const cli = resolve('node_modules/@deepseek-ai/dsh/lib/bin.js')
const environment = { ...process.env, DSH_HOME: home, XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'), PATH: `${resolve('node_modules/.bin')}${delimiter}${process.env.PATH}` }
const run = args => execFileSync(process.execPath, [cli, ...args], { env: environment, encoding: 'utf8', timeout: 30000 })
let child
try {
  run(['plugin', '--profile', 'verify', 'add', process.cwd(), '--ignore-scripts'])
  const tree = run(['--profile', 'verify', '--dump-config'])
  assert.match(tree, /# == dsh-maibot-artifacts/u)
  assert.match(tree, /name: dsh-maibot-artifacts/u)
  const probe = join(home, 'probe.mjs')
  const patch = join(home, 'probe.yml')
  await writeFile(probe, `
export const name = 'artifact-profile-probe';
export const inject = ['tools'];
export function apply(ctx) {
  const timer = setInterval(() => {
    if (['maibot_artifact_prepare', 'maibot_artifact_publish', 'maibot_artifact_local_status'].every(name => ctx.tools.get(name))) {
      clearInterval(timer); console.log('ARTIFACT_PROFILE_REGISTERED_OK');
    }
  }, 20);
  ctx.effect(() => () => clearInterval(timer));
}
`)
  await writeFile(patch, `- insert:\n    - id: artifact-profile-probe\n      name: ${JSON.stringify(probe)}\n`)
  child = spawn(process.execPath, [cli, '--profile', 'verify', '--patch', patch], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let errors = ''
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(`Profile registration timed out: ${errors}`)), 10000)
    const finish = error => { clearTimeout(timer); if (error) reject(error); else accept() }
    child.stdout.on('data', bytes => {
      output += bytes.toString()
      if (output.includes('ARTIFACT_PROFILE_REGISTERED_OK')) finish()
    })
    child.stderr.on('data', bytes => { errors = (errors + bytes.toString()).slice(-4000) })
    child.once('error', finish)
    child.once('exit', (code, signal) => { if (!output.includes('ARTIFACT_PROFILE_REGISTERED_OK')) finish(new Error(`Profile exited ${code}/${signal}: ${errors}`)) })
  })
  console.log('Official DSH profile: plugin install, config layer, boot and all 3 tool registrations passed')
} finally {
  if (child?.exitCode === null && child?.signalCode === null) {
    child.kill('SIGTERM')
    await new Promise(accept => {
      const timer = setTimeout(() => { child.kill('SIGKILL') }, 3000)
      child.once('exit', () => { clearTimeout(timer); accept() })
    })
  }
  await rm(home, { recursive: true, force: true })
}
