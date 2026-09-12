import asyncio
import json
import socket
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from dendrite.api import create_app, publish_heartbeats
from dendrite.cache import PrefixCache
from dendrite.config import Config, ModelConfig, NodeConfig, RuntimeConfig, load_config
from dendrite.node import Node
from dendrite.runtimes.base import RuntimeFailure
from dendrite.runtimes.llama import LlamaRuntime
from dendrite.schemas import ExecuteRequest

FIXTURE = str(Path(__file__).parent / "fixtures" / "fake_llama_server.py")


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def mock_config(**node_overrides):
    return Config(
        node=NodeConfig(**node_overrides),
        runtimes=[RuntimeConfig(id="demo", kind="mock")],
        models=[
            ModelConfig(id="a", runtime="demo", capabilities=["summarize"]),
            ModelConfig(id="b", runtime="demo", capabilities=["classify"]),
        ],
    )


def req(**overrides):
    return ExecuteRequest(**{"capability": "summarize", "prompt": "hello", **overrides})


@pytest.fixture
def native(tmp_path):
    path = tmp_path / "test.gguf"
    path.write_text("normal")
    model = ModelConfig(id="native-a", runtime="cpu", path=path, capabilities=["summarize"])
    config = RuntimeConfig(
        id="cpu", kind="ik_llama", executable=FIXTURE, port=free_port(), startup_timeout_seconds=2
    )
    return LlamaRuntime(config, NodeConfig()), model


def test_config_references_and_endpoint_constraints():
    with pytest.raises(ValidationError):
        RuntimeConfig(id="x", kind="ik_llama", mode="attach", base_url="http://example.com")
    with pytest.raises(ValidationError):
        Config(
            runtimes=[RuntimeConfig(id="x", kind="mock")],
            models=[ModelConfig(id="a", runtime="missing", capabilities=["x"])],
        )
    config = load_config(Path("configs/dendrite.local.toml"))
    assert config.models[0].path.is_absolute()
    assert config.models[0].path.name == "small-general.gguf"


def test_api_contract_auth_model_switch_and_discovery(monkeypatch):
    monkeypatch.setenv("DENDRITE_API_TOKEN", "test-only")
    app = create_app(mock_config())
    with TestClient(app) as client:
        assert client.get("/healthz").status_code == 200
        assert client.get("/v1/node").status_code == 401
        headers = {"Authorization": "Bearer test-only"}
        assert client.get("/v1/node", headers=headers).json()["hardware"]["logical_cpus"] > 0
        first = client.post(
            "/v1/execute",
            headers=headers,
            json={"capability": "summarize", "prompt": "first", "prefix": "private-prefix: "},
        )
        assert first.status_code == 200
        assert first.json()["simulated"] is True
        assert first.json()["cache"]["reported_cached_tokens"] is None
        again = client.post(
            "/v1/execute",
            headers=headers,
            json={"capability": "summarize", "prompt": "second", "prefix": "private-prefix: "},
        ).json()
        assert again["cache"]["candidate_before_request"] is True
        state = client.get("/v1/node", headers=headers).json()
        assert "private-prefix" not in json.dumps(state)
        assert state["runtimes"][0]["prefix_cache"][0]["portable"] is False
        changed = client.post("/v1/models/load", headers=headers, json={"model_id": "b"})
        assert changed.json()["loaded_model"] == "b"
        assert changed.json()["prefix_cache"] == []
        assert (
            client.post(
                "/v1/execute", headers=headers, json={"capability": "missing", "prompt": "x"}
            ).status_code
            == 404
        )
        assert (
            client.post(
                "/v1/execute",
                headers=headers,
                json={"capability": "summarize", "prompt": "x", "command": "evil"},
            ).status_code
            == 422
        )
        assert (
            client.post("/v1/runtimes/demo/unload", headers=headers).json()["state"] == "unloaded"
        )


def test_lan_bind_requires_token(monkeypatch):
    monkeypatch.delenv("DENDRITE_API_TOKEN", raising=False)
    with pytest.raises(ValueError, match="DENDRITE_API_TOKEN"):
        create_app(mock_config(host="0.0.0.0"))


async def test_busy_lane_rejects_switch_and_releases_after_cancellation():
    config = mock_config()
    config.runtimes[0].mock_delay_seconds = 5
    node = Node(config)
    task = asyncio.create_task(node.execute(req(prefix="P")))
    await asyncio.sleep(0.02)
    with pytest.raises(RuntimeFailure) as error:
        await node.load("b")
    assert error.value.status_code == 429
    with pytest.raises(RuntimeFailure) as error:
        await node.execute(req())
    assert error.value.status_code == 429
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    runtime = node.runtimes["demo"]
    assert not runtime.lock.locked()
    assert runtime.cache.snapshot() == []
    config.runtimes[0].mock_delay_seconds = 0
    assert (await node.execute(req())).model_id == "a"
    await node.close()


async def test_managed_native_inference_cache_switch_and_shutdown(native, tmp_path):
    runtime, model = native
    try:
        first = await runtime.execute(model, req(prefix="prefix: "))
        first_process = runtime.process
        first_instance = runtime.instance
        assert first["content"] == "fixture:native-a:prefix: hello"
        assert (
            first["simulated"] is False
        )  # Adapter contract; fixture itself is not real inference.
        second = await runtime.execute(model, req(prefix="prefix: ", prompt="world"))
        assert second["cache"]["candidate_before_request"] is True
        assert second["cache"]["reported_cached_tokens"] > 0
        await runtime.execute(model, req(prefix="new prefix: "))
        old = await runtime.execute(model, req(prefix="prefix: "))
        assert old["cache"]["candidate_before_request"] is False
        next_path = tmp_path / "next.gguf"
        next_path.write_text("normal")
        other = model.model_copy(update={"id": "native-b", "path": next_path})
        await runtime.load(other)
        assert first_process.returncode is not None
        assert runtime.instance != first_instance
        assert runtime.cache.snapshot() == []
        assert runtime.loaded_model.id == "native-b"
    finally:
        process = runtime.process
        await runtime.close()
        assert process is None or process.returncode is not None


@pytest.mark.parametrize(
    "mode,status",
    [
        ("slow-start", 504),
        ("crash", 503),
        ("bad-json", 502),
        ("error", 503),
    ],
)
async def test_native_failures_are_bounded_and_cleaned(native, mode, status):
    runtime, model = native
    model.path.write_text(mode)
    runtime.config.startup_timeout_seconds = 0.5
    try:
        with pytest.raises(RuntimeFailure) as error:
            await runtime.execute(model, req())
        assert error.value.status_code == status
        assert runtime.process is None
        assert runtime.loaded_model is None
        assert not runtime.lock.locked()
        assert runtime.cache.snapshot() == []
        model.path.write_text("normal")
        assert (await runtime.execute(model, req()))["content"].startswith("fixture:")
    finally:
        await runtime.close()


async def test_generation_timeout_kills_owned_process(native):
    runtime, model = native
    model.path.write_text("slow-infer")
    runtime.node.request_timeout_seconds = 0.5
    try:
        with pytest.raises(RuntimeFailure) as error:
            await runtime.execute(model, req())
        assert error.value.status_code == 504
        assert runtime.process is None
        assert runtime.cache.snapshot() == []
    finally:
        await runtime.close()


async def test_occupied_port_does_not_hijack_or_stop_listener(native):
    runtime, model = native
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", runtime.config.port))
        listener.listen()
        try:
            with pytest.raises(RuntimeFailure, match="already in use"):
                await runtime.execute(model, req())
            assert listener.getsockname()[1] == runtime.config.port
            assert runtime.process is None
        finally:
            await runtime.close()


async def test_attach_identity_and_lifecycle_do_not_touch_external_process(native):
    owner, model = native
    attached = LlamaRuntime(
        RuntimeConfig(id="attached", kind="llama_cpp", mode="attach", base_url=owner.url),
        NodeConfig(),
    )
    try:
        await owner.load(model)
        external = owner.process
        wrong = model.model_copy(update={"upstream_model": "wrong"})
        with pytest.raises(RuntimeFailure, match="expected model"):
            await attached.ensure_loaded(wrong)
        match = model.model_copy(update={"upstream_model": "native-a"})
        await attached.execute(match, req(prefix="private: "))
        assert attached.cache.snapshot() == []
        with pytest.raises(RuntimeFailure, match="another process"):
            await attached.unload()
        await attached.close()
        assert external.returncode is None
        await owner.verify_model(model)
    finally:
        await attached.close()
        await owner.close()


async def test_file_replacement_and_runtime_exit_invalidate_residency(native):
    runtime, model = native
    try:
        await runtime.execute(model, req(prefix="P"))
        old_instance = runtime.instance
        model.path.write_text("normal ")
        await runtime.load(model)
        assert runtime.instance != old_instance
        assert runtime.cache.snapshot() == []
        runtime.process.kill()
        await runtime.process.wait()
        assert runtime.snapshot()["loaded_model"] is None
        assert runtime.snapshot()["prefix_cache"] == []
    finally:
        await runtime.close()


async def test_truncation_does_not_advertise_prefix(native):
    runtime, model = native
    model.path.write_text("truncated")
    try:
        await runtime.execute(model, req(prefix="prefix"))
        assert runtime.cache.snapshot() == []
    finally:
        await runtime.close()


def test_cache_expiry():
    cache = PrefixCache(300)
    cache.record("P", "runtime", "model", False)
    cache.entry["expires_at"] = time.time() - 1
    assert cache.snapshot() == []
    assert not cache.matches("P", "runtime", "model")


async def test_heartbeat_contract_and_failure_do_not_stop_node(monkeypatch):
    node = Node(
        mock_config(control_plane_url="http://control-plane", advertise_url="http://node:8090")
    )
    calls = []
    client_type = httpx.AsyncClient

    def handler(request):
        calls.append(request)
        return httpx.Response(503)

    def client(**kwargs):
        return client_type(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr("dendrite.api.httpx.AsyncClient", client)
    task = asyncio.create_task(publish_heartbeats(node, "test-secret"))
    await asyncio.sleep(0.03)
    try:
        assert calls[0].url.path == "/v1/nodes/heartbeat"
        assert json.loads(calls[0].content)["node_id"] == "dendrite-local"
        assert node.heartbeat["last_error"]
        assert (await node.execute(req())).content.startswith("[SIMULATED")
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await node.close()
