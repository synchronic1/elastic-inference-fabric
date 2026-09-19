"""Native /completion adapter shared by IK_Llama and llama.cpp single-model servers."""

import asyncio
import os
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
        token = os.environ.get(config.api_token_env or "") if config.api_token_env else None
        if config.api_token_env and not token:
            raise ValueError(f"Set {config.api_token_env} before attaching to llama-server")
        self.client = httpx.AsyncClient(
            base_url=self.url,
            headers={"Authorization": "Bearer " + token} if token else None,
            trust_env=False,
            follow_redirects=False,
            timeout=node.request_timeout_seconds,
        )
        self.quarantined = False
        self.last_observed_at: float | None = None
        self._supports_chat = False
        self._chat_endpoint_unsupported = False
        self._request_sent = False
        self._known_rejection = False

    @property
    def supports_chat(self) -> bool:
        return self._supports_chat

    def reset(self):
        super().reset()
        self._supports_chat = False

    def native_alias(self, model: ModelConfig) -> str:
        return model.id + "@" + self.instance

    def command(self, model: ModelConfig) -> list[str]:
        return [
            self.config.executable,
            "--model",
            str(model.path),
            "--alias",
            self.native_alias(model),
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
        expected = (
            model.upstream_model if self.config.mode == "attach" else self.native_alias(model)
        )
        if expected not in {item.get("id") for item in response.json().get("data", [])}:
            raise RuntimeFailure(f"Native runtime is not serving expected model {model.id}")
        # /props is observational. A missing or ambiguous template must not make
        # raw completion unavailable, but it cannot authorize structured chat.
        self._supports_chat = False
        if not self._chat_endpoint_unsupported:
            try:
                props_response = await self.client.get("/props", timeout=2)
                if props_response.status_code == 200:
                    props = props_response.json()
                    self._supports_chat = (
                        isinstance(props, dict)
                        and props.get("model_alias") == expected
                        and isinstance(props.get("chat_template"), str)
                        and bool(props["chat_template"].strip())
                    )
            except (httpx.HTTPError, ValueError, TypeError):
                pass

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
            chat_ready = self._supports_chat
            if self.loaded_model != model:
                self.reset()
            self._supports_chat = chat_ready
            self.loaded_model = model
            self.fingerprint = "attached:" + model.upstream_model
            self.state = "ready"
            self.last_observed_at = time.time()
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
            # Native runtimes can create default log/cache files before parsing flags.
            # Keep those artifacts out of the project root and isolated per instance.
            work_dir = self.node.state_dir.resolve() / ("runtime-" + self.instance)
            work_dir.mkdir(parents=True, exist_ok=True)
            self.process = await asyncio.create_subprocess_exec(
                *self.command(model),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
                cwd=work_dir,
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

    def validate_request(self, request: ExecuteRequest):
        if self.config.mode == "managed" and request.max_tokens >= self.config.context_size:
            raise RuntimeFailure("max_tokens must be smaller than runtime context_size", 422)
        if request.messages is not None and not self.supports_chat:
            raise RuntimeFailure("Native runtime has no verified chat template", 409)

    async def generate(self, request: ExecuteRequest, execution_id: str | None = None) -> dict:
        if self.loaded_model is None:
            raise RuntimeFailure("Native model is not ready")
        chat = request.messages is not None
        expected = (
            self.loaded_model.upstream_model
            if self.config.mode == "attach"
            else self.native_alias(self.loaded_model)
        )
        if chat:
            body = {
                "model": expected,
                "messages": [message.model_dump() for message in request.messages or []],
                "max_tokens": request.max_tokens,
                "temperature": request.temperature,
                "stream": False,
            }
        else:
            body = {
                "prompt": request.full_prompt,
                "n_predict": request.max_tokens,
                "temperature": request.temperature,
                "stream": False,
            }
            if self.config.mode == "managed":
                body.update({"cache_prompt": True, "id_slot": 0})
        self._known_rejection = False
        try:
            self._request_sent = True
            response = await self.client.post(
                "/v1/chat/completions" if chat else "/completion", json=body
            )
            if response.status_code in (400, 404, 405, 422, 429, 501):
                self._known_rejection = True
                if chat and response.status_code in (404, 405, 501):
                    self._chat_endpoint_unsupported = True
            response.raise_for_status()
            result = response.json()
            if chat:
                if not isinstance(result, dict) or result.get("model") != expected:
                    raise ValueError("Chat response has wrong model")
                choices = result.get("choices")
                if not isinstance(choices, list) or len(choices) != 1:
                    raise ValueError("Invalid chat choices")
                choice = choices[0]
                if not isinstance(choice, dict) or choice.get("index") != 0:
                    raise ValueError("Invalid chat choice")
                message = choice.get("message")
                content = message.get("content") if isinstance(message, dict) else None
                if not isinstance(content, str) or len(content.encode("utf-8")) > 131072:
                    raise ValueError("Invalid chat content")
                finish_reason = choice.get("finish_reason")
                if not isinstance(finish_reason, str):
                    raise ValueError("Invalid chat finish reason")
                usage = result.get("usage")
                if usage is not None and not isinstance(usage, dict):
                    raise ValueError("Invalid chat usage")
                self._request_sent = False
                return {
                    "content": content,
                    "cached_tokens": None,
                    "truncated": finish_reason == "length",
                    "usage": {
                        "prompt_tokens": (usage or {}).get("prompt_tokens"),
                        "completion_tokens": (usage or {}).get("completion_tokens"),
                    },
                }
            if not isinstance(result, dict) or not isinstance(result.get("content"), str):
                raise ValueError("Missing completion text")
            timings = result.get("timings") or {}
            if not isinstance(timings, dict):
                raise ValueError("Invalid timing metadata")
            # IK's legacy tokens_cached is post-generation slot.n_past in current source,
            # despite older docs describing it as reuse. Do not infer a hit from it.
            cached = timings.get("cache_n")
            if type(cached) is not int or cached < 0:
                cached = None
            self._request_sent = False
            return {
                "content": result["content"],
                "cached_tokens": cached,
                "truncated": result.get("truncated", False),
                "usage": {
                    "prompt_tokens": result.get("tokens_evaluated"),
                    "completion_tokens": result.get("tokens_predicted"),
                    "backend_tokens_cached": result.get("tokens_cached"),
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
        if self.config.mode == "attach" and self._request_sent and not self._known_rejection:
            self.quarantined = True
        self._request_sent = False
        self._known_rejection = False
        await self.stop()

    async def close(self):
        await super().close()
        await self.client.aclose()

    async def observe_attached(self, models: list[ModelConfig]):
        if self.config.mode != "attach" or self.lock.locked() or self.quarantined or self.closing:
            return
        async with self.lane():
            for model in models:
                try:
                    await self.ensure_loaded(model)
                    self.last_error = None
                    return
                except RuntimeFailure as exc:
                    self.last_error = exc.detail
            self.reset()
            self.state = "unavailable"
            self.last_observed_at = time.time()

    def snapshot(self) -> dict:
        if (
            self.config.mode == "attach"
            and not self.lock.locked()
            and self.last_observed_at is not None
            and time.time() - self.last_observed_at > self.node.heartbeat_seconds
        ):
            self.reset()
            self.state = "unavailable"
        if self.process and self.process.returncode is not None and not self.lock.locked():
            self.reset()
            self.state = "error"
            self.last_error = "Owned native runtime exited"
        return {
            **super().snapshot(),
            "process_id": self.process.pid if self.process else None,
            "binary_available": bool(shutil.which(self.config.executable)),
            "observed_at": time.time(),
            "attachment_observed_at": self.last_observed_at,
        }
