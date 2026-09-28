# SPDX-License-Identifier: MIT
"""
shared_infra/sandbox/preview_rewrite.py — références ABSOLUES-RACINE d'une
page en aperçu.

Une page écrite pour être servie à la racine d'un site référence
``/style.css``, ``url(/img/bg.png)`` ou ``fetch('/data.json')``. Montée sous
``/api/sandbox/pv/<jeton>/<chemin>``, ces refs visent l'origine de l'app.
L'ancien repli (gestionnaire 404 + ``Referer``) ne tient plus : le document
a une origine OPAQUE (audit 2026-09-22, H1) et le navigateur n'envoie alors
plus le chemin du référent (Chromium : aucun ``Referer``, Firefox : l'origine
seule — vérifié).

On réécrit donc ces refs côté serveur vers le résolveur
``/api/sandbox/pv/<jeton>/~r/d<dossier>/<chemin>``, qui cherche ``<chemin>``
dans le dossier du document puis en remontant vers la racine de la sandbox
(même règle que l'ancien repli). Couvre les attributs HTML, ``url()`` et
``@import`` CSS, et ``fetch``/``XMLHttpRequest`` par un court script injecté.
Limite : une URL absolue construite autrement (``new Image().src = '/x'``,
``import('/m.js')``) n'est pas vue.
"""
from __future__ import annotations

import json
import re
from urllib.parse import quote, unquote

RESOLVER = "~r"
MAX_REWRITE_BYTES = 4 * 1024 * 1024

_ATTR_RE = re.compile(
    r"""(\s(?:href|src|action|poster|data|formaction)\s*=\s*)(["']?)/(?![/\\])""", re.I)
_CSS_URL_RE = re.compile(r"""(url\(\s*)(["']?)/(?![/\\])""", re.I)
_CSS_IMPORT_RE = re.compile(r"""(@import\s+)(["'])/(?![/\\])""", re.I)
_HEAD_RE = re.compile(r"<head\b[^>]*>", re.I)

_SHIM = ("<script>(function(b){function f(u){return(typeof u==='string'&&u.charAt(0)==='/'"
         "&&u.charAt(1)!=='/')?b+u.slice(1):u}var F=window.fetch;if(F)window.fetch="
         "function(u,o){return F.call(this,f(u),o)};var X=window.XMLHttpRequest;if(X){var O="
         "X.prototype.open;X.prototype.open=function(m,u){arguments[1]=f(u);return O.apply("
         "this,arguments)}}})(%s);</script>")


def resolver_base(prefix: str, doc_dir: str) -> str:
    """``<prefix>~r/d<dossier encodé>/`` — ``d`` seul pour la racine (un
    segment « . » serait normalisé par le navigateur)."""
    return f"{prefix}{RESOLVER}/d{quote(doc_dir.strip('/'), safe='')}/"


def split_resolver(rest: str):
    """``d<dossier>/<chemin>`` → ``(dossier, chemin)`` ou ``None``."""
    seg, _, wanted = rest.partition("/")
    if not seg.startswith("d") or not wanted:
        return None
    return unquote(seg[1:]), wanted


def rewrite_css(text: str, base: str) -> str:
    text = _CSS_URL_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{base}", text)
    return _CSS_IMPORT_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{base}", text)


def rewrite_html(text: str, base: str) -> str:
    text = _ATTR_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{base}", text)
    text = rewrite_css(text, base)
    shim = _SHIM % json.dumps(base)
    m = _HEAD_RE.search(text)
    if m:
        return text[:m.end()] + shim + text[m.end():]
    return shim + text


__all__ = ["RESOLVER", "MAX_REWRITE_BYTES", "resolver_base", "split_resolver",
           "rewrite_css", "rewrite_html"]
