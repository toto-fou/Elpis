# SPDX-License-Identifier: MIT
"""
backend.services._tool_parsing — Tool-call parsing — Extract JSON tool_calls from LLM output.

Handles the dialects emitted by different llama.cpp builds:
  • <tool_call>{...}</tool_call> XML-style
  • ```json …``` fenced code blocks
  • bare JSON arrays after the assistant text
"""
from __future__ import annotations

import json
import re
import logging
from typing import Any, Dict, List, Optional, Tuple

# ``_clean_json_text`` lives in ``_chat_with_tools``; importing it eagerly
# at module load creates a cycle (``_chat_with_tools`` imports from us).
# The lazy import below is resolved on first call to ``extract_tool_calls``,
# at which point both modules are fully loaded.
def _clean_json_text(text: str) -> str:
    from llm_core._chat_with_tools import _clean_json_text as _f
    return _f(text)


logger = logging.getLogger("uvicorn.error")

# AUDIT 2026-06 — feedback des tool-calls PERDUS. Quand un appel d'outil est
# détecté (balise <tool_call> ou objet JSON {"name":…} plausible) mais NE PARSE
# PAS, on remontait l'info en log uniquement → le petit modèle 30-129B restait
# dans le silence et rejouait son erreur en boucle. On expose un diagnostic
# module-niveau (même pattern que ``_detection_client.LAST_ERROR``) que la boucle
# chat lit juste après l'appel pour réinjecter un message correctif au modèle.
LAST_PARSE_DIAGNOSTIC: str = ""

# Message correctif renvoyé au modèle (FR, actionnable). Volontairement court et
# explicite sur le format attendu — c'est ce que le modèle voit, pas un log.
_PARSE_DIAGNOSTIC_MSG = (
    "A tool call was detected in your reply but could not be parsed "
    "(invalid JSON/markup). Re-issue it in EXACTLY this format, one valid "
    'JSON object per block, with no text between the braces:\n'
    '<tool_call>{"name": "<tool_name>", "arguments": {<key>: <value>}}</tool_call>'
)


_GLM_NAME_RE = re.compile(r'^[\w.\-]{1,128}$')
_GLM_ARG_RE = re.compile(
    r'<arg_key>\s*(.*?)\s*</arg_key>\s*<arg_value>\s*(.*?)\s*</arg_value>',
    re.DOTALL | re.IGNORECASE,
)


def _parse_glm_tool_block(block: str) -> Optional[Tuple[str, Dict[str, Any]]]:
    """Corps d'un ``<tool_call>`` au format **GLM-4.5/4.6** (XML, PAS du JSON) :
    ``name <arg_key>k</arg_key> <arg_value>v</arg_value> …``. Le nom suit
    immédiatement la balise ouvrante ; chaque paire arg_key/arg_value est un
    argument (valeur dé-JSON-ifiée si possible : nombre/bool/objet, sinon
    string). Gère aussi l'appel SANS argument (``<tool_call>refresh</tool_call>``).
    Renvoie ``(name, args)`` ou ``None`` si ça ne ressemble pas à du GLM-XML."""
    m = re.search(r'<arg_key>', block, re.IGNORECASE)
    head = (block[:m.start()] if m else block).strip()
    name = head.splitlines()[0].strip() if head else ""
    if not name or not _GLM_NAME_RE.match(name):
        return None
    args: Dict[str, Any] = {}
    for k, v in _GLM_ARG_RE.findall(block):
        k = k.strip()
        v = v.strip()
        try:
            args[k] = json.loads(v)          # nombre / bool / null / objet / array
        except (json.JSONDecodeError, ValueError):
            args[k] = v                      # valeur texte brute
    return (name, args)


def _strip_param_value(v: str) -> str:
    """Retire un seul ``\n`` (ou ``\r\n``) de tête et de fin, rien d'autre.
    Une valeur écrite EN LIGNE, sans aucun saut (``<parameter=path> a.py
    </parameter>``), est strippée en entier."""
    if "\n" not in v:
        return v.strip()
    if v.startswith("\r\n"):
        v = v[2:]
    elif v.startswith("\n"):
        v = v[1:]
    if v.endswith("\r\n"):
        v = v[:-2]
    elif v.endswith("\n"):
        v = v[:-1]
    return v


def extract_tool_calls(text: str) -> Optional[List[Tuple[str, Dict[str, Any]]]]:
    """
    Parse tool calls from LLM text output. Handles multiple formats:
    1. JSON: {"name": "...", "arguments": {...}}
    2. Qwen XML: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
    3. GLM-4.5/4.6 XML: <tool_call>name <arg_key>k</arg_key> <arg_value>v</arg_value></tool_call>
    4. GPT-like: <function=name> <parameter=key>value</parameter> </function>
    5. tool_call wrapper: {"tool_call": {"name": "...", "arguments": {...}}}
    """
    global LAST_PARSE_DIAGNOSTIC
    LAST_PARSE_DIAGNOSTIC = ""          # reset à chaque appel (lu juste après)
    if not text:
        return None

    found_tools = []
    _failed_blocks: List[str] = []     # blocs <tool_call> balisés mais non parsables

    # ── Strategy 1: <tool_call> XML blocks (Qwen JSON + GLM-4.x XML) ──────────
    tool_call_blocks = re.findall(
        r'<tool_call>\s*(.*?)\s*</tool_call>', text, re.DOTALL
    )
    for block in tool_call_blocks:
        block = block.strip()
        parsed = False
        try:
            obj = json.loads(block)
            if isinstance(obj, dict) and "name" in obj:
                args = obj.get("arguments", obj.get("parameters", {}))
                if isinstance(args, str):
                    # Args émis comme STRING JSON (dialectes hors canal natif).
                    # On scope l'except (un ``except:`` nu attraperait aussi
                    # KeyboardInterrupt/SystemExit) et on retombe sur ``{}`` —
                    # aligné sur le chemin natif (_chat_with_tools : args illisible
                    # ⇒ {}), plus sûr que de smuggler ``{"value": <str brute>}``
                    # qui mésformerait l'appel (le caller filtre par nom connu).
                    try:
                        args = json.loads(args)
                    except (json.JSONDecodeError, ValueError, TypeError):
                        args = {}
                found_tools.append((obj["name"], args))
                parsed = True
        except json.JSONDecodeError:
            pass
        if not parsed:
            # Pas du JSON → essaie le dialecte GLM-4.5/4.6 (name + arg_key/
            # arg_value), le format XML natif de ces modèles « thinking » qui
            # arrivait jusqu'ici en TEXTE quand llama.cpp ne le parsait pas.
            glm = _parse_glm_tool_block(block)
            if glm:
                found_tools.append(glm)
                parsed = True
        if not parsed:
            # AUDIT 2026-06 — un bloc <tool_call> explicitement balisé qui ne
            # parse (ni JSON ni GLM-XML) = signal fort d'un tool-call PERDU. On
            # logge (tronqué) ET on le mémorise pour remonter un diagnostic au
            # modèle si aucun autre tool-call n'est finalement extrait.
            _failed_blocks.append(block)
            logger.warning(
                "[tool_parsing] bloc <tool_call> non parsable (ni JSON ni "
                "GLM-XML) ignoré (%d chars): %.120s…", len(block), block,
            )

    if found_tools:
        return found_tools

    # ── Strategy 2: <function=name> <parameter=key>value (GPT-like) ─
    # AUDIT 2026-09-24 (2e passe) — noms en ``[\w.-]`` (outils MCP comme
    # ``resolve-library-id``, jamais extraits avec ``\w+``) ; valeurs
    # débarrassées du SEUL saut de ligne qui suit la balise ouvrante et de
    # celui qui précède la fermante (convention du format, cf. analyseur
    # qwen3-coder de llama.cpp) : ``.strip()`` mangeait l'indentation et la
    # fin de ligne d'un ``old_string``/``content`` → édition sans effet.
    func_blocks = re.findall(
        r'<function=([\w.\-]+)>(.*?)(?:</function>|$)', text, re.DOTALL
    )
    for func_name, body in func_blocks:
        params = {}
        param_matches = re.findall(
            r'<parameter=([\w.\-]+)>(.*?)(?:</parameter>|$)', body, re.DOTALL
        )
        for pk, pv in param_matches:
            params[pk] = _strip_param_value(pv)
        # If no <parameter> tags, treat entire body as single arg
        if not params and body.strip():
            params = {"input": body.strip()}
        found_tools.append((func_name, params))

    if found_tools:
        return found_tools

    # ── Strategy 3: Clean JSON parsing (original method) ──────────
    cleaned = _clean_json_text(text)

    def _norm_args(args):
        # Certains dialectes (hors canal natif) émettent ``arguments`` comme
        # une string JSON ("{\"a\": 1}") plutôt qu'un objet. On dé-stringifie
        # comme la Strategy 1, sinon le caller ferait ``.items()`` sur une str
        # → AttributeError. Fallback {"value": args} si ce n'est pas du JSON.
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except (json.JSONDecodeError, ValueError):
                return {"value": args}
        return args if isinstance(args, dict) else {}

    def _process_obj(obj):
        if isinstance(obj, dict):
            if "tool_call" in obj:
                tc = obj["tool_call"]
                if isinstance(tc, dict) and "name" in tc:
                    found_tools.append((tc["name"], _norm_args(tc.get("arguments", {}))))
            elif "name" in obj and "arguments" in obj:
                found_tools.append((obj["name"], _norm_args(obj.get("arguments", {}))))
            elif "name" in obj and "parameters" in obj:
                found_tools.append((obj["name"], _norm_args(obj.get("parameters", {}))))
        elif isinstance(obj, list):
            for item in obj:
                _process_obj(item)

    try:
        obj = json.loads(cleaned)
        _process_obj(obj)
        if found_tools:
            return found_tools
    except json.JSONDecodeError:
        pass

    # ── Strategy 4: Scan for JSON objects in free text ────────────
    decoder = json.JSONDecoder()
    pos = 0
    # AUDIT 2026-06 — compteur des débuts d'objets JSON plausibles ('{'/'[')
    # qui n'ont PAS parsé : un tool-call avec une typo était ignoré en
    # silence (ex. 3 calls émis, 2 exécutés). UN SEUL log récapitulatif par
    # appel (le scan avance caractère par caractère → pas de log par échec).
    _failed_starts = 0
    while pos < len(cleaned):
        while pos < len(cleaned) and cleaned[pos].isspace():
            pos += 1
        if pos >= len(cleaned):
            break
        try:
            obj, end_pos = decoder.raw_decode(cleaned, idx=pos)
            _process_obj(obj)
            pos = end_pos
        except json.JSONDecodeError:
            # Critère resserré : '{' suivi de "name"/"tool_call" à proximité —
            # un '{' de prose ou de snippet de code ne doit pas alerter.
            if cleaned[pos] == "{" and re.match(
                r'\{\s*"(?:name|tool_call)"', cleaned[pos:pos + 40]
            ):
                _failed_starts += 1
            pos += 1

    if _failed_starts and not found_tools:
        logger.warning(
            "[tool_parsing] %d début(s) d'objet JSON non parsable(s) dans le "
            "texte libre, aucun tool-call extrait — tool-call mal formé "
            "probablement perdu (%.120s…)", _failed_starts, cleaned,
        )

    # Une tentative d'appel d'outil plausible (bloc balisé OU objet {"name":…})
    # qui n'a RIEN donné → on arme le diagnostic pour la boucle chat. Pas de
    # diagnostic si un nom d'outil inconnu a quand même parsé (géré ailleurs).
    if not found_tools and (_failed_blocks or _failed_starts):
        LAST_PARSE_DIAGNOSTIC = _PARSE_DIAGNOSTIC_MSG

    return found_tools if found_tools else None
