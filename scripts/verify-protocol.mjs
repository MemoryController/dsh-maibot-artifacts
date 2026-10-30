import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ArtifactService, relayText } from '../dist/core.js'

// This deliberately executes the real, pinned peer validator, not a local copy.
// The checkout is an explicit caller-supplied input; this script never fetches it.
const baseline = 'ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8'
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-protocol.mjs /path/to/maibot-dsh-artifacts')
const peer = resolve(process.argv[2])
const git = (...args) => execFileSync('git', ['-C', peer, ...args], { encoding: 'utf8' }).trim()
assert.equal(git('rev-parse', '--verify', 'HEAD^{commit}'), baseline, 'peer checkout must use the pinned protocol commit')
git('diff', '--exit-code', baseline, '--', 'handoff.py', 'safe_files.py', 'tools/dsh_handoff.py')

const temporary = await mkdtemp(join(tmpdir(), 'dsh-maibot-protocol-'))
try {
  const workspaceRoot = join(temporary, 'workspace')
  const outbox = join(workspaceRoot, 'outbox', '协议校验')
  await mkdir(outbox, { recursive: true })
  const binary = Buffer.from([0, 255, 128, 10, 13, 0, 42, 240, 159, 152, 128])
  await writeFile(join(outbox, '中文产物.bin'), binary)
  await writeFile(join(outbox, '空文件.txt'), Buffer.alloc(0))
  const service = new ArtifactService({ workspaceRoot, stateDir: join(temporary, 'private') })
  const prepared = await service.prepare(['outbox/协议校验/中文产物.bin', 'outbox/协议校验/空文件.txt'], 'protocol-verification')
  assert.equal(prepared.state, 'prepared')
  assert.equal(prepared.duplicate, false)
  assert.deepEqual(prepared.manifest.files.map(file => file.size), [binary.length, 0])
  const manifestPath = 'outbox/协议校验/manifest.json'
  await writeFile(join(workspaceRoot, manifestPath), JSON.stringify(prepared.manifest))
  const instruction = JSON.parse(relayText(prepared.manifest).split('\n').at(-1))
  assert.equal(instruction.arguments.send, false)

  const python = String.raw`
import hashlib
import importlib.util
import json
import pathlib
import sys

peer, root, manifest_path = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
# Same package layout used by the peer's tools/dsh_handoff.py _load_protocol.
name = "dsh_handoff_protocol"
spec = importlib.util.spec_from_file_location(name, peer / "handoff.py", submodule_search_locations=[str(peer)])
module = importlib.util.module_from_spec(spec)
sys.modules[name] = module
spec.loader.exec_module(module)
manifest = json.loads((root / manifest_path).read_text(encoding="utf-8"))
assert module.validate_manifest(manifest, 8) == manifest
assert len(manifest["files"]) == 2
for item in manifest["files"]:
    data = (root / item["path"]).read_bytes()
    assert len(data) == item["size"]
    assert hashlib.sha256(data).hexdigest() == item["sha256"]

helper_spec = importlib.util.spec_from_file_location("peer_dsh_helper", peer / "tools" / "dsh_handoff.py")
helper = importlib.util.module_from_spec(helper_spec)
helper_spec.loader.exec_module(helper)
relay = helper.relay_arguments(root, manifest_path, "trusted-original-host-target")
assert relay["target"] == "trusted-original-host-target"
peer_instruction = json.loads(relay["text"].split("\n")[-1])
assert peer_instruction == json.load(sys.stdin)
assert peer_instruction == {"tool": "dsh_import_handoff", "arguments": {"manifest": manifest, "send": False}}
print(json.dumps({"manifestValidations": 1, "fileMetadataValidations": 2, "relayInstructionComparisons": 1}))
`
  // execFileSync propagates a nonzero Python exit as a failing script exit.
  const result = JSON.parse(execFileSync('python3', ['-B', '-c', python, peer, workspaceRoot, manifestPath], {
    input: JSON.stringify(instruction),
    encoding: 'utf8',
  }))
  assert.deepEqual(result, { manifestValidations: 1, fileMetadataValidations: 2, relayInstructionComparisons: 1 })
  console.log(`Pinned MaiBot ${baseline}: 1 real manifest validation, 2 file size/SHA-256 validations (Chinese binary + empty), 1 real helper relay instruction comparison passed.`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
