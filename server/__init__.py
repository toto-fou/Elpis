# SPDX-License-Identifier: MIT
"""Points d'entrée serveur Elpis (app principale, admin, MCP local) et configs gunicorn."""

# DOIT rester la première instruction exécutable du paquet : importer
# ``server.app`` (ou ``server.admin_app``, ou ``server.local_mcp_server``)
# passe forcément par ici, donc avant tout import de fastapi/pydantic — ce que
# le réglage exige. Voir shared_infra/runtime/pyruntime.py pour la mesure et le
# pourquoi (−21,6 Mo de RSS par worker).
import shared_infra.runtime.pyruntime  # noqa: F401  (importé pour son effet de bord)
