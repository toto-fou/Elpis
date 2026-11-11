# SPDX-License-Identifier: MIT
"""tests/desktop_agent/conftest.py — jeton Bearer de l'agent de bureau, posé avant le chargement de server.py (sinon il écrit agent_token.txt)."""
import os

os.environ["DESKTOP_AGENT_TOKEN"] = "jeton-de-test-agent-de-bureau"
os.environ.pop("DESKTOP_AGENT_INSECURE", None)
