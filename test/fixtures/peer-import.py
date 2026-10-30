"""Run actual peer request/Handoff with an explicitly simulated Files API.

No SDK, Host, network, ACP or QQ server is replaced by a claimed real service.
Only the file-service boundary is doubled; the peer parser, snapshotter and
durable deduplication ledger are the actual reviewed checkout's implementation.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import sys
import tempfile
from pathlib import Path
from typing import Any


class ScopedFiles:
    """Official upload/list/send signatures with fixture-controlled scope only."""

    def __init__(self, root: Path, scope: str | None = "original-chat") -> None:
        self.root = root
        self.scope = scope
        self.fail_after_upload = False
        root.mkdir(mode=0o700, exist_ok=True)
        self.index = root / "assets.json"
        self.calls = root / "calls.json"
        if not self.index.exists():
            self.index.write_text(json.dumps({"original-chat": {}, "other-chat": {}}))
        if not self.calls.exists():
            self.calls.write_text(json.dumps({"uploads": [], "lists": [], "sends": []}))

    def _scope(self) -> str:
        if self.scope is None:
            raise PermissionError("Fixture has no current Host file scope")
        return self.scope

    def _log(self, kind: str, value: Any) -> None:
        data = json.loads(self.calls.read_text())
        data[kind].append(value)
        self.calls.write_text(json.dumps(data))

    async def list(self, offset: int = 0) -> list[dict[str, Any]]:
        scope = self._scope()
        self._log("lists", {"scope": scope, "offset": offset})
        return list(json.loads(self.index.read_text())[scope].values())[offset : offset + 50]

    async def upload(self, path: Path, *, name: str) -> dict[str, Any]:
        scope = self._scope()
        payload = Path(path).read_bytes()
        calls = json.loads(self.calls.read_text())
        file_ref = f"{len(calls['uploads']) + 1:032x}"
        metadata = {
            "file_ref": file_ref,
            "name": name,
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "state": "ready",
        }
        (self.root / f"{file_ref}.bin").write_bytes(payload)
        assets = json.loads(self.index.read_text())
        assets[scope][file_ref] = metadata
        self.index.write_text(json.dumps(assets, ensure_ascii=False))
        self._log("uploads", {"scope": scope, **metadata})
        if self.fail_after_upload:
            raise TimeoutError("Simulated response lost after file-service side effect")
        return metadata

    async def send(self, file_ref: str) -> dict[str, Any]:
        self._log("sends", file_ref)
        raise AssertionError("Controlled request confirmation must never send QQ files")

    @property
    def uploads(self) -> list[dict[str, Any]]:
        return json.loads(self.calls.read_text())["uploads"]

    @property
    def sends(self) -> list[str]:
        return json.loads(self.calls.read_text())["sends"]


async def run(peer: Path, workspace: Path, input_file: Path) -> dict[str, Any]:
    sys.path.insert(0, str(peer))
    request = importlib.import_module("request")
    handoff = importlib.import_module("handoff")
    assert Path(request.__file__).resolve() == peer / "request.py"
    assert Path(handoff.__file__).resolve() == peer / "handoff.py"
    cases = json.loads(input_file.read_text(encoding="utf-8"))["cases"]
    checks: list[str] = []

    def passed(name: str) -> None:
        checks.append(name)

    with tempfile.TemporaryDirectory(prefix="peer-handoff-private-", dir=workspace.parent) as private:
        private_root = Path(private)
        runtime = private_root / "runtime"
        runtime.mkdir(mode=0o700)
        data = private_root / "data"
        files_root = private_root / "simulated-files"
        files = ScopedFiles(files_root)

        def broker(max_bytes: int = 50 * 1024**2, max_batch: int = 8) -> Any:
            return handoff.Handoff(files, str(workspace), runtime, data, max_bytes, max_batch)

        async def confirm(name: str, current: Any = None, sha: str | None = None) -> dict[str, Any]:
            args = cases[name]["confirmation"]["arguments"]
            assert cases[name]["confirmation"]["tool"] == "dsh_import_request"
            return await request.import_request(
                broker() if current is None else current,
                args["task_id"],
                args["request_sha256"] if sha is None else sha,
            )

        # Exact-content confirmation must reject the wrong request digest before
        # any simulated file upload, even when the request itself is valid.
        wrong = await confirm("wrong_sha", sha="0" * 64)
        assert wrong["error"]["code"] == "request_hash_mismatch" and not files.uploads
        passed("wrong-request-sha-zero-uploads")

        files.scope = None
        no_scope = await confirm("no_scope")
        assert no_scope["registered"] == "unconfirmed" and not files.uploads
        assert not data.exists()
        files.scope = "original-chat"
        passed("no-current-scope-cannot-import-or-claim")

        main = cases["main"]["manifest"]
        first = await confirm("main")
        assert first["success"] and first["tool_called"]
        assert first["registered"] == "confirmed" and first["delivery"] == "not_requested"
        assert len(first["items"]) == len(main["files"]) == len(files.uploads)
        refs = []
        for declaration, item, upload in zip(main["files"], first["items"], files.uploads, strict=True):
            source = (workspace / declaration["path"]).read_bytes()
            metadata = item["file"]
            refs.append(metadata["file_ref"])
            assert item["status"] == "imported"
            assert metadata["name"] == Path(declaration["path"]).name
            assert metadata["size"] == declaration["size"] == len(source)
            assert metadata["sha256"] == declaration["sha256"] == hashlib.sha256(source).hexdigest()
            assert metadata["file_ref"] == upload["file_ref"]
            assert (files_root / f"{metadata['file_ref']}.bin").read_bytes() == source
            assert upload["scope"] == "original-chat"
        assert not files.sends and not list(runtime.iterdir())
        passed("real-peer-imports-text-png-chinese-spaces-unicode-empty-binary-multi")

        count = len(files.uploads)
        duplicate = await confirm("main")
        assert duplicate["cached"] is True and duplicate["registered"] == "confirmed"
        assert len(files.uploads) == count and not files.sends
        passed("duplicate-confirmation-zero-new-uploads")

        files = ScopedFiles(files_root)  # Simulated remote store and peer ledger both persist.
        restarted = broker()
        replay = await confirm("main", restarted)
        assert replay["cached"] and replay["registered"] == "confirmed"
        assert len(files.uploads) == count
        passed("peer-and-files-api-object-restart-zero-new-uploads")

        # Simulate losing the caller-facing successful receipt, rather than
        # inventing another upload attempt to recover it.
        del first, duplicate, replay
        recovered = await restarted.status(main["task_id"])
        assert recovered["cached"] and recovered["registered"] == "confirmed"
        assert [item["file"]["file_ref"] for item in recovered["items"]] == refs
        assert len(files.uploads) == count
        passed("lost-success-receipt-recovered-by-same-chat-read-only-status")

        files.scope = "other-chat"
        wrong_chat = await confirm("main", restarted)
        wrong_status = await restarted.status(main["task_id"])
        assert wrong_chat["registered"] == wrong_status["registered"] == "unconfirmed"
        assert not any(ref in json.dumps(wrong_chat) + json.dumps(wrong_status) for ref in refs)
        assert len(files.uploads) == count
        files.scope = None
        assert (await restarted.status(main["task_id"]))["registered"] == "unconfirmed"
        files.scope = "original-chat"
        passed("other-or-missing-current-scope-no-cached-refs-no-reupload")

        tampered = workspace / cases["tamper"]["manifest"]["files"][0]["path"]
        tampered.write_bytes(b"tampered after DSH submission")
        denied = await confirm("tamper")
        assert not denied["success"] and denied["registered"] == "not_registered"
        assert len(files.uploads) == count
        passed("real-peer-snapshot-rejects-post-submission-artifact-tamper")

        limited = await confirm("file_limit", broker(max_bytes=1))
        assert not limited["success"] and limited["registered"] == "not_registered"
        assert limited["items"][0]["error"]["code"] == "too_large"
        assert len(files.uploads) == count
        passed("peer-configured-single-file-limit-zero-uploads")

        batch_limited = await confirm("batch_limit", broker(max_batch=1))
        assert not batch_limited["success"] and batch_limited["error"]["code"] == "invalid_manifest"
        assert len(files.uploads) == count
        passed("peer-configured-batch-limit-zero-uploads")

        files.fail_after_upload = True
        uncertain = await confirm("unknown_upload")
        assert not uncertain["success"] and uncertain["registered"] == "unknown"
        assert len(files.uploads) == count + 1
        files.fail_after_upload = False
        await confirm("unknown_upload")
        files = ScopedFiles(files_root)
        await confirm("unknown_upload", broker())
        unknown_status = await broker().status(cases["unknown_upload"]["manifest"]["task_id"])
        assert unknown_status["registered"] != "confirmed"
        assert len(files.uploads) == count + 1 and not files.sends
        passed("uncertain-upload-side-effect-never-retried-after-confirmation-or-restart")
        assert not list(runtime.iterdir())
        passed("private-staging-clean-and-zero-send-calls")
        return {
            "files_api": "simulated scoped official-signature API",
            "real_host_network_qq": False,
            "passed": len(checks),
            "failed": 0,
            "checks": checks,
            "confirmed_main_file_refs": refs,
            "simulated_uploads": len(files.uploads),
            "simulated_sends": len(files.sends),
            "scope_boundary": "fixture-selected current scope; actual Host capability issuance is not exercised",
        }


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: peer-import.py <peer-checkout> <workspace> <confirmation-json-file>")
    print(json.dumps(asyncio.run(run(*(Path(value).resolve() for value in sys.argv[1:]))), ensure_ascii=False))
