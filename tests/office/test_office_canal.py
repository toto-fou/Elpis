# SPDX-License-Identifier: MIT
"""tests/office/test_office_canal.py — worker Office : cadres du protocole, descripteur 3 obligatoire et non héritable, démarrage par `python -m elpis_office`."""
from __future__ import annotations

import io
import json
import os
import struct
import subprocess
import sys
from pathlib import Path

import pytest

from elpis_office import canal

RACINE = Path(__file__).resolve().parents[2]


def _cadre(entete: dict, corps: bytes = b"") -> bytes:
    brut = json.dumps(entete).encode()
    return struct.pack(">I", len(brut)) + brut + struct.pack(">I", len(corps)) + corps


def _cadres(flux: bytes) -> list:
    lu, tampon = [], io.BytesIO(flux)
    while (c := canal.lire_cadre(tampon)) is not None:
        lu.append(c)
    return lu


def _servir(entree: bytes) -> tuple:
    sortie, codes = io.BytesIO(), []
    canal.servir(io.BytesIO(entree), sortie, paralleles=1, sortir=codes.append)
    return _cadres(sortie.getvalue()), codes


def test_aller_retour_d_un_cadre_avec_corps():
    assert _cadres(_cadre({"type": "x"}, b"abc")) == [({"type": "x"}, b"abc")]


def test_entree_fermee_au_milieu_d_un_cadre():
    with pytest.raises(EOFError):
        canal.lire_cadre(io.BytesIO(_cadre({"type": "x"})[:6]))


def test_en_tete_trop_grand_refuse():
    with pytest.raises(ValueError):
        canal.lire_cadre(io.BytesIO(struct.pack(">I", canal.MAX_ENTETE + 1)))


def test_le_worker_annonce_ses_outils_puis_sort_proprement():
    cadres, codes = _servir(b"")
    assert cadres[0][0]["type"] == "pret" and cadres[0][0]["version"] == canal.VERSION
    assert "docx_create" in cadres[0][0]["outils"] and codes == [0]


def test_outil_inconnu_et_cadre_inconnu_ne_tuent_pas_le_worker():
    entree = _cadre({"type": "bizarre"}) + _cadre({"type": "appel", "id": 7, "outil": "nope", "args": {}})
    cadres, codes = _servir(entree)
    resultat = next(e for e, _ in cadres if e["type"] == "resultat")
    assert resultat["id"] == 7 and resultat["valeur"]["error"] == "unknown_tool" and codes == [0]


def test_canal_rompu_sort_en_code_1():
    _, codes = _servir(_cadre({"type": "appel", "id": 1, "outil": "nope"})[:5])
    assert codes == [1]


def test_stdout_n_est_pas_le_canal():
    source = (RACINE / "office/elpis_office/canal.py").read_text(encoding="utf-8")
    assert "dup2" not in source and canal.FD_PROTOCOLE == 3


def _worker(code: str, *args: str, pass_fds=(), stdin=subprocess.DEVNULL) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONPATH": str(RACINE / "office"), "PYTHONDONTWRITEBYTECODE": "1"}
    return subprocess.run([sys.executable, "-c", code, *args], env=env, stdin=stdin, capture_output=True,
                          pass_fds=pass_fds, timeout=60)


def test_sans_descripteur_3_le_worker_sort_en_code_2():
    r = _worker("import elpis_office.__main__ as m; m.main()")
    assert r.returncode == 2 and b"descripteur 3 absent" in r.stderr


def test_python_m_elpis_office_sans_descripteur_3_sort_en_code_2():
    env = {**os.environ, "PYTHONPATH": str(RACINE / "office"), "PYTHONDONTWRITEBYTECODE": "1"}
    r = subprocess.run([sys.executable, "-m", "elpis_office"], env=env, stdin=subprocess.DEVNULL,
                       capture_output=True, timeout=60)
    assert r.returncode == 2


def test_le_worker_parle_sur_le_descripteur_3_et_garde_stdout_pour_le_journal():
    lecture, ecriture = os.pipe()
    pilote = ("import os, sys\nos.dup2(int(sys.argv[1]), 3)\nos.close(int(sys.argv[1]))\n"
              "print('bruit au demarrage', flush=True)\nimport elpis_office.canal as c\nc.main()\n")
    try:
        r = _worker(pilote, str(ecriture), pass_fds=(ecriture,))
    finally:
        os.close(ecriture)
    with os.fdopen(lecture, "rb") as flux:
        entete, _ = canal.lire_cadre(flux)
    assert r.returncode == 0 and entete["type"] == "pret"
    assert b"bruit au demarrage" in r.stdout and b"pret" not in r.stdout


def test_descripteur_3_non_heritable():
    lecture, ecriture = os.pipe()
    pilote = ("import os, sys\nos.dup2(int(sys.argv[1]), 3)\nos.set_inheritable(3, True)\n"
              "import elpis_office.canal as c\n"
              "c.servir = lambda *a, **k: sys.stderr.write('heritable=%s' % os.get_inheritable(3))\nc.main()\n")
    try:
        r = _worker(pilote, str(ecriture), pass_fds=(ecriture,))
    finally:
        os.close(ecriture)
        os.close(lecture)
    assert b"heritable=False" in r.stderr
