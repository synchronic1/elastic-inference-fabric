import argparse
import asyncio
import json
import sys
from pathlib import Path

import uvicorn
from pydantic import ValidationError

from dendrite.api import create_app
from dendrite.config import load_config
from dendrite.node import Node
from dendrite.probe import parse_ports, run_probe


async def inspect(config):
    node = Node(config)
    try:
        await node.start()
        print(json.dumps(node.snapshot(), indent=2))
    finally:
        await node.close()


def main():
    parser = argparse.ArgumentParser(description="Dendrite local inference node")
    parser.add_argument("command", choices=["serve", "inspect", "probe"])
    parser.add_argument("--config", type=Path, help="Required for serve and inspect")
    parser.add_argument(
        "--ports", help="Comma-separated loopback ports to scan instead of the defaults (probe)"
    )
    parser.add_argument(
        "--model-dirs",
        help="Comma-separated directories to scan one level for GGUFs (probe)",
    )
    parser.add_argument(
        "--check-completion",
        action="store_true",
        help="Verify the /completion contract; sends a no-generation request (probe)",
    )
    parser.add_argument("--json", action="store_true", help="Machine-readable output (probe)")
    args = parser.parse_args()
    try:
        if args.command == "probe":
            model_dirs = tuple(Path(item) for item in (args.model_dirs or "").split(",") if item)
            sys.exit(
                run_probe(
                    ports=parse_ports(args.ports),
                    model_dirs=model_dirs,
                    check_completion=args.check_completion,
                    as_json=args.json,
                )
            )
        if not args.config:
            parser.error("--config is required for serve and inspect")
        config = load_config(args.config)
        if args.command == "inspect":
            asyncio.run(inspect(config))
        else:
            uvicorn.run(
                create_app(config), host=config.node.host, port=config.node.port, access_log=False
            )
    except (OSError, ValueError, ValidationError) as exc:
        print(f"dendrite: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
