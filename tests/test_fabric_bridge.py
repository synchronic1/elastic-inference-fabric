import asyncio
import json

import pytest
from pydantic import ValidationError
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from dendrite.api import create_app
from dendrite.config import Config, ModelConfig, NodeConfig, RuntimeConfig
from dendrite.fabric import cloud_snapshot, connection_url, serve_connection
from dendrite.node import Node


def config():
    return Config(
        node=NodeConfig(id="bridge-test", heartbeat_seconds=1),
        runtimes=[RuntimeConfig(id="mock", kind="mock")],
        models=[ModelConfig(id="test-model", runtime="mock", capabilities=["complete"])],
    )


@pytest.mark.parametrize(
    "origin", ["http://external.test", "https://x.test/path", "https://u:p@x.test", "file:///tmp/x"]
)
def test_fabric_origin_restrictions(origin):
    with pytest.raises(ValidationError):
        NodeConfig(fabric_url=origin)


def test_fabric_url_and_required_credential(monkeypatch):
    assert (
        connection_url("https://fabric.test", "node 1")
        == "wss://fabric.test/v1/nodes/connect?node_id=node+1"
    )
    assert (
        connection_url("http://127.0.0.1:8787", "n")
        == "ws://127.0.0.1:8787/v1/nodes/connect?node_id=n"
    )
    cfg = config()
    cfg.node.fabric_url = "https://fabric.test"
    monkeypatch.delenv("GANGLION_FABRIC_TOKEN", raising=False)
    with pytest.raises(ValueError, match="GANGLION_FABRIC_TOKEN"):
        create_app(cfg)


def test_cloud_snapshot_omits_local_process_details():
    snapshot = cloud_snapshot(Node(config()))
    assert "binaries" not in snapshot["hardware"]
    assert "last_error" not in snapshot["runtimes"][0]
    assert "process_id" not in snapshot["runtimes"][0]
    assert snapshot["node_id"] == "bridge-test"


async def test_websocket_bridge_heartbeat_execution_duplicates_and_disconnect():
    node = Node(config())
    finished = asyncio.Event()

    async def worker(ws):
        heartbeat = json.loads(await ws.recv())
        assert heartbeat["type"] == "heartbeat"
        assert heartbeat["snapshot"]["node_id"] == "bridge-test"
        message = {
            "type": "execute",
            "job_id": "job-1",
            "request": {
                "capability": "complete",
                "model_id": "test-model",
                "prompt": "hello\nworld",
            },
        }
        await ws.send(json.dumps(message))
        await ws.send(json.dumps(message))
        result = json.loads(await ws.recv())
        assert result["type"] == "result"
        assert result["job_id"] == "job-1"
        assert result["result"]["simulated"] is True
        await ws.send(json.dumps(message))
        # Next message is a heartbeat, not a second execution result.
        assert json.loads(await ws.recv())["type"] == "heartbeat"
        await ws.send(json.dumps({"type": "execute", "job_id": "invalid", "request": {}}))
        invalid = json.loads(await ws.recv())
        assert invalid["status_code"] == 422
        node.config.runtimes[0].mock_delay_seconds = 5
        await ws.send(json.dumps(dict(message, job_id="cancelled")))
        for _ in range(100):
            if node.runtimes["mock"].lock.locked():
                break
            await asyncio.sleep(0.005)
        assert node.runtimes["mock"].lock.locked()
        await ws.close()
        finished.set()

    async with serve(worker, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async with connect(f"ws://127.0.0.1:{port}") as ws:
            await asyncio.wait_for(serve_connection(node, ws), timeout=5)
        assert finished.is_set()
        assert not node.runtimes["mock"].lock.locked()
        assert node.runtimes["mock"].cache.snapshot() == []
    await node.close()
