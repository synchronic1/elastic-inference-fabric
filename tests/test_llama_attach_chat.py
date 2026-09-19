"""Read-only discovery and chat forwarding for an operator-owned llama-server."""

import json

import httpx
import pytest

from dendrite.config import Config, ModelConfig, NodeConfig, RuntimeConfig
from dendrite.node import Node
from dendrite.runtimes.base import RuntimeFailure
from dendrite.schemas import ExecuteRequest


async def attached_node(handler):
    config = Config(
        node=NodeConfig(id="test-attach"),
        runtimes=[
            RuntimeConfig(
                id="existing",
                kind="llama_cpp",
                mode="attach",
                base_url="http://127.0.0.1:18080",
            )
        ],
        models=[
            ModelConfig(
                id="resident",
                runtime="existing",
                upstream_model="upstream-resident",
                capabilities=["complete"],
            )
        ],
    )
    node = Node(config)
    runtime = node.runtimes["existing"]
    await runtime.client.aclose()
    runtime.client = httpx.AsyncClient(
        base_url="http://127.0.0.1:18080",
        transport=httpx.MockTransport(handler),
        trust_env=False,
        follow_redirects=False,
    )
    await node.start()
    return node


def chat_request(max_tokens=256):
    return ExecuteRequest(
        capability="complete",
        messages=[{"role": "user", "content": "What is 2+2?"}],
        max_tokens=max_tokens,
    )


@pytest.mark.parametrize("props", [None, {"model_alias": "other", "chat_template": "X"}])
async def test_attached_llama_without_verified_template_stays_raw_only(props):
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path))
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "upstream-resident"}]})
        if request.url.path == "/props":
            return httpx.Response(200, json=props) if props else httpx.Response(404)
        if request.url.path == "/completion":
            body = json.loads(request.content)
            assert body["prompt"] == "raw"
            assert "id_slot" not in body and "cache_prompt" not in body
            return httpx.Response(200, json={"content": "raw-ok", "timings": {}})
        raise AssertionError(request.url.path)

    node = await attached_node(handler)
    try:
        assert all(method == "GET" for method, _ in calls)
        assert node.snapshot()["runtimes"][0]["supports_chat"] is False
        with pytest.raises(RuntimeFailure, match="No chat-capable model"):
            await node.execute(chat_request())
        result = await node.execute(ExecuteRequest(capability="complete", prompt="raw"))
        assert result.content == "raw-ok"
        assert result.cache["reuse_attempted"] is False
    finally:
        await node.close()


async def test_attached_llama_uses_upstream_chat_template_without_managing_process():
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path))
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "upstream-resident"}]})
        if request.url.path == "/props":
            return httpx.Response(
                200, json={"model_alias": "upstream-resident", "chat_template": "{{ messages }}"}
            )
        if request.url.path == "/v1/chat/completions":
            body = json.loads(request.content)
            assert body == {
                "model": "upstream-resident",
                "messages": [{"role": "user", "content": "What is 2+2?"}],
                "max_tokens": 4096,
                "temperature": 0.2,
                "stream": False,
            }
            return httpx.Response(
                200,
                json={
                    "model": "upstream-resident",
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "4"},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 8, "completion_tokens": 1},
                },
            )
        raise AssertionError(request.url.path)

    node = await attached_node(handler)
    runtime = node.runtimes["existing"]
    try:
        assert all(method == "GET" for method, _ in calls)
        assert node.snapshot()["runtimes"][0]["supports_chat"] is True
        result = await node.execute(chat_request(max_tokens=4096))
        assert result.content == "4"
        assert result.cache["reuse_attempted"] is False
        assert runtime.process is None
        assert runtime.quarantined is False
        assert calls[-1] == ("POST", "/v1/chat/completions")
    finally:
        await node.close()


async def test_missing_chat_endpoint_disables_chat_but_preserves_raw_attachment():
    def handler(request):
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "upstream-resident"}]})
        if request.url.path == "/props":
            return httpx.Response(
                200, json={"model_alias": "upstream-resident", "chat_template": "template"}
            )
        if request.url.path == "/v1/chat/completions":
            return httpx.Response(404)
        if request.url.path == "/completion":
            return httpx.Response(200, json={"content": "still-running", "timings": {}})
        raise AssertionError(request.url.path)

    node = await attached_node(handler)
    runtime = node.runtimes["existing"]
    try:
        with pytest.raises(RuntimeFailure, match="HTTP 404"):
            await node.execute(chat_request())
        assert runtime.quarantined is False
        await node.refresh_attached()
        assert runtime.supports_chat is False
        result = await node.execute(ExecuteRequest(capability="complete", prompt="raw"))
        assert result.content == "still-running"
    finally:
        await node.close()


async def test_malformed_attached_chat_response_quarantines_without_stopping_upstream():
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path))
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "upstream-resident"}]})
        if request.url.path == "/props":
            return httpx.Response(
                200, json={"model_alias": "upstream-resident", "chat_template": "template"}
            )
        if request.url.path == "/v1/chat/completions":
            return httpx.Response(200, json={"model": "wrong-model", "choices": []})
        raise AssertionError(request.url.path)

    node = await attached_node(handler)
    runtime = node.runtimes["existing"]
    try:
        with pytest.raises(RuntimeFailure, match="malformed JSON"):
            await node.execute(chat_request())
        assert runtime.quarantined is True
        assert runtime.process is None
        await node.refresh_attached()
        assert runtime.supports_chat is False
        assert calls.count(("POST", "/v1/chat/completions")) == 1
    finally:
        await node.close()
