import contextlib
import json
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

from dendrite.probe import (
    ATTACH_READY,
    DENDRITE,
    LLAMA_FAMILY,
    MANAGED_ALIAS,
    OLLAMA,
    OPENAI_ONLY,
    Candidate,
    ollama_model_files,
    parse_ports,
    probe_port,
    run_probe,
    suggest_toml,
)

FIXTURE = str(Path(__file__).parent / "fixtures" / "fake_llama_server.py")
ALIAS = "qwen3-1.7b"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_ready(port, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            httpx.get(f"http://127.0.0.1:{port}/health", timeout=0.5)
            return
        except httpx.HTTPError:
            time.sleep(0.05)
    raise AssertionError(f"fixture on port {port} never became ready")


@pytest.fixture
def fake_native(tmp_path):
    """Launch the protocol fixture on a free loopback port; the probe only reads it."""
    processes = []

    def launch(mode="normal", alias=ALIAS):
        stub = tmp_path / f"{mode}.gguf"
        stub.write_text(f"GGUF:{mode}")
        port = free_port()
        process = subprocess.Popen(
            [sys.executable, FIXTURE, "--model", str(stub), "--alias", alias, "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        processes.append(process)
        wait_ready(port)
        return port

    yield launch
    for process in processes:
        process.terminate()
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=3)


@contextlib.contextmanager
def json_server(routes):
    """Serve a fixed {path: payload} map on loopback; every other path is 404."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            payload = routes.get(self.path)
            if payload is None:
                self.send_response(404)
                self.end_headers()
                return
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


async def test_probe_verifies_the_native_contract(fake_native):
    port = fake_native()
    candidate = await probe_port(port, check_completion=True)
    assert candidate.kind == ATTACH_READY
    assert candidate.upstream_model == ALIAS
    assert candidate.completion_status == 200
    assert candidate.supports_chat is True
    assert "timings" in candidate.telemetry
    assert "tokens_evaluated" in candidate.telemetry
    assert candidate.notes == []
    assert candidate.as_dict()["kind"] == ATTACH_READY


async def test_probe_without_contract_check_does_not_claim_attach_ready(fake_native):
    port = fake_native()
    candidate = await probe_port(port)
    assert candidate.kind == LLAMA_FAMILY
    assert any("--check-completion" in note for note in candidate.notes)
    assert candidate.completion_status is None
    assert candidate.supports_chat is True


async def test_probe_does_not_claim_chat_when_props_model_differs():
    with json_server(
        {
            "/health": {"status": "ok"},
            "/v1/models": {"data": [{"id": ALIAS}]},
            "/props": {"model_alias": "other", "chat_template": "{{ messages }}"},
        }
    ) as port:
        candidate = await probe_port(port)
    assert candidate.kind == LLAMA_FAMILY
    assert candidate.supports_chat is False
    assert candidate.as_dict()["supports_chat"] is False


async def test_probe_flags_a_missing_cache_n(fake_native):
    port = fake_native(mode="legacy-cache")
    candidate = await probe_port(port, check_completion=True)
    assert candidate.kind == ATTACH_READY
    assert any("cache_n" in note for note in candidate.notes)


async def test_probe_identifies_dendrite_and_ollama():
    with json_server({"/healthz": {"status": "ok", "node_id": "pver730xd"}}) as port:
        candidate = await probe_port(port)
    assert candidate.kind == DENDRITE
    assert candidate.node_id == "pver730xd"

    with json_server({"/api/version": {"version": "0.32.15"}}) as port:
        candidate = await probe_port(port)
    assert candidate.kind == OLLAMA
    assert candidate.version == "0.32.15"
    assert candidate.attachable is False


async def test_probe_labels_an_openai_only_endpoint_as_unattachable():
    with json_server({"/v1/models": {"data": [{"id": "meta-llama/Llama-3-8B"}]}}) as port:
        candidate = await probe_port(port)
    assert candidate.kind == OPENAI_ONLY
    assert candidate.attachable is False
    assert candidate.model_ids == ["meta-llama/Llama-3-8B"]


async def test_probe_refuses_to_attach_to_another_nodes_managed_runtime(fake_native):
    """A managed alias means an owning Dendrite will stop this process on switch/unload."""
    port = fake_native(alias=f"{ALIAS}@c7426464-f5f1-4dde-ab8e-90694b1987e2")
    candidate = await probe_port(port, check_completion=True)
    assert candidate.kind == MANAGED_ALIAS
    assert candidate.attachable is False
    assert candidate.completion_status is None  # no request is sent to a runtime we will not use
    assert any("stops this process" in note for note in candidate.notes)


def test_run_probe_warns_about_an_orphaned_managed_runtime(fake_native, capsys):
    port = fake_native(alias=f"{ALIAS}@orphaned-instance")
    run_probe(ports=(port,), as_json=True)
    payload = json.loads(capsys.readouterr().out)
    assert payload["engines"][0]["kind"] == MANAGED_ALIAS
    assert any("orphaned" in warning for warning in payload["warnings"])


async def test_probe_returns_none_for_a_closed_port():
    assert await probe_port(free_port()) is None


async def test_probe_prefers_a_real_model_id_over_a_managed_alias(fake_native):
    port = fake_native()
    candidate = await probe_port(port)
    assert candidate.upstream_model == ALIAS
    assert "@" in f"{ALIAS}@{port}"  # the alias form a managed runtime would advertise


def test_ollama_model_files_maps_only_gguf_blobs(tmp_path, monkeypatch):
    """Manifest digests are Docker-style "sha256:<hex>"; the blob file is "sha256-<hex>"."""
    root = tmp_path / "models"
    manifest = root / "manifests" / "registry.ollama.ai" / "library" / "qwen3" / "1.7b"
    manifest.parent.mkdir(parents=True)
    model_hex = "a" * 64
    config_hex = "b" * 64
    blobs = root / "blobs"
    blobs.mkdir()
    (blobs / f"sha256-{model_hex}").write_bytes(b"GGUF" + b"\x00" * 32)
    (blobs / f"sha256-{config_hex}").write_text('{"model_format": "gguf"}')
    manifest.write_text(
        json.dumps(
            {
                "layers": [
                    {
                        "mediaType": "application/vnd.ollama.image.model",
                        "digest": f"sha256:{model_hex}",
                    },
                    {
                        "mediaType": "application/vnd.ollama.image.params",
                        "digest": f"sha256:{config_hex}",
                    },
                ]
            }
        )
    )
    monkeypatch.setenv("OLLAMA_MODELS", str(root))
    found = ollama_model_files()
    assert len(found) == 1
    assert found[0]["model"] == "qwen3/1.7b"
    assert found[0]["path"].endswith(f"sha256-{model_hex}")


def test_ollama_model_files_accepts_a_hyphenated_digest(tmp_path, monkeypatch):
    root = tmp_path / "models"
    manifest = root / "manifests" / "registry.ollama.ai" / "library" / "llama3" / "8b"
    manifest.parent.mkdir(parents=True)
    digest_hex = "c" * 64
    blobs = root / "blobs"
    blobs.mkdir()
    (blobs / f"sha256-{digest_hex}").write_bytes(b"GGUF" + b"\x00" * 32)
    manifest.write_text(json.dumps({"layers": [{"digest": f"sha256-{digest_hex}"}]}))
    monkeypatch.setenv("OLLAMA_MODELS", str(root))
    found = ollama_model_files()
    assert [entry["model"] for entry in found] == ["llama3/8b"]


def test_ollama_model_files_skips_cloud_manifests(tmp_path, monkeypatch):
    """Cloud entries carry "layers": null and must not crash or match."""
    root = tmp_path / "models"
    manifest = root / "manifests" / "registry.ollama.ai" / "library" / "glm-5" / "cloud"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({"layers": None}))
    monkeypatch.setenv("OLLAMA_MODELS", str(root))
    assert ollama_model_files() == []


def test_ollama_model_files_is_silent_without_a_store(tmp_path, monkeypatch):
    monkeypatch.setenv("OLLAMA_MODELS", str(tmp_path / "absent"))
    assert ollama_model_files() == []


def test_parse_ports_validates_and_defaults():
    assert parse_ports(None)
    assert parse_ports("8123, 8124") == (8123, 8124)
    with pytest.raises(ValueError):
        parse_ports("eighty")
    with pytest.raises(ValueError):
        parse_ports("70000")


def test_suggest_toml_prefers_attach_and_avoids_a_discovered_port():
    hardware = {
        "hostname": "pver730xd",
        "binaries": {"llama-server": "/usr/bin/llama-server"},
        "physical_cpus": 8,
        "logical_cpus": 16,
    }
    attached = Candidate(
        port=8080,
        kind=ATTACH_READY,
        upstream_model=ALIAS,
        model_ids=[ALIAS],
    )
    text = suggest_toml([attached], hardware, [], ())
    assert 'mode = "attach"' in text
    assert 'base_url = "http://127.0.0.1:8080"' in text
    assert f'upstream_model = "{ALIAS}"' in text
    assert "[[models]]" in text

    # With no attachable server, a managed runtime must not reuse a port already in use.
    managed = suggest_toml([Candidate(port=8081, kind=OPENAI_ONLY)], hardware, [], ())
    assert 'executable = "/usr/bin/llama-server"' in managed
    assert "port = 8081" not in managed
    assert "threads = 8" in managed
    assert "nothing is fetched automatically" in managed


def test_suggest_toml_uses_discovered_ggufs_and_model_dirs():
    hardware = {"hostname": "n1", "binaries": {}, "physical_cpus": 4}
    ggufs = [{"name": "qwen2.5-0.5b-instruct-q4_k_m.gguf", "size_bytes": 1}]
    text = suggest_toml([], hardware, ggufs, (Path("../models"),))
    assert 'model_dirs = ["../models"]' in text
    assert 'path = "qwen2.5-0.5b-instruct-q4_k_m.gguf"' in text
    assert "no llama-server on PATH" in text


def test_suggest_toml_reuses_existing_ollama_weights_as_files():
    hardware = {"hostname": "n1", "binaries": {"llama-server": "/usr/bin/llama-server"}}
    weights = [
        {"model": "qwen3/1.7b", "path": "/root/.ollama/models/blobs/sha256-abc", "size_bytes": 1}
    ]
    text = suggest_toml([], hardware, [], (), weights)
    assert 'id = "qwen3-1.7b"' in text
    assert 'path = "/root/.ollama/models/blobs/sha256-abc"' in text
    assert "does not involve Ollama" in text


def test_suggest_toml_reports_nothing_on_a_closed_port(capsys):
    port = free_port()
    assert run_probe(ports=(port,)) == 1
    assert "nothing written" in capsys.readouterr().out


def test_run_probe_json_is_machine_readable_on_a_live_engine(fake_native, capsys):
    port = fake_native()
    assert run_probe(ports=(port,), check_completion=True, as_json=True) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["schema_version"] == 1
    assert payload["actionable"] is True
    assert payload["engines"][0]["kind"] == ATTACH_READY
    assert 'mode = "attach"' in payload["suggested_toml"]
