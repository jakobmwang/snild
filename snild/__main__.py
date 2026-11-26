"""Start snild: `python -m snild`.

SNILD_HOST and SNILD_PORT choose where it listens (default 127.0.0.1:8080). The container sets SNILD_HOST to
0.0.0.0; compose.yaml decides which of the host's addresses the port is published on (SNILD_BIND).
"""

from __future__ import annotations

import logging
import os
import sys

import uvicorn

from .app import create_app, describe
from .config import ConfigError, load_config


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    try:
        config = load_config()
        port = int(os.environ.get("SNILD_PORT", "8080"))
        if not 0 < port < 65536:
            raise ValueError
    except ConfigError as e:
        print(f"snild: configuration problem: {e}", file=sys.stderr)
        return 2
    except ValueError:
        print("snild: configuration problem: SNILD_PORT must be a port number", file=sys.stderr)
        return 2
    logging.getLogger("snild").info("starting with %s", describe(config))
    uvicorn.run(
        create_app(config),
        host=os.environ.get("SNILD_HOST", "127.0.0.1"),
        port=port,
        server_header=False,
        # Forwarded client addresses are accepted only from configured peers, and only for the client's address
        # (sign-in limits); public_url, not a header, gives snild's own origin.
        proxy_headers=bool(config.trusted_proxies),
        forwarded_allow_ips=list(config.trusted_proxies) or None,
        log_level="info",
        # Open reply streams can last minutes. On shutdown, stop waiting for them after a few seconds so the
        # runs are saved as interrupted before Docker's stop timeout (compose.yaml gives it 20 s).
        timeout_graceful_shutdown=5,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
