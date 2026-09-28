# SPDX-License-Identifier: MIT
"""``python -m elpis_auto script.py [options] [--param=valeur ...]`` — exécute un
script d'automatisation avec les backends de l'agent (dossier parent sur sys.path).

Options (avant le script ou après) :
  --dry-run        vol à blanc : résout chaque cible, n'envoie AUCUNE entrée
  --trace          capture + extrait d'arbre à chaque étape (visualiseur dans rapport.html)
  --repeat N       N exécutions → stabilite.json/html (taux de réussite, durées, suggestions)
  --data F.csv     une exécution par ligne (colonnes → paramètres) → donnees.json/html
Le code de sortie est celui de ``s.finish()`` : 0 ok, 1 vérification échouée,
2 erreur d'exécution (pour --repeat/--data : 0 si TOUTES les exécutions sont à 0).
"""
from __future__ import annotations

import csv
import json
import os
import runpy
import sys
import time
from typing import Any, Dict, List, Optional


def _run_once(script: str, argv: List[str], env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Une exécution : code de sortie + document de rapport (si la séance a fini)."""
    from . import session as _session
    _session._CURRENT = None
    saved = {}
    for k, v in (env or {}).items():
        saved[k] = os.environ.get(k)
        os.environ[k] = v
    sys.argv = [script] + list(argv)
    code = 0
    try:
        runpy.run_path(script, run_name="__main__")
    except SystemExit as e:
        c = e.code
        code = int(c) if isinstance(c, int) else (0 if c is None else 2)
    except Exception as e:                 # noqa: BLE001 — abandon : rapport écrit, message court, code 1/2
        code = 1 if isinstance(e, _session.CheckFailed) else 2
        cur = _session._CURRENT
        if cur is not None:
            # Vérification en échec APRÈS une étape en échec continuée : c'est l'erreur
            # d'exécution (2) qui prime, comme dans ``finish()``.
            code = max(code, cur.report.exit_code())
        if cur is not None and not cur.report.finished:
            if not isinstance(e, (_session.StepError, _session.CheckFailed, _session.NeedsVision)):
                cur.report.note(f"plantage : {type(e).__name__}: {e}")
            cur.report.finish(code, f"ABANDON — {e}")
        else:
            print(f"ABANDON — {type(e).__name__}: {e}", file=sys.stderr)
        if os.environ.get("ELPIS_TRACE"):
            import traceback
            traceback.print_exc()
        else:
            print("(trace complète : ELPIS_TRACE=1)", file=sys.stderr)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    cur = _session._CURRENT
    doc: Dict[str, Any] = {}
    if cur is not None:
        # Script sans ``raise SystemExit(s.finish())`` (fin de fichier) : le code 0 de la
        # fin normale ne masque pas les étapes en échec du rapport.
        code = max(code, cur.report.exit_code())
        if not cur.report.finished:
            cur.report.finish(code)
        doc = _load_doc(cur.report.dir)
    return {"code": code, "doc": doc, "dir": getattr(getattr(cur, "report", None), "dir", "")}


def _load_doc(rep_dir: str) -> Dict[str, Any]:
    try:
        with open(os.path.join(rep_dir, "rapport.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


# ── --repeat : stabilité ──────────────────────────────────────────────────────
def stability(docs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Par étape (index + libellé) : taux de réussite, durées p50/p95, attente
    moyenne, réparations ; suggestions concrètes. PUR (testable)."""
    by: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for d in docs:
        for st in d.get("steps") or []:
            key = f"{st.get('index')}|{st.get('label')}"
            if key not in by:
                by[key] = {"index": st.get("index"), "label": st.get("label"), "runs": 0, "ok": 0,
                           "ms": [], "waited": [], "healed": 0, "errors": {}}
                order.append(key)
            b = by[key]
            b["runs"] += 1
            b["ok"] += 1 if st.get("ok") else 0
            b["ms"].append(int(st.get("ms") or 0))
            b["waited"].append(int(st.get("waited_ms") or 0))
            b["healed"] += 1 if st.get("healed") else 0
            if st.get("error"):
                b["errors"][str(st["error"])[:120]] = b["errors"].get(str(st["error"])[:120], 0) + 1

    def pct(v: List[int], q: float) -> int:
        if not v:
            return 0
        v = sorted(v)
        return v[min(len(v) - 1, int(round((len(v) - 1) * q)))]
    steps = []
    for key in order:
        b = by[key]
        rate = b["ok"] / b["runs"] if b["runs"] else 0.0
        row = {"index": b["index"], "label": b["label"], "runs": b["runs"], "ok": b["ok"],
               "rate": round(rate, 3), "p50_ms": pct(b["ms"], 0.5), "p95_ms": pct(b["ms"], 0.95),
               "waited_avg_ms": int(sum(b["waited"]) / len(b["waited"])) if b["waited"] else 0,
               "healed": b["healed"], "errors": b["errors"], "suggestions": []}
        if rate < 1.0:
            row["suggestions"].append("fragile : %d échec(s) sur %d" % (b["runs"] - b["ok"], b["runs"]))
            if any("délai" in e or "introuvable" in e for e in b["errors"]):
                row["suggestions"].append("ajoutez une attente nommée avant cette étape (s.wait.element / s.wait.window) ou une précondition (s.require)")
        if row["waited_avg_ms"] >= 1000:
            row["suggestions"].append("la cible met ~%d ms à apparaître : attente explicite conseillée avant l'action" % row["waited_avg_ms"])
        if row["p95_ms"] > 12000:
            row["suggestions"].append("p95 à %d ms : relevez le délai (timeout=%d)" % (row["p95_ms"], int(row["p95_ms"] / 1000) + 5))
        if b["healed"]:
            row["suggestions"].append("cible réparée %d fois : reprenez la ligne proposée dans le rapport" % b["healed"])
        steps.append(row)
    runs_ok = sum(1 for d in docs if int(d.get("exit_code", 2)) == 0)
    return {"runs": len(docs), "runs_ok": runs_ok, "rate": round(runs_ok / len(docs), 3) if docs else 0.0,
            "steps": steps, "fragile": [s["index"] for s in steps if s["rate"] < 1.0]}


def _stability_html(doc: Dict[str, Any]) -> str:
    import html as _h
    rows = "".join(
        f"<tr class='{'ok' if s['rate'] >= 1 else 'ko'}'><td>{s['index']}</td><td>{_h.escape(str(s['label']))}</td>"
        f"<td>{s['ok']}/{s['runs']}</td><td>{s['p50_ms']} / {s['p95_ms']} ms</td><td>{s['waited_avg_ms']} ms</td>"
        f"<td>{'<br>'.join(_h.escape(x) for x in s['suggestions'])}</td></tr>" for s in doc["steps"])
    return f"""<!doctype html><meta charset="utf-8"><title>stabilité</title>
<style>body{{font:14px system-ui;margin:24px;color:#1e293b}}table{{border-collapse:collapse;width:100%}}
td,th{{border-bottom:1px solid #e2e8f0;padding:6px 8px;text-align:left;vertical-align:top}}tr.ko td{{background:#fef2f2}}</style>
<h1>Stabilité — {doc['runs_ok']}/{doc['runs']} exécutions réussies</h1>
<table><tr><th>#</th><th>Étape</th><th>Réussite</th><th>p50 / p95</th><th>Attente moy.</th><th>Suggestions</th></tr>{rows}</table>"""


def _write_summary(base_dir: str, name: str, kind: str, doc: Dict[str, Any], html_text: str) -> str:
    d = os.path.join(base_dir, f"{name}-{kind}-{time.strftime('%Y-%m-%d_%H-%M-%S')}")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"{kind}.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    with open(os.path.join(d, f"{kind}.html"), "w", encoding="utf-8") as f:
        f.write(html_text)
    return d


def _read_csv(path: str) -> List[Dict[str, str]]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        sample = f.read(2048)
        f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=";,\t")
        except csv.Error:
            dialect = csv.excel
        return [{(k or "").strip(): (v or "").strip() for k, v in row.items()} for row in csv.DictReader(f, dialect=dialect)]


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    opts = {"dry_run": False, "trace": False, "repeat": 1, "data": ""}
    rest: List[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--dry-run":
            opts["dry_run"] = True
        elif a == "--trace":
            opts["trace"] = True
        elif a == "--repeat" and i + 1 < len(argv):
            opts["repeat"] = max(1, int(argv[i + 1])); i += 1
        elif a.startswith("--repeat="):
            opts["repeat"] = max(1, int(a.split("=", 1)[1]))
        elif a == "--data" and i + 1 < len(argv):
            opts["data"] = argv[i + 1]; i += 1
        elif a.startswith("--data="):
            opts["data"] = a.split("=", 1)[1]
        else:
            rest.append(a)
        i += 1
    if not rest or rest[0] in ("-h", "--help"):
        print(__doc__, file=sys.stderr)
        return 2
    script = os.path.abspath(rest[0])
    if not os.path.isfile(script):
        print(f"script introuvable : {script}", file=sys.stderr)
        return 2
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sdir = os.path.dirname(script)
    for p in (here, sdir):                       # runtime + dossier du script (→ ``import lib.xxx``)
        if p not in sys.path:
            sys.path.insert(0, p)
    env: Dict[str, str] = {}
    if opts["dry_run"]:
        env["ELPIS_DRY_RUN"] = "1"
    if opts["trace"]:
        env["ELPIS_TRACE_STEPS"] = "1"
    name = os.path.splitext(os.path.basename(script))[0]

    if opts["data"]:
        rows = _read_csv(opts["data"])
        if not rows:
            print(f"aucune ligne dans {opts['data']}", file=sys.stderr)
            return 2
        results = []
        for k, row in enumerate(rows, 1):
            renv = dict(env, **{"ELPIS_PARAM_" + key.upper(): val for key, val in row.items() if key})
            print(f"\n=== ligne {k}/{len(rows)} : {row}", file=sys.stderr)
            r = _run_once(script, rest[1:], renv)
            results.append({"row": k, "params": row, "code": r["code"], "summary": (r["doc"] or {}).get("summary", ""),
                            "dir": r["dir"], "script": (r["doc"] or {}).get("script", "")})
        last_dir = next((r["dir"] for r in reversed(results) if r["dir"]), "")
        base = os.path.dirname(last_dir) if last_dir else os.path.join(sdir, "rapports")
        name = next((r["script"] for r in results if r.get("script")), None) or name
        doc = {"script": name, "rows": len(rows), "ok": sum(1 for r in results if r["code"] == 0), "results": results}
        import html as _h
        rows_html = "".join(f"<tr class='{'ok' if r['code'] == 0 else 'ko'}'><td>{r['row']}</td><td>{_h.escape(json.dumps(r['params'], ensure_ascii=False))}</td>"
                            f"<td>{r['code']}</td><td>{_h.escape(r['summary'])}</td></tr>" for r in results)
        d = _write_summary(base, name, "donnees", doc,
                           f"<!doctype html><meta charset='utf-8'><title>données</title><style>body{{font:14px system-ui;margin:24px}}table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid #e2e8f0;padding:6px 8px;text-align:left}}tr.ko td{{background:#fef2f2}}</style>"
                           f"<h1>{_h.escape(name)} — {doc['ok']}/{doc['rows']} lignes réussies</h1><table><tr><th>#</th><th>Paramètres</th><th>Code</th><th>Résumé</th></tr>{rows_html}</table>")
        print(f"\nDONNÉES — {doc['ok']}/{doc['rows']} lignes réussies  →  {d}", file=sys.stderr)
        return 0 if doc["ok"] == doc["rows"] else 1

    if opts["repeat"] > 1:
        docs, codes, last_dir = [], [], ""
        for k in range(opts["repeat"]):
            print(f"\n=== exécution {k + 1}/{opts['repeat']}", file=sys.stderr)
            r = _run_once(script, rest[1:], env)
            codes.append(r["code"])
            if r["doc"]:
                docs.append(r["doc"])
            last_dir = r["dir"] or last_dir
        stab = stability(docs)
        base = os.path.dirname(last_dir) if last_dir else os.path.join(sdir, "rapports")
        name = (docs[0].get("script") if docs else None) or name
        d = _write_summary(base, name, "stabilite", stab, _stability_html(stab))
        print(f"\nSTABILITÉ — {stab['runs_ok']}/{stab['runs']} exécutions réussies"
              + (f", étapes fragiles : {stab['fragile']}" if stab["fragile"] else "") + f"  →  {d}", file=sys.stderr)
        return 0 if all(c == 0 for c in codes) else max(codes)

    return _run_once(script, rest[1:], env)["code"]


if __name__ == "__main__":
    raise SystemExit(main())
