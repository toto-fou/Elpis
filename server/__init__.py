# SPDX-License-Identifier: MIT
"""server — point d'entrée Python restant : elpis-tools (local_mcp_server)."""

# DOIT rester la première instruction exécutable du paquet : importer
# ``server.local_mcp_server``
# passe forcément par ici, donc avant tout import de fastapi/pydantic — ce que
# le réglage exige. Voir shared_infra/runtime/pyruntime.py pour la mesure et le
# pourquoi (−21,6 Mo de RSS par worker).
import shared_infra.runtime.pyruntime  # noqa: F401  (importé pour son effet de bord)
