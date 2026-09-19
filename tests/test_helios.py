import json
import re

import httpx
import pytest
from pydantic import ValidationError

from dendrite.config import Config, ModelConfig, RuntimeConfig
from dendrite.node import Node
from dendrite.runtimes.base import RuntimeFailure
from dendrite.schemas import ExecuteRequest


def helios_config() -> Config:
    return Config(
        runtimes=[
            RuntimeConfig(
                id=name,
                kind="helios",
                mode="attach",
                base_url="http://127.0.0.1:8471",
                api_token_env="TEST_HELIOS_TOKEN",
            )
            for name in ("gpu-pair", "v100")
        ],
        models=[
            ModelConfig(
                id="fabric-" + name,
                runtime=name,
                upstream_model="helios-" + name,
                capabilities=["complete"],
            )
            for name in ("gpu-pair", "v100")
        ],
    )


async def mock_helios(node: Node, handler):
    for runtime in node.runtimes.values():
        await runtime.client.aclose()
        runtime.client = httpx.AsyncClient(
            base_url="http://127.0.0.1:8471",
            headers={"Authorization": "Bearer local-secret"},
            transport=httpx.MockTransport(handler),
            trust_env=False,
            follow_redirects=False,
        )


@pytest.mark.asyncio
async def test_chat_setup_probe_advertises_verified_format_for_current_hot_instance(monkeypatch):
    monkeypatch.setenv("TEST_HELIOS_TOKEN", "local-secret")
    node = Node(helios_config())
    instance = "cpp-3"
    posts = []

    def handler(request):
        if request.url.path == "/v1/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "helios-gpu-pair"}]})
        if request.url.path == "/v1/runtime-instances":
            return httpx.Response(200, json=[
                {"id": instance, "model_id": "helios-gpu-pair", "lifecycle": "hot"}
            ])
        assert request.url.path == "/v1/completions"
        body = json.loads(request.content)
        posts.append(body)
        assert body["max_tokens"] == 32
        assert "<think>\n\n</think>" in body["prompt"]
        challenge = re.search(r"FABRIC_[0-9A-F]{8}", body["prompt"]).group()
        return httpx.Response(200, json={
            "model": "helios-gpu-pair",
            "choices": [{"index": 0, "text": challenge, "finish_reason": "stop"}],
        })

    await mock_helios(node, handler)
    try:
        await node.start()
        assert node.snapshot()["runtimes"][0]["chat_profile"] is None
        profiles = await node.probe_chat_profiles()
        assert profiles == [node.snapshot()["runtimes"][0]["chat_profile"]]
        assert profiles[0]["status"] == "verified"
        assert profiles[0]["format"] == "raw_chatml_no_think"
        assert profiles[0]["upstream_instance_id"] == "cpp-3"
        assert len(posts) == 1
        instance = "cpp-4"
        await node.refresh_attached()
        assert node.snapshot()["runtimes"][0]["chat_profile"] is None
    finally:
        await node.close()


def test_helios_config_requires_authenticated_numeric_loopback(monkeypatch):
    with pytest.raises(ValidationError, match="must attach"):
        RuntimeConfig(id="h", kind="helios", api_token_env="HELIOS_TOKEN")
    with pytest.raises(ValidationError, match="api_token_env"):
        RuntimeConfig(id="h", kind="helios", mode="attach", base_url="http://127.0.0.1:8471")
    with pytest.raises(ValidationError, match="explicit 127.0.0.1"):
        RuntimeConfig(
            id="h",
            kind="helios",
            mode="attach",
            base_url="http://localhost:8471",
            api_token_env="HELIOS_TOKEN",
        )
    monkeypatch.delenv("TEST_HELIOS_TOKEN", raising=False)
    with pytest.raises(ValueError, match="TEST_HELIOS_TOKEN"):
        Node(helios_config())


@pytest.mark.asyncio
async def test_two_hot_helios_models_share_queue_boundary_without_cache(monkeypatch):
    monkeypatch.setenv("TEST_HELIOS_TOKEN", "local-secret")
    node = Node(helios_config())
    posts = []

    def handler(request):
        assert request.url.host == "127.0.0.1"
        assert request.headers["Authorization"] == "Bearer local-secret"
        if request.url.path == "/v1/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/models":
            return httpx.Response(
                200,
                json={"data": [{"id": "helios-gpu-pair"}, {"id": "helios-v100"}]},
            )
        if request.url.path == "/v1/runtime-instances":
            return httpx.Response(
                200,
                json=[
                    {"id": "cpp-3", "model_id": "helios-gpu-pair", "lifecycle": "hot"},
                    {"id": "cpp-7", "model_id": "helios-v100", "lifecycle": "hot"},
                ],
            )
        if request.url.path == "/v1/completions":
            body = json.loads(request.content)
            posts.append((request, body))
            return httpx.Response(
                200,
                json={
                    "model": body["model"],
                    "choices": [{"index": 0, "text": "done", "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 4, "completion_tokens": 1},
                },
            )
        raise AssertionError(request.url.path)

    await mock_helios(node, handler)
    try:
        await node.start()
        state = node.snapshot()
        assert [model["resident"] for model in state["models"]] == [True, True]
        assert [model["available"] for model in state["models"]] == [True, True]
        for name in ("gpu-pair", "v100"):
            result = await node.execute(
                ExecuteRequest(
                    capability="complete",
                    model_id="fabric-" + name,
                    prefix="private: ",
                    prompt="test",
                ),
                execution_id="fabric-job-" + name,
            )
            assert result.model_id == "fabric-" + name
            assert result.request_id == "fabric-job-" + name
            assert result.simulated is False
            assert result.cache["candidate_before_request"] is False
            assert result.cache["reuse_attempted"] is False
            assert result.cache["reported_cached_tokens"] is None
        assert [body["model"] for _, body in posts] == ["helios-gpu-pair", "helios-v100"]
        assert all(body["prompt"] == "private: test" for _, body in posts)
        assert posts[0][0].headers["Idempotency-Key"].endswith("fabric-job-gpu-pair")
        assert posts[1][0].headers["Idempotency-Key"].endswith("fabric-job-v100")
        assert all(request.headers["X-Ganglion-Purpose"] == "fabric" for request, _ in posts)
        assert all(not runtime.cache.snapshot() for runtime in node.runtimes.values())
    finally:
        await node.close()


@pytest.mark.asyncio
async def test_helios_rejects_wrong_model_and_quarantines_uncertain_result(monkeypatch):
    monkeypatch.setenv("TEST_HELIOS_TOKEN", "local-secret")
    node = Node(helios_config())

    def handler(request):
        if request.url.path == "/v1/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "helios-gpu-pair"}]})
        if request.url.path == "/v1/runtime-instances":
            return httpx.Response(
                200, json=[{"id": "cpp-3", "model_id": "helios-gpu-pair", "lifecycle": "hot"}]
            )
        return httpx.Response(
            200,
            json={
                "model": "other-model",
                "choices": [{"index": 0, "text": "wrong", "finish_reason": "stop"}],
                "usage": {},
            },
        )

    await mock_helios(node, handler)
    try:
        await node.start()
        request = ExecuteRequest(capability="complete", model_id="fabric-gpu-pair", prompt="test")
        with pytest.raises(RuntimeFailure, match="invalid JSON"):
            await node.execute(request)
        runtime = node.runtimes["gpu-pair"]
        assert runtime.quarantined is True
        await node.refresh_attached()
        assert node.model_available(node.config.models[0]) is False
    finally:
        await node.close()


@pytest.mark.asyncio
async def test_helios_queue_rejection_does_not_quarantine(monkeypatch):
    monkeypatch.setenv("TEST_HELIOS_TOKEN", "local-secret")
    node = Node(helios_config())

    def handler(request):
        if request.url.path == "/v1/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "helios-gpu-pair"}]})
        if request.url.path == "/v1/runtime-instances":
            return httpx.Response(
                200, json=[{"id": "cpp-3", "model_id": "helios-gpu-pair", "lifecycle": "hot"}]
            )
        return httpx.Response(429, json={"error": "queue full"})

    await mock_helios(node, handler)
    try:
        await node.start()
        with pytest.raises(RuntimeFailure) as exc:
            await node.execute(
                ExecuteRequest(capability="complete", model_id="fabric-gpu-pair", prompt="test")
            )
        assert exc.value.status_code == 429
        assert node.runtimes["gpu-pair"].quarantined is False
        await node.refresh_attached()
        assert node.model_available(node.config.models[0]) is True
    finally:
        await node.close()


@pytest.mark.asyncio
async def test_helios_hot_instance_loss_does_not_quarantine_without_work(monkeypatch):
    monkeypatch.setenv("TEST_HELIOS_TOKEN", "local-secret")
    node = Node(helios_config())
    hot = True

    def handler(request):
        if request.url.path == "/v1/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "helios-gpu-pair"}]})
        if request.url.path == "/v1/runtime-instances":
            return httpx.Response(
                200,
                json=(
                    [{"id": "cpp-3", "model_id": "helios-gpu-pair", "lifecycle": "hot"}]
                    if hot
                    else []
                ),
            )
        raise AssertionError("No completion should be sent after hot instance loss")

    await mock_helios(node, handler)
    try:
        await node.start()
        hot = False
        runtime = node.runtimes["gpu-pair"]
        with pytest.raises(RuntimeFailure, match="exactly one hot instance"):
            await runtime.execute(
                node.config.models[0], ExecuteRequest(capability="complete", prompt="test")
            )
        assert runtime.quarantined is False
        await node.refresh_attached()
        assert node.model_available(node.config.models[0]) is False
    finally:
        await node.close()


@pytest.mark.asyncio
async def test_chat_uses_helios_template_endpoint_and_preserves_raw_contract(monkeypatch):
    monkeypatch.setenv("TEST_HELIOS_TOKEN", "local-secret")
    node = Node(helios_config())
    posted = []

    def handler(request):
        if request.url.path == "/v1/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "helios-gpu-pair"}]})
        if request.url.path == "/v1/runtime-instances":
            return httpx.Response(
                200, json=[{"id": "cpp-3", "model_id": "helios-gpu-pair", "lifecycle": "hot"}]
            )
        posted.append((request.url.path, json.loads(request.content), request.headers))
        return httpx.Response(
            200,
            json={
                "model": "helios-gpu-pair",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "4"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 12, "completion_tokens": 1},
            },
        )

    await mock_helios(node, handler)
    try:
        await node.start()
        assert node.snapshot()["runtimes"][0]["supports_chat"] is True
        result = await node.execute(
            ExecuteRequest(
                capability="complete",
                model_id="fabric-gpu-pair",
                messages=[{"role": "user", "content": "What is 2+2?"}],
                max_tokens=16,
            ),
            execution_id="fabric-job-chat",
        )
        assert result.content == "4"
        assert result.cache["reuse_attempted"] is False
        path, body, headers = posted[0]
        assert path == "/v1/chat/completions"
        assert body["model"] == "helios-gpu-pair"
        assert body["messages"] == [{"role": "user", "content": "What is 2+2?"}]
        assert "prompt" not in body
        assert headers["Idempotency-Key"].endswith("fabric-job-chat")
    finally:
        await node.close()


def test_chat_schema_rejects_ambiguous_or_unbounded_input():
    base = {"capability": "complete"}
    messages = [{"role": "user", "content": "hello"}]
    for extra in (
        {},
        {"prompt": "raw", "messages": messages},
        {"messages": messages, "prefix": "prefix"},
        {"messages": [{"role": "tool", "content": "x"}]},
        {"messages": [{"role": "user", "content": "x" * 65537}]},
        {"messages": [{"role": "assistant", "content": "no user turn"}]},
        {"messages": [{"role": "user", "content": "x"}, {"role": "system", "content": "late"}]},
    ):
        with pytest.raises(ValidationError):
            ExecuteRequest(**(base | extra))
