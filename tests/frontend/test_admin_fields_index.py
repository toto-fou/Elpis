# SPDX-License-Identifier: MIT
"""tests/frontend/test_admin_fields_index.py — index des réglages de la recherche Ctrl+K.

La recherche de la console (refonte 2026-09-27, lot 7) trouve un réglage sur
une page non affichée grâce à ``frontend/js/admin/_fields.js``, GÉNÉRÉ depuis
les gabarits par ``tools/generate_admin_fields.py``. Un gabarit modifié sans
régénérer l'index ferait pointer la recherche vers un champ disparu, ou taire
un champ ajouté : ce test l'interdit.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parents[2]
INDEX = RACINE / "frontend" / "js" / "admin" / "_fields.js"
REGISTRE = RACINE / "frontend" / "js" / "admin" / "_registry.js"


def _champs():
    lignes = INDEX.read_text(encoding="utf-8").splitlines()
    return [json.loads(l.strip().rstrip(",")) for l in lignes if l.strip().startswith("{")]


def test_index_a_jour_des_gabarits():
    r = subprocess.run([sys.executable, str(RACINE / "tools" / "generate_admin_fields.py"), "--check"],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_chaque_champ_vise_une_page_du_registre_et_un_data_field_reel():
    pages = set(re.findall(r"\{\s*id:\s*'([a-z0-9-]+)',\s*label:", REGISTRE.read_text(encoding="utf-8")))
    gabarits = "".join(p.read_text(encoding="utf-8")
                       for p in (RACINE / "frontend" / "includes" / "admin").glob("tab_*.html"))
    champs = _champs()
    assert len(champs) > 80
    for c in champs:
        assert c["page"] in pages, c
        assert f'data-field="{c["store"]}:{c["path"]}"' in gabarits, c
        assert c["label"] and "{{" not in c["label"], c


def test_reperes():
    par_chemin = {(c["store"], c["path"]): c for c in _champs()}
    assert par_chemin[("config", "llama.ip")]["page"] == "inference"
    assert par_chemin[("config", "maintenance.metrics_retention_days")]["label"] == "Compteurs"
    assert par_chemin[("config", "security.session.cookie_name")]["page"] == "sessions"
    assert par_chemin[("exec", "limits.memory_mb")]["page"] == "sandbox-limits"


def test_charge_par_les_deux_pages_apres_le_registre():
    for page in ("admin.html", "index.html"):
        html = (RACINE / "frontend" / page).read_text(encoding="utf-8")
        i_reg = html.find("static/js/admin/_registry.js")
        i_idx = html.find("static/js/admin/_fields.js")
        i_adm = html.find("static/js/app-admin.js")
        assert -1 < i_reg < i_idx < i_adm, page
