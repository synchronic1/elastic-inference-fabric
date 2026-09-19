"""Loopback engine discovery for node onboarding.

This module only *suggests*. It opens TCP connections to loopback ports, reads a
few JSON endpoints, and prints a configuration block for the operator to paste.
It never writes a config, never starts a runtime, and never adopts an engine:
`dendrite/config.py` stays the only thing that decides what a node may execute,
so a probe result cannot silently become a routing target.

Loopback is not an arbitrary restriction. `RuntimeConfig.local_endpoint` rejects
any attached origin that is not an http:// loopback address, so probing anywhere
else could only produce a suggestion the config layer would refuse.

The `/completion` contract check is opt-in. A completion request can reset the
slot prefix cache of a server that other clients share, so the default probe
does not send one.
"""

import asyncio
import json
import os
import socket
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from dendrite.hardware import discover_gguf, discover_hardware, file_identity

# Common loopback bindings: llama.cpp examples, IK_Llama, vLLM, LM Studio, Ollama,
# the Dendrite daemon, and the Dendrite managed-runtime example port.
CANDIDATE_PORTS = (8080, 8081, 8000, 1234, 11434, 8090, 18090, 18091)
DEFAULT_TIMEOUT = 1.5

# Classification vocabulary, ordered from most to least actionable.
ATTACH_READY = "attach-ready"
LLAMA_FAMILY = "llama-family"
MANAGED_ALIAS = "dendrite-managed-runtime"
DENDRITE = "dendrite-node"
OLLAMA = "ollama"
OPENAI_ONLY = "openai-compatible"
LISTENING = "listening-unrecognized"

ATTACHABLE_KINDS = (ATTACH_READY, LLAMA_FAMILY)

# Fields the native adapter reads out of a /completion response.
CONTRACT_FIELDS = (
    "timings",
    "tokens_evaluated",
    "tokens_predicted",
    "tokens_cached",
    "truncated",
)

EXIT_ACTIONABLE = 0
EXIT_NOTHING_FOUND = 1


@dataclass
class Candidate:
    """One loopback port that accepted a connection, with whatever it identified as."""

    port: int
    kind: str
    detail: str = ""
    model_ids: list[str] = field(default_factory=list)
    upstream_model: str | None = None
    version: str | None = None
    node_id: str | None = None
    completion_status: int | None = None
    supports_chat: bool = False
    telemetry: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def attachable(self) -> bool:
        return self.kind in ATTACHABLE_KINDS

    def as_dict(self) -> dict:
        return {
            "port": self.port,
            "kind": self.kind,
            "detail": self.detail,
            "model_ids": self.model_ids,
            "upstream_model": self.upstream_model,
            "version": self.version,
            "node_id": self.node_id,
            "completion_status": self.completion_status,
            "supports_chat": self.supports_chat,
            "telemetry": self.telemetry,
            "notes": self.notes,
        }


async def _tcp_open(port: int, timeout: float) -> bool:
    """Distinguish a closed port from one that answered but did not identify itself."""
    try:
        async with asyncio.timeout(timeout):
            _, writer = await asyncio.open_connection("127.0.0.1", port)
    except (OSError, TimeoutError):
        return False
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass
    return True


async def _get_json(client: httpx.AsyncClient, path: str) -> object:
    try:
        response = await client.get(path)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        return response.json()
    except ValueError:
        return None


def _model_ids(payload: object) -> list[str]:
    if not isinstance(payload, dict):
        return []
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [
        item["id"] for item in data if isinstance(item, dict) and isinstance(item.get("id"), str)
    ]


def _suggest_upstream(model_ids: list[str]) -> str | None:
    """Prefer the identifier an attached server reports for the model itself.

    A managed runtime aliases its model as `<id>@<instance>`; a real upstream
    server normally has no "@", so those identifiers sort first.
    """
    plain = [item for item in model_ids if "@" not in item]
    return (plain or model_ids or [None])[0]


async def _check_completion(client: httpx.AsyncClient, timeout: float):
    """Exercise the native contract with no generation: an empty prompt and n_predict=0."""
    body = {
        "prompt": "",
        "n_predict": 0,
        "temperature": 0,
        "cache_prompt": True,
        "id_slot": 0,
        "stream": False,
    }
    try:
        response = await client.post("/completion", json=body, timeout=timeout * 4)
    except httpx.HTTPError:
        return None, None
    if response.status_code != 200:
        return response.status_code, None
    try:
        return 200, response.json()
    except ValueError:
        return 200, None


async def probe_port(
    port: int, *, check_completion: bool = False, timeout: float = DEFAULT_TIMEOUT
) -> Candidate | None:
    """Identify whatever is listening on a loopback port, or None if nothing is."""
    if not await _tcp_open(port, timeout):
        return None
    found = Candidate(
        port=port, kind=LISTENING, detail="port is open but no known node API answered"
    )
    async with httpx.AsyncClient(
        base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=timeout
    ) as client:
        # /healthz is public on loopback even when DENDRITE_API_TOKEN protects the rest.
        healthz = await _get_json(client, "/healthz")
        if isinstance(healthz, dict) and isinstance(healthz.get("node_id"), str):
            found.kind = DENDRITE
            found.node_id = healthz["node_id"]
            found.detail = "an existing Dendrite node is already listening here"
            found.notes.append(
                "Reuse this node rather than enrolling a second one, or give the new "
                "node its own port; one node_id on two machines replaces the first."
            )
            return found

        # Ollama serves /v1/models but 404s /health and /completion, so it must be
        # recognized before the OpenAI-compatible branch below.
        version = await _get_json(client, "/api/version")
        if isinstance(version, dict) and isinstance(version.get("version"), str):
            found.kind = OLLAMA
            found.version = version["version"]
            found.detail = "Ollama native API; it does not serve the llama.cpp /completion contract"
            found.notes.append(
                "Attach mode cannot use Ollama. Its GGUF blobs can still be loaded as files "
                "by a managed runtime."
            )
            return found

        health = await _get_json(client, "/health")
        model_ids = _model_ids(await _get_json(client, "/v1/models"))
        if isinstance(health, dict) and health.get("status") == "ok" and model_ids:
            if all("@" in item for item in model_ids):
                # A managed runtime aliases its model as `<id>@<instance>` (runtimes/llama.py).
                # Contract-shaped, but attaching would contend with the Dendrite that owns it,
                # and that owner terminates this process on model switch or unload.
                found.kind = MANAGED_ALIAS
                found.model_ids = model_ids
                found.detail = "a Dendrite managed runtime; its alias carries the @instance suffix"
                found.notes.append(
                    "Do not attach here: the owning Dendrite stops this process on model "
                    "switch or unload. Give this node its own runtime on a free port."
                )
                return found
            found.kind = LLAMA_FAMILY
            found.model_ids = model_ids
            found.upstream_model = _suggest_upstream(model_ids)
            props = await _get_json(client, "/props")
            found.supports_chat = (
                isinstance(props, dict)
                and props.get("model_alias") == found.upstream_model
                and isinstance(props.get("chat_template"), str)
                and bool(props["chat_template"].strip())
            )
            found.detail = "llama.cpp-family server identified; contract not yet verified"
            if not check_completion:
                found.notes.append(
                    "Re-run with --check-completion to verify /completion before attaching."
                )
                return found
            status, body = await _check_completion(client, timeout)
            found.completion_status = status
            if status == 200 and isinstance(body, dict):
                found.kind = ATTACH_READY
                found.detail = "llama.cpp-family server accepted the /completion contract"
                found.telemetry = [name for name in CONTRACT_FIELDS if name in body]
                timings = body.get("timings")
                if not (isinstance(timings, dict) and "cache_n" in timings):
                    found.notes.append(
                        "No timings.cache_n: cached-token counts will stay null "
                        "(see docs/node-runtime.md)."
                    )
            else:
                found.notes.append(
                    f"/completion did not accept the contract (status {status}); keep this "
                    "runtime managed rather than attached."
                )
            return found

        if model_ids:
            found.kind = OPENAI_ONLY
            found.model_ids = model_ids
            found.detail = "OpenAI-compatible models endpoint, not the llama.cpp contract"
            found.notes.append("Only a llama.cpp-family server can be attached; this cannot.")
            return found
    return found


def ollama_model_files() -> list[dict]:
    """Map local Ollama models to GGUF blob paths a managed runtime can load as files.

    Best-effort and read-only: a missing or unreadable store simply yields nothing.
    Blobs are accepted only if `file_identity` confirms GGUF magic, which filters
    out the template/config layers that share the manifest.
    """
    root = Path(os.environ.get("OLLAMA_MODELS") or (Path.home() / ".ollama" / "models"))
    manifests = root / "manifests"
    if not manifests.is_dir():
        return []
    found = []
    for manifest in sorted(manifests.rglob("*")):
        if not manifest.is_file():
            continue
        try:
            data = json.loads(manifest.read_text())
        except (OSError, ValueError):
            continue
        layers = data.get("layers") if isinstance(data, dict) else None
        if not isinstance(layers, list):
            continue
        for layer in layers:
            digest = layer.get("digest") if isinstance(layer, dict) else None
            if not isinstance(digest, str):
                continue
            # Manifests carry Docker-style "sha256:<hex>"; the blob file on disk is
            # named "sha256-<hex>". Older stores hyphenate in both places, so accept
            # either separator and normalize to the on-disk name.
            algorithm, separator, hex_digest = digest.partition(":")
            if not separator:
                algorithm, separator, hex_digest = digest.partition("-")
            if algorithm != "sha256" or len(hex_digest) != 64:
                continue
            blob = root / "blobs" / f"sha256-{hex_digest}"
            identity = file_identity(blob)
            if not identity["cached_on_disk"]:
                continue
            parts = manifest.relative_to(manifests).parts
            found.append(
                {
                    "model": "/".join(parts[-2:]) if len(parts) >= 2 else manifest.name,
                    "path": str(blob),
                    "size_bytes": identity["size_bytes"],
                }
            )
            break
    return found


def _free_port(preferences: tuple[int, ...], taken: set[int]) -> int:
    """Pick a port this host can actually bind, preferring the conventional ones."""
    with socket.socket() as probe:
        for port in preferences:
            if port in taken:
                continue
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    return preferences[-1]


def suggest_toml(
    candidates: list[Candidate],
    hardware: dict,
    ggufs: list[dict],
    dirs,
    ollama_files: list[dict] = (),
) -> str:
    """Build a paste-ready config. Every value the operator must review is marked."""
    taken = {candidate.port for candidate in candidates}
    hostname = str(hardware.get("hostname") or "node")
    slug = "".join(char if char.isalnum() or char == "-" else "-" for char in hostname.lower())
    node_port = _free_port((8090, 18090, 18091, 18092), taken)

    lines = [
        "# Generated by `dendrite probe`. Review every EDIT line before use.",
        "# capabilities are operator routing labels, not measured model quality.",
        "[node]",
        f'id = "{slug}"  # EDIT: must match the node_id this token is bound to',
        'host = "127.0.0.1"',
        f"port = {node_port}",
        f'state_dir = "../.dendrite/{slug}"',
    ]
    if dirs:
        rendered = ", ".join(f'"{Path(item).as_posix()}"' for item in dirs)
        lines.append(f"model_dirs = [{rendered}]")
    lines += [
        "# Set fabric_url to join the cloud fabric; it also needs the node token in the",
        "# environment (see docs/remote-linux-node.md).",
        '# fabric_url = "https://elasticinferencefabric.airanger.dev"',
        "",
    ]

    attached = next((item for item in candidates if item.attachable), None)
    if attached:
        upstream = attached.upstream_model or "REPLACE-WITH-MODEL-ID"
        lines += [
            "# Existing llama.cpp-family server on loopback: attach, do not spawn.",
            "# Dendrite verifies this model id and never owns the upstream process.",
            "[[runtimes]]",
            'id = "attached"',
            'kind = "llama_cpp"',
            'mode = "attach"',
            f'base_url = "http://127.0.0.1:{attached.port}"',
            "",
            "[[models]]",
            f'id = "{upstream}"',
            'runtime = "attached"',
            f'upstream_model = "{upstream}"  # EDIT: exactly as GET /v1/models reports it',
            'capabilities = ["complete", "summarize"]',
        ]
        if attached.kind != ATTACH_READY:
            lines += [
                "",
                "# Not contract-verified: confirm with --check-completion before relying on this.",
            ]
        if attached.supports_chat:
            lines += ["# Chat template reported by /props; Dendrite checks it again at runtime."]
        return "\n".join(lines)

    binary = next(
        (
            path
            for name in ("llama-server", "ik_llama-server")
            if (path := hardware.get("binaries", {}).get(name))
        ),
        None,
    )
    runtime_port = _free_port((8081, 8082, 8083, 18091), taken)
    physical = hardware.get("physical_cpus") or hardware.get("logical_cpus") or 4
    lines += [
        "# No attachable server found: manage a native runtime instead.",
        "[[runtimes]]",
        'id = "cpu"',
        'kind = "llama_cpp"',
        f'executable = "{binary or "llama-server"}"'
        + ("" if binary else "  # EDIT: no llama-server on PATH"),
        f"port = {runtime_port}",
        f"threads = {physical}",
        "context_size = 4096",
        "gpu_layers = 0",
        "",
    ]
    if ggufs:
        for entry in ggufs[:5]:
            stem = Path(entry["name"]).stem
            lines += [
                "[[models]]",
                f'id = "{stem}"',
                'runtime = "cpu"',
                f'path = "{entry["name"]}"  # EDIT: path relative to this TOML file',
                'capabilities = ["complete", "summarize"]',
                "",
            ]
        lines.append("# Remaining scanned GGUFs:")
        lines += [f"#   {entry['name']}" for entry in ggufs[5:]]
    elif ollama_files:
        lines += [
            "# Nothing under the configured model dirs, but this host already has Ollama",
            "# weights. Those blobs are ordinary GGUFs: a managed runtime reads the file",
            "# directly and does not involve Ollama or its API.",
        ]
        for entry in ollama_files[:5]:
            lines += [
                "[[models]]",
                f'id = "{entry["model"].replace("/", "-")}"',
                'runtime = "cpu"',
                f'path = "{entry["path"]}"',
                'capabilities = ["complete", "summarize"]',
                "",
            ]
        lines.append("# Remaining Ollama weights:")
        lines += [f"#   {entry['model']}" for entry in ollama_files[5:]]
    else:
        lines += [
            "# No GGUF found. Download one yourself: nothing is fetched automatically.",
            "[[models]]",
            'id = "REPLACE-WITH-MODEL-ID"',
            'runtime = "cpu"',
            'path = "../models/REPLACE-ME.gguf"',
            'capabilities = ["complete", "summarize"]',
        ]
    return "\n".join(lines)


def _warnings(candidates: list[Candidate]) -> list[str]:
    """Cross-port observations that no single probe result can make."""
    kinds = {item.kind for item in candidates}
    warnings = []
    if MANAGED_ALIAS in kinds and DENDRITE not in kinds:
        warnings.append(
            "A Dendrite managed runtime is listening but no Dendrite node API answered on the "
            "scanned ports. Its parent may have exited and left it orphaned, still holding "
            "memory with a model loaded. Check with: "
            "ps -Ao pid,ppid,etime,command | grep llama-server"
        )
    return warnings


def render(
    candidates: list[Candidate],
    hardware: dict,
    ggufs: list[dict],
    ollama_files: list[dict],
    warnings: list[str],
) -> str:
    binaries = hardware.get("binaries", {})
    memory = hardware.get("memory_total_bytes")
    binaries_found = ", ".join(f"{name}: {path or 'not found'}" for name, path in binaries.items())
    lines = [
        "Dendrite node probe - loopback only, nothing written, nothing started",
        "",
        f"  Host          {hardware.get('hostname')} ({hardware.get('os')} {hardware.get('arch')})",
        f"  CPUs          {hardware.get('logical_cpus')} logical / "
        f"{hardware.get('physical_cpus')} physical",
        f"  Memory        {memory / 1024**3:.1f} GiB" if memory else "  Memory        unknown",
        f"  Binaries      {binaries_found}",
        "",
    ]
    if candidates:
        lines.append("Engines found")
        for candidate in candidates:
            lines.append(f"  127.0.0.1:{candidate.port:<6} {candidate.kind}")
            lines.append(f"                  {candidate.detail}")
            if candidate.node_id:
                lines.append(f"                  node_id = {candidate.node_id}")
            if candidate.version:
                lines.append(f"                  version = {candidate.version}")
            if candidate.model_ids:
                lines.append(f"                  models = {', '.join(candidate.model_ids[:8])}")
            if candidate.upstream_model:
                lines.append(f'                  upstream_model = "{candidate.upstream_model}"')
            if candidate.completion_status is not None:
                lines.append(f"                  /completion = {candidate.completion_status}")
            if candidate.attachable:
                lines.append(
                    "                  chat template = "
                    + ("reported for this model" if candidate.supports_chat else "not verified")
                )
            if candidate.telemetry:
                contract = ", ".join(candidate.telemetry)
                lines.append(f"                  contract fields = {contract}")
            for note in candidate.notes:
                lines.append(f"                  note: {note}")
        lines.append("")
    else:
        lines += [f"No engine on the {len(CANDIDATE_PORTS)} scanned loopback ports.", ""]

    if ollama_files:
        lines.append("Ollama weights reusable as files (managed mode only, attach is impossible)")
        for entry in ollama_files:
            size = entry["size_bytes"] / 1024**2 if entry["size_bytes"] else 0
            lines.append(f"  {entry['model']:<24} {entry['path']} ({size:.0f} MiB)")
        lines.append("")

    if warnings:
        lines.append("Warnings")
        for warning in warnings:
            lines.append(f"  {warning}")
        lines.append("")

    return "\n".join(lines)


async def _scan(ports, *, check_completion: bool, timeout: float) -> list[Candidate]:
    results = await asyncio.gather(
        *(probe_port(port, check_completion=check_completion, timeout=timeout) for port in ports)
    )
    return sorted((item for item in results if item), key=lambda item: item.port)


def parse_ports(value: str | None) -> tuple[int, ...]:
    if not value:
        return CANDIDATE_PORTS
    ports = []
    for item in value.split(","):
        item = item.strip()
        if not item:
            continue
        if not item.isdigit() or not 1 <= int(item) <= 65535:
            raise ValueError(f"Invalid port: {item}")
        ports.append(int(item))
    return tuple(ports) or CANDIDATE_PORTS


def run_probe(
    *,
    ports: tuple[int, ...] | None = None,
    model_dirs: tuple[Path, ...] = (),
    check_completion: bool = False,
    as_json: bool = False,
    timeout: float = DEFAULT_TIMEOUT,
) -> int:
    """Probe loopback, print a suggestion, and report whether this node is actionable."""
    scanned = ports or CANDIDATE_PORTS
    hardware = discover_hardware()
    candidates = asyncio.run(_scan(scanned, check_completion=check_completion, timeout=timeout))
    ggufs = discover_gguf(list(model_dirs)) if model_dirs else []
    ollama_files = ollama_model_files()
    warnings = _warnings(candidates)
    suggestion = suggest_toml(candidates, hardware, ggufs, model_dirs, ollama_files)
    actionable = any(item.attachable for item in candidates) or bool(
        next(
            (
                hardware.get("binaries", {}).get(name)
                for name in ("llama-server", "ik_llama-server")
            ),
            None,
        )
        and (ggufs or ollama_files)
    )

    if as_json:
        print(
            json.dumps(
                {
                    "schema_version": 1,
                    "actionable": actionable,
                    "hostname": hardware.get("hostname"),
                    "engines": [item.as_dict() for item in candidates],
                    "ollama_weights": ollama_files,
                    "gguf_files": ggufs,
                    "warnings": warnings,
                    "suggested_toml": suggestion,
                },
                indent=2,
            )
        )
    else:
        print(render(candidates, hardware, ggufs, ollama_files, warnings))
        print("Suggested node config")
        print()
        print(suggestion)
        print()
        if actionable:
            print("Next: save the block above, then `dendrite inspect --config <file>`.")
        else:
            print(
                "Nothing actionable yet. This node needs a llama.cpp-family server or a\n"
                "llama-server binary plus a GGUF before it can serve the fabric."
            )
    return EXIT_ACTIONABLE if actionable else EXIT_NOTHING_FOUND
