from typing import Any, Literal

from pydantic import Field, model_validator

from dendrite.config import StrictModel


class ChatMessage(StrictModel):
    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1, max_length=65536)


class ExecuteRequest(StrictModel):
    capability: str = Field(min_length=1, max_length=128)
    prompt: str | None = Field(default=None, min_length=1, max_length=65536)
    prefix: str = Field(default="", max_length=65536)
    messages: list[ChatMessage] | None = Field(default=None, min_length=1, max_length=32)
    model_id: str | None = None
    max_tokens: int = Field(default=256, ge=1, le=4096)
    temperature: float = Field(default=0.2, ge=0, le=2)

    @model_validator(mode="after")
    def input_mode(self):
        if (self.prompt is None) == (self.messages is None):
            raise ValueError("Provide exactly one of prompt or messages")
        if self.messages is not None:
            if self.prefix:
                raise ValueError("prefix is only valid with a raw prompt")
            if sum(len(message.content.encode("utf-8")) for message in self.messages) > 65536:
                raise ValueError("Combined chat content exceeds 65536 bytes")
            if any(message.role == "system" for message in self.messages[1:]):
                raise ValueError("system message must be first")
            if self.messages[-1].role != "user":
                raise ValueError("last chat message must be user")
        return self

    @property
    def full_prompt(self) -> str:
        # Exact byte concatenation, without a hidden template or separator.
        if self.prompt is None:
            raise ValueError("A chat request has no raw prompt")
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
