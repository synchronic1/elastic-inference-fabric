import asyncio
import time
import uuid
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager

from dendrite.cache import PrefixCache
from dendrite.config import ModelConfig, NodeConfig, RuntimeConfig
from dendrite.hardware import file_identity
from dendrite.schemas import ExecuteRequest


class RuntimeFailure(Exception):
    def __init__(self, detail: str, status_code: int = 503):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


class Runtime(ABC):
    def __init__(self, config: RuntimeConfig, node: NodeConfig):
        self.config = config
        self.node = node
        self.lock = asyncio.Lock()
        self.state = "unloaded"
        self.loaded_model: ModelConfig | None = None
        self.fingerprint: str | None = None
        self.instance = str(uuid.uuid4())
        self.cache = PrefixCache(node.cache_ttl_seconds)
        self.last_error: str | None = None
        self.closing = False

    @property
    def simulated(self) -> bool:
        return self.config.kind == "mock"

    @property
    def supports_chat(self) -> bool:
        return self.config.kind == "helios"

    def model_fingerprint(self, model: ModelConfig) -> str | None:
        if self.simulated:
            return "simulated:" + model.id
        return file_identity(model.path)["fingerprint"]

    def reset(self):
        self.loaded_model = None
        self.fingerprint = None
        self.instance = str(uuid.uuid4())
        self.cache.clear()
        self.state = "unloaded"

    @asynccontextmanager
    async def lane(self):
        if self.closing:
            raise RuntimeFailure(f"Runtime {self.config.id} is shutting down")
        # No await between the check and uncontended acquire: no hidden request queue.
        if self.lock.locked():
            raise RuntimeFailure(f"Runtime {self.config.id} is busy", 429)
        await self.lock.acquire()
        try:
            yield
        finally:
            self.lock.release()

    async def execute(
        self, model: ModelConfig, request: ExecuteRequest, execution_id: str | None = None
    ) -> dict:
        async with self.lane():
            self.validate_request(request)
            started = time.monotonic()
            try:
                async with asyncio.timeout(self.node.request_timeout_seconds):
                    await self.ensure_loaded(model)
                    self.state = "generating"
                    candidate = self.cache.matches(request.prefix, self.instance, self.fingerprint)
                    self.cache.clear()  # In-flight slot state must not be advertised as reusable.
                    result = await self.generate(request, execution_id)
                    if self.config.mode == "managed" and not result.get("truncated", False):
                        self.cache.record(
                            request.prefix, self.instance, self.fingerprint, self.simulated
                        )
                    self.state = "ready"
                    self.last_error = None
                    return {
                        "content": result["content"],
                        "simulated": self.simulated,
                        "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
                        "usage": result.get("usage", {}),
                        "cache": {
                            "candidate_before_request": candidate,
                            "reuse_attempted": self.config.mode == "managed"
                            and self.config.kind != "helios",
                            "reported_cached_tokens": result.get("cached_tokens"),
                            "portable": False,
                            "simulated": self.simulated,
                        },
                    }
            except BaseException as exc:
                # Cancellation/timeout may leave a native generation active. Managed adapters
                # stop the owned process; attached adapters quarantine themselves instead.
                await self.abort()
                self.last_error = (
                    "Request cancelled" if isinstance(exc, asyncio.CancelledError) else str(exc)
                )
                self.state = "error"
                if isinstance(exc, TimeoutError):
                    raise RuntimeFailure("Inference deadline exceeded", 504) from exc
                raise

    async def load(self, model: ModelConfig):
        async with self.lane():
            try:
                await self.ensure_loaded(model)
                self.last_error = None
            except BaseException:
                await self.abort()
                self.state = "error"
                raise

    async def unload(self):
        async with self.lane():
            if self.config.mode == "attach":
                raise RuntimeFailure("Cannot unload a runtime owned by another process", 409)
            await self.stop()

    def snapshot(self) -> dict:
        return {
            "id": self.config.id,
            "kind": self.config.kind,
            "mode": self.config.mode,
            "state": self.state,
            "busy": self.lock.locked(),
            "simulated": self.simulated,
            "loaded_model": self.loaded_model.id if self.loaded_model else None,
            "runtime_instance": self.instance,
            "model_fingerprint": self.fingerprint,
            "prefix_cache": self.cache.snapshot(),
            "last_error": self.last_error,
            "supports_model_switch": self.config.mode == "managed",
            "supports_cache_transfer": False,
            "supports_chat": self.supports_chat,
        }

    @abstractmethod
    async def ensure_loaded(self, model: ModelConfig): ...

    def validate_request(self, request: ExecuteRequest):
        """Reject invalid work before loading or disturbing a resident model."""

    @abstractmethod
    async def generate(self, request: ExecuteRequest, execution_id: str | None = None) -> dict: ...

    @abstractmethod
    async def stop(self): ...

    async def abort(self):
        await self.stop()

    async def close(self):
        self.closing = True
        # Drain the bounded active request before stopping; no late result can resurrect state.
        async with self.lock:
            await self.stop()
