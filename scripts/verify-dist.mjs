import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const temp = await mkdtemp(join(tmpdir(), 'artifact-build-'))
async function tree(root, prefix = '') {
  const result = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await tree(root, path))
    else result.push(path)
  }
  return result.sort()
}
try {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--outDir', temp], { stdio: 'inherit' })
  const paths = await tree(temp)
  assert.deepEqual(await tree(resolve('dist')), paths, 'dist file set differs from source build')
  for (const path of paths) assert.deepEqual(await readFile(join('dist', path)), await readFile(join(temp, path)), `stale dist/${path}`)
  console.log(`Verified ${paths.length} prebuilt files against a clean TypeScript build`)
} finally { await rm(temp, { recursive: true, force: true }) }
