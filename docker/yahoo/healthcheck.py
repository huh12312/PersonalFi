# SPDX-License-Identifier: MIT
"""The yahoo sidecar's healthcheck: GET /health on loopback, exit 0 on 200.

Run by the image's HEALTHCHECK and compose.yml's healthcheck as
`python -I /app/healthcheck.py`, so the container needs no shell, curl or
wget at runtime. /health never contacts Yahoo, so a healthcheck spends nothing
from the 60-per-hour budget.
"""

import sys
import urllib.request

try:
    with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3) as response:  # noqa: S310 - loopback, fixed URL
        sys.exit(0 if response.status == 200 else 1)
except Exception:  # noqa: BLE001 - any failure is unhealthy
    sys.exit(1)
