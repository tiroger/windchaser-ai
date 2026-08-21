#!/usr/bin/env python3
"""Entry point for the WindChaser MCP server.

Kept at the top so the command in a client's configuration is a plain path to a
file, with no package flags or working-directory assumptions.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from windchaser_mcp.server import main  # noqa: E402

if __name__ == "__main__":
    main()
