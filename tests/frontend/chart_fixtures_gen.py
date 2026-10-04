# SPDX-License-Identifier: MIT
"""Régénère ``chart-fixtures.json`` : une option ECharts par type d'outil
``chart_<type>`` (produite par le vrai moteur ``llm_core.tools._chart``), plus
une ancienne configuration Chart.js qui doit afficher l'avis « ancien format ».

    venv/bin/python tests/frontend/chart_fixtures_gen.py
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests" / "llm_core"))

from test_chart_tools import EXEMPLES  # noqa: E402

from llm_core.tools._chart import run_chart  # noqa: E402


def main() -> None:
    order, configs = [], {}
    for kind, args in EXEMPLES.items():
        res, opt, _ = run_chart({"type": kind, "title": f"Exemple {kind}", **args})
        assert res["ok"], (kind, res)
        cid = hashlib.sha1(json.dumps(opt, sort_keys=True).encode()).hexdigest()[:12]
        order.append([kind, cid])
        configs[cid] = opt
    legacy = {"type": "bar", "data": {"labels": ["a"], "datasets": [{"label": "x", "data": [1]}]}}
    order.append(["ancien_format", "0123456789ab"])
    configs["0123456789ab"] = legacy
    out = Path(__file__).with_name("chart-fixtures.json")
    out.write_text(json.dumps({"order": order, "configs": configs}, ensure_ascii=False), encoding="utf-8")
    print(f"{out} : {len(order)} graphiques")


if __name__ == "__main__":
    main()
