"""Opt-in outbound bridge to the Cloudflare fabric. Native inference remains local."""

import asyncio
import json
import logging
import random
from urllib.parse import urlencode, urlsplit, urlunsplit

from pydantic import ValidationError
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from dendrite.node import Node
from dendrite.runtimes.base import RuntimeFailure
from dendrite.schemas import ExecuteRequest

logger = logging.getLogger(__name__)


def connection_url(origin: str, node_id: str) -> str:
    url = urlsplit(origin)
    return urlunsplit(
        (
            "wss" if url.scheme == "https" else "ws",
            url.netloc,
            "/v1/nodes/connect",
            urlencode({"node_id": node_id}),
            "",
        )
    )


def cloud_snapshot(node: Node) -> dict:
    snapshot = node.snapshot()
    # The cloud needs capacities, not native binary paths, process IDs, or local errors.
    return {
        key: snapshot[key]
        for key in (
            "schema_version",
            "node_id",
            "observed_at",
            "uptime_seconds",
            "execution_scope",
            "active_requests",
            "performance",
            "models",
            "load",
        )
    } | {
        "hardware": {
            key: value for key, value in snapshot["hardware"].items() if key != "binaries"
        },
        "runtimes": [
            {
                key: value
                for key, value in runtime.items()
                if key not in ("process_id", "last_error")
            }
            for runtime in snapshot["runtimes"]
        ],
    }


async def serve_connection(node: Node, ws):
    active: dict[str, asyncio.Task] = {}
    completed: set[str] = set()
    probe_task: asyncio.Task | None = None

    async def send(payload: dict):
        await ws.send(json.dumps(payload))

    async def heartbeats():
        while True:
            await node.refresh_attached()
            await send({"type": "heartbeat", "snapshot": cloud_snapshot(node)})
            await asyncio.sleep(min(node.config.node.heartbeat_seconds, 10))

    async def execute(message: dict):
        job_id = message["job_id"]
        try:
            request = ExecuteRequest.model_validate(message.get("request"))
            result = await node.execute(request, execution_id=job_id)
            await send({"type": "result", "job_id": job_id, "result": result.model_dump()})
        except ValidationError:
            await send(
                {
                    "type": "result",
                    "job_id": job_id,
                    "error": "Invalid node request",
                    "status_code": 422,
                }
            )
        except RuntimeFailure as exc:
            # Don't disclose executable paths or local errors to the cloud.
            await send(
                {
                    "type": "result",
                    "job_id": job_id,
                    "error": "Local runtime could not complete the task",
                    "status_code": exc.status_code,
                }
            )
        except WebSocketException:
            pass
        except Exception:
            logger.exception("Fabric execution failed")
            await send(
                {
                    "type": "result",
                    "job_id": job_id,
                    "error": "Local execution failed",
                    "status_code": 500,
                }
            )
        finally:
            active.pop(job_id, None)
            completed.add(job_id)

    async def receive():
        nonlocal probe_task
        async for raw in ws:
            try:
                message = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(message, dict):
                continue
            if message.get("type") == "probe_chat":
                if probe_task is None or probe_task.done():
                    async def run_probe():
                        await node.probe_chat_profiles()
                        await send({"type": "heartbeat", "snapshot": cloud_snapshot(node)})
                    probe_task = asyncio.create_task(run_probe())
                continue
            if message.get("type") != "execute":
                continue
            job_id = message.get("job_id")
            if not isinstance(job_id, str) or not 1 <= len(job_id) <= 128:
                continue
            if job_id in active or job_id in completed:
                continue  # Never execute the same job twice in a connection.
            if len(completed) >= 1024:
                await ws.close(1000, "Rotate completed job history")
                return
            if len(active) >= len(node.runtimes):
                await send(
                    {
                        "type": "result",
                        "job_id": job_id,
                        "error": "Node has no available execution lane",
                        "status_code": 429,
                    }
                )
                continue
            active[job_id] = asyncio.create_task(execute(message))

    heartbeat = asyncio.create_task(heartbeats())
    receiver = asyncio.create_task(receive())
    try:
        # A failed sender or closed receiver ends this connection and triggers reconnect.
        done, _ = await asyncio.wait([heartbeat, receiver], return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        tasks = [heartbeat, receiver, *active.values()]
        if probe_task is not None:
            tasks.append(probe_task)
        for task in tasks:
            task.cancel()
        # Cancelling runtime execution clears its slot and stops only owned native processes.
        await asyncio.gather(*tasks, return_exceptions=True)


async def run_fabric_bridge(node: Node, token: str):
    url = connection_url(node.config.node.fabric_url, node.config.node.id)
    delay = 1
    while True:
        try:
            async with connect(
                url,
                additional_headers={"Authorization": "Bearer " + token},
                proxy=None,
                max_size=262144,
                max_queue=4,
                open_timeout=10,
                ping_interval=20,
                ping_timeout=20,
                close_timeout=3,
            ) as ws:
                delay = 1
                logger.info("Connected to fabric control plane")
                await serve_connection(node, ws)
        except (OSError, TimeoutError, WebSocketException):
            logger.warning("Fabric connection lost; retrying while local API stays available")
        await asyncio.sleep(delay + random.random())
        delay = min(delay * 2, 30)
