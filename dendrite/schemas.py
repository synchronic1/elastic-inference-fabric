from typing import Any

from pydantic import Field

from dendrite.config import StrictModel


class ExecuteRequest(StrictModel):
    capability: str = Field(min_length=1, max_length=128)
    prompt: str = Field(min_length=1, max_length=65536)
    prefix: str = Field(default="", max_length=65536)
    model_id: str | None = None
    max_tokens: int = Field(default=256, ge=1, le=4096)
    temperature: float = Field(default=0.2, ge=0, le=2)

    @property
    def full_prompt(self) -> str:
        # Exact byte concatenation, without a hidden template or separator.
        return self.prefix + self.prompt


class LoadRequest(StrictModel):
    model_id: str


class ExecuteResponse(StrictModel):
    request_id: str
    node_id: str
    runtime_id: str
    model_id: str
    content: str
    simulated: bool
    elapsed_ms: float
    cache: dict[str, Any]
    usage: dict[str, Any]
