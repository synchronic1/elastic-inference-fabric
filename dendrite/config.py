"""Operator-owned configuration; requests cannot supply paths or subprocess flags."""

import ipaddress
import tomllib
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelConfig(StrictModel):
    id: str = Field(min_length=1)
    runtime: str
    capabilities: list[str] = Field(min_length=1)
    path: Path | None = None
    # Attach-only runtimes must match this exact identity in GET /v1/models.
    upstream_model: str | None = None


class RuntimeConfig(StrictModel):
    id: str = Field(min_length=1)
    kind: Literal["ik_llama", "llama_cpp", "mock"]
    mode: Literal["managed", "attach"] = "managed"
    executable: str = "llama-server"
    port: int = Field(default=8081, ge=1, le=65535)
    base_url: str | None = None
    context_size: int = Field(default=4096, ge=128)
    threads: int = Field(default=4, ge=1)
    gpu_layers: int = Field(default=0, ge=0)
    startup_timeout_seconds: float = Field(default=120, gt=0, le=600)
    mock_delay_seconds: float = Field(default=0, ge=0, le=30)

    @model_validator(mode="after")
    def local_endpoint(self):
        if self.mode == "attach":
            parsed = urlsplit(self.base_url or "")
            try:
                local = (
                    parsed.hostname == "localhost"
                    or ipaddress.ip_address(parsed.hostname or "").is_loopback
                )
            except ValueError:
                local = False
            if (
                not local
                or parsed.scheme != "http"
                or parsed.username
                or parsed.password
                or parsed.path not in ("", "/")
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("Attached runtime must use an http:// loopback origin")
            if self.kind == "mock":
                raise ValueError("Mock runtime does not attach to a real server")
        elif self.base_url:
            raise ValueError("base_url is only used by attach mode")
        return self


class NodeConfig(StrictModel):
    id: str = "dendrite-local"
    host: str = "127.0.0.1"
    port: int = Field(default=8090, ge=1, le=65535)
    token_env: str = "DENDRITE_API_TOKEN"
    state_dir: Path = Path(".dendrite")
    model_dirs: list[Path] = Field(default_factory=list)
    request_timeout_seconds: float = Field(default=180, gt=0, le=900)
    cache_ttl_seconds: float = Field(default=300, gt=0, le=3600)
    control_plane_url: str | None = None
    advertise_url: str | None = None
    heartbeat_seconds: float = Field(default=10, ge=1, le=300)
    fabric_url: str | None = None
    fabric_token_env: str = "GANGLION_FABRIC_TOKEN"

    @model_validator(mode="after")
    def validate_fabric_origin(self):
        if self.fabric_url:
            url = urlsplit(self.fabric_url)
            local = url.hostname in ("localhost", "127.0.0.1", "::1")
            if (
                url.scheme not in ("http", "https")
                or not url.hostname
                or url.username
                or url.password
                or url.query
                or url.fragment
                or url.path not in ("", "/")
                or (url.scheme == "http" and not local)
            ):
                raise ValueError("fabric_url requires an HTTPS origin (HTTP only on loopback)")
        return self


class Config(StrictModel):
    node: NodeConfig = Field(default_factory=NodeConfig)
    runtimes: list[RuntimeConfig] = Field(min_length=1)
    models: list[ModelConfig] = Field(min_length=1)

    @model_validator(mode="after")
    def references(self):
        runtime_ids = [r.id for r in self.runtimes]
        if len(set(runtime_ids)) != len(runtime_ids):
            raise ValueError("Runtime IDs must be unique")
        if len({m.id for m in self.models}) != len(self.models):
            raise ValueError("Model IDs must be unique")
        ports = [r.port for r in self.runtimes if r.mode == "managed" and r.kind != "mock"]
        if len(set(ports)) != len(ports) or self.node.port in ports:
            raise ValueError("Managed runtimes and daemon must use distinct ports")
        for model in self.models:
            if model.runtime not in runtime_ids:
                raise ValueError(f"Unknown runtime {model.runtime} for model {model.id}")
            runtime = next(r for r in self.runtimes if r.id == model.runtime)
            if runtime.kind != "mock" and runtime.mode == "managed" and not model.path:
                raise ValueError(f"Managed model {model.id} needs a GGUF path")
            if runtime.mode == "attach" and not model.upstream_model:
                raise ValueError(f"Attached model {model.id} needs upstream_model identity")
        return self


def load_config(path: Path) -> Config:
    path = path.resolve()
    config = Config.model_validate(tomllib.loads(path.read_text()))
    config.node.state_dir = (path.parent / config.node.state_dir).resolve()
    config.node.model_dirs = [(path.parent / p).resolve() for p in config.node.model_dirs]
    for model in config.models:
        if model.path:
            model.path = (path.parent / model.path).resolve()
    for runtime in config.runtimes:
        if "/" in runtime.executable:
            runtime.executable = str((path.parent / runtime.executable).resolve())
    return config
