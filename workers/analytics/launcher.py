"""Bounded file protocol. This launcher runs only inside a disposable container."""
import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading

MAX_PACKET = 48 * 1024 * 1024


def drain(stream, chunks):
    size = 0
    while chunk := stream.read(4096):
        take = min(len(chunk), max(0, 16000 - size))
        if take:
            chunks.append(chunk[:take])
            size += take


def main():
    raw = sys.stdin.buffer.read(MAX_PACKET + 1)
    if len(raw) > MAX_PACKET:
        raise ValueError("COMPUTE_INPUT_LIMIT")
    packet = json.loads(raw)
    root = Path("/job")
    for file in packet["files"]:
        name = file["name"]
        if Path(name).name != name or name not in {"code.py", *[f"dataset-{n}.json" for n in range(20)]}:
            raise ValueError("INPUT_PATH_INVALID")
        (root / name).write_bytes(base64.b64decode(file["base64"], validate=True))
    (root / "manifest.json").write_text(json.dumps(packet["manifest"]), encoding="utf-8")
    child = subprocess.Popen([sys.executable, "-I", "-m", "squabble_analytics.cli", str(root / "manifest.json")],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, cwd=root)
    stdout, stderr = [], []
    threads = [threading.Thread(target=drain, args=(child.stdout, stdout), daemon=True),
               threading.Thread(target=drain, args=(child.stderr, stderr), daemon=True)]
    for thread in threads:
        thread.start()
    try:
        code = child.wait(timeout=packet["maxRuntimeMs"] / 1000)
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for thread in threads:
        thread.join(timeout=1)
    if code != 0:
        raise ValueError("COMPUTE_WORKER_FAILED:" + b"".join(stderr).decode("utf-8", errors="replace"))
    output_root = root / "outputs"
    if output_root.is_symlink() or not output_root.is_dir():
        raise ValueError("OUTPUT_PATH_INVALID")
    index = output_root / "outputs.json"
    if index.is_symlink() or not index.is_file() or index.stat().st_size > 64000:
        raise ValueError("OUTPUT_MANIFEST_INVALID")
    entries = json.loads(index.read_text(encoding="utf-8"))["files"]
    if not 1 <= len(entries) <= 8:
        raise ValueError("OUTPUT_LIMIT")
    files, total = [], 0
    for entry in entries:
        name = entry["name"]
        if Path(name).name != name or name in {".", ".."}:
            raise ValueError("OUTPUT_PATH_INVALID")
        target = output_root / name
        if target.is_symlink() or not target.is_file():
            raise ValueError("OUTPUT_PATH_INVALID")
        with target.open("rb") as handle:
            data = handle.read(packet["maxOutputBytes"] + 1)
        total += len(data)
        if total > packet["maxOutputBytes"]:
            raise ValueError("OUTPUT_LIMIT")
        digest = hashlib.sha256(data).hexdigest()
        if digest != entry["sha256"] or len(data) != entry["sizeBytes"]:
            raise ValueError("OUTPUT_INTEGRITY")
        files.append({"name": name, "mime": entry["mime"], "sha256": digest,
                      "base64": base64.b64encode(data).decode("ascii")})
    # Child streams are never the transport; only this bounded packet is returned.
    print(json.dumps({"files": files, "stdout": b"".join(stdout).decode("utf-8", errors="replace")[:4000],
                      "stderr": b"".join(stderr).decode("utf-8", errors="replace")[:4000]}))


if __name__ == "__main__":
    main()
