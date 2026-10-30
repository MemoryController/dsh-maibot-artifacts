import assert from 'node:assert/strict'
import process from 'node:process'
import { ArtifactService } from '../../src/core.ts'

const { config, taskId, owner, phase } = JSON.parse(process.argv[2])
assert(['before-complete', 'before-main-save'].includes(phase))
const service = new ArtifactService(config)
const exclusive = service.exclusive.bind(service)
service.exclusive = async (path, value) => {
  if (phase === 'before-complete' && path.endsWith('.submission-complete')) process.exit(74)
  return exclusive(path, value)
}
const save = service.save.bind(service)
service.save = async record => {
  if (phase === 'before-main-save' && record.submission) process.exit(73)
  return save(record)
}
await service.publish(taskId, owner)
throw new Error('Expected deterministic crash injection point was not reached')
