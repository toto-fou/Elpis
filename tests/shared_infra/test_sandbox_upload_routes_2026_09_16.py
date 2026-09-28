# SPDX-License-Identifier: MIT
"""Import vers la sandbox : pré-contrôle, garde de quota des morceaux,
annulation (2026-09-16). Cf. ``docs/evolutions-upload-moteurs-reprise-design-2026-09-16.md`` § 1.

Contrats verrouillés :

* ``POST /api/sandbox/upload-precheck`` refuse un import qui dépasse le plafond
  d'UN import (``app.sandbox_import_max_pct`` de la capacité, défaut 60 %) ou
  l'espace restant — AVANT le moindre envoi, écrasements déduits ;
* quota illimité : capacité = espace disque libre du volume ;
* ``/upload-chunk`` ne croit plus la taille déclarée sur parole (cumul, taille
  finale, ``.part`` précédent, fichier écrasé) et isole deux imports par
  ``upload_id`` ;
* ``DELETE /api/sandbox/upload-chunk`` ne peut effacer QUE le tmp d'un import ;
* ``/upload`` signale ``quota_exceeded`` et ne range jamais un fichier dans un
  dossier homonyme.
"""
from __future__ import annotations

import shutil

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import shared_infra.config as cfg
import shared_infra.sandbox.exec_bridge as xb
import shared_infra.sandbox.routes_files as sf
from shared_infra.routes._helpers import reset_sandbox_usage_cache

MO = 1024 * 1024


@pytest.fixture()
def env(tmp_path, monkeypatch):
    root = tmp_path / "work"
    root.mkdir()
    state = {"quota_mb": 10, "calls": []}

    def _host(rel):
        return root / sf._strip_work_prefix(rel)

    async def _append(uid, rel, data, *, truncate):
        state["calls"].append(("append", rel, len(data), truncate))
        p = _host(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "wb" if truncate else "ab") as fh:
            fh.write(data)

    async def _rename(uid, old, new, *, overwrite=False):
        # Audit éditeur 2026-09-23 (E4) : la promotion du ``.part`` écrase.
        state["calls"].append(("rename", old, new))
        _host(new).parent.mkdir(parents=True, exist_ok=True)
        _host(old).replace(_host(new))

    async def _delete(uid, rel):
        state["calls"].append(("delete", rel))
        p = _host(rel)
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink(missing_ok=True)

    async def _write_bytes(uid, rel, data):
        state["calls"].append(("write", rel, len(data)))
        p = _host(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    monkeypatch.setattr(sf, "require_user_id", lambda request: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: root)
    monkeypatch.setattr(sf, "get_user_settings",
                        lambda uid: {"sandbox_quota_mb": state["quota_mb"]})
    monkeypatch.setattr(xb, "sandbox_append_chunk", _append)
    monkeypatch.setattr(xb, "sandbox_rename", _rename)
    monkeypatch.setattr(xb, "sandbox_delete", _delete)
    monkeypatch.setattr(xb, "sandbox_write_bytes", _write_bytes)
    monkeypatch.setattr(cfg, "sandbox_import_max_pct", lambda: 60)
    reset_sandbox_usage_cache()

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    yield TestClient(app), root, state
    reset_sandbox_usage_cache()


def _occupe(root, name, n):
    (root / name).write_bytes(b"\0" * n)


def _chunk(client, path, index, total, size, data, upload_id="imp1"):
    params = {"path": path, "index": index, "total": total, "size": size}
    if upload_id is not None:
        params["upload_id"] = upload_id
    return client.post("/api/sandbox/upload-chunk", params=params, content=data)


# ─────────────────────────────────────────────────────────────────────────────
#  Pré-contrôle
# ─────────────────────────────────────────────────────────────────────────────
def test_precheck_import_qui_tient(env):
    client, root, _ = env
    r = client.post("/api/sandbox/upload-precheck", json={
        "files": [{"path": "d/a.txt", "size": MO}, {"path": "d/b.txt", "size": MO}],
        "total_bytes": 2 * MO})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["fits"] is True and d["reason"] == ""
    assert d["needed_bytes"] == 2 * MO and d["total_bytes"] == 2 * MO
    assert d["quota_bytes"] == 10 * MO and d["max_pct"] == 60
    assert d["limit_bytes"] == 6 * MO
    assert d["unlimited"] is False and d["detailed"] is True


def test_precheck_refuse_au_dela_du_plafond_d_un_import(env):
    """7 Mo sur une sandbox de 10 Mo presque vide : l'espace restant suffirait,
    mais un import ne peut pas prendre plus de 60 % de la sandbox."""
    client, root, _ = env
    r = client.post("/api/sandbox/upload-precheck", json={
        "files": [{"path": "gros.bin", "size": 7 * MO}], "total_bytes": 7 * MO})
    d = r.json()
    assert d["fits"] is False
    assert d["reason"] == "import_limit"
    assert d["allowed_bytes"] == 6 * MO
    assert d["remaining_bytes"] > 7 * MO


def test_precheck_refuse_si_l_espace_restant_ne_suffit_pas(env):
    client, root, _ = env
    _occupe(root, "deja.bin", 8 * MO)
    r = client.post("/api/sandbox/upload-precheck", json={
        "files": [{"path": "nouveau.bin", "size": 3 * MO}], "total_bytes": 3 * MO})
    d = r.json()
    assert d["fits"] is False
    assert d["reason"] == "remaining"
    assert d["allowed_bytes"] == d["remaining_bytes"] <= 2 * MO


def test_precheck_mesure_l_usage_en_exact_pas_le_cache(env):
    """La jauge peut se contenter d'un cache de 30 s, pas la décision d'importer :
    un fichier écrit hors app juste avant (terminal, outil) doit compter."""
    client, root, _ = env
    assert client.get("/api/sandbox/quota").status_code == 200   # amorce le cache
    _occupe(root, "ecrit-par-le-terminal.bin", 8 * MO)
    d = client.post("/api/sandbox/upload-precheck", json={
        "files": [{"path": "x.bin", "size": 3 * MO}], "total_bytes": 3 * MO}).json()
    assert d["used_bytes"] >= 8 * MO
    assert d["fits"] is False


def test_precheck_deduit_les_ecrasements(env):
    client, root, _ = env
    _occupe(root, "a.bin", 5 * MO)
    d = client.post("/api/sandbox/upload-precheck", json={
        "files": [{"path": "a.bin", "size": 5 * MO + MO // 2}],
        "total_bytes": 5 * MO + MO // 2}).json()
    assert d["overwrite_bytes"] == 5 * MO
    assert d["needed_bytes"] == MO // 2
    assert d["fits"] is True


def test_precheck_un_dossier_homonyme_n_est_pas_un_ecrasement(env):
    client, root, _ = env
    (root / "a.bin").mkdir()
    d = client.post("/api/sandbox/upload-precheck", json={
        "files": [{"path": "a.bin", "size": MO}], "total_bytes": MO}).json()
    assert d["overwrite_bytes"] == 0 and d["needed_bytes"] == MO


def test_precheck_quota_illimite_juge_sur_le_disque_libre(env, monkeypatch):
    client, root, state = env
    state["quota_mb"] = 0
    monkeypatch.setattr(sf, "_disk_free_bytes", lambda r: 100 * MO)
    d = client.post("/api/sandbox/upload-precheck", json={
        "files": [{"path": "g.bin", "size": 70 * MO}], "total_bytes": 70 * MO}).json()
    assert d["unlimited"] is True
    assert d["limit_bytes"] == 60 * MO and d["remaining_bytes"] == 100 * MO
    assert d["fits"] is False and d["reason"] == "import_limit"
    d = client.post("/api/sandbox/upload-precheck", json={
        "files": [{"path": "g.bin", "size": 50 * MO}], "total_bytes": 50 * MO}).json()
    assert d["fits"] is True


def test_precheck_disque_illisible_ne_bloque_pas(env, monkeypatch):
    client, root, state = env
    state["quota_mb"] = 0
    monkeypatch.setattr(sf, "_disk_free_bytes", lambda r: 0)
    d = client.post("/api/sandbox/upload-precheck", json={
        "files": [{"path": "g.bin", "size": 70 * MO}], "total_bytes": 70 * MO}).json()
    assert d["fits"] is True and d["allowed_bytes"] is None and d["limit_bytes"] is None


def test_precheck_pourcentage_configurable(env, monkeypatch):
    client, root, _ = env
    monkeypatch.setattr(cfg, "sandbox_import_max_pct", lambda: 100)
    d = client.post("/api/sandbox/upload-precheck", json={
        "files": [{"path": "gros.bin", "size": 7 * MO}], "total_bytes": 7 * MO}).json()
    assert d["limit_bytes"] == 10 * MO and d["fits"] is True


def test_precheck_chemins_hors_sandbox_ignores(env):
    client, root, _ = env
    d = client.post("/api/sandbox/upload-precheck", json={
        "files": [{"path": "../../etc/x", "size": 9 * MO}, {"path": "ok.txt", "size": 10}],
        "total_bytes": 9 * MO + 10}).json()
    assert d["escaped"] == 1
    assert d["needed_bytes"] == 10 and d["fits"] is True


def test_precheck_au_dela_du_plafond_d_entrees_juge_sur_le_total(env, monkeypatch):
    client, root, _ = env
    monkeypatch.setattr(sf, "_PRECHECK_MAX_ENTRIES", 2)
    _occupe(root, "a.bin", MO)
    d = client.post("/api/sandbox/upload-precheck", json={
        "files": [{"path": "a.bin", "size": MO}] * 3, "total_bytes": 7 * MO}).json()
    assert d["detailed"] is False
    assert d["needed_bytes"] == 7 * MO and d["overwrite_bytes"] == 0
    assert d["fits"] is False


@pytest.mark.parametrize("body", [[], {"files": "x"}, {"files": [], "total_bytes": "abc"}])
def test_precheck_corps_invalide(env, body):
    client, root, _ = env
    assert client.post("/api/sandbox/upload-precheck", json=body).status_code == 400


@pytest.mark.parametrize("raw,attendu", [(None, 60), ("abc", 60), (0, 1), (250, 100), (35, 35)])
def test_pourcentage_borne_et_tolerant(monkeypatch, raw, attendu):
    app = {} if raw is None else {"sandbox_import_max_pct": raw}
    monkeypatch.setattr(cfg, "config_view", lambda: {"app": app})
    assert cfg.sandbox_import_max_pct() == attendu


def test_quota_expose_les_octets(env, monkeypatch):
    client, root, state = env
    d = client.get("/api/sandbox/quota").json()
    assert {"used_mb", "quota_mb", "pct"} <= set(d)          # contrat historique
    assert d["quota_bytes"] == 10 * MO
    assert d["remaining_bytes"] == 10 * MO - d["used_bytes"]
    state["quota_mb"] = 0
    reset_sandbox_usage_cache()
    d = client.get("/api/sandbox/quota").json()
    assert d["quota_bytes"] == 0 and d["remaining_bytes"] is None


# ─────────────────────────────────────────────────────────────────────────────
#  Upload multipart
# ─────────────────────────────────────────────────────────────────────────────
def test_upload_signale_quota_exceeded(env):
    client, root, state = env
    state["quota_mb"] = 1
    r = client.post("/api/sandbox/upload",
                    files=[("files", ("gros.bin", b"\0" * (2 * MO))),
                           ("files", ("petit.txt", b"ok"))],
                    data={"paths": ["gros.bin", "petit.txt"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["saved"] == 1
    assert d["skipped"] == [{"path": "gros.bin", "reason": "quota_exceeded"}]


def test_upload_ne_range_pas_un_fichier_dans_un_dossier_homonyme(env):
    client, root, state = env
    (root / "rapport").mkdir()
    r = client.post("/api/sandbox/upload",
                    files=[("files", ("rapport", b"contenu"))], data={"paths": ["rapport"]})
    d = r.json()
    assert d["saved"] == 0
    assert d["skipped"] == [{"path": "rapport", "reason": "is_directory"}]
    assert not any(c[0] == "write" for c in state["calls"])


# ─────────────────────────────────────────────────────────────────────────────
#  Upload découpé
# ─────────────────────────────────────────────────────────────────────────────
def test_chunk_nominal_isole_par_upload_id(env):
    client, root, state = env
    a, b = b"A" * 100, b"B" * 50
    r = _chunk(client, "d/f.bin", 0, 2, 150, a, upload_id="imp1")
    assert r.status_code == 200 and r.json() == {"ok": True, "done": False}
    assert (root / "d" / "f.bin.imp1.elpis-upload.part").exists()
    # Un second import du même fichier dans un autre onglet : autre tmp.
    assert _chunk(client, "d/f.bin", 0, 2, 150, b"Z" * 100, upload_id="imp2").status_code == 200
    assert (root / "d" / "f.bin.imp2.elpis-upload.part").read_bytes() == b"Z" * 100
    r = _chunk(client, "d/f.bin", 1, 2, 150, b, upload_id="imp1")
    assert r.status_code == 200 and r.json()["done"] is True
    assert (root / "d" / "f.bin").read_bytes() == a + b
    assert not (root / "d" / "f.bin.imp1.elpis-upload.part").exists()


def test_chunk_sans_upload_id_garde_le_nom_historique(env):
    client, root, state = env
    assert _chunk(client, "f.bin", 0, 2, 20, b"x" * 10, upload_id=None).status_code == 200
    assert (root / ("f.bin" + sf.UPLOAD_TMP_SUFFIX)).exists()


@pytest.mark.parametrize("bad", ["../x", "a b", "x" * 41, "é"])
def test_chunk_upload_id_invalide(env, bad):
    client, root, _ = env
    assert _chunk(client, "f.bin", 0, 1, 1, b"x", upload_id=bad).status_code == 400


def test_chunk_quota_depasse_au_premier_morceau(env):
    client, root, state = env
    _occupe(root, "deja.bin", 8 * MO)
    r = _chunk(client, "f.bin", 0, 1, 3 * MO, b"x")
    assert r.status_code == 413
    assert "Quota" in r.json()["detail"]
    assert not any(c[0] == "append" for c in state["calls"])


def test_chunk_quota_deduit_ecrasement_et_part_precedent(env):
    """8 Mo occupés dont un ``.part`` de 3 Mo d'une tentative abandonnée et le
    fichier de 3 Mo qu'on remplace : réimporter 4 Mo tient dans 10 Mo."""
    client, root, state = env
    _occupe(root, "autre.bin", 2 * MO)
    _occupe(root, "f.bin", 3 * MO)
    _occupe(root, "f.bin.imp1" + sf.UPLOAD_TMP_SUFFIX, 3 * MO)
    r = _chunk(client, "f.bin", 0, 2, 4 * MO, b"x" * 10)
    assert r.status_code == 200, r.text


def test_chunk_un_fichier_seul_ne_depasse_pas_le_plafond_d_un_import(env):
    client, root, state = env
    r = _chunk(client, "f.bin", 0, 2, 7 * MO, b"x" * 10)
    assert r.status_code == 413
    assert "limite" in r.json()["detail"] and "60 %" in r.json()["detail"]


def test_chunk_quota_illimite_juge_sur_le_disque(env, monkeypatch):
    client, root, state = env
    state["quota_mb"] = 0
    monkeypatch.setattr(sf, "_disk_free_bytes", lambda r: 10 * MO)
    assert _chunk(client, "f.bin", 0, 2, 7 * MO, b"x").status_code == 413
    assert _chunk(client, "g.bin", 0, 2, 5 * MO, b"x").status_code == 200


def test_chunk_cumul_superieur_a_la_taille_declaree(env):
    """Annoncer 10 octets au contrôle de quota puis en envoyer davantage."""
    client, root, state = env
    assert _chunk(client, "f.bin", 0, 3, 10, b"x" * 8).status_code == 200
    r = _chunk(client, "f.bin", 1, 3, 10, b"x" * 8)
    assert r.status_code == 400
    assert not (root / ("f.bin.imp1" + sf.UPLOAD_TMP_SUFFIX)).exists()


def test_chunk_taille_finale_incoherente_pas_de_promotion(env):
    client, root, state = env
    assert _chunk(client, "f.bin", 0, 2, 100, b"x" * 40).status_code == 200
    r = _chunk(client, "f.bin", 1, 2, 100, b"x" * 40)
    assert r.status_code == 400
    assert not (root / "f.bin").exists()
    assert not (root / ("f.bin.imp1" + sf.UPLOAD_TMP_SUFFIX)).exists()
    assert not any(c[0] == "rename" for c in state["calls"])


def test_chunk_vers_un_dossier_homonyme_refuse(env):
    client, root, state = env
    (root / "f.bin").mkdir()
    assert _chunk(client, "f.bin", 0, 1, 5, b"x" * 5).status_code == 409


def test_chunk_apres_annulation_ne_recree_pas_de_part(env):
    client, root, state = env
    assert _chunk(client, "d/f.bin", 0, 3, 30, b"x" * 10).status_code == 200
    r = client.delete("/api/sandbox/upload-chunk", params={"path": "d/f.bin", "upload_id": "imp1"})
    assert r.json() == {"ok": True, "removed": True}
    r = _chunk(client, "d/f.bin", 1, 3, 30, b"x" * 10)
    assert r.status_code == 409
    assert not (root / "d" / ("f.bin.imp1" + sf.UPLOAD_TMP_SUFFIX)).exists()


def test_chunk_hors_sandbox(env):
    client, root, _ = env
    assert _chunk(client, "../evil.bin", 0, 1, 1, b"x").status_code == 403


# ─────────────────────────────────────────────────────────────────────────────
#  Annulation : suppression du tmp
# ─────────────────────────────────────────────────────────────────────────────
def test_delete_idempotent(env):
    client, root, _ = env
    r = client.delete("/api/sandbox/upload-chunk", params={"path": "rien.bin", "upload_id": "imp9"})
    assert r.status_code == 200 and r.json() == {"ok": True, "removed": False}


def test_delete_ne_vise_jamais_un_fichier_utilisateur(env):
    client, root, _ = env
    (root / "a.txt").write_text("précieux")
    (root / ("a.txt" + sf.UPLOAD_TMP_SUFFIX)).write_text("tmp")
    r = client.delete("/api/sandbox/upload-chunk", params={"path": "a.txt"})
    assert r.json()["removed"] is True
    assert (root / "a.txt").read_text() == "précieux"
    assert not (root / ("a.txt" + sf.UPLOAD_TMP_SUFFIX)).exists()


def test_delete_hors_sandbox_et_parametres(env):
    client, root, _ = env
    assert client.delete("/api/sandbox/upload-chunk", params={"path": "../../x"}).status_code == 403
    assert client.delete("/api/sandbox/upload-chunk", params={"path": ""}).status_code == 400
    assert client.delete("/api/sandbox/upload-chunk",
                         params={"path": "a", "upload_id": "../x"}).status_code == 400


def test_le_balayage_de_maintenance_reconnait_le_tmp_avec_upload_id():
    assert ("f.bin.imp1" + sf.UPLOAD_TMP_SUFFIX).endswith(sf.UPLOAD_TMP_SUFFIX)
    assert sf._upload_tmp_rel("f.bin", "imp1").endswith(sf.UPLOAD_TMP_SUFFIX)
