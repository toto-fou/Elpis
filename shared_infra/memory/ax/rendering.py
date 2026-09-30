# SPDX-License-Identifier: MIT
"""
Prompt rendering — windowed / full / focused DOM, credential hints, etc.

Auto-extracted from the former monolithic ``backend/ax_memory/_legacy.py``.
Function bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger(__name__)

from shared_infra.memory.ax._connection import _conn
from shared_infra.memory.ax.transitions import (
    _bfs_paths,
    _build_adjacency,
    load_transitions,
)
from shared_infra.memory.ax.tree import load_dom_tree, load_tree
from shared_infra.memory.ax.urls import normalize_url

# ── Display ordering for semantic regions in rendered prompts ───────
# Lower number = rendered first. Regions not listed fall back to 8.
_REGION_ORDER = {
    "header": 0, "banner": 0,
    "nav": 1, "navigation": 1,
    "main": 2,
    "search": 3,
    "form": 4,
    "dialog": 5, "menu": 5, "toolbar": 5,
    "aside": 6, "complementary": 6,
    "footer": 7, "contentinfo": 7,
    "body": 9,
}


def _render_selector(sel: dict) -> str:
    """Formate un selecteur en chaine compacte pour le LLM."""
    strat = sel["strategy"]
    val = sel["value"]
    sc = sel.get("success_count", 0)
    fc = sel.get("failure_count", 0)
    total = sc + fc
    if total >= 2:
        rate = int(100 * sc / max(total, 1))
        tag = f"({sc}/{total}, {rate}%)"
    else:
        tag = ""

    if strat == "role_name":
        role, _, name = val.partition("|")
        base = f"role={role} name=\"{name}\""
    elif strat == "test_id":
        base = f"test_id={val}"
    elif strat == "css":
        base = f"css={val}"
    elif strat == "xpath":
        base = f"xpath={val}"
    elif strat == "text":
        base = f"text=\"{val}\""
    elif strat == "label":
        base = f"label=\"{val}\""
    elif strat == "placeholder":
        base = f"placeholder=\"{val}\""
    else:
        base = f"{strat}={val}"
    return f"{base} {tag}".strip()
def _render_credentials_hint(site: str, owner: str = "") -> Optional[str]:
    """
    Si des credentials sont connus pour ce site (deja normalise) ET pour CE
    proprietaire, retourne une ligne indicative. Ne revele jamais le password.

    AUDIT 2026-08-23 — sans ``owner``, l'indice partait dans le prompt de
    n'importe quel compte avec le ``username`` d'un autre. Proprietaire
    inconnu ⇒ aucun indice (on ne devine pas).
    """
    if not site or not owner:
        return None
    try:
        with _conn() as c:
            row = c.execute("""
                SELECT username, use_count FROM ax_credentials
                 WHERE site = ? AND owner = ?
            """, (site, owner)).fetchone()
        if not row:
            return None
        return (
            f"CREDENTIALS KNOWN: user={row['username']} "
            f"(used {row['use_count']}x, auto-injected by pw_session)"
        )
    except Exception:
        return None
def render_for_prompt(site: str, max_chars: int = 4000,
                      owner: str = "") -> str:
    """
    Produit un arbre ASCII hierarchique du site pour injection dans le prompt.
    """
    tree = load_tree(site, include_stale=False)
    creds_hint = _render_credentials_hint(site, owner)
    if not tree and not creds_hint:
        return ""

    lines: list[str] = []
    lines.append(f"KNOWN UI: {site}")
    if tree:
        total_elements = sum(
            sum(len(nodes) for nodes in regions.values())
            for regions in tree.values()
        )
        lines.append(
            f"({total_elements} verified elements across {len(tree)} paths)"
        )
    if creds_hint:
        lines.append(creds_hint)
    lines.append("")

    if not tree:
        return "\n".join(lines).rstrip()

    paths = sorted(tree.keys(), key=lambda p: (p != "/", p))
    for path in paths:
        regions = tree[path]
        if not regions:
            continue
        lines.append(f"[{path}]")

        sorted_regions = sorted(
            regions.keys(),
            key=lambda r: (_REGION_ORDER.get(r, 8), r)
        )
        for region in sorted_regions:
            nodes = regions[region]
            if not nodes:
                continue
            lines.append(f"  {region}")

            n = len(nodes)
            for i, node in enumerate(nodes):
                is_last = (i == n - 1)
                branch = "`-" if is_last else "|-"
                lines.append(
                    f"    {branch} {node['role']} \"{node['name']}\""
                )
                sel_prefix = "       " if is_last else "    |  "
                for sel in node["selectors"]:
                    lines.append(f"{sel_prefix}- {_render_selector(sel)}")
        lines.append("")

    out = "\n".join(lines).rstrip()
    if len(out) > max_chars:
        out = out[:max_chars] + "\n... (truncated)"
    return out


# ---------------------------------------------------------------------------
# Graphe de navigation : BFS bi-directionnel autour d'un path courant
# ---------------------------------------------------------------------------
def render_windowed_for_prompt(
    site: str,
    current_path: str,
    ancestors_depth: int = 2,
    descendants_depth: int = 2,
    max_chars: int = 4000,
    owner: str = "",
) -> str:
    """
    Rendu fenetre centre sur current_path :
      - liste les ancetres jusqu'a N niveaux en amont (via BFS arriere)
      - liste les descendants jusqu'a N niveaux en aval (via BFS avant)
      - injecte les details d'elements UNIQUEMENT pour la page courante
      - pour les autres pages : juste le resume (nb d'elements) + les
        transitions sortantes

    Format :

        KNOWN UI: saucedemo.com
        (12 elements, 8 transitions, focused on /cart.html)

        NAVIGATION GRAPH (2 hops each direction):
          [/]                              <-- 2 hops back
            -- button "Login" --> /inventory.html  (5x)
          [/inventory.html]                <-- 1 hop back
            -- link "Cart" --> /cart.html  (5x)
          [/cart.html]  *** CURRENT ***
            -- button "Checkout" --> /checkout-step-one.html  (3x)
            -- button "Continue Shopping" --> /inventory.html (1x)
          [/checkout-step-one.html]        --> 1 hop forward
            -- button "Continue" --> /checkout-step-two.html  (2x)
          [/checkout-step-two.html]        --> 2 hops forward
            -- button "Finish" --> /checkout-complete.html    (2x)

        CURRENT PAGE DETAILS: [/cart.html]
          header
            `- link "Cart"
               - test_id=shopping-cart-link (5/5, 100%)
          main
            |- button "Continue Shopping"
            |  - test_id=continue-shopping
            `- button "Checkout"
               - test_id=checkout (3/3, 100%)
    """
    if not site:
        return ""

    # Charger transitions + arbre complet
    transitions = load_transitions(site)
    tree = load_tree(site, include_stale=False)
    if not transitions and not tree:
        return ""

    # Normaliser current_path
    _, current_path = normalize_url(
        "http://dummy" + (current_path if current_path.startswith("/")
                          else "/" + current_path)
    )

    # Si on n'a pas de transitions OU si current_path n'est pas dans le graphe,
    # on fallback sur le rendu complet (comportement v2).
    fwd, bwd = _build_adjacency(transitions)
    has_current_in_graph = (
        current_path in fwd or current_path in bwd or current_path in tree
    )
    if not has_current_in_graph:
        return render_for_prompt(site, max_chars=max_chars)

    # BFS avant/arriere
    ancestors = _bfs_paths(current_path, bwd, ancestors_depth)
    descendants = _bfs_paths(current_path, fwd, descendants_depth)
    # Union : tous les paths visibles dans la fenetre
    window_paths: dict[str, tuple[str, int]] = {}  # path -> (direction, depth)
    for p, d in ancestors.items():
        if p == current_path:
            continue
        window_paths[p] = ("back", d)
    for p, d in descendants.items():
        if p == current_path:
            continue
        if p not in window_paths:
            window_paths[p] = ("fwd", d)
    # current path toujours present
    window_paths[current_path] = ("current", 0)

    # ── Rendu ──
    lines: list[str] = []
    lines.append(f"KNOWN UI: {site}")
    total_elements = sum(
        sum(len(nodes) for nodes in regions.values())
        for regions in tree.values()
    )
    lines.append(
        f"({total_elements} elements, {len(transitions)} transitions, "
        f"focused on {current_path})"
    )
    _creds_hint = _render_credentials_hint(site, owner)
    if _creds_hint:
        lines.append(_creds_hint)
    lines.append("")
    lines.append(
        f"NAVIGATION GRAPH "
        f"({ancestors_depth} hops back, {descendants_depth} forward):"
    )

    # Tri : ancetres (depth decroissant) -> current -> descendants (depth croissant)
    def _order_key(item):
        path, (direction, depth) = item
        if direction == "back":
            return (-depth, 0, path)  # depth 2 avant depth 1
        if direction == "current":
            return (0, 1, path)
        return (depth, 2, path)

    ordered = sorted(window_paths.items(), key=_order_key)

    for path, (direction, depth) in ordered:
        marker = ""
        if direction == "back" and depth > 0:
            marker = f"  <-- {depth} hop(s) back"
        elif direction == "fwd" and depth > 0:
            marker = f"  --> {depth} hop(s) forward"
        elif direction == "current":
            marker = "  *** CURRENT ***"
        lines.append(f"  [{path}]{marker}")
        # Transitions sortantes de cette page (limite a celles dont la
        # destination est dans la fenetre ou le path courant)
        for edge in sorted(fwd.get(path, []), key=lambda e: -e[3]):
            to_p, role, name, vc = edge
            # On affiche toute transition sortante, meme vers une page hors
            # fenetre : c'est une indication utile pour le LLM
            lines.append(
                f'    -- {role} "{name}" --> {to_p}  ({vc}x)'
            )
    lines.append("")

    # Details de la page courante
    current_regions = tree.get(current_path, {})
    if current_regions:
        lines.append(f"CURRENT PAGE DETAILS: [{current_path}]")
        sorted_regions = sorted(
            current_regions.keys(),
            key=lambda r: (_REGION_ORDER.get(r, 8), r)
        )
        for region in sorted_regions:
            nodes = current_regions[region]
            if not nodes:
                continue
            lines.append(f"  {region}")
            n = len(nodes)
            for i, node in enumerate(nodes):
                is_last = (i == n - 1)
                branch = "`-" if is_last else "|-"
                lines.append(
                    f"    {branch} {node['role']} \"{node['name']}\""
                )
                sel_prefix = "       " if is_last else "    |  "
                for sel in node["selectors"]:
                    lines.append(f"{sel_prefix}- {_render_selector(sel)}")
    else:
        lines.append(
            f"CURRENT PAGE [{current_path}]: no elements recorded yet. "
            "Use pw_page(op='inspect') to discover."
        )

    out = "\n".join(lines).rstrip()
    if len(out) > max_chars:
        out = out[:max_chars] + "\n... (truncated)"
    return out


# ---------------------------------------------------------------------------
# Credentials (pour pw_session auth HTTP Basic)
# ---------------------------------------------------------------------------
def _render_dom_subtree(
    node: dict,
    lines: list,
    indent: int = 0,
    include_selectors: bool = True,
    is_last: bool = True,
    prefix_stack: Optional[list] = None,
) -> None:
    """
    Rendu ASCII recursif d'un noeud et de ses enfants.
    Utilise des box-drawing chars simples: `|-` / `` `- `` / `|  ` / `   `
    """
    if prefix_stack is None:
        prefix_stack = []

    # Construit le prefix (chaine de barres verticales pour les parents)
    indent_str = "".join(prefix_stack)
    branch = "`- " if is_last else "|- "

    role = node["role"]
    name = node["name"]
    ntype = node["node_type"]
    vc = node.get("verified_count") or 0
    usage_tag = f" [used {vc}x]" if vc > 1 else ""

    if ntype == "region":
        # Les regions apparaissent en header de leur sous-arbre, sans
        # selectors (elles ne sont pas cliquees directement).
        if name:
            label = f"{role} \"{name}\""
        else:
            label = f"{role}"
        lines.append(f"{indent_str}{branch}{label}{usage_tag}")
    else:
        # Element feuille avec selectors
        lines.append(f"{indent_str}{branch}{role} \"{name}\"{usage_tag}")
        if include_selectors and node.get("selectors"):
            sel_prefix = indent_str + ("   " if is_last else "|  ")
            for sel in node["selectors"]:
                lines.append(f"{sel_prefix}- {_render_selector(sel)}")

    # Recursion sur les enfants
    children = node.get("children") or []
    n_children = len(children)
    next_prefix = prefix_stack + ["   " if is_last else "|  "]
    for i, child in enumerate(children):
        _render_dom_subtree(
            child, lines,
            indent=indent + 1,
            include_selectors=include_selectors,
            is_last=(i == n_children - 1),
            prefix_stack=next_prefix,
        )
def render_full_dom_for_prompt(site: str, max_chars: int = 6000,
                               owner: str = "") -> str:
    """
    Rendu COMPLET de l'arbre DOM profond pour toutes les pages connues.
    Mode "initial" : injecte au premier tour du tool loop pour donner au
    LLM une cartographie complete de l'application.

    Exemple de sortie :

        KNOWN UI: :1010
        (14 elements across 3 paths, full DOM hierarchy)

        [/]
          `- banner "Jira header"
             |- navigation "Main nav"
             |  |- link "Dashboards"
             |  |    - test_id=nav-dashboards (4/4)
             |  `- menu "Admin"
             |     |- link "Users"
             |     |    - test_id=admin-users (2/2)
             |     `- link "Permissions"
             |          - test_id=admin-perms (1/1)
             `- button "User menu"
                  - test_id=user-avatar (8/8)

        [/browse/*]
          `- main
             `- form "Issue edit"
                |- textbox "Title"
                |    - test_id=issue-title (3/3)
                `- button "Save"
                     - test_id=issue-save (3/3)
    """
    if not site:
        return ""
    dom = load_dom_tree(site)
    if not dom:
        return ""

    lines: list[str] = []
    total_elements = 0
    for p_data in dom.values():
        for node in p_data["by_id"].values():
            if node["node_type"] == "element":
                total_elements += 1

    lines.append(f"KNOWN UI: {site}")
    lines.append(
        f"({total_elements} elements across {len(dom)} paths, "
        f"full DOM hierarchy)"
    )
    _creds_hint = _render_credentials_hint(site, owner)
    if _creds_hint:
        lines.append(_creds_hint)
    lines.append("")

    paths = sorted(dom.keys(), key=lambda p: (p != "/", p))
    for path in paths:
        roots = dom[path]["roots"]
        if not roots:
            continue
        lines.append(f"[{path}]")
        n_roots = len(roots)
        for i, root in enumerate(roots):
            _render_dom_subtree(
                root, lines,
                is_last=(i == n_roots - 1),
                prefix_stack=["  "],  # indentation initiale sous [path]
            )
        lines.append("")

    out = "\n".join(lines).rstrip()
    if len(out) > max_chars:
        out = out[:max_chars] + "\n... (truncated)"
    return out
def _find_node_by_path_and_context(
    dom_path: dict,
    current_path: str,
) -> Optional[dict]:
    """
    Pour le mode 'focused' : determine le noeud courant dans le DOM.
    Heuristique : le noeud le plus recemment utilise (last_ok max) sur
    cette page est considere comme la 'position courante' du LLM.
    """
    by_id = dom_path.get("by_id") or {}
    if not by_id:
        return None
    # On cherche parmi les elements (pas les regions)
    candidates = [n for n in by_id.values() if n["node_type"] == "element"]
    if not candidates:
        return None
    # Le plus recent
    candidates.sort(key=lambda n: (n.get("last_ok") or 0), reverse=True)
    return candidates[0]
def _collect_ancestors(dom_by_id: dict, node: dict,
                      max_up: int = 2) -> list[dict]:
    """Remonte max_up parents d'un noeud. Retourne du plus proche au plus
    eloigne."""
    out = []
    cur = node
    for _ in range(max_up):
        pid = cur.get("parent_id")
        if pid is None or pid not in dom_by_id:
            break
        parent = dom_by_id[pid]
        out.append(parent)
        cur = parent
    return out
def _collect_descendants(node: dict, max_depth: int = 2,
                        _depth: int = 0) -> list[dict]:
    """Collecte tous les descendants jusqu'a max_depth. Retourne une liste
    plate, chaque item augmente d'un champ '_depth'."""
    out = []
    if _depth >= max_depth:
        return out
    for child in node.get("children") or []:
        c_copy = dict(child)
        c_copy["_depth"] = _depth + 1
        out.append(c_copy)
        out.extend(_collect_descendants(child, max_depth, _depth + 1))
    return out
def render_focused_dom_for_prompt(
    site: str,
    current_path: str,
    current_node_id: Optional[int] = None,
    max_chars: int = 3000,
    owner: str = "",
) -> str:
    """
    Rendu FOCUSED : juste autour de la position courante du LLM.
    Mode "suivant" (iterations 2+ du tool loop) : on limite le volume pour
    eviter de re-envoyer toute la cartographie a chaque tour.

    - Ancetres n-1 et n-2 (remontee vers le parent)
    - Siblings du noeud courant
    - Descendants n+1 et n+2 (si le noeud courant a des enfants)

    Si current_node_id n'est pas fourni, utilise le noeud le plus
    recemment utilise sur current_path comme position.

    Exemple de sortie :

        KNOWN UI: :1010
        FOCUSED ON: [/admin/users] menu "Admin"

        Path to here:
          banner "Jira header"
            |- navigation "Main nav"
               `- menu "Admin"  *** YOU ARE HERE ***

        Siblings:
          - link "Dashboards"  [test_id=nav-dashboards]
          - link "Projects"    [test_id=nav-projects]

        Below (1-2 hops):
          - link "Users"
               - test_id=admin-users (2/2)
          - link "Permissions"
               - test_id=admin-perms (1/1)
    """
    if not site or not current_path:
        return ""

    dom = load_dom_tree(site, path=current_path)
    page_data = dom.get(current_path)
    if not page_data or not page_data["by_id"]:
        # Pas de DOM connu pour cette page : fallback leger
        return (
            f"KNOWN UI: {site}\n"
            f"FOCUSED ON: [{current_path}] (no DOM recorded yet, "
            f"use pw_page(op='inspect') to discover)"
        )

    by_id = page_data["by_id"]
    current = None
    if current_node_id and current_node_id in by_id:
        current = by_id[current_node_id]
    else:
        current = _find_node_by_path_and_context(page_data, current_path)
    if not current:
        # Rien a focus : retombe sur le rendu complet de cette page
        return render_full_dom_for_prompt(site, max_chars=max_chars)

    lines: list[str] = []
    lines.append(f"KNOWN UI: {site}")
    lines.append(
        f"FOCUSED ON: [{current_path}] "
        f"{current['role']} \"{current['name']}\""
    )
    _creds_hint = _render_credentials_hint(site, owner)
    if _creds_hint:
        lines.append(_creds_hint)
    lines.append("")

    # Ancetres (n-1, n-2)
    ancestors = _collect_ancestors(by_id, current, max_up=2)
    if ancestors:
        lines.append("Path to here (ancestors):")
        # On rend du plus eloigne au plus proche (racine -> ... -> current)
        chain = list(reversed(ancestors)) + [current]
        for i, node in enumerate(chain):
            indent = "  " * (i + 1)
            marker = "  *** YOU ARE HERE ***" if node is current else ""
            label = f"{node['role']}"
            if node['name']:
                label += f" \"{node['name']}\""
            lines.append(f"{indent}`- {label}{marker}")
        lines.append("")

    # Siblings (memes parents, frere du current)
    parent_id = current.get("parent_id")
    if parent_id and parent_id in by_id:
        parent = by_id[parent_id]
        siblings = [c for c in (parent.get("children") or [])
                    if c["id"] != current["id"]]
        if siblings:
            lines.append("Siblings (same parent):")
            for s in siblings:
                top_sel = (s.get("selectors") or [None])[0]
                sel_str = (f"  [{_render_selector(top_sel)}]"
                           if top_sel else "")
                lines.append(
                    f"  - {s['role']} \"{s['name']}\"{sel_str}"
                )
            lines.append("")

    # Descendants (n+1, n+2)
    descendants = _collect_descendants(current, max_depth=2)
    if descendants:
        lines.append("Below (1-2 hops):")
        for d in descendants:
            depth_prefix = "  " * d["_depth"]
            top_sel = (d.get("selectors") or [None])[0]
            lines.append(
                f"{depth_prefix}- {d['role']} \"{d['name']}\""
            )
            if top_sel:
                lines.append(
                    f"{depth_prefix}     {_render_selector(top_sel)}"
                )
        lines.append("")

    out = "\n".join(lines).rstrip()
    if len(out) > max_chars:
        out = out[:max_chars] + "\n... (truncated)"
    return out
# Signal minimal avant INJECTION d'un site en prompt (audit 2026-07-26) :
# l'auto-curation enregistre aussi les explorations de l'agent lui-même — un
# site visité une fois « pour voir » (ex. www.iana.org cliqué pendant un test)
# se retrouvait injecté au tour suivant comme s'il s'agissait d'un savoir
# établi. On exige un cumul de vérifications (somme des verified_count des
# transitions + nb d'éléments non-stale) avant de considérer la mémoire d'un
# site assez mûre pour être poussée dans le contexte. Le site reste stocké et
# continue de mûrir — il n'est simplement pas ENCORE injecté.
import os as _os

AX_INJECT_MIN_SIGNAL = int(_os.environ.get("AX_INJECT_MIN_SIGNAL", "3") or 3)


def _site_signal(site: str) -> int:
    """Cumul de signal d'un site : verifs de transitions + éléments non-stale."""
    try:
        with _conn() as c:
            t = c.execute(
                "SELECT COALESCE(SUM(verified_count), 0) AS v"
                "  FROM ax_transitions WHERE site = ?", (site,)).fetchone()
            n = c.execute(
                "SELECT COUNT(*) AS n FROM ax_nodes"
                " WHERE site = ? AND node_type = 'element' AND stale = 0",
                (site,)).fetchone()
        return int(t["v"] or 0) + int(n["n"] or 0)
    except Exception:
        # Fail-open : ne jamais priver l'agent d'une mémoire à cause d'une
        # erreur de stats — le gate est une optimisation, pas une barrière.
        return AX_INJECT_MIN_SIGNAL


def render_site_contextual(
    site: str,
    current_path: Optional[str] = None,
    max_chars: int = 4000,
    iteration: int = 0,
    owner: str = "",
) -> str:
    """
    Point d'entree de haut niveau pour services.py.

    Strategie selon l'iteration du tool loop :
      iteration == 0  (premier appel LLM du chat) :
         -> rendu DOM COMPLET de l'app (cartographie complete, mode 'initial')
         -> Sert a donner au LLM une vue d'ensemble pour planifier
      iteration >= 1  (tours suivants du tool loop) :
         -> rendu FOCUSED (position courante + ancetres n-1/n-2 + siblings +
            descendants n+1/n+2)
         -> Economise le contexte en ne renvoyant que ce qui est pertinent
         -> Si current_path est disponible, on centre sur cette page
         -> Sinon fallback sur rendu complet (leger)

    Fallback si aucune donnee : retourne chaine vide.
    Gate anti-pollution : un site au signal insuffisant (< AX_INJECT_MIN_SIGNAL)
    n'est pas injecté (cf. _site_signal — l'agent qui a cliqué une fois sur un
    site pendant un test n'en fait pas un savoir établi).
    """
    if not site:
        return ""
    if AX_INJECT_MIN_SIGNAL > 0 and _site_signal(site) < AX_INJECT_MIN_SIGNAL:
        return ""
    if iteration == 0:
        return render_full_dom_for_prompt(site, max_chars=max_chars, owner=owner)
    if current_path:
        return render_focused_dom_for_prompt(
            site, current_path, max_chars=max_chars, owner=owner,
        )
    return render_full_dom_for_prompt(site, max_chars=max_chars, owner=owner)
