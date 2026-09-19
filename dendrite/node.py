import asyncio
import shutil
import time
import uuid

from dendrite.config import Config, ModelConfig
from dendrite.hardware import current_load, discover_gguf, discover_hardware, file_identity
from dendrite.performance import PerformanceTracker
from dendrite.runtimes.base import RuntimeFailure
from dendrite.runtimes.helios import HeliosRuntime
from dendrite.runtimes.llama import LlamaRuntime
from dendrite.runtimes.mock import MockRuntime
from dendrite.schemas import ExecuteRequest, ExecuteResponse


class Node:
    def __init__(self, config: Config):
        self.config = config
        self.started_at = time.time()
        self.hardware = discover_hardware()
        self.discovered_models = discover_gguf(config.node.model_dirs)
        self.performance = PerformanceTracker()
        runtime_classes = {"mock": MockRuntime, "helios": HeliosRuntime}
        self.runtimes = {
            cfg.id: runtime_classes.get(cfg.kind, LlamaRuntime)(cfg, config.node)
            for cfg in config.runtimes
        }
        self.heartbeat = {
            "enabled": bool(config.node.control_plane_url),
            "last_success_at": None,
            "last_error": None,
        }

    async def start(self):
        # Attachment is observational. Configured managed models stay cold until requested.
        await self.refresh_attached()

    async def refresh_attached(self):
        await asyncio.gather(
            *(
                runtime.observe_attached(
                    [m for m in self.config.models if m.runtime == runtime.config.id]
                )
                for runtime in self.runtimes.values()
                if runtime.config.mode == "attach"
            )
        )

    async def probe_chat_profiles(self) -> list[dict]:
        """Explicit, bounded setup probe for already attached Helios models."""
        await self.refresh_attached()
        checks = [
            (runtime, runtime.loaded_model)
            for runtime in self.runtimes.values()
            if isinstance(runtime, HeliosRuntime) and runtime.loaded_model is not None
        ]
        async def check(runtime: HeliosRuntime, model: ModelConfig) -> dict:
            try:
                return await runtime.probe_chat(model)
            except RuntimeFailure:
                return {"status": "unverified", "model_id": model.id}
        return await asyncio.gather(
            *(check(runtime, model) for runtime, model in checks)
        )

    def model_available(self, model: ModelConfig) -> bool:
        runtime = self.runtimes[model.runtime]
        if runtime.simulated:
            return True
        if runtime.config.mode == "attach":
            return runtime.loaded_model == model and runtime.state in ("ready", "generating")
        return file_identity(model.path)["cached_on_disk"] and bool(
            shutil.which(runtime.config.executable)
        )

    def snapshot(self) -> dict:
        runtimes = [runtime.snapshot() for runtime in self.runtimes.values()]
        models = []
        for model in self.config.models:
            runtime = self.runtimes[model.runtime]
            models.append(
                {
                    "id": model.id,
                    "runtime": model.runtime,
                    "capabilities": model.capabilities,
                    **file_identity(model.path),
                    "resident": runtime.loaded_model == model,
                    "available": self.model_available(model),
                    "simulated": runtime.simulated,
                }
            )
        return {
            "schema_version": "1",
            "node_id": self.config.node.id,
            "observed_at": time.time(),
            "uptime_seconds": time.time() - self.started_at,
            "execution_scope": "local",
            "advertise_url": self.config.node.advertise_url,
            "hardware": self.hardware,
            "load": current_load(),
            "active_requests": sum(r.lock.locked() for r in self.runtimes.values()),
            "performance": self.performance.snapshot(),
            "runtimes": runtimes,
            "models": models,
            "discovered_gguf": self.discovered_models,
            "heartbeat": dict(self.heartbeat),
        }

    def select(self, request: ExecuteRequest) -> ModelConfig:
        candidates = [
            m
            for m in self.config.models
            if request.capability in m.capabilities
            and (request.model_id is None or m.id == request.model_id)
            and (request.messages is None or self.runtimes[m.runtime].supports_chat)
        ]
        if not candidates:
            if request.messages is not None:
                raise RuntimeFailure("No chat-capable model satisfies this selection", 404)
            raise RuntimeFailure(
                "No configured model satisfies this capability/model selection", 404
            )
        available = [m for m in candidates if self.model_available(m)]
        if not available:
            raise RuntimeFailure("Matching models exist but no local runtime/model is available")
        idle = [m for m in available if not self.runtimes[m.runtime].lock.locked()]
        if not idle:
            raise RuntimeFailure("All matching runtimes are busy", 429)
        # Node-local selection only. Cluster scheduling belongs to Ganglion.
        return min(
            idle,
            key=lambda m: (
                self.runtimes[m.runtime].loaded_model != m,
                self.runtimes[m.runtime].simulated,
            ),
        )

    async def execute(
        self, request: ExecuteRequest, execution_id: str | None = None
    ) -> ExecuteResponse:
        await self.refresh_attached()
        model = self.select(request)
        request_id = execution_id or str(uuid.uuid4())
        result = await self.runtimes[model.runtime].execute(model, request, request_id)
        self.performance.observe(result, model.id, model.runtime)
        return ExecuteResponse(
            request_id=request_id,
            node_id=self.config.node.id,
            runtime_id=model.runtime,
            model_id=model.id,
            **result,
        )

    async def load(self, model_id: str):
        model = next((m for m in self.config.models if m.id == model_id), None)
        if not model:
            raise RuntimeFailure("Unknown model", 404)
        await self.runtimes[model.runtime].load(model)
        return self.runtimes[model.runtime].snapshot()

    async def close(self):
        await asyncio.gather(*(runtime.close() for runtime in self.runtimes.values()))
