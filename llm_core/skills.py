# SPDX-License-Identifier: MIT
"""
llm_core/skills.py — Loader de mémoire procédurale ("skills").

Un skill = un fichier markdown décrivant *comment* réaliser une action concrète
(déployer via Jenkins, réinitialiser Qdrant, builder le serveur MCP, …), avec un
frontmatter ``name`` / ``description`` / ``tags``. Pattern Claude Code, appliqué
aux *procédures*.

Trois sources, fusionnées par ``discover_skills`` (priorité décroissante, le plus
spécifique gagne en cas de collision de ``name``) :

    user    ← ``<sandbox_user>/skills/``   (perso ; écrit par l'agent via
                                            ``skill_save`` — visible de ce SEUL
                                            user, jamais injecté chez autrui)
    learned ← ``<skills>/learned/``        (SAS de curation ADMIN : brouillons en
                                            attente de promotion ; PAS injecté
                                            dans le prompt avant promotion)
    global  ← ``<skills>/``                (curé, versionné en repo)

Chargement = injection déterministe (cf. ``llm_core/_system_prompts.py``) : le
backend matche la requête utilisateur contre les ``description`` via
``match_skills`` et injecte le corps des top-N skills dans le system prompt
(``discover_skills(..., include_learned=False)`` — learned exclu). Le modèle ne
décide rien — mais un index léger de TOUS les skills (user+global) est aussi
injecté (garde-fou : un mauvais matching ne crée pas d'angle mort) ; le modèle
peut charger un corps non détaillé à la demande via l'outil ``skill_get``.

Conception :
  - pas de dépendance YAML (parser partagé ``llm_core/_frontmatter.py``) ;
  - pas de cache long (relecture disque à chaque appel → hot-reload, coût négligeable) ;
  - fail-soft (un skill corrompu n'empêche pas les autres de charger).

Le module reste volontairement SANS dépendance à ``shared_infra`` (testable seul). Le
chemin de la sandbox perso est résolu par l'appelant et passé via ``user_skills_dir``.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import fcntl  # verrous advisory POSIX (cross-worker). Absent → fail-open.
except ImportError:  # pragma: no cover (non-POSIX)
    fcntl = None  # type: ignore

from llm_core._frontmatter import split_frontmatter

logger = logging.getLogger("uvicorn.error")


# ──────────────────────────────────────────────────────────────────────────
# Verrou des mutations de skills — RÉENTRANT et robuste en MULTI-WORKER.
# ──────────────────────────────────────────────────────────────────────────
# MAJ-17 — sérialise les mutations de skills. Le serveur MCP exécute les tools
# de façon concurrente (threads FastMCP) et, en prod, gunicorn lance PLUSIEURS
# workers : sans verrou, deux ``skill_save`` (ou un save concurrent à un promote),
# qu'ils soient dans le même process ou dans deux workers, pouvaient passer le
# même check de collision puis s'écraser mutuellement.
#
# E2 (fragilité d'archi) — un ``threading.RLock`` ne synchronise QUE le process
# courant : en multi-worker il ne protège rien entre workers. On compose donc
# deux niveaux :
#   • ``threading.RLock`` — réentrance + exclusion entre threads du MÊME worker
#     (la route HTTP tient le verrou autour de « check d'existence + write » pour
#     le rendre atomique, et les ``save_*()`` le ré-acquièrent en interne ; un
#     Lock simple provoquerait un deadlock sur cette ré-acquisition).
#   • ``fcntl.flock`` advisory sur un lockfile partagé — étend l'exclusion à TOUS
#     les workers de la machine.
#
# Le flock n'est pris qu'à la profondeur d'imbrication 0 (compteur protégé par le
# RLock → un seul thread du process le manipule) et relâché au retour à 0.
#
# Garde-fous (le verrou ne doit JAMAIS casser une écriture légitime) :
#   • FAIL-OPEN : flock indisponible (pas de ``fcntl``, FS sans verrou, perms) ou
#     contention prolongée au-delà de ``_FLOCK_TIMEOUT_S`` → on retombe sur le
#     RLock seul + écritures atomiques (tmp+rename). Pas de blocage indéfini.
#   • Acquire BORNÉ et non-bloquant (spin LOCK_NB) : le cas normal (pas de
#     contention) acquiert instantanément ; sous contention l'attente est plafonnée
#     (les routes sont ``async`` → pas de stall illimité de l'event loop).
#   • Lockfile jamais unlink (inode stable, cf. ``cron_lock``) ; le kernel libère
#     le flock à la mort du process.
#   • Désactivable via ``SKILLS_FILELOCK=0`` (RLock seul).
_FLOCK_TIMEOUT_S = 5.0    # plafond d'attente sous contention avant fail-open
_FLOCK_POLL_S    = 0.02   # granularité du spin LOCK_NB


def _filelock_enabled() -> bool:
    if fcntl is None:
        return False
    return os.environ.get("SKILLS_FILELOCK", "1").strip().lower() not in ("0", "false", "no", "")


class _SkillsWriteLock:
    """Verrou réentrant à deux niveaux (RLock intra-process + flock cross-worker).

    Expose l'interface d'un context manager (``with _write_lock:``) et les
    méthodes ``acquire``/``release`` — drop-in pour l'ancien ``threading.RLock``.
    """

    def __init__(self) -> None:
        self._rlock = threading.RLock()
        self._depth = 0
        self._fd: Optional[int] = None

    def _flock_path(self) -> Path:
        override = os.environ.get("SKILLS_LOCK_PATH", "").strip()
        if override:
            return Path(override)
        # Co-localisé avec la bibliothèque globale → tous les workers de la
        # machine résolvent le MÊME chemin (même env/dépôt).
        return _global_skills_root() / ".skills_write.lock"

    def acquire(self) -> None:
        self._rlock.acquire()                 # réentrant + exclusion intra-process
        try:
            if self._depth == 0:
                self._flock_acquire()
            self._depth += 1
        except Exception:
            # Ne jamais laisser le RLock pris si l'init du flock explose.
            self._rlock.release()
            raise

    def release(self) -> None:
        try:
            self._depth -= 1
            if self._depth <= 0:
                self._depth = 0
                self._flock_release()
        finally:
            self._rlock.release()

    def _flock_acquire(self) -> None:
        if not _filelock_enabled():
            return
        fd = None
        try:
            path = self._flock_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
            deadline = time.monotonic() + _FLOCK_TIMEOUT_S
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self._fd = fd
                    return
                except (BlockingIOError, OSError):
                    if time.monotonic() >= deadline:
                        # Contention prolongée (worker bloqué ?) → fail-open : le
                        # RLock + les écritures atomiques restent la protection.
                        logger.warning("[skills] flock contention > %.0fs — fail-open (RLock seul)",
                                       _FLOCK_TIMEOUT_S)
                        try:
                            os.close(fd)
                        except OSError:
                            pass
                        self._fd = None
                        return
                    time.sleep(_FLOCK_POLL_S)
        except Exception:
            # FAIL-OPEN : flock indisponible → RLock + écritures atomiques suffisent.
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            self._fd = None
            logger.debug("[skills] flock indisponible (fail-open, RLock seul)", exc_info=True)

    def _flock_release(self) -> None:
        if self._fd is None:
            return
        try:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(self._fd)
        except OSError:
            pass
        self._fd = None

    def __enter__(self) -> "_SkillsWriteLock":
        self.acquire()
        return self

    def __exit__(self, *exc) -> bool:
        self.release()
        return False


_write_lock = _SkillsWriteLock()


# ──────────────────────────────────────────────────────────────────────────
# Data class
# ──────────────────────────────────────────────────────────────────────────

@dataclass
class SkillSpec:
    """Une procédure chargée depuis un fichier markdown.

    ``body`` est le corps markdown (la procédure elle-même). Les autres champs
    viennent du frontmatter. ``source`` indique d'où vient le skill (utile pour
    l'UI de gestion et la promotion learned → global). ``domain`` est l'applicatif
    auquel le skill se rapporte — dérivé du sous-dossier (``skills/<domain>/...``),
    surchargeable par le frontmatter. Sert au regroupement de l'index et au matching.
    """
    name:        str
    description: str = ""
    body:        str = ""
    tags:        List[str] = field(default_factory=list)
    source:      str = "global"          # global | learned | user
    domain:      str = ""                 # ex. "jenkins", "elpis" ; "" = racine
    path:        Optional[str] = None
    # ── Modèle "Agent Skill" (dossier) — None pour un skill legacy mono-fichier ──
    skill_dir:     Optional[str] = None   # dossier du skill (contient SKILL.md + scripts/…)
    files:         List[str] = field(default_factory=list)  # fichiers bundlés (relatifs à skill_dir)
    license:       str = ""
    compatibility: str = ""               # besoins d'env (≤500) — cf. spec
    metadata:      Dict[str, Any] = field(default_factory=dict)
    allowed_tools: str = ""               # expérimental : outils pré-approuvés
    # ── Hiérarchie (sous-skills imbriqués) — assignés par _scan_tree ──
    id:        str = ""                    # chaîne de noms depuis la racine, ex. "pkg/child" (== name au niveau-0)
    parent_id: Optional[str] = None        # id du skill parent (None au niveau-0)
    depth:     int = 0                      # 0 = racine, 1 = sous-skill, 2 = sous-sous-skill

    @property
    def is_folder(self) -> bool:
        return self.skill_dir is not None

    def to_summary_dict(self) -> Dict[str, Any]:
        """Dict léger pour l'API listing — sans le corps complet."""
        return {
            "name":        self.name,
            "description": self.description,
            "tags":        list(self.tags),
            "source":      self.source,
            "domain":      self.domain,
            "path":        self.path,
            "body_preview": self.body[:500],
            "body_length":  len(self.body),
            "is_folder":    self.skill_dir is not None,
            "skill_dir":    self.skill_dir,
            "files":        list(self.files),
            "license":      self.license,
            "compatibility": self.compatibility,
            "metadata":     dict(self.metadata),
            "allowed_tools": self.allowed_tools,
            "id":           self.id or self.name,
            "parent_id":    self.parent_id,
            "depth":        self.depth,
        }


# ──────────────────────────────────────────────────────────────────────────
# Path resolution
# ──────────────────────────────────────────────────────────────────────────

def _global_skills_root() -> Path:
    """Localise le dossier global ``skills/``.

    Priorité :
      1. ``$APP_SKILLS_DIR`` (env, override explicite — aligné avec shared_infra.config).
      2. ``<project_root>/skills/`` (remontée depuis ce fichier).
      3. Fallback : ``./skills`` (cwd).
    """
    override = os.environ.get("APP_SKILLS_DIR", "").strip()
    if override:
        return Path(override)
    here = Path(__file__).resolve().parent.parent          # llm_core/ → project root
    cand = here / "skills"
    if cand.is_dir():
        return cand
    return Path("skills")


def _learned_skills_root() -> Path:
    """Sous-dossier SAS de curation admin (brouillons en attente de promotion,
    non injectés dans le prompt avant promotion)."""
    return _global_skills_root() / "learned"


# ──────────────────────────────────────────────────────────────────────────
# Loading
# ──────────────────────────────────────────────────────────────────────────

def _is_skill_file(p: Path) -> bool:
    """``True`` pour les fichiers de skill à charger (skip README/_TEMPLATE/cachés)."""
    if p.suffix.lower() != ".md":
        return False
    name = p.stem
    if name.lower() in ("readme", "_template"):
        return False
    if name.startswith("_") or name.startswith("."):
        return False
    return True


def _domain_from_path(path: Path, root: Path) -> str:
    """Domaine = premier sous-dossier sous ``root`` (``skills/<domain>/...``).

    Retourne "" pour un skill posé directement à la racine du root.
    """
    try:
        rel = path.relative_to(root)
    except ValueError:
        return ""
    parts = rel.parts
    return parts[0] if len(parts) > 1 else ""


def _load_spec_from_path(path: Path, source: str, domain: str = "") -> Optional[SkillSpec]:
    """Lit un fichier `.md` et construit un ``SkillSpec`` (None si vide/illisible).

    ``domain`` est dérivé du sous-dossier par l'appelant ; le frontmatter
    ``domain:`` le surcharge si présent.
    """
    try:
        content = path.read_text(encoding="utf-8")
    except Exception as e:
        logger.debug("[skills] read échoué pour %s : %s", path, e)
        return None

    fm, body = split_frontmatter(content)
    body = body.strip()
    if not body:
        logger.debug("[skills] corps vide pour %s", path.name)
        return None

    name = str(fm.get("name") or path.stem).strip()
    if not name:
        return None
    description = str(fm.get("description") or "").strip()
    domain = str(fm.get("domain") or domain or "").strip()

    raw_tags = fm.get("tags")
    if isinstance(raw_tags, str):
        tags = [t.strip() for t in raw_tags.split(",") if t.strip()]
    elif isinstance(raw_tags, list):
        tags = [str(t).strip() for t in raw_tags if str(t).strip()]
    else:
        tags = []

    return SkillSpec(
        name=name, description=description, body=body,
        tags=tags, source=source, domain=domain, path=str(path),
    )


def _is_under(path: Path, base: Path) -> bool:
    try:
        path.resolve().relative_to(base.resolve())
        return True
    except (ValueError, OSError):
        return False


def _load_spec_from_dir(skill_dir: Path, source: str, domain: str = "") -> Optional[SkillSpec]:
    """Construit un ``SkillSpec`` à partir d'un dossier-skill ``<dir>/SKILL.md``
    (modèle Agent Skill). ``name`` = nom du dossier (règle du spec). Capture les
    fichiers bundlés (scripts/references/assets/…) en chemins relatifs.
    """
    skillmd = skill_dir / "SKILL.md"
    try:
        content = skillmd.read_text(encoding="utf-8")
    except Exception as e:
        logger.debug("[skills] read échoué pour %s : %s", skillmd, e)
        return None

    fm, body = split_frontmatter(content)
    body = body.strip()
    name = skill_dir.name.strip()
    if not name:
        return None

    description = str(fm.get("description") or "").strip()
    domain = str(fm.get("domain") or domain or "").strip()

    raw_tags = fm.get("tags")
    if isinstance(raw_tags, str):
        tags = [t.strip() for t in raw_tags.split(",") if t.strip()]
    elif isinstance(raw_tags, list):
        tags = [str(t).strip() for t in raw_tags if str(t).strip()]
    else:
        tags = []

    md = fm.get("metadata")
    metadata = dict(md) if isinstance(md, dict) else {}

    # Fichiers bundlés (hors SKILL.md et hors cachés), relatifs au dossier.
    # Capture BORNÉE : on s'arrête à tout sous-dossier qui est lui-même un skill
    # (contient son propre SKILL.md) — ses fichiers appartiennent au skill ENFANT,
    # pas à ce parent. Sans ça, un parent avalerait le bundle de ses sous-skills.
    files: List[str] = []
    try:
        child_skill_dirs = [
            sm.parent for sm in skill_dir.rglob("SKILL.md")
            if sm.parent.resolve() != skill_dir.resolve()
        ]
        for f in sorted(skill_dir.rglob("*")):
            if not f.is_file() or f.name == "SKILL.md":
                continue
            rel = f.relative_to(skill_dir)
            if any(part.startswith(".") for part in rel.parts):
                continue
            if any(_is_under(f, csd) for csd in child_skill_dirs):
                continue
            files.append(str(rel))
    except OSError:
        pass

    # Validation PERMISSIVE en découverte : on ne fait pas disparaître un skill
    # non strictement conforme — on logge. La conformité stricte est imposée aux
    # écritures (skill_save / route / upload).
    try:
        from llm_core._skill_validate import validate_frontmatter
        errs = validate_frontmatter({**fm, "name": name}, dir_name=name)
        if errs:
            logger.warning("[skills] %s non conforme (gardé) : %s", skillmd, "; ".join(errs))
    except Exception:
        pass

    return SkillSpec(
        name=name, description=description, body=body, tags=tags,
        source=source, domain=domain, path=str(skillmd),
        skill_dir=str(skill_dir), files=files,
        license=str(fm.get("license") or "").strip(),
        compatibility=str(fm.get("compatibility") or "").strip(),
        metadata=metadata,
        allowed_tools=str(fm.get("allowed-tools") or fm.get("allowed_tools") or "").strip(),
    )


# AUDIT 2026-08-31 (passe 2) — cache du scan disque. ``discover_skills()``
# tournait à CHAQUE tour de chat, SUR la boucle : deux rglob + re-parse du
# frontmatter de chaque SKILL.md + resolve() croisés (24 ms mesurés sur 13
# skills, linéaire en taille de bibliothèque). Le scan est idempotent tant
# qu'aucun .md n'a bougé : cache par (racine, source, exclusions), TTL court
# + invalidation EXPLICITE par tous les écrivains du module. Le TTL ne couvre
# que les mutations hors-process (autre worker gunicorn, édition disque à la
# main) — d'où sa brièveté.
_SCAN_CACHE: Dict[tuple, tuple] = {}
_SCAN_CACHE_TTL_S = 15.0


def invalidate_skills_scan_cache() -> None:
    """À appeler après TOUTE mutation du store (les écrivains le font)."""
    _SCAN_CACHE.clear()


def _scan_tree(root: Path, source: str, *, exclude_dirs: tuple = ()) -> List[SkillSpec]:
    key = (str(root), source, tuple(exclude_dirs))
    now = time.monotonic()
    hit = _SCAN_CACHE.get(key)
    if hit is not None and (now - hit[0]) < _SCAN_CACHE_TTL_S:
        return list(hit[1])
    specs = _scan_tree_uncached(root, source, exclude_dirs=exclude_dirs)
    # AUDIT 2026-09-01 (passe 5, B16) — éviction des entrées PÉRIMÉES au
    # passage : sans elle, une clé par dossier utilisateur (avec le corps
    # complet de chaque skill dans les SkillSpec) restait retenue à vie —
    # croissance monotone sur un run de plusieurs mois. Le balayage n'a lieu
    # qu'au-delà d'un petit seuil : coût nul en régime nominal.
    if len(_SCAN_CACHE) > 32:
        for _k in [k for k, v in _SCAN_CACHE.items()
                   if (now - v[0]) >= _SCAN_CACHE_TTL_S]:
            _SCAN_CACHE.pop(_k, None)
    _SCAN_CACHE[key] = (now, specs)
    # Copie superficielle : les appelants trient/fusionnent la LISTE ; les
    # SkillSpec eux-mêmes sont traités en lecture seule partout.
    return list(specs)


def _scan_tree_uncached(root: Path, source: str, *, exclude_dirs: tuple = ()) -> List[SkillSpec]:
    """Scanne un arbre de skills RÉCURSIVEMENT. Fail-soft par entrée.

    Deux modèles cohabitent :
      - **dossier** ``<root>/[<domain>/]<name>/SKILL.md`` (Agent Skill — peut
        embarquer scripts/references/assets) ;
      - **legacy** ``<root>/[<domain>/]<name>.md`` (mono-fichier).
    Les ``.md`` situés À L'INTÉRIEUR d'un dossier-skill (references, etc.) ne
    sont JAMAIS chargés comme skills indépendants.

    ``exclude_dirs`` : sous-dossiers de premier niveau ignorés (ex. ``learned``).
    """
    if not root or not root.is_dir():
        return []
    root_r = root.resolve()
    specs: List[SkillSpec] = []
    skill_dirs: List[Path] = []

    # 1) Dossiers-skills (présence d'un SKILL.md).
    for skillmd in sorted(root.rglob("SKILL.md")):
        d = skillmd.parent
        if d.resolve() == root_r:
            continue  # SKILL.md à la racine = dégénéré, ignoré
        rel = d.relative_to(root).parts
        if rel and rel[0] in exclude_dirs:
            continue
        if any(part.startswith(".") or part.startswith("_") for part in rel):
            continue
        try:
            spec = _load_spec_from_dir(d, source, _domain_from_path(d, root))
            if spec is not None:
                specs.append(spec)
                skill_dirs.append(d.resolve())
        except Exception as e:
            logger.warning("[skills] parse error (dir) %s: %s", d, e)

    # 2) Legacy mono-fichier ``.md`` — hors SKILL.md et hors dossiers-skills.
    for entry in sorted(root.rglob("*.md")):
        if entry.name == "SKILL.md":
            continue
        rel_parts = entry.relative_to(root).parts
        if rel_parts and rel_parts[0] in exclude_dirs:
            continue
        if skill_dirs and any(_is_under(entry, sd) for sd in skill_dirs):
            continue
        if not _is_skill_file(entry):
            continue
        try:
            spec = _load_spec_from_path(entry, source, _domain_from_path(entry, root))
            if spec is not None:
                specs.append(spec)
        except Exception as e:
            logger.warning("[skills] parse error %s: %s", entry.name, e)

    # ── Hiérarchie des dossiers-skills (sous-skills imbriqués) ──
    # id = chaîne de noms (== name au niveau-0) ; parent = dossier-skill ancêtre
    # le plus proche. Legacy mono-fichier = toujours niveau-0.
    folder_specs = [s for s in specs if s.skill_dir]
    dir_of = {Path(s.skill_dir).resolve(): s for s in folder_specs}
    _dirs = list(dir_of.keys())

    def _assign(sp: SkillSpec) -> None:
        if sp.id:
            return
        sd = Path(sp.skill_dir).resolve()
        parent_dir = None
        for other in _dirs:
            if other != sd and _is_under(sd, other):
                if parent_dir is None or _is_under(other, parent_dir):
                    parent_dir = other      # ancêtre le plus profond (= le plus proche)
        if parent_dir is not None:
            psp = dir_of[parent_dir]
            _assign(psp)                     # parent calculé d'abord
            sp.parent_id, sp.id, sp.depth = psp.id, f"{psp.id}/{sp.name}", psp.depth + 1
            if sp.depth > 2:
                logger.warning("[skills] sous-skill au-delà de 3 niveaux (depth=%d): %s", sp.depth, sp.id)
        else:
            sp.parent_id, sp.id, sp.depth = None, sp.name, 0

    for sp in folder_specs:
        _assign(sp)
    for sp in specs:
        if not sp.id:                        # legacy mono-fichier → niveau-0
            sp.parent_id, sp.id, sp.depth = None, sp.name, 0
    return specs


def discover_skills(
    user_skills_dir: Optional[Path] = None,
    *,
    include_learned: bool = True,
) -> List[SkillSpec]:
    """Liste tous les skills disponibles, fusionnés par ``name``.

    Scan RÉCURSIF : les skills sont rangés en sous-dossiers par applicatif
    (``skills/jenkins/...``, ``skills/elpis/...``) ; le sous-dossier de premier
    niveau devient le ``domain`` du skill.

    Précédence (le plus spécifique gagne) : ``user`` > ``learned`` > ``global``.
    L'ordre de retour est trié par (``domain``, ``name``) pour un index déterministe
    et regroupé.

    ``user_skills_dir`` : dossier ``skills/`` de la sandbox personnelle de
    l'utilisateur courant (résolu par l'appelant). ``None`` = pas de skills perso.

    ``include_learned`` : ``learned/`` est un SAS de curation admin (brouillons
    en attente de promotion). Le chemin d'INJECTION dans le system prompt passe
    ``False`` pour ne PAS rendre un learned actif dans le prompt de tous AVANT
    promotion ; les listings de gestion gardent ``True``.
    """
    by_id: Dict[str, SkillSpec] = {}
    # Ordre d'application : global d'abord, puis learned, puis user → les
    # derniers écrasent les premiers sur collision d'id. Le global exclut le
    # sous-arbre ``learned/`` (scanné séparément comme source distincte).
    for spec in _scan_tree(_global_skills_root(), "global", exclude_dirs=("learned",)):
        by_id[spec.id] = spec
    if include_learned:
        for spec in _scan_tree(_learned_skills_root(), "learned"):
            by_id[spec.id] = spec
    if user_skills_dir is not None:
        for spec in _scan_tree(Path(user_skills_dir), "user"):
            by_id[spec.id] = spec
    return sorted(by_id.values(), key=lambda s: (s.domain, s.id))


def discover_skills_by_source(
    source: str,
    user_skills_dir: Optional[Path] = None,
) -> List[SkillSpec]:
    """Liste les skills d'UNE seule source, SANS fusion par ``name``.

    Contrairement à :func:`discover_skills` (qui fusionne et applique la
    précédence user>learned>global), ceci renvoie l'inventaire RÉEL d'un scope.
    L'UI de gestion en a besoin : un skill global ``foo`` reste listable sous
    ``scope=global`` même si un skill ``user`` du même nom le masque dans le
    prompt. ``source`` ∈ {global, learned, user}. Trié par (domain, name).
    """
    if source == "global":
        specs = _scan_tree(_global_skills_root(), "global", exclude_dirs=("learned",))
    elif source == "learned":
        specs = _scan_tree(_learned_skills_root(), "learned")
    elif source == "user":
        specs = _scan_tree(Path(user_skills_dir), "user") if user_skills_dir is not None else []
    else:
        raise ValueError(f"source invalide : {source!r}")
    return sorted(specs, key=lambda s: (s.domain, s.name))


# AUDIT 2026-08-23 — six fonctions SUPPRIMÉES : ``_find_global_file``,
# ``_find_learned_file``, ``_remove_slug_copies``, ``find_user_skill``,
# ``save_user_skill_from_md`` et ``build_skill_tree``. Zéro appelant, zéro
# import, zéro test.
#
# Les trois premières étaient les versions HISTORIQUES (recherche par glob
# ``<slug>.md``) des helpers branchés depuis le passage au modèle « Agent
# Skill » (dossier ``<slug>/SKILL.md``) — et elles ne divergeaient pas en
# théorie mais MESURABLEMENT : sur la bibliothèque réelle du dépôt,
# ``_find_global_entry('creer-un-skill')`` trouvait le skill quand
# ``_find_global_file`` répondait None. Avec la signature la plus simple et
# le nom le plus évident du module, elles n'attendaient qu'un contributeur
# pour réintroduire d'un coup le bug « ne voit pas les dossiers-skills ».
# Vivants : ``_find_global_entry`` / ``_find_learned_entry`` /
# ``_purge_slug_entries``, tous bâtis sur ``_scan_tree``.


# ──────────────────────────────────────────────────────────────────────────
# Matching (lexical, déterministe, sans dépendance)
# ──────────────────────────────────────────────────────────────────────────
#
# v1 lexical : recouvrement de tokens entre la requête et le texte cherchable
# du skill (name + tags + description), avec pondération par champ. Suffisant
# pour une bibliothèque de quelques dizaines de skills, instantané, et 100 %
# déterministe (ce que demande l'injection déterministe).
#
# UPGRADE PATH (si le recall lexical devient insuffisant) : remplacer
# ``_score_skill`` par un match vectoriel (embed la requête + chaque description,
# score = cosinus). Garder la même signature ``match_skills`` pour ne rien changer
# côté appelant.

_TOKEN_RE = re.compile(r"[a-z0-9]+")

# Stopwords FR + EN courants — on ne veut pas que "comment", "the", "sur"
# fassent matcher tout. Liste volontairement courte.
_STOPWORDS = frozenset("""
a à au aux avec ce ces dans de des du elle en et eux il je la le les leur lui ma
mais me même mes moi mon ne nos notre nous on ou où par pas pour qu que qui sa se
ses son sur ta te tes toi ton tu un une vos votre vous y comment quel quelle
the a an and or of to in on for with how do does is are be can i you my your it
this that these those use using make get set
""".split())

# Poids par champ : un match dans le name/tags est plus signifiant qu'en
# description ; le domaine (sous-dossier applicatif) ne pèse que faiblement —
# sinon une requête contenant le nom du domaine ("jenkins …") remonte TOUS ses
# skills à égalité et noie le match spécifique.
_W_NAME   = 3.0
_W_TAGS   = 2.0
_W_DOMAIN = 1.5     # > SKILLS_MIN_SCORE par défaut (1.0) → un match domaine-seul
                    # reste injecté ; < _W_TAGS pour ne pas noyer les matchs spécifiques
_W_DESC   = 1.0

# Match "par radical" (préfixe commun) : pallie l'absence de lemmatisation FR —
# « déployer »/« déploie » partagent le préfixe « deplo » avec « déploiement »,
# qu'un set-membership exact ne rapprocherait jamais. Compte pour une FRACTION
# du poids exact (precision-safe) et seulement sur des tokens assez longs pour
# que le préfixe soit discriminant.
_FUZZY_FACTOR = 0.5
_MIN_PREFIX   = 4     # longueur de préfixe commun minimale pour un match fuzzy
_MIN_FUZZY    = 4     # longueur minimale des deux tokens pour tenter le fuzzy


def _strip_accents(text: str) -> str:
    """``déploiement`` → ``deploiement`` : aplatit les accents pour que la
    tokenisation [a-z0-9] ne fragmente pas les mots accentués (français)."""
    nfkd = unicodedata.normalize("NFKD", text)
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def _tokenize(text: str) -> List[str]:
    return [t for t in _TOKEN_RE.findall(_strip_accents(text or "").lower())
            if len(t) >= 2 and t not in _STOPWORDS]


def _common_prefix_len(a: str, b: str) -> int:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


def _field_hit(qt: str, toks: set) -> float:
    """1.0 si ``qt`` matche exactement un token du champ ; ``_FUZZY_FACTOR`` s'il
    partage un radical (préfixe ``>= _MIN_PREFIX``) avec l'un d'eux ; 0 sinon."""
    if qt in toks:
        return 1.0
    if len(qt) >= _MIN_FUZZY:
        for ft in toks:
            if len(ft) >= _MIN_FUZZY and _common_prefix_len(qt, ft) >= _MIN_PREFIX:
                return _FUZZY_FACTOR
    return 0.0


def _score_skill(query_tokens: set, spec: SkillSpec) -> Tuple[float, int]:
    """Score lexical d'un skill + nb de matches "forts" (name/tags) pour le
    tie-break par spécificité. ``(0.0, 0)`` = aucun recouvrement.

    Pour chaque token de requête on retient la MEILLEURE contribution parmi les
    champs (name > tags > domaine/desc), exacte ou par radical.
    """
    if not query_tokens:
        return 0.0, 0
    name_toks   = set(_tokenize(spec.name.replace("-", " ").replace("_", " ")))
    tag_toks    = set(_tokenize(" ".join(spec.tags)))
    domain_toks = set(_tokenize(spec.domain.replace("-", " ")))
    desc_toks   = set(_tokenize(spec.description))
    score = 0.0
    strong = 0
    for qt in query_tokens:
        h_name = _W_NAME   * _field_hit(qt, name_toks)
        h_tags = _W_TAGS   * _field_hit(qt, tag_toks)
        h_dom  = _W_DOMAIN * _field_hit(qt, domain_toks)
        h_desc = _W_DESC   * _field_hit(qt, desc_toks)
        best = max(h_name, h_tags, h_dom, h_desc)
        if best > 0:
            score += best
            # "fort" = matche le name ou les tags (plus spécifique qu'une simple
            # occurrence en description/domaine) → départage les ex-aequo.
            if h_name > 0 or h_tags > 0:
                strong += 1
    return score, strong


def match_skills(
    query: str,
    skills: List[SkillSpec],
    *,
    top_n: int = 3,
    min_score: float = 1.0,
) -> List[SkillSpec]:
    """Retourne les skills les plus pertinents pour ``query`` (score décroissant).

    - Score lexical + radical (voir ``_score_skill``).
    - Filtre ``score >= min_score`` (un skill non pertinent n'est jamais injecté).
    - Tri déterministe : score décroissant, puis spécificité (nb de matches forts
      en name/tags) décroissante, puis ``name`` croissant (tie-break stable).
    - Tronqué à ``top_n``.
    """
    if not skills or top_n <= 0:
        return []
    query_tokens = set(_tokenize(query))
    if not query_tokens:
        return []
    scored: List[Tuple[SkillSpec, float, int]] = []
    for s in skills:
        sc, strong = _score_skill(query_tokens, s)
        if sc >= min_score:
            scored.append((s, sc, strong))
    scored.sort(key=lambda t: (-t[1], -t[2], t[0].name))
    return [s for s, _, _ in scored[:top_n]]


# ──────────────────────────────────────────────────────────────────────────
# Sauvegarde d'un skill appris (écrit par l'agent via l'outil skill_save)
# ──────────────────────────────────────────────────────────────────────────

_NAME_RE = re.compile(r"[^a-z0-9_-]+")


def slugify_name(name: str) -> str:
    """Normalise un ``name``/``domain`` en slug sûr pour un nom de dossier/fichier."""
    s = _strip_accents(name or "").strip().lower().replace(" ", "-")
    s = _NAME_RE.sub("", s)
    s = re.sub(r"-{2,}", "-", s).strip("-_")
    return s


class SkillSaveError(Exception):
    """Erreur métier lors de la sauvegarde d'un skill (message destiné à l'agent)."""


class SkillExistsError(SkillSaveError):
    """Import refusé : le(s) dossier(s)-skill cible(s) existe(nt) déjà et
    ``overwrite`` n'a pas été demandé. Sous-classe de ``SkillSaveError`` pour
    que les appelants non avertis dégradent en 400 (jamais en 500) ; la route
    HTTP la traduit en 409 + confirmation côté UI."""

    def __init__(self, names: List[str]):
        self.names = list(names)
        if len(self.names) == 1:
            msg = f"skill existe déjà : {self.names[0]}"
        else:
            msg = "skills existent déjà : " + ", ".join(self.names)
        super().__init__(msg)


# ──────────────────────────────────────────────────────────────────────────
# Limites & assainissement — SOURCE UNIQUE de vérité partagée par TOUS les
# chemins d'écriture (route HTTP /api/skills ET outil MCP skill_save). Avant,
# seul l'outil MCP bornait les tailles ; la route ne validait que la non-vacuité
# → un body arbitrairement gros pouvait être injecté dans le system prompt.
# ──────────────────────────────────────────────────────────────────────────
MAX_NAME_LEN = 80
MAX_DESC_LEN = 300
MAX_BODY_LEN = 20000
MAX_TAGS     = 20
MAX_TAG_LEN  = 40


# Tout caractère qui ferait passer une valeur de frontmatter mono-ligne sur
# PLUSIEURS lignes au re-parse. ``str.splitlines()`` (utilisé par le parser)
# coupe sur bien plus que ``\n`` : CR, VT, FF, séparateurs Unicode, NEL, etc.
# Les neutraliser TOUS empêche l'injection de fausses clés (name/domain/…) via
# n'importe quel champ texte (description, tags).
_FRONTMATTER_BREAKS = re.compile(r"[\r\n\v\f\x1c\x1d\x1e\x1f\x85  ]+")


def _one_line(text: Any) -> str:
    """Aplatit toute valeur de frontmatter mono-ligne : remplace les coupures de
    ligne (au sens ``splitlines``) par des espaces, puis compacte."""
    s = _FRONTMATTER_BREAKS.sub(" ", str(text or ""))
    return re.sub(r"\s{2,}", " ", s).strip()


def _sanitize_tags(tags: Any) -> List[str]:
    """Nettoie + borne une liste de tags. Retire les coupures de ligne ET
    ``[`` / ``]`` / ``,`` (sinon un tag injecte des lignes arbitraires dans le
    frontmatter rendu, qui au re-parse deviennent de vraies clés — surcharge
    silencieuse de ``name``/``domain``)."""
    out: List[str] = []
    for t in _parse_tags(tags):
        t = _one_line(re.sub(r"[\[\],]+", " ", str(t)))
        if t:
            out.append(t[:MAX_TAG_LEN])
        if len(out) >= MAX_TAGS:
            break
    return out


def _prepare_fields(
    name: str, description: str, body: str, tags: Any,
) -> Tuple[str, str, str, List[str]]:
    """Valide, borne et assainit les champs communs à tous les écrivains.

    Retourne ``(slug, description, body, tags)`` prêts à écrire. Lève
    ``SkillSaveError`` si ``name`` (après slug) ou ``body`` est vide.
    """
    slug = slugify_name((name or "")[:MAX_NAME_LEN])
    if not slug:
        raise SkillSaveError("name invalide (vide après normalisation)")
    body = (body or "").strip()
    if not body:
        raise SkillSaveError("body requis (la procédure ne peut pas être vide)")
    body = body[:MAX_BODY_LEN]
    description = (description or "").strip()[:MAX_DESC_LEN]
    return slug, description, body, _sanitize_tags(tags)




def _delete_slug_copies(root: Path, slug: str, *, exclude_learned: bool = False) -> bool:
    """Supprime TOUTES les copies de ``<slug>.md`` sous ``root``. Retourne True
    si au moins un fichier a été supprimé. Évite l'orphelin-après-delete (un
    doublon de domaine laissait une copie après un delete ``matches[0]``)."""
    root = Path(root)
    if not root.is_dir():
        return False
    learned_r = _learned_skills_root().resolve() if exclude_learned else None
    removed = False
    for p in sorted(root.rglob(f"{slug}.md")):
        if not p.is_file():
            continue
        if learned_r is not None:
            try:
                p.resolve().relative_to(learned_r)
                continue
            except ValueError:
                pass
        try:
            p.unlink()
            removed = True
        except OSError:
            pass
    return removed


def _global_name_exists(name: str) -> bool:
    """``True`` si un skill GLOBAL curé porte déjà ce slug (hors ``learned/``).

    Folder-aware : voit les legacy ``<slug>.md`` ET les dossiers-skills
    ``<slug>/SKILL.md`` — sous-skills inclus (un name de feuille doit rester
    unique globalement, sinon ``skill_get``/pins deviennent ambigus)."""
    return _find_global_entry(name) is not None


# ──────────────────────────────────────────────────────────────────────────
# Folder-aware : finders / purge / delete unifiés (legacy ``<slug>.md`` ET
# dossiers-skills ``<slug>/SKILL.md``). Source de vérité = ``_scan_tree`` —
# les mêmes règles que la découverte (un finder glob parallèle divergerait).
# ──────────────────────────────────────────────────────────────────────────

def _find_entry(root: Path, source: str, ident: str,
                *, exclude_dirs: tuple = ()) -> Optional[SkillSpec]:
    """Localise une entrée par id qualifié (``pkg/child``), name exact, ou slug
    du dernier segment. Tie sur le slug : dossier > legacy (l'état transitoire
    « les deux modèles coexistent » se résout en faveur du dossier, le save
    purge la copie legacy), puis le moins profond, puis id croissant."""
    ident = (ident or "").strip().strip("/")
    root = Path(root) if root else None
    if not ident or root is None or not root.is_dir():
        return None
    specs = _scan_tree(root, source, exclude_dirs=exclude_dirs)
    for sp in specs:
        if sp.id == ident:
            return sp
    cands = [sp for sp in specs if sp.name == ident]
    if not cands:
        leaf = slugify_name(ident.rsplit("/", 1)[-1])
        if leaf:
            cands = [sp for sp in specs if slugify_name(sp.name) == leaf]
    if not cands:
        return None
    cands.sort(key=lambda s: (0 if s.skill_dir else 1, s.depth, s.id))
    return cands[0]


def _find_global_entry(ident: str) -> Optional[SkillSpec]:
    return _find_entry(_global_skills_root(), "global", ident, exclude_dirs=("learned",))


def _find_learned_entry(ident: str) -> Optional[SkillSpec]:
    return _find_entry(_learned_skills_root(), "learned", ident)


def find_user_entry(user_skills_dir: Optional[Path], ident: str) -> Optional[SkillSpec]:
    if user_skills_dir is None:
        return None
    return _find_entry(Path(user_skills_dir), "user", ident)


def _purge_slug_entries(root: Path, slug: str, keep: Path,
                        *, exclude_learned: bool = False) -> None:
    """Supprime toute AUTRE entrée du slug que ``keep`` : fichiers legacy
    ``<slug>.md`` ET dossiers-skills nommés ``<slug>``. Généralise
    ``_remove_slug_copies`` au modèle dossier (dédup cross-modèle après save).

    Containment strict : jamais la racine, jamais un ancêtre de ``keep``,
    jamais hors de ``root`` ; ``learned/`` protégé côté global. À appeler sous
    ``_write_lock``."""
    root = Path(root)
    if not root.is_dir():
        return
    keep_r = keep.resolve()
    learned_r = _learned_skills_root().resolve() if exclude_learned else None

    def _in_learned(p: Path) -> bool:
        if learned_r is None:
            return False
        try:
            p.resolve().relative_to(learned_r)
            return True
        except (ValueError, OSError):
            return False

    for p in sorted(root.rglob(f"{slug}.md")):
        if not p.is_file() or _in_learned(p):
            continue
        try:
            if p.resolve() == keep_r:
                continue
            p.unlink()
        except OSError:
            pass
    for sm in sorted(root.rglob("SKILL.md")):
        d = sm.parent
        if d.name != slug or _in_learned(d):
            continue
        try:
            dr = d.resolve()
        except OSError:
            continue
        if dr == root.resolve() or not _is_under(d, root):
            continue
        # keep lui-même (son SKILL.md) ou un ancêtre de keep : intouchable.
        if sm.resolve() == keep_r or _is_under(keep, d):
            continue
        try:
            shutil.rmtree(d)
        except OSError:
            pass


def _delete_slug_entries(root: Path, source: str, ident: str,
                         *, exclude_learned: bool = False) -> bool:
    """Supprime un skill par ident — folder-aware. Qualifié (``pkg/child``) →
    SEULE l'entrée résolue (un sous-skill précis ; un homonyme ailleurs n'est
    pas touché). Simple → toutes les copies du slug, fichiers legacy ET
    dossiers-skills (rmtree : les sous-skills du dossier partent avec — l'UI le
    confirme explicitement). Retourne True si quelque chose a été supprimé."""
    root = Path(root)
    if not root.is_dir():
        return False
    ident = (ident or "").strip().strip("/")
    if not ident:
        return False
    if "/" in ident:
        spec = _find_entry(root, source, ident,
                           exclude_dirs=(("learned",) if exclude_learned else ()))
        if spec is None:
            return False
        target = Path(spec.skill_dir) if spec.skill_dir else (
            Path(spec.path) if spec.path else None)
        if (target is None or not _is_under(target, root)
                or target.resolve() == root.resolve()):
            return False
        try:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
            invalidate_skills_scan_cache()
            return True
        except OSError:
            return False
    slug = slugify_name(ident)
    if not slug:
        return False
    removed = _delete_slug_copies(root, slug, exclude_learned=exclude_learned)
    learned_r = _learned_skills_root().resolve() if exclude_learned else None
    for sm in sorted(root.rglob("SKILL.md")):
        d = sm.parent
        if d.name != slug:
            continue
        if learned_r is not None:
            try:
                d.resolve().relative_to(learned_r)
                continue
            except (ValueError, OSError):
                pass
        try:
            if d.resolve() == root.resolve() or not _is_under(d, root):
                continue
            shutil.rmtree(d)
            removed = True
        except OSError:
            pass
    if removed:
        invalidate_skills_scan_cache()
    return removed


def _render_skill_md(slug: str, description: str, body: str,
                     tags: Optional[List[str]], domain_slug: str = "") -> str:
    """Rend le markdown d'un skill (frontmatter + corps). Source unique de vérité
    pour tous les écrivains (learned, perso)."""
    tag_list = _sanitize_tags(tags)
    description = _one_line(description)
    fm_lines = ["---", f"name: {slug}", f"description: {description}",
                "tags: [" + ", ".join(tag_list) + "]"]
    if domain_slug:
        fm_lines.append(f"domain: {domain_slug}")
    fm_lines.append("---")
    return "\n".join(fm_lines) + "\n\n" + body.strip() + "\n"


def _atomic_write(dest: Path, content: str) -> None:
    """Écriture atomique tmp → rename, dossier parent créé au besoin."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".md.tmp")
    try:
        tmp.write_text(content, encoding="utf-8")
        os.replace(tmp, dest)
    finally:
        # write/replace échoué (disque plein, perms) → pas de .tmp orphelin qui
        # s'accumule. Après un replace réussi, tmp n'existe plus (missing_ok).
        tmp.unlink(missing_ok=True)


# Ordre canonique des clés gérées/connues du frontmatter (spec Agent Skills).
_FM_MANAGED_ORDER = ("name", "description", "tags", "domain",
                     "license", "compatibility", "allowed-tools")


def _render_frontmatter(fm: Dict[str, Any]) -> str:
    """Rend un bloc frontmatter COMPLET ``---…---`` (ordre canonique).

    Toutes les valeurs passent par ``_one_line`` — même protection anti-injection
    de fausses clés que ``_render_skill_md``. Les clés inconnues scalaires/listes
    sont émises telles quelles (passthrough — c'est ce qui permet à l'update
    in-place de PRÉSERVER ce que le formulaire ne gère pas). ``metadata`` (dict,
    1 niveau — symétrique du parser ``_frontmatter.parse_frontmatter_block``)
    est émis EN DERNIER : ses lignes indentées se rattachent à la dernière clé
    à valeur vide, il ne doit rien y avoir après."""
    lines = ["---"]

    def _emit(key: str, val: Any) -> None:
        if isinstance(val, (list, tuple)):
            items = [_one_line(re.sub(r"[\[\],]+", " ", str(t))) for t in val]
            lines.append(f"{key}: [" + ", ".join(t for t in items if t) + "]")
        else:
            lines.append(f"{key}: {_one_line(val)}")

    seen = set()
    for key in _FM_MANAGED_ORDER:
        val = fm.get(key)
        if val in (None, "") or val == [] or val == {}:
            continue
        _emit(key, val)
        seen.add(key)
    for key, val in fm.items():
        if key in seen or key == "metadata" or isinstance(val, dict):
            continue
        if val in (None, "") or val == []:
            continue
        k = _one_line(key)
        if k:
            _emit(k, val)
    meta = fm.get("metadata")
    if isinstance(meta, dict) and meta:
        lines.append("metadata:")
        for k, v in meta.items():
            k2 = _one_line(k)
            if k2:
                lines.append(f"  {k2}: {_one_line(v)}")
    lines.append("---")
    return "\n".join(lines) + "\n"


def _update_skill_md_in_place(skillmd: Path, *, name_slug: str, description: str,
                              body: str, tags: List[str],
                              domain: Optional[str]) -> None:
    """Ré-émet le ``SKILL.md`` d'un dossier-skill EN PLACE.

    Les champs gérés par le formulaire (description / tags / corps — ``name``
    réaligné sur le nom du dossier, règle du spec) écrasent l'existant ; TOUT le
    reste du frontmatter (license, compatibility, metadata, allowed-tools, clés
    inconnues) est préservé. ``domain`` : ``None`` = ne pas toucher la clé
    existante ; ``""`` = retirer la surcharge ; valeur = la poser. Le dossier
    n'est jamais déplacé (sous-skills et bundle intacts)."""
    try:
        prev_fm, _ = split_frontmatter(skillmd.read_text(encoding="utf-8"))
    except OSError:
        prev_fm = {}
    fm: Dict[str, Any] = dict(prev_fm)
    fm["name"] = name_slug
    fm["description"] = description
    fm["tags"] = list(tags)
    if domain is not None:
        if domain:
            fm["domain"] = domain
        else:
            fm.pop("domain", None)
    _atomic_write(skillmd, _render_frontmatter(fm) + "\n" + body.strip() + "\n")


def _save_skill_entry(root: Path, source: str, name: str, description: str,
                      body: str, tags: Optional[List[str]], domain: Optional[str],
                      *, prev_name: Optional[str] = None,
                      exclude_learned: bool = False,
                      forbid_learned_names: bool = False) -> Path:
    """Écrivain folder-aware COMMUN aux trois scopes (à appeler sous ``_write_lock``).

    Résolution :
      1. ``prev_name`` fourni avec un slug-feuille différent → RENAME de l'entrée
         existante. Dossier : ``os.replace`` du dir DANS SON PARENT (un sous-skill
         reste sous son package, le bundle suit) + ré-émission in-place du
         SKILL.md. Legacy : nouveau fichier + unlink de l'ancien (le modèle ne
         change pas).
      2. entrée existante pour le slug → UPDATE. Dossier : SKILL.md in-place
         (frontmatter non géré préservé, dossier jamais déplacé — depth>0 ignore
         ``domain``, dicté par le parent). Legacy : comportement historique
         (ré-émission atomique, déplacement si changement de domaine — pas de
         migration silencieuse de format au PUT).
      3. sinon → CREATE au format dossier ``root/[<domain>/]<slug>/SKILL.md``
         (le mécanisme réel — Agent Skill, prêt à recevoir scripts/sous-skills).

    Termine toujours par ``_purge_slug_entries`` (dédup cross-modèle : un legacy
    et un dossier du même slug ne coexistent jamais après une écriture)."""
    slug, description, body, tags = _prepare_fields(name, description, body, tags)
    domain_slug = slugify_name(domain) if domain else ""
    if forbid_learned_names and "learned" in (slug, domain_slug):
        raise SkillSaveError(
            "'learned' est réservé (SAS de curation) — choisis un autre name/domaine")
    exclude = ("learned",) if exclude_learned else ()

    def _finish(dest: Path) -> Path:
        _purge_slug_entries(root, slug, keep=dest, exclude_learned=exclude_learned)
        invalidate_skills_scan_cache()
        return dest

    # ── 1. Rename (slug-feuille différent) ──
    if prev_name:
        prev_leaf = slugify_name(prev_name.rsplit("/", 1)[-1])
        if prev_leaf and prev_leaf != slug:
            old = _find_entry(root, source, prev_name, exclude_dirs=exclude)
            if old is not None and old.skill_dir:
                old_dir = Path(old.skill_dir)
                new_dir = old_dir.parent / slug
                if new_dir.exists():
                    raise SkillSaveError(
                        f"'{slug}' existe déjà à cet emplacement — renommage refusé")
                try:
                    os.replace(old_dir, new_dir)
                except OSError as e:
                    raise SkillSaveError(f"renommage du dossier impossible : {e}")
                dest = new_dir / "SKILL.md"
                _update_skill_md_in_place(
                    dest, name_slug=slug, description=description, body=body,
                    tags=tags, domain=(domain_slug if old.depth == 0 else None))
                return _finish(dest)
            if old is not None and old.path:
                dest_dir = (root / domain_slug) if domain_slug else root
                dest = dest_dir / f"{slug}.md"
                _atomic_write(dest, _render_skill_md(slug, description, body, tags, domain_slug))
                try:
                    Path(old.path).unlink()
                except OSError:
                    pass
                return _finish(dest)
            # prev introuvable → create-or-update sur le nouveau slug (PUT idempotent)

    # ── 2. Update d'une entrée existante ──
    existing = _find_entry(root, source, slug, exclude_dirs=exclude)
    if existing is not None and existing.skill_dir:
        dest = Path(existing.skill_dir) / "SKILL.md"
        _update_skill_md_in_place(
            dest, name_slug=existing.name, description=description, body=body,
            tags=tags, domain=(domain_slug if existing.depth == 0 else None))
        return _finish(dest)
    if existing is not None and existing.path:
        dest_dir = (root / domain_slug) if domain_slug else root
        dest = dest_dir / f"{slug}.md"
        _atomic_write(dest, _render_skill_md(slug, description, body, tags, domain_slug))
        return _finish(dest)

    # ── 3. Create : format dossier (Agent Skill) ──
    dest_dir = (root / domain_slug / slug) if domain_slug else (root / slug)
    if dest_dir.is_dir() and any(p.is_file() and p.name != "SKILL.md"
                                 for p in dest_dir.rglob("*.md")):
        # Poser un SKILL.md dans un dossier de DOMAINE contenant des skills
        # legacy les ferait disparaître du scan (ils deviendraient « internes »
        # au nouveau dossier-skill) — on refuse plutôt que de masquer des données.
        raise SkillSaveError(
            f"un dossier '{slug}' existe déjà et contient des skills mono-fichier — "
            f"choisis un autre name (ou migre d'abord ce dossier en package)")
    dest = dest_dir / "SKILL.md"
    fm: Dict[str, Any] = {"name": slug, "description": description, "tags": tags}
    _atomic_write(dest, _render_frontmatter(fm) + "\n" + body.strip() + "\n")
    return _finish(dest)


def save_learned_skill(
    name: str,
    description: str,
    body: str,
    tags: Optional[List[str]] = None,
    domain: Optional[str] = None,
    *,
    prev_name: Optional[str] = None,
) -> Path:
    """Écrit un brouillon ADMIN dans ``skills/learned/`` (folder-aware).

    SAS de curation : l'admin propose ici, puis promeut vers ``skills/`` (global)
    via ``promote_learned_skill``. NON injecté dans le prompt avant promotion.
    (L'agent, lui, n'écrit PAS ici — ``skill_save`` va dans la sandbox perso.)
    Création = dossier ``learned/[<domain>/]<slug>/SKILL.md`` ; un learned
    existant (dossier ou legacy) est mis à jour selon son modèle
    (cf. ``_save_skill_entry``). ``prev_name`` (PUT) = renommage.

    Lève ``SkillSaveError`` (message lisible) si :
      - ``name`` ou ``body`` vide ;
      - le ``name`` entre en collision avec un skill GLOBAL existant (on refuse le
        shadowing silencieux d'un skill curé — il faut passer par la promotion).
    """
    slug, description, body, tags = _prepare_fields(name, description, body, tags)
    with _write_lock:
        if _global_name_exists(slug):
            raise SkillSaveError(
                f"un skill global '{slug}' existe déjà — édite-le directement ou "
                f"choisis un autre name (les learned ne peuvent pas masquer un skill curé)"
            )
        dest = _save_skill_entry(_learned_skills_root(), "learned", slug, description,
                                 body, tags, domain, prev_name=prev_name,
                                 forbid_learned_names=True)
    logger.info("[skills] learned skill saved: %s", dest)
    return dest




def promote_learned_skill(name: str) -> Path:
    """Promeut un skill learned vers la bibliothèque curée ``skills/``.

    Validation humaine learned → curé, folder-aware : déplace le fichier legacy
    OU le dossier-skill entier (bundle + sous-skills) en PRÉSERVANT son
    sous-dossier de domaine (``learned/jenkins/x`` → ``skills/jenkins/x``).
    Retourne le chemin déplacé : FICHIER pour un legacy, DOSSIER pour un
    dossier-skill (l'appelant lit ``dest.stem``/``dest.name`` → le slug, jamais
    « SKILL »). Lève ``SkillSaveError`` si le learned n'existe pas, si c'est un
    sous-skill (on promeut le package racine), ou si un global du même nom
    existe déjà (on n'écrase jamais un curé silencieusement).
    """
    slug = slugify_name(name)
    if not slug:
        raise SkillSaveError("name invalide")
    with _write_lock:
        spec = _find_learned_entry(name)
        if spec is None:
            raise SkillSaveError(f"skill learned introuvable : {slug}")
        if spec.depth > 0:
            raise SkillSaveError(
                f"'{spec.id}' est un sous-skill — promeus son package racine "
                f"('{spec.id.split('/')[0]}')")
        if _global_name_exists(spec.name):
            raise SkillSaveError(
                f"un skill global '{spec.name}' existe déjà — résous le conflit à la main"
            )
        src = Path(spec.skill_dir) if spec.skill_dir else Path(spec.path)
        # Préserve le sous-dossier de domaine relatif à learned/.
        rel = src.relative_to(_learned_skills_root())
        dest = _global_skills_root() / rel
        if dest.exists():
            raise SkillSaveError(
                f"'{rel}' existe déjà côté global — résous le conflit à la main")
        dest.parent.mkdir(parents=True, exist_ok=True)
        os.replace(src, dest)
    logger.info("[skills] promoted learned → global: %s", dest)
    invalidate_skills_scan_cache()
    return dest


# ──────────────────────────────────────────────────────────────────────────
# Skills PERSO (sandbox utilisateur) — import / suppression depuis l'UI
# ──────────────────────────────────────────────────────────────────────────
#
# Les skills perso vivent dans ``<sandbox_utilisateur>/skills/`` et surchargent
# le global par ``name`` (cf. discover_skills). Le dossier racine est résolu par
# l'appelant (la route, qui connaît la sandbox de l'user) et passé ici — ce
# module reste sans dépendance à ``shared_infra``.



def save_user_skill(
    user_skills_dir: Path,
    name: str,
    description: str,
    body: str,
    tags: Optional[List[str]] = None,
    domain: Optional[str] = None,
    *,
    prev_name: Optional[str] = None,
) -> Path:
    """Crée / met à jour un skill PERSO (folder-aware).

    Création = dossier ``<user_skills_dir>/[<domain>/]<slug>/SKILL.md`` (modèle
    Agent Skill) ; un skill existant (dossier ou legacy) est mis à jour selon
    son modèle, un dossier n'est jamais déplacé (cf. ``_save_skill_entry``).
    ``prev_name`` (PUT) = renommage. Pas de contrôle de collision avec le
    global : un skill perso a le droit de surcharger un skill curé (priorité
    user > global). Lève ``SkillSaveError`` si ``name`` ou ``body`` est vide.
    """
    with _write_lock:
        dest = _save_skill_entry(Path(user_skills_dir), "user", name, description,
                                 body, tags, domain, prev_name=prev_name)
    logger.info("[skills] user skill saved: %s", dest)
    return dest




def delete_user_skill(user_skills_dir: Path, name: str) -> bool:
    """Supprime un skill perso (folder-aware). ``name`` accepte un id qualifié
    ``pkg/child`` (seul ce sous-skill est supprimé) ou un slug simple (toutes
    les copies : legacy ET dossiers — les sous-skills d'un package partent avec
    lui). Retourne True si quelque chose a été supprimé. Ne touche QUE le store
    de l'utilisateur."""
    with _write_lock:
        removed = _delete_slug_entries(Path(user_skills_dir), "user", name)
    if removed:
        logger.info("[skills] user skill deleted: %s", name)
    return removed


# ──────────────────────────────────────────────────────────────────────────
# Store protégé (hors sandbox) + miroir de travail dans la sandbox
#
# Les skills PERSO vivaient dans ``<sandbox>/skills/`` : ce dossier est monté
# RW dans le conteneur shell et accessible aux outils fs — le modèle pouvait
# le détruire (rm -rf). Le store réel est désormais HORS sandbox
# (``USER_SKILLS_DIR/<safe_name>/``) ; la sandbox ne contient qu'une COPIE
# (``<sandbox>/skills/``) régénérée à chaque écriture du store et auto-réparée
# par ``skill_get``. Supprimer la copie est sans conséquence.
# ──────────────────────────────────────────────────────────────────────────

def ensure_user_skills_store(store_dir: Path, sandbox_dir: Optional[Path] = None) -> Path:
    """Garantit le store protégé ; migre l'ancien ``<sandbox>/skills`` si présent.

    Migration douce une-fois : si le store n'existe pas encore et que l'ancien
    emplacement sandbox contient des skills, l'arborescence est DÉPLACÉE vers
    le store (sous le verrou d'écriture — sûr multi-worker), puis le miroir
    sandbox est recréé. Best-effort : ne lève jamais (retourne le chemin du
    store dans tous les cas).
    """
    store = Path(store_dir)
    migrated = False
    try:
        legacy = (Path(sandbox_dir) / "skills") if sandbox_dir else None
        if legacy is not None and not store.exists() and legacy.is_dir():
            with _write_lock:
                if not store.exists() and legacy.is_dir():   # re-check sous verrou
                    store.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(legacy), str(store))
                    migrated = True
            if migrated:
                logger.info("[skills] store perso migré hors sandbox : %s → %s",
                            legacy, store)
    except Exception as e:                                    # noqa: BLE001
        logger.warning("[skills] migration du store perso échouée (%s) : %s", store, e)
    if migrated and sandbox_dir:
        sync_user_skills_mirror(store, sandbox_dir)
    return store


def sync_user_skills_mirror(store_dir: Optional[Path],
                            sandbox_dir: Optional[Path]) -> Optional[Path]:
    """Reconstruit la COPIE de travail ``<sandbox>/skills/`` depuis le store.

    Appelée après chaque mutation du store (save/delete/import) et par
    ``skill_get`` (self-heal si le modèle a supprimé/altéré la copie). Build
    dans un dossier temporaire puis bascule, pour minimiser la fenêtre sans
    miroir. Store vide/absent → miroir retiré. Best-effort : ne lève jamais.
    """
    if not sandbox_dir:
        return None
    mirror = Path(sandbox_dir) / "skills"
    store = Path(store_dir) if store_dir else None
    tmp = Path(sandbox_dir) / ".skills-mirror.tmp"
    try:
        with _write_lock:
            shutil.rmtree(tmp, ignore_errors=True)
            has_content = store is not None and store.is_dir() and any(store.iterdir())
            if has_content:
                shutil.copytree(store, tmp)
                shutil.rmtree(mirror, ignore_errors=True)
                tmp.rename(mirror)
            else:
                shutil.rmtree(mirror, ignore_errors=True)
        return mirror
    except Exception as e:                                    # noqa: BLE001
        logger.warning("[skills] sync du miroir sandbox échoué (%s) : %s", mirror, e)
        shutil.rmtree(tmp, ignore_errors=True)
        return None


def find_user_skill_dir(user_skills_dir: Path, ident: str) -> Optional[Path]:
    """Localise le DOSSIER d'un skill perso par slug ou id qualifié ``pkg/child``.

    Déterministe : si plusieurs dossiers portent le slug terminal, celui dont le
    chemin relatif se termine par l'id qualifié gagne, sinon le premier trié.
    Retourne None si introuvable (ou skill legacy mono-fichier)."""
    store = Path(user_skills_dir)
    parts = [slugify_name(p) for p in str(ident or "").split("/") if p.strip()]
    if not parts or not store.is_dir():
        return None
    cands = sorted(d for d in store.rglob(parts[-1])
                   if d.is_dir() and (d / "SKILL.md").is_file())
    if not cands:
        return None
    suffix = "/".join(parts)
    for d in cands:
        rel = d.relative_to(store).as_posix()
        if rel == suffix or rel.endswith("/" + suffix):
            return d
    return cands[0]


# Cap d'un fichier groupé ajouté via skill_add_file (scripts/références).
SKILL_FILE_MAX_BYTES = int(os.environ.get("SKILL_FILE_MAX_BYTES", str(256 * 1024)))


def add_user_skill_file(user_skills_dir: Path, name: str, relpath: str,
                        content: str) -> Path:
    """Écrit un fichier groupé (script, référence…) dans un skill perso EXISTANT.

    Écrit dans le STORE protégé — c'est le pendant contrôlé de ce que
    ``write_file`` ne doit plus faire (la sandbox n'est qu'un miroir jetable).
    Chemin relatif au dossier du skill, sans ``..`` ni segments cachés ;
    ``SKILL.md`` se met à jour via ``skill_save``. Lève ``SkillSaveError``.
    """
    rel = (relpath or "").replace("\\", "/").strip().lstrip("/")
    parts = [p for p in rel.split("/") if p]
    if not parts or len(rel) > 300 or any(p.startswith(".") for p in parts):
        raise SkillSaveError(
            "chemin invalide : relatif au dossier du skill (ex. scripts/run.sh), "
            "sans '..' ni segments cachés")
    if parts[-1] == "SKILL.md":
        raise SkillSaveError("SKILL.md se met à jour via skill_save, pas via skill_add_file")
    data = (content or "").encode("utf-8")
    if not data:
        raise SkillSaveError("content requis (fichier vide refusé)")
    if len(data) > SKILL_FILE_MAX_BYTES:
        raise SkillSaveError(f"fichier trop gros ({len(data)} > {SKILL_FILE_MAX_BYTES} octets)")
    with _write_lock:
        d = find_user_skill_dir(user_skills_dir, name)
        if d is None:
            raise SkillSaveError(
                f"skill perso « {name} » introuvable au format dossier — "
                "crée-le d'abord avec skill_save")
        target = d / rel
        # Ceinture : containment (rel déjà validé sans '..').
        if not str(target.resolve()).startswith(str(d.resolve()) + os.sep):
            raise SkillSaveError("chemin hors du dossier du skill")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    logger.info("[skills] user skill file written: %s", target)
    return target


# ──────────────────────────────────────────────────────────────────────────
# Packaging .zip (Agent Skills) — import/export d'un dossier-skill.
# Durci : anti zip-slip, caps taille/nombre, SKILL.md requis, name conforme.
# ──────────────────────────────────────────────────────────────────────────
SKILL_ZIP_MAX_BYTES        = int(os.environ.get("SKILL_ZIP_MAX_BYTES", str(25 * 1024 * 1024)))
SKILL_ZIP_MAX_UNCOMPRESSED = int(os.environ.get("SKILL_ZIP_MAX_UNCOMPRESSED", str(25 * 1024 * 1024)))
SKILL_ZIP_MAX_FILES        = int(os.environ.get("SKILL_ZIP_MAX_FILES", "500"))


def _slug_from_skill_md(md_bytes: bytes) -> str:
    """Slug du ``name:`` du frontmatter d'un SKILL.md (``''`` si illisible) —
    nomme le dossier lors d'un import « en vrac » (SKILL.md sans dossier racine).
    Partagé par l'import .zip et l'import dossier (routes HTTP)."""
    try:
        fm, _body = split_frontmatter(md_bytes.decode("utf-8", "replace"))
        return slugify_name(str((fm or {}).get("name") or "")[:MAX_NAME_LEN])
    except Exception:
        return ""


def export_skill_zip(spec: "SkillSpec") -> bytes:
    """Zippe un skill au layout ``<name>/…`` (Agent Skill). Dossier-skill : tous
    ses fichiers (hors cachés). Legacy mono-fichier : exporté en ``<name>/SKILL.md``."""
    import io as _io
    import zipfile as _zip
    buf = _io.BytesIO()
    name = spec.name
    with _zip.ZipFile(buf, "w", _zip.ZIP_DEFLATED) as z:
        if spec.skill_dir:
            root = Path(spec.skill_dir)
            for f in sorted(root.rglob("*")):
                if not f.is_file():
                    continue
                rel = f.relative_to(root)
                if any(p.startswith(".") for p in rel.parts):
                    continue
                z.write(f, f"{name}/{rel.as_posix()}")
        elif spec.path:
            try:
                z.writestr(f"{name}/SKILL.md", Path(spec.path).read_text(encoding="utf-8"))
            except OSError as e:
                raise SkillSaveError(f"lecture du skill échouée : {e}")
    return buf.getvalue()


def _zip_safe_members(zf, *, max_files: int, max_uncompressed: int):
    """Valide un zip → (roots:set, [(arcname, ZipInfo), …]). Lève
    ``SkillSaveError`` sur zip-slip / caps. N'impose PAS un dossier racine unique
    (un package multi-skills a plusieurs racines)."""
    infos = [i for i in zf.infolist() if not i.is_dir()]
    if not infos:
        raise SkillSaveError("archive vide")
    if len(infos) > max_files:
        raise SkillSaveError(f"trop de fichiers ({len(infos)} > {max_files})")
    if sum(max(0, i.file_size) for i in infos) > max_uncompressed:
        raise SkillSaveError(
            f"contenu décompressé trop volumineux (> {max_uncompressed // 1048576} Mo)")
    members = []
    roots: set = set()
    for i in infos:
        arc = i.filename.replace("\\", "/")
        if "\x00" in arc:
            # Un NUL ferait exploser Path.resolve() plus bas (ValueError → 500).
            raise SkillSaveError(f"chemin d'archive invalide : {arc!r}")
        parts = [p for p in Path(arc).parts if p not in ("", ".")]
        if not parts:
            continue
        if arc.startswith("/") or ".." in parts:
            raise SkillSaveError(f"chemin d'archive dangereux (zip-slip) : {arc}")
        if any(p.startswith(".") for p in parts):
            continue  # ignore fichiers/dossiers cachés
        roots.add(parts[0])
        members.append((arc, i))
    if not members:
        raise SkillSaveError("archive sans fichier exploitable")
    return roots, members


def install_skill_zip(zip_bytes: bytes, dest_root: Path, *, source: str = "global",
                      strict: bool = True, overwrite: bool = False) -> List[str]:
    """Installe UN ou PLUSIEURS skills depuis un ``.zip`` sous ``dest_root``, en
    préservant l'arborescence (sous-skills imbriqués + scripts). Détecte
    automatiquement skill unique (``<name>/SKILL.md``) vs package multi-skills
    (plusieurs ``*/SKILL.md``). Retourne la liste des dossiers-skills installés
    (chemins relatifs POSIX, ex. ``["pkg", "pkg/child"]``).

    Layout TOLÉRANT (les deux archives « presque bonnes » les plus courantes) :
    un ``SKILL.md`` à la RACINE de l'archive (contenu d'un dossier zippé) → tout
    est ré-emballé sous un dossier nommé d'après son frontmatter, comme la
    sélection « en vrac » de l'import-dossier ; ``skill.md``/``Skill.md`` (zips
    mac/Windows) → canonisé en ``SKILL.md`` quand AUCUN manifest exact n'existe.

    Sécurité (toujours) : taille zip, anti zip-slip, caps fichiers/décompressé,
    containment. ``strict`` : True → valide chaque SKILL.md contre le spec Agent
    Skills ; False (import TOLÉRANT) → exige seulement un SKILL.md parsable (la
    découverte reste permissive en aval → accepte les vrais skills Claude).
    ``overwrite`` : False (défaut) → ``SkillExistsError`` si un dossier-skill
    cible existe déjà (AUCUNE écriture) ; True → clean-install (rmtree).
    """
    import io as _io
    import shutil as _sh
    import zipfile as _zip
    if not zip_bytes:
        raise SkillSaveError("fichier .zip vide")
    if len(zip_bytes) > SKILL_ZIP_MAX_BYTES:
        raise SkillSaveError(
            f"archive trop volumineuse ({len(zip_bytes) / 1048576:.1f} Mo"
            f" > {SKILL_ZIP_MAX_BYTES / 1048576:.0f} Mo)")
    try:
        zf = _zip.ZipFile(_io.BytesIO(zip_bytes))
    except _zip.BadZipFile:
        raise SkillSaveError("fichier invalide : ce n'est pas une archive .zip")
    with zf:
        _roots, members = _zip_safe_members(
            zf, max_files=SKILL_ZIP_MAX_FILES, max_uncompressed=SKILL_ZIP_MAX_UNCOMPRESSED)

        # Layout tolérant — (a) rescue de casse : AUCUN manifest exact-case ?
        # on canonise ``skill.md``/``Skill.md``… → ``SKILL.md`` (rescue-only :
        # un ``docs/skill.md`` à côté d'un vrai SKILL.md reste un simple doc).
        if not any(arc == "SKILL.md" or arc.endswith("/SKILL.md") for arc, _ in members):
            remapped = []
            for arc, info in members:
                parts = arc.split("/")
                if parts[-1].lower() == "skill.md":
                    parts[-1] = "SKILL.md"
                remapped.append(("/".join(parts), info))
            if len({a for a, _ in remapped}) != len(remapped):
                raise SkillSaveError(
                    "plusieurs SKILL.md avec des casses différentes dans le même dossier")
            members = remapped

        # (b) vrac : manifest à la RACINE de l'archive (contenu d'un dossier
        # zippé) → tout emballer sous le slug de son frontmatter, exactement
        # comme la sélection « en vrac » de l'import-dossier.
        root_info = next((info for arc, info in members if arc == "SKILL.md"), None)
        if root_info is not None:
            folder = _slug_from_skill_md(zf.read(root_info)) or "skill-importe"
            members = [(f"{folder}/{arc}", info) for arc, info in members]

        # Un skill par SKILL.md ; son dossier parent = le dossier-skill.
        by_arc = {arc: info for arc, info in members}
        skill_dirs = sorted({
            arc[:-len("/SKILL.md")] for arc, _ in members if arc.endswith("/SKILL.md")
        })
        if not skill_dirs:
            raise SkillSaveError(
                "aucun fichier SKILL.md trouvé — l'archive ou le dossier doit "
                "contenir un SKILL.md (à la racine ou dans un dossier de skill)")

        if strict:
            from llm_core._skill_validate import validate_frontmatter
            for d in skill_dirs:
                info = by_arc.get(f"{d}/SKILL.md")
                if info is None:
                    raise SkillSaveError(f"SKILL.md illisible : {d}/SKILL.md")
                txt = zf.read(info).decode("utf-8", "replace")
                errs = validate_frontmatter(split_frontmatter(txt)[0], dir_name=d.split("/")[-1])
                if errs:
                    raise SkillSaveError(f"{d}/SKILL.md non conforme : " + " ; ".join(errs))

        # N'extrait QUE les fichiers appartenant à un dossier-skill (ignore les
        # éventuels fichiers parasites à la racine de l'archive, ex. README).
        keep = [(arc, info) for arc, info in members
                if any(arc == f"{d}/SKILL.md" or arc.startswith(f"{d}/") for d in skill_dirs)]

        dest_root = Path(dest_root)
        dest_root_r = dest_root.resolve()
        with _write_lock:
            # Clean install des dossiers RACINE concernés (segment simple).
            # Guard symlink D'ABORD (même overwrite=True ne doit pas suivre un
            # lien hors bibliothèque), refus AVANT toute écriture ensuite.
            targets: List[Tuple[str, Path]] = []
            for r in sorted({d.split("/")[0] for d in skill_dirs}):
                tgt = (dest_root / r).resolve()
                if tgt.parent != dest_root_r:
                    raise SkillSaveError(
                        f"dossier de skill invalide : {r} (chemin résolu hors de la bibliothèque)")
                targets.append((r, tgt))
            existing = [r for r, tgt in targets if tgt.exists()]
            if existing and not overwrite:
                raise SkillExistsError(existing)
            for _r, tgt in targets:
                if tgt.exists():
                    _sh.rmtree(tgt, ignore_errors=True)
            for arc, info in keep:
                out = (dest_root / arc).resolve()
                if not _is_under(out, dest_root):
                    raise SkillSaveError(f"chemin d'extraction hors cible : {arc}")
                out.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, open(out, "wb") as dst:
                    dst.write(src.read())
    logger.info("[skills] installed %d skill(s) (%s) → %s", len(skill_dirs), source, skill_dirs)
    invalidate_skills_scan_cache()
    return skill_dirs


# ──────────────────────────────────────────────────────────────────────────
# Helpers partagés : parsing de tags + écriture/suppression GLOBAL et LEARNED
# (la curation côté HTTP réutilise ces écrivains plutôt que d'écrire à la main)
# ──────────────────────────────────────────────────────────────────────────

def _parse_tags(raw_tags: Any) -> List[str]:
    """Normalise un champ ``tags`` (liste OU CSV string) en ``List[str]``.

    Source unique de vérité — ``_load_spec_from_path`` et
    ``save_user_skill_from_md`` font la même chose ; les écrivains HTTP la
    réutilisent pour parser un import ``raw_md``.
    """
    if isinstance(raw_tags, str):
        return [t.strip() for t in raw_tags.split(",") if t.strip()]
    if isinstance(raw_tags, list):
        return [str(t).strip() for t in raw_tags if str(t).strip()]
    return []


def save_global_skill(
    name: str,
    description: str,
    body: str,
    tags: Optional[List[str]] = None,
    domain: Optional[str] = None,
    *,
    prev_name: Optional[str] = None,
) -> Path:
    """Crée / met à jour un skill GLOBAL curé (folder-aware).

    Curation côté HTTP (réservée admin par l'appelant). Création = dossier
    ``skills/[<domain>/]<slug>/SKILL.md`` (modèle Agent Skill) ; un global
    existant (dossier ou legacy) est mis à jour selon son modèle, un dossier
    n'est jamais déplacé et son frontmatter non géré est préservé
    (cf. ``_save_skill_entry``). ``prev_name`` (PUT) = renommage. Lève
    ``SkillSaveError`` si ``name`` ou ``body`` est vide, ou si name/domaine
    vaut ``learned`` (réservé au SAS).
    """
    with _write_lock:
        dest = _save_skill_entry(_global_skills_root(), "global", name, description,
                                 body, tags, domain, prev_name=prev_name,
                                 exclude_learned=True, forbid_learned_names=True)
    logger.info("[skills] global skill saved: %s", dest)
    return dest


def delete_learned_skill(name: str) -> bool:
    """Supprime (rejette) un skill ``learned`` non encore promu (folder-aware,
    id qualifié accepté). Retourne True si quelque chose a été supprimé.
    Ne touche QUE le sous-arbre ``learned/``.
    """
    with _write_lock:
        removed = _delete_slug_entries(_learned_skills_root(), "learned", name)
    if removed:
        logger.info("[skills] learned skill deleted: %s", name)
    return removed




def delete_global_skill(name: str) -> bool:
    """Supprime un skill GLOBAL curé (folder-aware, curation admin côté appelant).

    ``name`` accepte un id qualifié ``pkg/child`` (seul ce sous-skill est
    supprimé) ou un slug simple (toutes les copies : legacy ET dossiers — les
    sous-skills d'un package partent avec lui). Retourne True si quelque chose
    a été supprimé. N'affecte PAS le sous-arbre ``learned/``.
    """
    with _write_lock:
        removed = _delete_slug_entries(_global_skills_root(), "global", name,
                                       exclude_learned=True)
    if removed:
        logger.info("[skills] global skill deleted: %s", name)
    return removed
