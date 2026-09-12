import asyncio
import hmac
import logging
import os
import time
from contextlib import asynccontextmanager, suppress

import httpx
from fastapi import Depends, FastAPI, Header
from fastapi.responses import JSONResponse

from dendrite.config import Config
from dendrite.fabric import run_fabric_bridge
from dendrite.node import Node
from dendrite.runtimes.base import RuntimeFailure
from dendrite.schemas import ExecuteRequest, ExecuteResponse, LoadRequest

logger = logging.getLogger(__name__)


async def publish_heartbeats(node: Node, token: str | None):
    headers = {"Authorization": "Bearer " + token} if token else {}
    async with httpx.AsyncClient(timeout=5, trust_env=False, headers=headers) as client:
        while True:
            try:
                await node.refresh_attached()
                # Proposed control-plane contract, documented for the next build phase.
                response = await client.post(
                    node.config.node.control_plane_url.rstrip("/") + "/v1/nodes/heartbeat",
                    json=node.snapshot(),
                )
                response.raise_for_status()
                node.heartbeat.update(last_success_at=time.time(), last_error=None)
            except httpx.HTTPError:
                node.heartbeat["last_error"] = "Control plane heartbeat failed"
                logger.warning("Control plane heartbeat failed; node continues serving locally")
            await asyncio.sleep(node.config.node.heartbeat_seconds)


def create_app(config: Config) -> FastAPI:
    token = os.environ.get(config.node.token_env)
    fabric_token = os.environ.get(config.node.fabric_token_env)
    if config.node.fabric_url and not fabric_token:
        raise ValueError(f"Set {config.node.fabric_token_env} before joining the cloud fabric")
    if config.node.host not in ("127.0.0.1", "::1", "localhost") and not token:
        raise ValueError(f"Set {config.node.token_env} before binding to a network interface")
    if config.node.control_plane_url and not config.node.advertise_url:
        raise ValueError("advertise_url is required when publishing heartbeats")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        node = Node(config)
        app.state.node = node
        heartbeat = None
        fabric_bridge = None
        try:
            await node.start()
            if config.node.control_plane_url:
                heartbeat = asyncio.create_task(publish_heartbeats(node, token))
            if config.node.fabric_url:
                fabric_bridge = asyncio.create_task(run_fabric_bridge(node, fabric_token))
            yield
        finally:
            if fabric_bridge:
                fabric_bridge.cancel()
                with suppress(asyncio.CancelledError):
                    await fabric_bridge
            if heartbeat:
                heartbeat.cancel()
                with suppress(asyncio.CancelledError):
                    await heartbeat
            await node.close()

    app = FastAPI(title="Dendrite", version="0.1.0", lifespan=lifespan)

    async def authorize(authorization: str | None = Header(default=None)):
        if token and not hmac.compare_digest(authorization or "", "Bearer " + token):
            raise RuntimeFailure("Invalid or missing Dendrite token", 401)

    protected = [Depends(authorize)]

    @app.exception_handler(RuntimeFailure)
    async def runtime_error(_request, exc: RuntimeFailure):
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.detail},
            headers={"Retry-After": "1"} if exc.status_code == 429 else None,
        )

    @app.get("/healthz")
    async def health():
        return {"status": "ok", "node_id": config.node.id}

    @app.get("/v1/node", dependencies=protected)
    async def snapshot():
        await app.state.node.refresh_attached()
        return app.state.node.snapshot()

    @app.post("/v1/execute", response_model=ExecuteResponse, dependencies=protected)
    async def execute(request: ExecuteRequest):
        return await app.state.node.execute(request)

    @app.post("/v1/models/load", dependencies=protected)
    async def load(request: LoadRequest):
        return await app.state.node.load(request.model_id)

    @app.post("/v1/runtimes/{runtime_id}/unload", dependencies=protected)
    async def unload(runtime_id: str):
        runtime = app.state.node.runtimes.get(runtime_id)
        if not runtime:
            raise RuntimeFailure("Unknown runtime", 404)
        await runtime.unload()
        return runtime.snapshot()

    return app
