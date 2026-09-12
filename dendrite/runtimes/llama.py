"""Native /completion adapter shared by IK_Llama and llama.cpp single-model servers."""

import asyncio
import shutil
import socket
import time

import httpx

from dendrite.config import ModelConfig, NodeConfig, RuntimeConfig
from dendrite.hardware import file_identity
from dendrite.runtimes.base import Runtime, RuntimeFailure
from dendrite.schemas import ExecuteRequest


class LlamaRuntime(Runtime):
    def __init__(self, config: RuntimeConfig, node: NodeConfig):
        super().__init__(config, node)
        self.process: asyncio.subprocess.Process | None = None
        self.url = (config.base_url or f"http://127.0.0.1:{config.port}").rstrip("/")
        self.client = httpx.AsyncClient(
            base_url=self.url, trust_env=False, timeout=node.request_timeout_seconds
        )
        self.quarantined = False

    def command(self, model: ModelConfig) -> list[str]:
        return [
            self.config.executable,
            "--model",
            str(model.path),
            "--alias",
            model.id,
            "--host",
            "127.0.0.1",
            "--port",
            str(self.config.port),
            "--ctx-size",
            str(self.config.context_size),
            "--threads",
            str(self.config.threads),
            "--parallel",
            "1",
            "--n-gpu-layers",
            str(self.config.gpu_layers),
        ]

    async def verify_model(self, model: ModelConfig):
        health = await self.client.get("/health", timeout=2)
        health.raise_for_status()
        if health.json().get("status") != "ok":
            raise RuntimeFailure("Native runtime has no ready slot")
        response = await self.client.get("/v1/models", timeout=2)
        response.raise_for_status()
        expected = model.upstream_model if self.config.mode == "attach" else model.id
        if expected not in {item.get("id") for item in response.json().get("data", [])}:
            raise RuntimeFailure(f"Native runtime is not serving expected model {model.id}")

    async def ensure_loaded(self, model: ModelConfig):
        if self.quarantined:
            raise RuntimeFailure(
                "Attached runtime requires operator recovery after an uncertain request"
            )
        if self.config.mode == "attach":
            try:
                await self.verify_model(model)
            except (httpx.HTTPError, ValueError, TypeError, AttributeError) as exc:
                raise RuntimeFailure(
                    "Attached runtime is unavailable or returned invalid metadata"
                ) from exc
            if self.loaded_model != model:
                self.reset()
            self.loaded_model = model
            self.fingerprint = "attached:" + model.upstream_model
            self.state = "ready"
            return

        identity = file_identity(model.path)
        if not identity["cached_on_disk"]:
            raise RuntimeFailure(f"Model {model.id} is not a readable local GGUF file")
        if (
            self.loaded_model == model
            and self.fingerprint == identity["fingerprint"]
            and self.process
            and self.process.returncode is None
        ):
            return
        if not shutil.which(self.config.executable):
            raise RuntimeFailure(f"Runtime binary not found: {self.config.executable}")
        await self.stop()
        # Refuse to attach implicitly to an unrelated listener at the managed port.
        with socket.socket() as probe:
            # Permit immediate model switches while prior connections are in TIME_WAIT.
            # SO_REUSEADDR does not permit stealing an active listening socket.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", self.config.port))
            except OSError as exc:
                raise RuntimeFailure(f"Managed port {self.config.port} is already in use") from exc
        self.state = "loading"
        try:
            self.process = await asyncio.create_subprocess_exec(
                *self.command(model),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
            async with asyncio.timeout(self.config.startup_timeout_seconds):
                while True:
                    if self.process.returncode is not None:
                        raise RuntimeFailure(
                            f"Native runtime exited during startup ({self.process.returncode})"
                        )
                    try:
                        await self.verify_model(model)
                        # A competing listener must not count as this child's readiness.
                        if self.process.returncode is not None:
                            raise RuntimeFailure("Native runtime exited during readiness check")
                        break
                    except (httpx.HTTPError, ValueError, TypeError, AttributeError, RuntimeFailure):
                        await asyncio.sleep(0.1)
        except TimeoutError as exc:
            raise RuntimeFailure("Native model startup deadline exceeded", 504) from exc
        except OSError as exc:
            raise RuntimeFailure("Unable to start native runtime executable") from exc
        self.loaded_model = model
        self.fingerprint = identity["fingerprint"]
        self.state = "ready"

    async def generate(self, request: ExecuteRequest) -> dict:
        if request.max_tokens >= self.config.context_size:
            raise RuntimeFailure("max_tokens must be smaller than runtime context_size", 422)
        try:
            response = await self.client.post(
                "/completion",
                json={
                    "prompt": request.full_prompt,
                    "n_predict": request.max_tokens,
                    "temperature": request.temperature,
                    "cache_prompt": True,
                    "id_slot": 0,
                    "stream": False,
                },
            )
            response.raise_for_status()
            result = response.json()
            if not isinstance(result, dict) or not isinstance(result.get("content"), str):
                raise ValueError("Missing completion text")
            timings = result.get("timings") or {}
            if not isinstance(timings, dict):
                raise ValueError("Invalid timing metadata")
            cached = timings.get("cache_n", result.get("tokens_cached"))
            if type(cached) is not int or cached < 0:
                cached = None
            return {
                "content": result["content"],
                "cached_tokens": cached,
                "truncated": result.get("truncated", False),
                "usage": {
                    "prompt_tokens": result.get("tokens_evaluated"),
                    "completion_tokens": result.get("tokens_predicted"),
                    "timings": {
                        key: timings[key]
                        for key in ("prompt_n", "prompt_ms", "predicted_n", "predicted_ms")
                        if key in timings
                    },
                },
            }
        except httpx.TimeoutException as exc:
            raise RuntimeFailure("Native inference timed out", 504) from exc
        except httpx.HTTPStatusError as exc:
            status = 422 if exc.response.status_code == 400 else 503
            raise RuntimeFailure(
                f"Native inference returned HTTP {exc.response.status_code}", status
            ) from exc
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise RuntimeFailure("Native inference failed or returned malformed JSON", 502) from exc

    async def stop(self):
        process, self.process = self.process, None
        try:
            if process and process.returncode is None:
                try:
                    process.terminate()
                    await asyncio.wait_for(process.wait(), timeout=3)
                except TimeoutError:
                    process.kill()
                    await process.wait()
                except ProcessLookupError:
                    await process.wait()
        finally:
            self.reset()

    async def abort(self):
        if self.config.mode == "attach":
            self.quarantined = True
        await self.stop()

    async def close(self):
        await self.stop()
        await self.client.aclose()

    def snapshot(self) -> dict:
        if self.process and self.process.returncode is not None and not self.lock.locked():
            self.reset()
            self.state = "error"
            self.last_error = "Owned native runtime exited"
        return {
            **super().snapshot(),
            "process_id": self.process.pid if self.process else None,
            "binary_available": bool(shutil.which(self.config.executable)),
            "observed_at": time.time(),
        }
