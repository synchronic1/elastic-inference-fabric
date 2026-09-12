import asyncio

from dendrite.config import ModelConfig
from dendrite.runtimes.base import Runtime
from dendrite.schemas import ExecuteRequest


class MockRuntime(Runtime):
    """Deterministic plumbing demo; deliberately produces no model intelligence."""

    async def ensure_loaded(self, model: ModelConfig):
        if self.loaded_model != model:
            self.reset()
            self.loaded_model = model
            self.fingerprint = self.model_fingerprint(model)
        self.state = "ready"

    async def generate(self, request: ExecuteRequest) -> dict:
        await asyncio.sleep(self.config.mock_delay_seconds)
        return {
            "content": f"[SIMULATED {self.loaded_model.id}] {request.prompt}",
            "usage": {},
            "cached_tokens": None,
        }

    async def stop(self):
        self.reset()
