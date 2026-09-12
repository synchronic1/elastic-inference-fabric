"""Best-effort discovery with bounded subprocess probes; no network scan or installs."""

import csv
import hashlib
import io
import os
import platform
import shutil
import subprocess
from pathlib import Path

import psutil


def probe(args: list[str]) -> str | None:
    try:
        return subprocess.run(args, capture_output=True, text=True, check=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return None


def discover_hardware() -> dict:
    gpus = []
    if shutil.which("nvidia-smi"):
        output = probe(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,driver_version",
                "--format=csv,noheader,nounits",
            ]
        )
        if output:
            for row in csv.reader(io.StringIO(output)):
                if len(row) == 3:
                    try:
                        gpus.append(
                            {
                                "vendor": "nvidia",
                                "name": row[0].strip(),
                                "memory_bytes": int(float(row[1])) * 1024**2,
                                "driver": row[2].strip(),
                            }
                        )
                    except ValueError:
                        continue
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        gpus.append(
            {
                "vendor": "apple",
                "name": "Apple Silicon integrated GPU",
                "unified_memory": True,
                "memory_bytes": None,
            }
        )
    return {
        "os": platform.system(),
        "arch": platform.machine(),
        "hostname": platform.node(),
        "cpu": platform.processor(),
        "logical_cpus": os.cpu_count(),
        "physical_cpus": psutil.cpu_count(logical=False),
        "memory_total_bytes": psutil.virtual_memory().total,
        "gpus": gpus,
        "binaries": {
            name: shutil.which(name) for name in ("llama-server", "ik_llama-server", "ollama")
        },
    }


def current_load() -> dict:
    memory = psutil.virtual_memory()
    return {
        "load_average": list(os.getloadavg()) if hasattr(os, "getloadavg") else None,
        "memory_available_bytes": memory.available,
        "memory_used_percent": memory.percent,
    }


def file_identity(path: Path | None) -> dict:
    if path is None:
        return {"cached_on_disk": False, "fingerprint": None}
    try:
        stat = path.stat()
        cached = path.is_file() and path.suffix.lower() == ".gguf" and stat.st_size > 0
    except OSError:
        return {"cached_on_disk": False, "fingerprint": None}
    # This is a LOCAL identity/invalidator, never a portable content checksum.
    identity = f"{path.resolve()}:{stat.st_dev}:{stat.st_ino}:{stat.st_size}:{stat.st_mtime_ns}"
    return {
        "cached_on_disk": cached,
        "size_bytes": stat.st_size,
        "fingerprint": hashlib.sha256(identity.encode()).hexdigest(),
        "fingerprint_kind": "local-file-stat",
    }


def discover_gguf(directories: list[Path], limit: int = 256) -> list[dict]:
    found = []
    # One directory level, operator-specified paths only; no unbounded home scan.
    for directory in directories:
        try:
            for path in directory.glob("*.gguf"):
                found.append({"name": path.name, **file_identity(path)})
                if len(found) >= limit:
                    return found
        except OSError:
            continue
    return found
