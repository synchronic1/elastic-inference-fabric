"""Latest measured native inference throughput; never a capacity estimate."""

import math
import time


class PerformanceTracker:
    def __init__(self):
        self._snapshot = {
            "generation_tokens_per_second": None,
            "prompt_tokens_per_second": None,
            "samples": 0,
            "last_observed_at": None,
            "model_id": None,
            "runtime_id": None,
        }

    def observe(self, result: dict, model_id: str, runtime_id: str) -> bool:
        """Record one coherent backend timing sample, returning whether it was accepted."""
        if not isinstance(result, dict) or result.get("simulated") is not False:
            return False
        usage = result.get("usage")
        if not isinstance(usage, dict):
            return False
        timings = usage.get("timings")
        if not isinstance(timings, dict):
            return False
        generation = _tokens_per_second(timings.get("predicted_n"), timings.get("predicted_ms"))
        prompt = _tokens_per_second(timings.get("prompt_n"), timings.get("prompt_ms"))
        # Keep the previous coherent measurement if either backend timing pair is malformed.
        if generation is None or prompt is None:
            return False
        self._snapshot = {
            "generation_tokens_per_second": generation,
            "prompt_tokens_per_second": prompt,
            "samples": self._snapshot["samples"] + 1,
            "last_observed_at": time.time(),
            "model_id": model_id,
            "runtime_id": runtime_id,
        }
        return True

    def snapshot(self) -> dict:
        return dict(self._snapshot)


def _tokens_per_second(count, milliseconds) -> float | None:
    if (
        isinstance(count, bool)
        or isinstance(milliseconds, bool)
        or not isinstance(count, (int, float))
        or not isinstance(milliseconds, (int, float))
        or not math.isfinite(count)
        or not math.isfinite(milliseconds)
        or count < 0
        or milliseconds <= 0
    ):
        return None
    return count * 1000.0 / milliseconds
