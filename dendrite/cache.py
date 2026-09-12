"""At most one candidate per serialized runtime slot; metadata never contains prompt text."""

import hashlib
import time


def prefix_digest(prefix: str) -> str:
    return hashlib.sha256(prefix.encode()).hexdigest()


class PrefixCache:
    def __init__(self, ttl_seconds: float):
        self.ttl_seconds = ttl_seconds
        self.entry: dict | None = None

    def clear(self):
        self.entry = None

    def snapshot(self) -> list[dict]:
        if self.entry and self.entry["expires_at"] <= time.time():
            self.clear()
        return [self.entry.copy()] if self.entry else []

    def matches(self, prefix: str, instance: str, fingerprint: str) -> bool:
        entries = self.snapshot()
        return bool(
            prefix
            and entries
            and entries[0]["prefix_sha256"] == prefix_digest(prefix)
            and entries[0]["runtime_instance"] == instance
            and entries[0]["model_fingerprint"] == fingerprint
        )

    def record(self, prefix: str, instance: str, fingerprint: str, simulated: bool):
        self.clear()
        if prefix:
            self.entry = {
                "prefix_sha256": prefix_digest(prefix),
                "prefix_bytes": len(prefix.encode()),
                "runtime_instance": instance,
                "model_fingerprint": fingerprint,
                "slot_id": 0,
                "expires_at": time.time() + self.ttl_seconds,
                "state": "candidate",
                "portable": False,
                "simulated": simulated,
            }
