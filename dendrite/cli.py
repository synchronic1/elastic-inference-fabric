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


async def inspect(config):
    node = Node(config)
    try:
        await node.start()
        print(json.dumps(node.snapshot(), indent=2))
    finally:
        await node.close()


def main():
    parser = argparse.ArgumentParser(description="Dendrite local inference node")
    parser.add_argument("command", choices=["serve", "inspect"])
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    try:
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
