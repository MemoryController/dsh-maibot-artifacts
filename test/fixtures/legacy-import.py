"""Actual original peer manifest importer; Files API only is a scoped simulation."""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True


async def run(peer: Path, workspace: Path, confirmation_file: Path) -> dict:
    # Reuse the boundary double without running its newer request.py test path.
    spec = importlib.util.spec_from_file_location("shared_scoped_files_fixture", Path(__file__).with_name("peer-import.py"))
    assert spec is not None and spec.loader is not None
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    sys.path.insert(0, str(peer))
    actual = importlib.import_module("handoff")
    assert Path(actual.__file__).resolve() == peer / "handoff.py"
    confirmation = json.loads(confirmation_file.read_text(encoding="utf-8"))
    assert set(confirmation) == {"tool", "arguments"}
    assert confirmation["tool"] == "dsh_import_handoff"
    assert set(confirmation["arguments"]) == {"manifest", "send"}
    assert confirmation["arguments"]["send"] is False
    manifest = confirmation["arguments"]["manifest"]
    assert set(manifest) == {"type", "version", "task_id", "files"}
    checks = []
    with tempfile.TemporaryDirectory(prefix="legacy-peer-private-", dir=workspace.parent) as private:
        root = Path(private)
        runtime = root / "runtime"
        runtime.mkdir(mode=0o700)
        files_root = root / "simulated-files"
        files = fixture.ScopedFiles(files_root)

        def broker():
            return actual.Handoff(files, str(workspace), runtime, root / "data", 50 * 1024**2, 8)

        first = await broker().import_manifest(**confirmation["arguments"])
        assert first["success"] and first["registered"] == "confirmed" and first["delivery"] == "not_requested"
        refs = []
        for declaration, item in zip(manifest["files"], first["items"], strict=True):
            payload = (workspace / declaration["path"]).read_bytes()
            metadata = item["file"]
            assert item["status"] == "imported"
            assert metadata["name"] == Path(declaration["path"]).name
            assert metadata["size"] == declaration["size"] == len(payload)
            assert metadata["sha256"] == declaration["sha256"] == hashlib.sha256(payload).hexdigest()
            assert (files_root / f"{metadata['file_ref']}.bin").read_bytes() == payload
            refs.append(metadata["file_ref"])
        count = len(files.uploads)
        assert count == len(manifest["files"]) == 3
        checks.append("actual-original-peer-imports-default-text-png-chinese-empty-manifest")

        repeat = await broker().import_manifest(**confirmation["arguments"])
        assert repeat["cached"] and repeat["registered"] == "confirmed"
        files = fixture.ScopedFiles(files_root)
        restarted = broker()
        replay = await restarted.import_manifest(**confirmation["arguments"])
        assert replay["cached"] and replay["registered"] == "confirmed" and len(files.uploads) == count
        checks.append("duplicate-and-restart-have-zero-new-uploads")

        recovered = await restarted.status(manifest["task_id"])
        assert recovered["registered"] == "confirmed" and recovered["cached"]
        assert [item["file"]["file_ref"] for item in recovered["items"]] == refs
        files.scope = "other-chat"
        denied = await restarted.status(manifest["task_id"])
        assert denied["registered"] == "unconfirmed" and not any(ref in json.dumps(denied) for ref in refs)
        files.scope = None
        assert (await restarted.status(manifest["task_id"]))["registered"] == "unconfirmed"
        assert len(files.uploads) == count
        checks.append("same-chat-status-recovers-receipt-other-or-missing-scope-reveals-no-refs")

        assert not files.sends and not list(runtime.iterdir())
        checks.append("zero-send-calls-and-private-staging-clean")
        return {
            "passed": len(checks), "failed": 0, "checks": checks,
            "simulated_uploads": len(files.uploads), "simulated_sends": len(files.sends),
            "files_api": "simulated scoped official-signature API", "real_host_network_qq": False,
            "confirmed_file_refs": refs,
        }


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: legacy-import.py <baseline-peer-checkout> <workspace> <confirmation-json-file>")
    print(json.dumps(asyncio.run(run(*(Path(value).resolve() for value in sys.argv[1:]))), ensure_ascii=False))
