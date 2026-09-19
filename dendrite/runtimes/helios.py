"""Attach to a Helios host broker, leaving its models, queue, and processes owned by Helios."""

import os
import secrets
import time
import uuid

import httpx

from dendrite.config import ModelConfig, NodeConfig, RuntimeConfig
from dendrite.runtimes.base import Runtime, RuntimeFailure
from dendrite.schemas import ExecuteRequest


class HeliosRuntime(Runtime):
    def __init__(self, config: RuntimeConfig, node: NodeConfig):
        super().__init__(config, node)
        token = os.environ.get(config.api_token_env or "")
        if not token:
            raise ValueError(f"Set {config.api_token_env} before attaching to Helios")
        self.client = httpx.AsyncClient(
            base_url=config.base_url.rstrip("/"),
            headers={"Authorization": "Bearer " + token},
            timeout=node.request_timeout_seconds,
            trust_env=False,
            follow_redirects=False,
        )
        self.upstream_instance_id: str | None = None
        self.last_observed_at: float | None = None
        self.quarantined = False
        self._known_rejection = False
        self._request_sent = False
        self.chat_profile: dict | None = None

    async def verify_model(self, model: ModelConfig) -> str:
        health = await self.client.get("/v1/health", timeout=2)
        health.raise_for_status()
        if health.json().get("status") != "ok":
            raise RuntimeFailure("Helios is not healthy")

        response = await self.client.get("/v1/models", timeout=2)
        response.raise_for_status()
        data = response.json().get("data")
        if not isinstance(data, list):
            raise ValueError("Helios model list is malformed")
        matches = [
            item
            for item in data
            if isinstance(item, dict) and item.get("id") == model.upstream_model
        ]
        if len(matches) != 1:
            raise RuntimeFailure(f"Helios is not advertising the expected model {model.id}")

        response = await self.client.get("/v1/runtime-instances", timeout=2)
        response.raise_for_status()
        instances = response.json()
        if not isinstance(instances, list):
            raise ValueError("Helios runtime list is malformed")
        hot = [
            item
            for item in instances
            if isinstance(item, dict)
            and item.get("model_id") == model.upstream_model
            and item.get("lifecycle") == "hot"
            and isinstance(item.get("id"), str)
            and item["id"]
        ]
        if len(hot) != 1:
            raise RuntimeFailure(f"Helios model {model.id} needs exactly one hot instance")
        return hot[0]["id"]

    async def ensure_loaded(self, model: ModelConfig):
        if self.quarantined:
            raise RuntimeFailure("Helios attachment needs operator recovery after uncertain work")
        try:
            instance_id = await self.verify_model(model)
        except RuntimeFailure:
            raise
        except (httpx.HTTPError, ValueError, TypeError, AttributeError) as exc:
            raise RuntimeFailure(
                "Helios attachment is unavailable or returned invalid metadata"
            ) from exc
        if self.loaded_model != model or self.upstream_instance_id != instance_id:
            self.reset()
            self.chat_profile = None
        self.loaded_model = model
        self.upstream_instance_id = instance_id
        self.fingerprint = "helios:" + model.upstream_model + ":" + instance_id
        self.state = "ready"
        self.last_observed_at = time.time()

    async def probe_chat(self, model: ModelConfig) -> dict:
        """Check a hot model's response format without changing its runtime settings.

        This explicit setup operation submits tiny requests through Helios's own
        queue. It never starts, unloads, or reconfigures a local server.
        """
        if self.lock.locked():
            return {"status": "busy", "model_id": model.id}
        async with self.lane():
            await self.ensure_loaded(model)
            challenge = "FABRIC_" + secrets.token_hex(4).upper()
            prompt = f"Reply with exactly {challenge}."
            common = {"model": model.upstream_model, "max_tokens": 32,
                      "temperature": 0, "stream": False}
            raw = {**common,
                   "prompt": "<|im_start|>user\n" + prompt
                   + "\n<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"}
            structured = {**common, "messages": [{"role": "user", "content": prompt}]}
            format_name = "unverified"
            for path, body, candidate in (
                ("/v1/completions", raw, "raw_chatml_no_think"),
                ("/v1/chat/completions", structured, "structured"),
            ):
                try:
                    response = await self.client.post(
                        path, json=body, timeout=30,
                        headers={"Idempotency-Key": "dendrite-probe-" + str(uuid.uuid4()),
                                 "X-Ganglion-Purpose": "fabric"},
                    )
                    response.raise_for_status()
                    payload = response.json()
                    if payload.get("model") != model.upstream_model:
                        continue
                    choice = payload.get("choices", [{}])[0]
                    content = (choice.get("text") if candidate == "raw_chatml_no_think"
                               else (choice.get("message") or {}).get("content"))
                    if isinstance(content, str) and content.strip().strip(".") == challenge:
                        format_name = candidate
                        break
                except (
                    httpx.HTTPError, ValueError, TypeError, KeyError, IndexError, AttributeError
                ):
                    continue
            self.chat_profile = {
                "status": "verified" if format_name != "unverified" else "unverified",
                "format": format_name,
                "model_id": model.id,
                "upstream_instance_id": self.upstream_instance_id,
                "checked_at": time.time(),
            }
            return dict(self.chat_profile)

    async def generate(self, request: ExecuteRequest, execution_id: str | None = None) -> dict:
        if self.loaded_model is None:
            raise RuntimeFailure("Helios model is not ready")
        expected = self.loaded_model.upstream_model
        key = "dendrite-" + self.node.id + "-" + (execution_id or str(uuid.uuid4()))
        chat = request.messages is not None
        body = {
            "model": expected,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "stream": False,
        }
        if chat:
            body["messages"] = [message.model_dump() for message in request.messages or []]
        else:
            body["prompt"] = request.full_prompt
        try:
            self._request_sent = True
            response = await self.client.post(
                "/v1/chat/completions" if chat else "/v1/completions",
                headers={"Idempotency-Key": key, "X-Ganglion-Purpose": "fabric"},
                json=body,
            )
            if response.status_code in (400, 422, 429):
                # Helios rejected the request before admitting work to its queue.
                self._known_rejection = True
                status = 429 if response.status_code == 429 else 422
                raise RuntimeFailure(
                    f"Helios rejected the request (HTTP {response.status_code})", status
                )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or payload.get("model") != expected:
                raise ValueError("Helios returned the wrong model")
            choices = payload.get("choices")
            if not isinstance(choices, list) or len(choices) != 1:
                raise ValueError("Helios returned an invalid choice list")
            choice = choices[0]
            if not isinstance(choice, dict) or choice.get("index") != 0:
                raise ValueError("Helios returned an invalid choice")
            message = choice.get("message") if chat else None
            content = (
                (message.get("content") if isinstance(message, dict) else None)
                if chat
                else choice.get("text")
            )
            finish_reason = choice.get("finish_reason")
            if (
                not isinstance(content, str)
                or len(content.encode("utf-8")) > 131072
                or not isinstance(finish_reason, str)
                or not 1 <= len(finish_reason) <= 64
            ):
                raise ValueError("Helios returned invalid completion content")
            usage = payload.get("usage")
            if not isinstance(usage, dict):
                raise ValueError("Helios returned invalid usage metadata")
            timings = payload.get("llama_timings")
            if timings is not None and not isinstance(timings, dict):
                raise ValueError("Helios returned invalid timing metadata")
            result = {
                "content": content,
                "truncated": finish_reason == "length",
                "cached_tokens": None,
                "usage": {
                    "prompt_tokens": usage.get("prompt_tokens"),
                    "completion_tokens": usage.get("completion_tokens"),
                    "timings": {
                        key: timings[key]
                        for key in ("prompt_n", "prompt_ms", "predicted_n", "predicted_ms")
                        if timings and key in timings
                    },
                },
            }
            self._request_sent = False
            return result
        except RuntimeFailure:
            raise
        except httpx.TimeoutException as exc:
            raise RuntimeFailure("Helios inference timed out", 504) from exc
        except httpx.HTTPStatusError as exc:
            raise RuntimeFailure(f"Helios returned HTTP {exc.response.status_code}") from exc
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise RuntimeFailure("Helios inference failed or returned invalid JSON", 502) from exc

    async def stop(self):
        # An attachment must never terminate or unload a Helios-owned instance.
        self.reset()
        self.upstream_instance_id = None
        self.chat_profile = None

    async def abort(self):
        if self._request_sent and not self._known_rejection:
            self.quarantined = True
        self._known_rejection = False
        self._request_sent = False
        await self.stop()

    async def close(self):
        await super().close()
        await self.client.aclose()

    async def observe_attached(self, models: list[ModelConfig]):
        if self.lock.locked() or self.quarantined or self.closing:
            return
        async with self.lane():
            for model in models:
                try:
                    await self.ensure_loaded(model)
                    self.last_error = None
                    return
                except RuntimeFailure as exc:
                    self.last_error = exc.detail
            await self.stop()
            self.state = "unavailable"
            self.last_observed_at = time.time()

    def snapshot(self) -> dict:
        if (
            not self.lock.locked()
            and self.last_observed_at is not None
            and time.time() - self.last_observed_at > self.node.heartbeat_seconds
        ):
            self.reset()
            self.upstream_instance_id = None
            self.state = "unavailable"
        return {
            **super().snapshot(),
            "upstream_instance_id": self.upstream_instance_id,
            "attachment_observed_at": self.last_observed_at,
            "chat_profile": self.chat_profile,
        }
