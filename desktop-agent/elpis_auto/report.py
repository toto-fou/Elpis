# SPDX-License-Identifier: MIT
"""elpis_auto.report — journal d'une exécution : étapes, notes, captures
d'échec, puis rapport JSON + HTML dans ``rapports/<script>-<horodatage>/``.

Le rapport dit ce qui s'est passé, avec la méthode d'ancrage réellement
employée (``method``) : c'est ce qu'on lit pour comprendre un script devenu
fragile (une cible qui retombe en coordonnées est un signal avant la panne).
"""
from __future__ import annotations

import html
import json
import os
import re
import sys
import time
from typing import Any, Dict, List


class Report:
    def __init__(self, name: str, base_dir: str = "rapports"):
        self.name = str(name or "script")
        self.started = time.time()
        self.steps: List[Dict[str, Any]] = []
        self.notes: List[Dict[str, Any]] = []
        self.failed_checks = 0
        self.failed_steps = 0
        stamp = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime(self.started))
        self.dir = os.path.join(str(base_dir), f"{_slug(self.name)}-{stamp}")
        k = 2                                   # deux exécutions dans la même seconde (--repeat, --data) : dossiers distincts
        while os.path.exists(self.dir):
            self.dir = os.path.join(str(base_dir), f"{_slug(self.name)}-{stamp}-{k}")
            k += 1
        self._n_png = 0
        self.finished = False
        self.dry_run = False

    # ── écriture pendant l'exécution ────────────────────────────────────
    def step(self, rec: Dict[str, Any], ok: bool) -> None:
        rec = dict(rec)
        rec["ok"] = bool(ok)
        rec["at"] = round(time.time() - self.started, 3)
        rec["index"] = len(self.steps) + 1
        self.steps.append(rec)
        if not ok:
            # Attentes et vérifications passent toutes par ``_poll`` (``wait: True``). Le
            # libellé ne dit rien : « saisir « compte » dans… » est une ACTION (code 2).
            if rec.get("wait"):
                self.failed_checks += 1
            else:
                self.failed_steps += 1
        self._echo(rec)

    def note(self, text: str) -> None:
        self.notes.append({"at": round(time.time() - self.started, 3), "text": str(text),
                           "after_step": len(self.steps)})
        print(f"  · {text}", file=sys.stderr, flush=True)

    def save_png(self, png: bytes, label: str = "") -> str:
        os.makedirs(self.dir, exist_ok=True)
        self._n_png += 1
        fn = os.path.join(self.dir, f"echec-{self._n_png:02d}-{_slug(label)[:40]}.png")
        with open(fn, "wb") as f:
            f.write(png)
        return fn

    def save_trace_png(self, png: bytes, index: int) -> str:
        os.makedirs(self.dir, exist_ok=True)
        fn = os.path.join(self.dir, f"etape-{index:02d}.png")
        with open(fn, "wb") as f:
            f.write(png)
        return fn

    def save_trace_json(self, doc: Dict[str, Any], index: int) -> str:
        os.makedirs(self.dir, exist_ok=True)
        fn = os.path.join(self.dir, f"etape-{index:02d}.json")
        with open(fn, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)
        return fn

    # ── fin ─────────────────────────────────────────────────────────────
    def exit_code(self) -> int:
        if self.failed_steps:
            return 2
        return 1 if self.failed_checks else 0

    def finish(self, code: int, summary: str = "") -> Dict[str, Any]:
        if self.finished:
            return {}
        self.finished = True
        doc = {
            "script": self.name, "started": self.started, "duration_s": round(time.time() - self.started, 3),
            "exit_code": int(code), "summary": summary or self.summary(),
            "steps": self.steps, "notes": self.notes,
            "ok": sum(1 for s in self.steps if s["ok"]), "failed": sum(1 for s in self.steps if not s["ok"]),
            # pile auto-réparante : étapes résolues par une identité de repli, avec la ligne à écrire
            "healed": [{"index": s["index"], "label": s.get("label", ""), **s["healed"]}
                       for s in self.steps if s.get("healed")],
        }
        if self.dry_run:
            doc["dry_run"] = True
            doc["targets"] = self._dry_targets()
        try:
            os.makedirs(self.dir, exist_ok=True)
            with open(os.path.join(self.dir, "rapport.json"), "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False, indent=2)
            with open(os.path.join(self.dir, "rapport.html"), "w", encoding="utf-8") as f:
                f.write(_html(doc))
        except OSError as e:
            print(f"rapport non écrit : {e}", file=sys.stderr)
        print(f"\n{doc['summary']}  {_mark('→', '->')}  {self.dir}", file=sys.stderr, flush=True)
        return doc

    def _dry_targets(self) -> Dict[str, int]:
        """Vol à blanc : cibles d'ACTION trouvées / introuvables. Une touche, une pause,
        une attente de fenêtre (« absente maintenant », ok) ne sont pas des cibles trouvées."""
        acts = [s for s in self.steps if s.get("dry") and not s.get("wait")]
        return {"found": sum(1 for s in acts if str(s.get("method", "")).startswith(("trouvé", "point"))),
                "missing": sum(1 for s in acts if not s["ok"])}

    def summary(self) -> str:
        n = len(self.steps)
        bad = sum(1 for s in self.steps if not s["ok"])
        healed = sum(1 for s in self.steps if s.get("healed"))
        tail = f", {healed} réparée(s)" if healed else ""
        if self.dry_run:
            tg = self._dry_targets()
            return f"VOL À BLANC — {tg['found']} cible(s) trouvée(s), {tg['missing']} introuvable(s){tail}"
        if bad == 0:
            return f"OK — {n} étape(s){tail}"
        return f"ÉCHEC — {bad} étape(s) sur {n} (code {self.exit_code()}){tail}"

    @staticmethod
    def _echo(rec: Dict[str, Any]) -> None:
        mark = _mark("✓" if rec["ok"] else "✗", "OK" if rec["ok"] else "KO")
        tail = f" — {rec['error']}" if rec.get("error") else ""
        if rec.get("healed"):
            tail += f" — réparé par {rec['healed'].get('by')}" + (f" → {rec['healed']['suggest']}" if rec["healed"].get("suggest") else "")
        meth = f" [{rec['method']}]" if rec.get("method") else ""
        print(f"{mark} {rec['index']:>3}. {rec.get('label','')}{meth} ({rec.get('ms', 0)} ms){tail}",
              file=sys.stderr, flush=True)


def _mark(sym: str, ascii_: str) -> str:
    """``sym`` si la console sait l'écrire, sinon ``ascii_`` — une console
    Windows en cp850/cp1252 affichait « \\u2713 » à la place de la coche."""
    enc = getattr(sys.stderr, "encoding", None) or "utf-8"
    try:
        sym.encode(enc)
        return sym
    except (UnicodeEncodeError, LookupError):
        return ascii_


def _slug(s: str) -> str:
    s = re.sub(r"[^\w.-]+", "-", str(s or ""), flags=re.UNICODE).strip("-")
    return s or "script"


def _html(doc: Dict[str, Any]) -> str:
    rows = []
    for st in doc["steps"]:
        cls = "ok" if st["ok"] else "ko"
        links = []
        if st.get("screenshot"):
            links.append(f'<a href="{html.escape(os.path.basename(st["screenshot"]))}">capture</a>')
        if st.get("trace_png"):
            links.append(f'<a href="#" data-step="{st["index"]}" class="tr">voir</a>')
        healed = (f"<div class='heal'>réparé par <b>{html.escape(str(st['healed'].get('by')))}</b>"
                  + (f" → <code>{html.escape(st['healed']['suggest'])}</code>" if st["healed"].get("suggest") else "") + "</div>") if st.get("healed") else ""
        rows.append(f"<tr class='{cls}' id='s{st['index']}'><td>{st['index']}</td><td>{html.escape(str(st.get('label','')))}{healed}</td>"
                    f"<td>{html.escape(str(st.get('method','')))}{(' · ' + html.escape(str(st.get('resolved_by')))) if st.get('resolved_by') else ''}</td>"
                    f"<td>{st.get('ms',0)} ms{(' (attendu ' + str(st.get('waited_ms')) + ' ms)') if st.get('waited_ms') else ''}</td>"
                    f"<td>{html.escape(str(st.get('error','')))} {' '.join(links)}</td></tr>")
    notes = "".join(f"<li>{html.escape(n['text'])}</li>" for n in doc["notes"])
    healed_all = doc.get("healed") or []
    heal_html = ""
    if healed_all:
        items = "".join(f"<li>étape {h['index']} — {html.escape(str(h.get('label','')))} : résolue par <b>{html.escape(str(h.get('by')))}</b>"
                        + (f" → <code>{html.escape(str(h.get('suggest')))}</code>" if h.get("suggest") else "") + "</li>" for h in healed_all)
        heal_html = f"<h2>Réparations ({len(healed_all)})</h2><p class='sum'>Ces cibles ont été retrouvées par une identité de repli : mettez la ligne à jour.</p><ul>{items}</ul>"
    traces = {st["index"]: {"png": os.path.basename(st["trace_png"]), "json": os.path.basename(st.get("trace_tree") or ""), "box": st.get("box")}
              for st in doc["steps"] if st.get("trace_png")}
    viewer = ""
    if traces:
        viewer = """<h2>Trace pas à pas</h2><div class="viewer"><div class="stage"><img id="tImg" alt=""><div id="tBox" class="box"></div></div>
<pre id="tTree"></pre></div>
<script>
const TR = %s;
function show(i){const t=TR[i];if(!t)return;const img=document.getElementById('tImg');img.src=t.png;
img.onload=function(){const b=document.getElementById('tBox');if(t.box){const sx=img.clientWidth/img.naturalWidth,sy=img.clientHeight/img.naturalHeight;
b.style.display='block';b.style.left=(t.box[0]*sx)+'px';b.style.top=(t.box[1]*sy)+'px';b.style.width=(t.box[2]*sx)+'px';b.style.height=(t.box[3]*sy)+'px';}else b.style.display='none';};
document.querySelectorAll('tr').forEach(r=>r.classList.remove('cur'));const row=document.getElementById('s'+i);if(row)row.classList.add('cur');
if(t.json){fetch(t.json).then(r=>r.json()).then(d=>{document.getElementById('tTree').textContent=(d.nodes||[]).map(n=>(n.target?'▶ ':'  ')+'  '.repeat(n.depth||0)+(n.role||'')+' '+JSON.stringify(n.name||'')+(n.auto_id?' #'+n.auto_id:'')+(n.states&&n.states.length?' ['+n.states.join(',')+']':'')).join('\\n');}).catch(()=>{});}}
document.querySelectorAll('a.tr').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();show(a.dataset.step);}));
const first=Object.keys(TR)[0];if(first)show(first);
</script>""" % json.dumps(traces, ensure_ascii=False)
    return f"""<!doctype html><meta charset="utf-8"><title>{html.escape(doc['script'])}</title>
<style>body{{font:14px system-ui;margin:24px;color:#1e293b}}table{{border-collapse:collapse;width:100%}}
td,th{{border-bottom:1px solid #e2e8f0;padding:6px 8px;text-align:left;vertical-align:top}}
tr.ko td{{background:#fef2f2}}tr.cur td{{outline:2px solid #2563eb}}h1{{font-size:18px}}.sum{{color:#475569}}
.heal{{font-size:12px;color:#b45309}}code{{background:#f1f5f9;padding:1px 4px;border-radius:3px}}
.viewer{{display:flex;gap:16px;align-items:flex-start}}.stage{{position:relative;max-width:64%}}.stage img{{max-width:100%;border:1px solid #e2e8f0}}
.box{{position:absolute;border:3px solid #f59e0b;box-shadow:0 0 0 2px #fff;display:none;pointer-events:none}}
pre{{flex:1;font:12px ui-monospace,monospace;background:#f8fafc;padding:8px;max-height:70vh;overflow:auto}}</style>
<h1>{html.escape(doc['script'])}</h1>
<p class="sum">{html.escape(doc['summary'])} · {doc['duration_s']} s · {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(doc['started']))}</p>
<table><tr><th>#</th><th>Étape</th><th>Méthode</th><th>Durée</th><th>Erreur</th></tr>{''.join(rows)}</table>
{heal_html}
{('<h2>Notes</h2><ul>' + notes + '</ul>') if notes else ''}
{viewer}
"""
