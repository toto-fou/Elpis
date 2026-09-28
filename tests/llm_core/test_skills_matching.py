# SPDX-License-Identifier: MIT
"""Tests du ROUTAGE des skills (matching lexical + radical) et de l'INJECTION
dans le system prompt (exclusion learned, index borné, troncature du 1er corps).

Couvre les correctifs de l'audit routage/contexte :
  - match par radical (préfixe) → rappel FR sans lemmatisation ;
  - tie-break par spécificité (matches name/tags) et non alphabétique ;
  - domaine pondéré sous le name (ne noie plus les skills d'un domaine) ;
  - fenêtre multi-tours (recent_user_text) ;
  - learned exclu de l'injection ; index plafonné ; 1er corps tronqué au budget.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import llm_core.skills as s
from llm_core._system_prompts import _build_skills_block
from shared_infra.routes._helpers import recent_user_text


def _spec(name, description="", tags=None, domain="", body="steps"):
    return s.SkillSpec(name=name, description=description, tags=tags or [],
                       domain=domain, body=body)


# ── Matching : radical / préfixe (pallie l'absence de stemming FR) ──────────

@pytest.mark.parametrize("query", [
    "déployer une app", "déploie sur prod", "comment déployer", "deploiement",
])
def test_fuzzy_prefix_matches_inflections(query):
    skills = [_spec("jenkins-deploy", "Déclencher un déploiement via Jenkins",
                    ["déploiement", "ci"], "jenkins")]
    out = s.match_skills(query, skills)
    assert [x.name for x in out] == ["jenkins-deploy"], query


def test_no_match_when_unrelated():
    skills = [_spec("reset-qdrant", "Réinitialiser la base vectorielle", ["qdrant"], "qdrant")]
    assert s.match_skills("quelle est la météo aujourd'hui", skills) == []


# ── Tie-break par spécificité (et non alphabétique) ─────────────────────────

def test_tiebreak_specificity_breaks_score_tie():
    # Score STRICTEMENT ÉGAL (2.0) : seul le compteur 'strong' (match name/tags)
    # diffère → isole le tie-break par spécificité, indépendamment du score.
    a = _spec("zzz-strong", "", ["alpha"], "")        # 'alpha'→tag(2.0)  → strong=1
    b = _spec("aaa-weak", "alpha beta", [], "")        # desc(1)+desc(1)  → strong=0
    out = s.match_skills("alpha beta", [a, b], top_n=2)
    # 'a' (spécifique) gagne malgré un name alphabétiquement défavorable.
    assert out[0].name == "zzz-strong"


def test_ranking_picks_the_right_skill_realistic():
    # Cas réaliste : 'rerun' est l'intention ; ne doit pas perdre face à 'analyze'.
    skills = [
        _spec("jenkins-analyze-build-logs", "Analyser les logs d'un build",
              ["analyze", "build"], "jenkins"),
        _spec("jenkins-rerun-failed-job", "Rejouer un job en échec",
              ["rerun", "build"], "jenkins"),
    ]
    out = s.match_skills("rejouer un build jenkins en échec", skills, top_n=2)
    assert out[0].name == "jenkins-rerun-failed-job"


def test_domain_only_match_injected_at_default_threshold():
    # Un skill dont SEUL le domaine matche reste injecté au seuil par défaut
    # (_W_DOMAIN=1.5 > SKILLS_MIN_SCORE=1.0) — verrou anti-régression.
    sk = _spec("login-helper", "se connecter au service", [], domain="acme")
    assert [x.name for x in s.match_skills("acme", [sk], min_score=1.0)] == ["login-helper"]


# ── Le domaine ne pèse pas autant qu'un name/tag ────────────────────────────

def test_domain_weight_below_name():
    # 'jenkins' matche le DOMAINE de A (faible) et le NAME de B (fort).
    a = _spec("build-widget", "construire le widget", ["build"], "jenkins")
    b = _spec("jenkins-login", "se connecter à jenkins", ["auth"], "ops")
    out = s.match_skills("jenkins", [a, b], top_n=2)
    assert out[0].name == "jenkins-login"


# ── Fenêtre multi-tours ─────────────────────────────────────────────────────

def test_recent_user_text_concatenates_last_k():
    msgs = [
        {"role": "user", "content": "déployer le service via jenkins"},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": "vas-y, fais-le"},
    ]
    q = recent_user_text(msgs, k=3)
    # Le tour récent SANS mot-clé + le tour antérieur AVEC mot-clé.
    assert "fais-le" in q and "jenkins" in q
    # Et le matching retrouve le skill grâce au contexte antérieur.
    skills = [_spec("jenkins-deploy", "déploiement jenkins", ["deploy"], "jenkins")]
    assert s.match_skills(recent_user_text(msgs, 3), skills)


def test_recent_user_text_empty():
    assert recent_user_text([], 3) == ""
    assert recent_user_text([{"role": "assistant", "content": "x"}], 3) == ""


# ── discover_skills : exclusion de learned ──────────────────────────────────

def _write(root: Path, rel: str, name: str, body: str = "B"):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"---\nname: {name}\ndescription: d {name}\n---\n\n{body}\n", encoding="utf-8")


@pytest.fixture()
def skills_tree(tmp_path, monkeypatch):
    g = tmp_path / "skills"
    (g / "learned").mkdir(parents=True)
    monkeypatch.setattr(s, "_global_skills_root", lambda: g)
    monkeypatch.setattr(s, "_learned_skills_root", lambda: g / "learned")
    return g


def test_discover_excludes_learned_when_flag_false(skills_tree):
    _write(skills_tree, "jenkins/g1.md", "g1")
    _write(skills_tree, "learned/l1.md", "l1")
    with_learned = {sp.name for sp in s.discover_skills(include_learned=True)}
    without = {sp.name for sp in s.discover_skills(include_learned=False)}
    assert "l1" in with_learned and "g1" in with_learned
    assert without == {"g1"}


def test_delete_removes_all_copies(skills_tree):
    # Doublon de domaine (même slug, deux sous-dossiers) → le delete ne doit
    # laisser AUCUN orphelin.
    _write(skills_tree, "ops/dup.md", "dup")
    _write(skills_tree, "infra/dup.md", "dup")
    assert s.delete_global_skill("dup") is True
    assert list(skills_tree.rglob("dup.md")) == []


# ── Injection : learned jamais injecté, index borné, 1er corps tronqué ──────

def test_build_block_never_injects_learned(skills_tree):
    _write(skills_tree, "jenkins/g1.md", "g1", body="GLOBAL BODY")
    _write(skills_tree, "learned/secret.md", "secret", body="LEARNED BODY")
    block = _build_skills_block("secret g1", user_id=None) or ""
    assert "g1" in block            # global indexé
    assert "secret" not in block    # learned absent de l'index ET des corps
    assert "LEARNED BODY" not in block


def test_index_is_bounded(skills_tree, monkeypatch):
    import shared_infra.config as cfg
    for i in range(5):
        _write(skills_tree, f"d/s{i}.md", f"skill{i}")
    monkeypatch.setattr(cfg, "SKILLS_INDEX_MAX", 2)
    block = _build_skills_block("", user_id=None) or ""
    n_entries = sum(1 for ln in block.split("\n") if ln.startswith("- **"))
    assert n_entries == 2
    assert "+3 more" in block


def test_first_body_truncated_to_budget(skills_tree, monkeypatch):
    import shared_infra.config as cfg
    big = "X" * 5000
    _write(skills_tree, "ops/big.md", "big-skill", body=big)
    monkeypatch.setattr(cfg, "SKILLS_CHAR_BUDGET", 300)
    block = _build_skills_block("", user_id=None, pinned_skills=["big-skill"]) or ""
    assert "…[procedure truncated]" in block
    # Le corps injecté ne dépasse pas le budget (+ marge du marqueur/headers).
    # La marge couvre le header (qui documente skill_get/skill_read_file/
    # skill_run_script + le contrat d'exécution depuis /work) + l'index ; le
    # garde-fou attrape un corps NON tronqué (≈5000 chars), très au-dessus.
    assert len(block) < 300 + 950
