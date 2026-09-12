import math

import pytest

from dendrite.config import Config, ModelConfig, RuntimeConfig
from dendrite.fabric import cloud_snapshot
from dendrite.node import Node
from dendrite.performance import PerformanceTracker


def native_result(timings):
    return {"simulated": False, "usage": {"timings": timings}}


def test_records_latest_native_backend_rates_and_provenance(monkeypatch):
    tracker = PerformanceTracker()
    assert tracker.snapshot() == {
        "generation_tokens_per_second": None,
        "prompt_tokens_per_second": None,
        "samples": 0,
        "last_observed_at": None,
        "model_id": None,
        "runtime_id": None,
    }
    monkeypatch.setattr("dendrite.performance.time.time", lambda: 1_700_000_000.25)
    assert tracker.observe(
        native_result(
            {"predicted_n": 12, "predicted_ms": 600, "prompt_n": 8, "prompt_ms": 200}
        ),
        "qwen",
        "cpu",
    )
    assert tracker.snapshot() == {
        "generation_tokens_per_second": 20.0,
        "prompt_tokens_per_second": 40.0,
        "samples": 1,
        "last_observed_at": 1_700_000_000.25,
        "model_id": "qwen",
        "runtime_id": "cpu",
    }
    assert tracker.observe(
        native_result(
            {"predicted_n": 0, "predicted_ms": 5, "prompt_n": 0, "prompt_ms": 10}
        ),
        "next",
        "gpu",
    )
    assert tracker.snapshot()["generation_tokens_per_second"] == 0
    assert tracker.snapshot()["prompt_tokens_per_second"] == 0
    assert tracker.snapshot()["samples"] == 2
    assert tracker.snapshot()["model_id"] == "next"


@pytest.mark.parametrize(
    "result",
    [
        {},
        {"simulated": False},
        {"simulated": False, "usage": None},
        {"simulated": False, "usage": {"timings": None}},
        native_result({"predicted_n": 1, "predicted_ms": 1, "prompt_n": 1}),
        native_result({"predicted_n": 1, "predicted_ms": 0, "prompt_n": 1, "prompt_ms": 1}),
        native_result({"predicted_n": -1, "predicted_ms": 1, "prompt_n": 1, "prompt_ms": 1}),
        native_result(
            {"predicted_n": math.nan, "predicted_ms": 1, "prompt_n": 1, "prompt_ms": 1}
        ),
        native_result(
            {"predicted_n": 1, "predicted_ms": math.inf, "prompt_n": 1, "prompt_ms": 1}
        ),
        {"simulated": True, "usage": {"timings": {
            "predicted_n": 10, "predicted_ms": 1, "prompt_n": 10, "prompt_ms": 1
        }}},
    ],
)
def test_ignores_simulated_missing_and_malformed_timings(result):
    tracker = PerformanceTracker()
    assert tracker.observe(result, "model", "runtime") is False
    assert tracker.snapshot()["samples"] == 0
    assert tracker.snapshot()["last_observed_at"] is None


def test_node_and_cloud_snapshot_share_performance_without_capacity_claims(monkeypatch):
    config = Config(
        runtimes=[RuntimeConfig(id="demo", kind="mock")],
        models=[ModelConfig(id="model", runtime="demo", capabilities=["complete"])],
    )
    node = Node(config)
    monkeypatch.setattr("dendrite.performance.time.time", lambda: 1_700_000_001.5)
    node.performance.observe(
        native_result(
            {"predicted_n": 5, "predicted_ms": 250, "prompt_n": 3, "prompt_ms": 100}
        ),
        "measured-model",
        "measured-runtime",
    )
    local = node.snapshot()["performance"]
    cloud = cloud_snapshot(node)["performance"]
    assert cloud == local
    assert cloud["generation_tokens_per_second"] == 20
    assert cloud["prompt_tokens_per_second"] == 30
    assert "capacity" not in cloud


@pytest.mark.asyncio
async def test_simulated_node_execution_never_records_real_performance():
    config = Config(
        runtimes=[RuntimeConfig(id="demo", kind="mock")],
        models=[ModelConfig(id="model", runtime="demo", capabilities=["complete"])],
    )
    node = Node(config)
    try:
        from dendrite.schemas import ExecuteRequest

        result = await node.execute(ExecuteRequest(capability="complete", prompt="hello"))
        assert result.simulated is True
        assert node.snapshot()["performance"]["samples"] == 0
    finally:
        await node.close()
