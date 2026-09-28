#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""tools/generate_admin_fields.py — index des champs de la console admin (Ctrl+K).

La recherche de la console (lot 7 de la refonte, 2026-09-27) doit trouver un
réglage sur une page qui n'est PAS affichée : les pages sont en ``v-if``, leur
DOM n'existe pas. On indexe donc les gabarits eux-mêmes, une fois pour toutes :
chaque contrôle ``data-field="bloc:chemin"`` (le même attribut que lit la barre
d'enregistrement), avec le libellé de sa rangée (``.adm-row__label``), son aide
(``title``) et la page qui l'affiche (``v-if="adminTab==='…'"`` le plus proche).

Sortie : ``frontend/js/admin/_fields.js`` (``window.ELPIS_ADMIN_FIELDS``),
fichier GÉNÉRÉ et versionné. ``tests/frontend/test_admin_fields_index.py``
échoue s'il n'est plus à jour : relancer

    python3 tools/generate_admin_fields.py
"""
from __future__ import annotations

import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend" / "includes" / "admin"
OUT = ROOT / "frontend" / "js" / "admin" / "_fields.js"

_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
         "meta", "source", "track", "wbr"}
_PAGE_RE = re.compile(r"adminTab\s*===?\s*'([a-z0-9-]+)'")


class _Indexer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[dict] = []      # {tag, page, row}
        self.fields: list[dict] = []
        self._label_row = None            # rangée dont on lit le libellé
        self._label_at = -1               # indice, dans la pile, du libellé lu
        self._parts: list[str] = []

    # Contexte hérité : page (v-if le plus proche qui nomme UNE page) et rangée.
    def _ctx(self, key):
        for fr in reversed(self.stack):
            if fr.get(key) is not None:
                return fr[key]
        return None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        frame = {"tag": tag, "page": None, "row": None}
        vif = a.get("v-if") or a.get("v-else-if") or ""
        pages = _PAGE_RE.findall(vif)
        if len(pages) == 1 and "includes(" not in vif:
            frame["page"] = pages[0]
        cls = (a.get("class") or "").split()
        if "adm-row" in cls:
            frame["row"] = {"label": "", "hint": ""}
        row = self._ctx("row")
        if ("adm-row__label" in cls and row is not None and not row["label"]
                and self._label_row is None and tag not in _VOID):
            row["hint"] = (a.get("title") or "").strip()
            self._label_row, self._label_at, self._parts = row, len(self.stack), []
        df = a.get("data-field")
        if df and ":" in df:
            store, path = df.split(":", 1)
            label = ((row or {}).get("label") or "").strip() or (a.get("aria-label") or "").strip()
            page = self._ctx("page")
            if page and label:
                self.fields.append({
                    "page": page, "store": store, "path": path, "label": label,
                    "hint": ((row or {}).get("hint") or a.get("title") or "").strip(),
                    "control": (a.get("aria-label") or "").strip(),
                })
        if tag not in _VOID:
            self.stack.append(frame)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in _VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in _VOID:
            return
        # Tolérant : dépile jusqu'à la balise correspondante.
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i]["tag"] == tag:
                if self._label_row is not None and i <= self._label_at:
                    self._label_row["label"] = re.sub(r"\s+", " ", "".join(self._parts)).strip()
                    self._label_row, self._label_at = None, -1
                del self.stack[i:]
                break

    def handle_data(self, data):
        if self._label_row is not None:
            self._parts.append(data)


def build() -> list[dict]:
    fields: list[dict] = []
    seen = set()
    for f in sorted(SRC.glob("tab_*.html")):
        text = f.read_text(encoding="utf-8")
        # Les commentaires HTML contiennent parfois des balises d'exemple.
        text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
        ix = _Indexer()
        ix.feed(text)
        for fd in ix.fields:
            key = (fd["page"], fd["store"], fd["path"])
            if key in seen:
                continue
            seen.add(key)
            fd["label"] = re.sub(r"\s+", " ", fd["label"]).strip()
            fields.append(fd)
    fields.sort(key=lambda d: (d["page"], d["label"].lower(), d["path"]))
    return fields


def render(fields: list[dict]) -> str:
    body = ",\n".join("    " + json.dumps(f, ensure_ascii=False, sort_keys=True) for f in fields)
    return (
        "// SPDX-License-Identifier: MIT\n"
        "// ============================================================================\n"
        "//  frontend/js/admin/_fields.js — GÉNÉRÉ par tools/generate_admin_fields.py\n"
        "//  Ne pas éditer à la main : relancer le script après avoir changé un gabarit\n"
        "//  de la console (test : tests/frontend/test_admin_fields_index.py).\n"
        "//  Index des réglages pour la recherche Ctrl+K : page, bloc:chemin, libellé.\n"
        "// ============================================================================\n"
        "window.ELPIS_ADMIN_FIELDS = Object.freeze([\n" + body + "\n]);\n"
    )


def main() -> int:
    out = render(build())
    if "--check" in sys.argv:
        cur = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if cur != out:
            print("frontend/js/admin/_fields.js n'est plus à jour : python3 tools/generate_admin_fields.py")
            return 1
        return 0
    OUT.write_text(out, encoding="utf-8")
    print(f"écrit {OUT.relative_to(ROOT)} : {out.count(chr(10) + '    {')} champs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
