# SPDX-License-Identifier: MIT
"""
llm_core._tool_parsing — lecture des appels d'outils écrits en TEXTE par le
modèle, hors du canal ``tool_calls`` natif.

Couvre les dialectes des différentes versions de llama.cpp et des modèles :
  • ``<tool_call>{...}</tool_call>`` (Qwen, JSON) et sa variante GLM-4.5/4.6
    (XML ``arg_key``/``arg_value``) ;
  • ``<function=nom><parameter=clé>…`` (dialecte « GPT-like ») ;
  • blocs ```json …``` et objets JSON nus dans la prose.

Fournit aussi le nettoyage de ce balisage dans le texte montré à l'utilisateur
(``_strip_tool_call_markup``) et la récupération d'un appel piégé dans le canal
de raisonnement (``_recover_tool_calls_from_reasoning``).
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("uvicorn.error")

# Diagnostic d'un appel d'outil détecté (balise <tool_call> ou objet JSON
# {"name":…} plausible) mais illisible. La boucle le lit juste après l'appel et
# renvoie un message correctif au modèle : sans lui, un petit modèle rejoue son
# erreur en boucle. Même principe que ``_detection_client.LAST_ERROR``.
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
                    # KeyboardInterrupt/SystemExit). Illisibles, ils deviennent
                    # ``{}`` : plus sûr que de smuggler ``{"value": <str brute>}``
                    # qui mésformerait l'appel (le caller filtre par nom connu).
                    # Le canal natif, lui, n'exécute pas un appel aux arguments
                    # illisibles (``args_error`` dans ``engine.tool_dispatch``).
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
            # arg_value), le format XML natif de ces modèles « thinking », qui
            # arrive ici en TEXTE quand llama.cpp ne le lit pas.
            glm = _parse_glm_tool_block(block)
            if glm:
                found_tools.append(glm)
                parsed = True
        if not parsed:
            # Un bloc <tool_call> balisé qui ne se lit ni en JSON ni en
            # GLM-XML signale un appel perdu : journalisé (tronqué) et mémorisé
            # pour le diagnostic si aucun autre appel n'est extrait.
            _failed_blocks.append(block)
            logger.warning(
                "[tool_parsing] bloc <tool_call> non parsable (ni JSON ni "
                "GLM-XML) ignoré (%d chars): %.120s…", len(block), block,
            )

    if found_tools:
        return found_tools

    # ── Strategy 2: <function=name> <parameter=key>value (GPT-like) ─
    # Noms en ``[\w.-]`` : les outils MCP comme ``resolve-library-id`` ont des
    # tirets. Valeurs : seuls le saut de ligne qui suit la balise ouvrante et
    # celui qui précède la fermante sont retirés (convention du format, cf.
    # analyseur qwen3-coder de llama.cpp) ; un ``.strip()`` mangerait
    # l'indentation et la fin de ligne d'un ``old_string``/``content`` et
    # rendrait l'édition sans effet.
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
    # Compteur des débuts d'objets JSON plausibles ('{'/'[') qui ne se lisent
    # pas : un appel avec une faute de frappe serait sinon ignoré en silence.
    # Un seul journal récapitulatif par appel (le scan avance caractère par
    # caractère : pas de journal par échec).
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


# ── Balisage d'appel d'outil dans le texte visible ───────────────────────────
def _clean_json_text(text: str) -> str:
    """Prépare un texte libre à la lecture JSON des stratégies 3 et 4
    d'``extract_tool_calls`` : retire une clôture de bloc de code
    (```` ```json ````) et les balises ``<tool_call>``."""
    s = text.strip()
    s = re.sub(r"^\s*```(?:json)?\s*", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s*```\s*$", "", s)
    # Strip <tool_call> XML tags (Qwen format)
    s = re.sub(r"</?tool_call>", "", s)
    return s.strip("` \n\r\t")


def _strip_tool_call_markup(text: str) -> str:
    """Retire d'un texte TOUS les blocs d'appel d'outil pour ne garder que la
    prose destinée à l'utilisateur.

    Utilisé sur le chemin de secours « texte libre » : quand llama.cpp ne
    sait pas parser nativement les tool_calls d'un modèle, on récupère les
    appels via ``extract_tool_calls()`` PUIS on nettoie le contenu visible.

    Retire les deux dialectes : ``<tool_call>...</tool_call>`` (format Qwen)
    et ``<function=name>...</function>`` (Llama/GPT-like — extract_tool_calls
    strategy 2), y compris un bloc resté ouvert en fin de flux ; sinon ils
    resteraient affichés bruts dans la bulle assistant.
    """
    if not text:
        return text
    s = text
    # 1. Blocs FERMÉS (cas nominal).
    s = re.sub(r"<tool_call>.*?</tool_call>", "", s, flags=re.DOTALL | re.IGNORECASE)
    s = re.sub(r"<function=[^>]*>.*?</function>", "", s, flags=re.DOTALL | re.IGNORECASE)
    # 2. Bloc NON FERMÉ en fin de flux : un appel a commencé mais le modèle
    #    a été coupé avant la balise de fermeture → tout depuis la balise
    #    ouvrante jusqu'à EOF est du markup, pas de la prose (sinon un
    #    <tool_call> orphelin resterait visible).
    s = re.sub(r"<tool_call>.*$", "", s, flags=re.DOTALL | re.IGNORECASE)
    s = re.sub(r"<function=[^>]*>.*$", "", s, flags=re.DOTALL | re.IGNORECASE)
    # 3. Balises ORPHELINES résiduelles (émission hybride Qwen+Llama : une
    #    balise ouvrante <tool_call> dont le corps a déjà été retiré, ou des
    #    <parameter=>/</function> isolés).
    s = re.sub(r"</?tool_call>", "", s, flags=re.IGNORECASE)
    s = re.sub(r"</?function(?:=[^>]*)?>", "", s, flags=re.IGNORECASE)
    s = re.sub(r"</?parameter(?:=[^>]*)?>", "", s, flags=re.IGNORECASE)
    # GLM-4.5/4.6 : balises d'arguments XML (orphelines après retrait du bloc).
    s = re.sub(r"</?arg_key>", "", s, flags=re.IGNORECASE)
    s = re.sub(r"</?arg_value>", "", s, flags=re.IGNORECASE)
    return s.strip()


# Traces de markup d'appel d'outil (ouvrantes OU fermantes). Les fermantes
# comptent SEULES : quand le modèle émet le dialecte XML (<tool_call>
# <function=…><parameter=…>) HORS canal natif, le parseur du serveur consomme
# les balises ouvrantes en tentant un parse natif, échoue (ce n'est pas le JSON
# attendu), et seules les fermantes atteignent le client — souvent dans le
# canal reasoning. Symptôme : tour mort à quelques dizaines de tokens, réponse
# « Je vais créer… </parameter></function></tool_call> », aucun outil exécuté.
_TOOL_MARKUP_TRACE_RE = re.compile(
    r"</?tool_call>|</?function(?:=[^>]*)?>|</parameter>", re.IGNORECASE)


def _looks_like_pure_tool_call_text(raw_text: str) -> bool:
    """
    Détecte un texte qui est *intégralement* une tentative d'appel d'outil
    (XML <tool_call>, <function=...>, ou JSON pur) — par opposition à de la
    prose normale qui contiendrait un exemple JSON à des fins pédagogiques.

    Utilisé pour supprimer du flux utilisateur les appels d'outils dont le
    nom ne correspond à aucun outil enregistré (hallucination du modèle),
    sans pour autant masquer les réponses légitimes qui mentionnent du JSON.
    """
    if not raw_text:
        return False
    s = raw_text.strip()
    if not s:
        return False
    # Tout le texte = un bloc <tool_call>...</tool_call> (format Qwen)
    if re.fullmatch(r"\s*<tool_call>.*?</tool_call>\s*", s, re.DOTALL | re.IGNORECASE):
        return True
    # Tout le texte = un bloc <function=nom>...</function> (format Llama)
    if re.fullmatch(r"\s*<function=[^>]+>.*?</function>\s*", s, re.DOTALL | re.IGNORECASE):
        return True
    # Tout le texte = du JSON pur (éventuellement dans ```json ... ```)
    try:
        json.loads(_clean_json_text(s))
        return True
    except (json.JSONDecodeError, TypeError, ValueError):
        return False


def _recover_tool_calls_from_reasoning(
    reasoning_text: str, known_names: Optional[set] = None,
) -> List[Dict[str, Any]]:
    """Récupère un appel d'outil PIÉGÉ dans le canal *reasoning*.

    Échec connu des modèles « thinking » (Qwen3, GLM-4.5/4.6) : l'appel part
    dans ``reasoning_content`` / ``<think>`` au lieu du canal ``tool_calls``
    natif → ni exécuté, ni affiché comme réponse (juste visible, brut, dans le
    panneau réflexion). On ne tente la récupération QUE si le reasoning porte un
    markup d'appel EXPLICITE (``<tool_call>`` / ``<function=``) — garde-fou
    contre un modèle qui *raisonnerait* sur un appel sans l'émettre. Si
    ``known_names`` est fourni, on ne promeut QUE les appels dont le nom est un
    outil réellement enregistré (sinon un exemple/hallucination émis dans la
    réflexion serait exécuté). Renvoie une liste de tool_calls au format OpenAI
    (``[]`` si rien d'exploitable)."""
    if not reasoning_text or not re.search(r"<tool_call>|<function=", reasoning_text, re.IGNORECASE):
        return []
    try:
        rec = extract_tool_calls(reasoning_text)
    except Exception:  # noqa: BLE001 — récupération facultative : rien à promouvoir
        return []
    if not rec:
        return []
    if known_names is not None:
        rec = [(n, a) for (n, a) in rec if n in known_names]
        if not rec:
            return []
    return [{
        "id": f"call_{i}",
        "type": "function",
        "function": {"name": n, "arguments": json.dumps(a, ensure_ascii=False)},
    } for i, (n, a) in enumerate(rec)]
