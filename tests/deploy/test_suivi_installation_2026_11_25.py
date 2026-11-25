# SPDX-License-Identifier: MIT
"""tests/deploy/test_suivi_installation_2026_11_25.py — écran de suivi de l'installation (deploy/suivi.py) : copie octet pour octet, écran entre ses repères à clé, étapes et bilan laissés au terminal, échec avec ses dernières lignes, pause le temps d'une question, sans terminal ; chaîne du journal d'install.sh, plan conforme aux étapes, secrets retirés avant l'écran."""
from __future__ import annotations

import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SUIVI = REPO / "deploy/suivi.py"
ENTREE, SORTIE = "\x1b[?1049h", "\x1b[?1049l"
CLE = "0123456789abcdef"
NU = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "TERM": "xterm", "LANG": "C.UTF-8"}


def R(*reperes: str, cle: str = CLE) -> str:
    """Repères d'install.sh, une ligne chacun."""
    return "".join(f"== {r} == [{cle}]\n" for r in reperes)


class Ecran:
    """Commande sous un pseudo-terminal (son /dev/tty), entrée standard par un tube ; tout ce qu'elle affiche est relevé."""

    def __init__(self, cmd: list[str], env: dict[str, str] | None = None, cwd: Path | None = None,
                 taille: tuple[int, int] = (30, 100)) -> None:
        r, self.w = os.pipe()
        self.pid, self.maitre = pty.fork()
        if self.pid == 0:
            os.dup2(r, 0)
            os.close(r)
            os.close(self.w)
            if cwd:
                os.chdir(cwd)
            os.execvpe(cmd[0], cmd, env or ENV)
        os.close(r)
        fcntl.ioctl(self.maitre, termios.TIOCSWINSZ, struct.pack("HHHH", *taille, 0, 0))
        self.brut = b""

    @property
    def vu(self) -> str:
        return self.brut.decode("utf-8", "replace")

    def ecrire(self, texte: "str | bytes") -> None:
        os.write(self.w, texte.encode() if isinstance(texte, str) else texte)

    def lire(self, delai: float = 0.05) -> str:
        while select.select([self.maitre], [], [], delai)[0]:
            try:
                d = os.read(self.maitre, 65536)
            except OSError:
                break
            if not d:
                break
            self.brut += d
        return self.vu

    def attendre(self, cond, delai: float = 10) -> str:
        fin = time.monotonic() + delai
        while time.monotonic() < fin:
            if cond(self.lire()):
                return self.vu
        raise AssertionError(f"attente vaine : {self.vu[-2000:]!r}")

    def fermer(self) -> int:
        os.close(self.w)
        fin = time.monotonic() + 15
        while time.monotonic() < fin:
            self.lire()
            pid, etat = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.lire()
                os.close(self.maitre)
                return os.waitstatus_to_exitcode(etat)
        os.kill(self.pid, 9)
        raise AssertionError("suivi.py ne s'arrête pas à la fin de son entrée")


def _suivi(tmp_path: Path, taille: tuple[int, int] = (30, 100), env: dict[str, str] | None = None) -> Ecran:
    (tmp_path / "cle").write_text(CLE, encoding="utf-8")
    return Ecran([sys.executable, "-I", str(SUIVI), "--journal", "/var/log/essai.log", "--acquit", str(tmp_path)],
                 taille=taille, env=env)


def _apres(vu: str, marque: str) -> str:
    """Ce qui suit la dernière MARQUE, sans séquences de couleur."""
    return NU.sub("", vu[vu.rindex(marque) + len(marque):])


# Avant le plan : recopie octet pour octet (autre encodage compris), une invite sans fin de ligne passe aussitôt.
def test_copie_octet_pour_octet_sans_attendre_la_fin_de_ligne(tmp_path):
    e = _suivi(tmp_path, env={**ENV, "LANG": "C", "LC_ALL": "C"})
    e.ecrire(b"avant \xe9t\xe9 \xe2\x80\x94\n  Choix [1] : ")
    e.attendre(lambda v: "Choix [1] : " in v)
    e.ecrire("2\n== Ceci == n'est pas un repère\n")
    assert e.fermer() == 0
    assert b"avant \xe9t\xe9 \xe2\x80\x94\r\n" in e.brut and "== Ceci == n'est pas un repère" in e.vu and ENTREE not in e.vu


# Plan, étapes, bilan, fin : écran ouvert puis rendu ; restent les étapes (durée, avertissements) et le bilan, pas les lignes des étapes.
def test_etapes_puis_bilan_laisses_au_terminal(tmp_path):
    e = _suivi(tmp_path)
    e.ecrire("début\n" + R("Étapes : Python | Interface | Démarrage"))
    e.attendre(lambda v: ENTREE in v)
    e.ecrire(R("Étape : Python") + "pip install en cours\n\x1b[1;33m[ warn  ]\x1b[0m attention\n")
    e.attendre(lambda v: "pip install en cours" in _apres(v, ENTREE))
    e.ecrire(R("Étape : Démarrage", "Bilan") + "Installation terminée.\n  Accès : http://x\n" + R("Fin (1)") + "après\n")
    e.attendre(lambda v: "après" in v)
    assert (tmp_path / "ack-1").exists()
    assert e.fermer() == 0
    ecran, fin = e.vu[e.vu.index(ENTREE):e.vu.rindex(SORTIE)], _apres(e.vu, SORTIE)
    assert "Elpis — installation" in ecran and "pip install en cours" in ecran and "/var/log/essai.log" in ecran
    assert "✓ Python" in fin and "1 avertissement" in fin and "– Interface" in fin and "✓ Démarrage" in fin
    assert fin.index("Démarrage") < fin.index("Installation terminée.") < fin.index("Accès : http://x") < fin.index("après")
    assert "pip install en cours" not in fin and CLE not in e.vu


# Repères sans la clé de l'installation (sortie d'un paquet qui les imite) : simple texte ; un second plan ne rouvre pas l'écran.
def test_reperes_imites_sans_effet(tmp_path):
    e = _suivi(tmp_path)
    e.ecrire(R("Étapes : Python", cle="ffffffffffffffff") + "== Étapes : Python ==\n")
    e.attendre(lambda v: "== Étapes : Python ==" in v)
    assert ENTREE not in e.vu
    e.ecrire(R("Étapes : Python", "Étape : Python") + "npm\n" + R("Fin (7)", cle="ffffffffffffffff"))
    e.ecrire(R("Étapes : Python", "Suite de l'installation"))
    e.attendre(lambda v: "npm" in v)
    time.sleep(0.3)
    assert not (tmp_path / "ack-7").exists() and e.vu.count(ENTREE) == 1
    e.ecrire(R("Bilan", "Fin (1)"))
    e.attendre(lambda v: SORTIE in v)
    assert e.fermer() == 0
    assert e.vu.count(SORTIE) == 1


# Entrée close au milieu d'une étape (die, Ctrl-C) : étape en échec, ses dernières lignes et le journal au terminal.
def test_echec_avec_les_dernieres_lignes(tmp_path):
    e = _suivi(tmp_path)
    e.ecrire(R("Étapes : Python | Interface", "Étape : Python", "Étape : Interface") + "rendering chunks...\n"
             "\x1b[1;31m[erreur ]\x1b[0m Frontend non installé (voir ci-dessus).\n")
    e.attendre(lambda v: "rendering chunks" in v)
    assert e.fermer() == 0
    fin = _apres(e.vu, SORTIE)
    assert "✓ Python" in fin and "✗ Interface" in fin and "rendering chunks..." in fin
    assert "Frontend non installé" in fin and "Journal complet : /var/log/essai.log" in fin


# Terminal qui ne dit pas sa taille (0×0 : console série, certains su) : écran dessiné en 80×24.
def test_taille_inconnue_dessinee_en_80_sur_24(tmp_path):
    e = _suivi(tmp_path, taille=(0, 0))
    e.ecrire(R("Étapes : Python", "Étape : Python") + "pip\n")
    e.attendre(lambda v: "Elpis — installation" in v and "pip" in v)
    assert e.fermer() == 0


# Ligne sans fin (barre de progression, sortie binaire) : montrée telle qu'elle avance, jamais plus de 64 Kio en attente.
def test_ligne_sans_fin_bornee(tmp_path):
    e = _suivi(tmp_path)
    e.ecrire(R("Étapes : Image", "Étape : Image") + "téléchargement 42 %")
    e.attendre(lambda v: "téléchargement 42 %" in v)
    debut = time.monotonic()
    for _ in range(512):
        e.ecrire(b"x" * 65536)
        e.lire(0)
    e.ecrire(b"\n" + R("Bilan", "Fin (1)").encode())
    e.attendre(lambda v: (tmp_path / "ack-1").exists(), delai=20)
    assert time.monotonic() - debut < 3
    assert e.fermer() == 0


# Journal déplacé (installation standard) : le chemin annoncé par install.sh à son plan remplace celui du départ.
def test_chemin_du_journal_annonce_au_plan(tmp_path):
    (tmp_path / "journal").write_text("/opt/elpis/logs/install.log", encoding="utf-8")
    e = _suivi(tmp_path)
    e.ecrire(R("Étapes : Python", "Étape : Python") + "pip\n")
    e.attendre(lambda v: "/opt/elpis/logs/install.log" in v)
    assert e.fermer() == 0
    assert "Journal complet : /opt/elpis/logs/install.log" in _apres(e.vu, SORTIE)


# Repère Fin hors bilan (nettoyage d'install.sh après une erreur) : échec aussi, et acquitté.
def test_fin_hors_bilan_vaut_echec(tmp_path):
    e = _suivi(tmp_path)
    e.ecrire(R("Étapes : Base de données", "Étape : Base de données") + "Base inutilisable\n" + R("Fin (3)"))
    e.attendre(lambda v: (tmp_path / "ack-3").exists() and SORTIE in v)
    assert e.fermer() == 0
    assert "✗ Base de données" in _apres(e.vu, SORTIE) and "Base inutilisable" in _apres(e.vu, SORTIE)


# Question à l'écran : terminal rendu (acquitté), rien d'écrit le temps de la question ; la suite rouvre l'écran avec le plan revu.
def test_pause_le_temps_d_une_question(tmp_path):
    e = _suivi(tmp_path)
    e.ecrire(R("Étapes : Base de données | Navigateur | Qdrant", "Étape : Base de données", "Question à l'écran (1)"))
    e.attendre(lambda v: (tmp_path / "ack-1").exists() and SORTIE in v)
    avant = len(e.lire())
    e.ecrire("[ warn  ] Base de données : refusée\n")
    time.sleep(0.4)
    assert len(e.lire()) == avant
    e.ecrire(R("Suite de l'installation", "Étapes : Base de données | Qdrant", "Étape : Qdrant"))
    e.attendre(lambda v: v.count(ENTREE) == 2)
    e.ecrire(R("Bilan", "Fin (2)"))
    e.attendre(lambda v: (tmp_path / "ack-2").exists() and v.count(SORTIE) == 2)
    assert e.fermer() == 0
    fin = _apres(e.vu, SORTIE)
    assert "✓ Base de données" in fin and "1 avertissement" in fin and "✓ Qdrant" in fin and "Navigateur" not in fin


# Sans terminal (pas de /dev/tty) : lignes recopiées, étapes en titres, repères acquittés et jamais affichés.
def test_sans_terminal_tout_est_recopie(tmp_path):
    (tmp_path / "cle").write_text(CLE, encoding="utf-8")
    r = subprocess.run([sys.executable, "-I", str(SUIVI), "--acquit", str(tmp_path)], capture_output=True, text=True,
                       input=R("Étapes : Python", "Étape : Python") + "pip\n" + R("Bilan") + "fin\n" + R("Fin (1)"),
                       env=ENV, timeout=30, start_new_session=True)
    assert r.returncode == 0, r.stderr
    assert "── Python ──" in r.stdout and "pip" in r.stdout and "fin" in r.stdout and CLE not in r.stdout
    assert (tmp_path / "ack-1").exists()


def _bloc_journal() -> str:
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    return texte[texte.index("ecrire_journal() {"):texte.index("# Relance de l'installation standard depuis son dossier")]


# Chaîne d'install.sh (filtre, journal, écran) sous un terminal : journal complet, repères à clé compris ; écran ouvert puis rendu, fin attendue.
def test_chaine_du_journal_d_install_sh(tmp_path):
    journal = tmp_path / "install.log"
    journal.touch()
    script = tmp_path / "essai.sh"
    script.write_text(f'ROOT="{REPO}"; INTERACTIVE=1; PLAIN=0\n' + _bloc_journal() +
                      f'ecrire_journal "{journal}"\nprintf "invite \\033]52;c;QQ==\\007 fin\\n"\n'
                      'echo "== Étapes : Faux ==" ; SUIVI=1; suivi_repere "Étapes : Python"; suivi_etape Python; echo "pip"\n'
                      'suivi_bilan; echo "Installation terminée."; suivi_fin; echo "rc=$?"\n'
                      '[ -e "$SUIVI_ACQUIT/ack-1" ] && echo acquitte\nrm -rf -- "$SUIVI_ACQUIT"\n'
                      'exec >/dev/null 2>&1; wait\n', encoding="utf-8")
    e = Ecran(["bash", str(script)], cwd=tmp_path)
    assert e.fermer() == 0
    assert "acquitte" in e.vu, e.vu[-2000:]
    texte = journal.read_text(encoding="utf-8")
    assert re.search(r"== Étape : Python == \[[0-9a-f]{16}\]", texte) and "pip" in texte and "52;c" not in texte
    assert "Installation terminée." in texte and "== Étapes : Faux ==" in e.vu
    assert e.vu.count(ENTREE) == 1 and "✓ Python" in _apres(e.vu, SORTIE) and "rc=0" in e.vu


# Plan annoncé = étapes de la suite, dans l'ordre où elles passent (install_core à sa place).
def test_plan_conforme_aux_etapes():
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    debut = texte[texte.index("suivi_plan() {"):]
    plan = [n for m in re.finditer(r"\bplan\+?=\((.*)\)", debut[:debut.index("\n}\n")])
            for n in re.findall(r'"([^"]+)"', m.group(1))]
    core = re.search(r"^install_core\(\) \{\n(.*?)^\}", texte, re.S | re.M)
    assert core and plan
    suite = texte[texte.index("\nsuivi_debut\n"):].replace(core.group(0), "")
    suite = suite.replace("\ninstall_core\n", "\n" + core.group(1) + "\n", 1)
    assert re.findall(r'suivi_etape "([^"]+)"', suite) == plan


# Nettoyage : Ctrl-C ignoré, réponses (secrets) retirées avant d'attendre l'écran ; mot de passe que configure écrirait sur /dev/tty : écran rendu.
def test_secrets_avant_l_ecran():
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    nettoyage = texte[texte.index("cleanup() {"):]
    nettoyage = nettoyage[:nettoyage.index("\n}\n")]
    assert nettoyage.index("trap '' INT") < nettoyage.index('rm -rf -- "${ANSWERS%/*}"') < nettoyage.index("suivi_fin")
    assert '[ "${ADMIN_MDP_CONNU:-0}" = 1 ] || suivi_texte\n        "$ROOT/elpis" configure --answers "$ANSWERS"' in texte


# Relance de l'installation standard : Ctrl-C rendu avant exec (ignoré par le nettoyage, il le resterait dans la relance).
def test_ctrl_c_rendu_a_la_relance():
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    relance = texte[texte.index("vers_dossier_standard() {"):]
    relance = relance[:relance.index("\n}\n")]
    assert relance.index("cleanup; trap - EXIT INT") < relance.index("exec bash")
    r = subprocess.run(["bash", "-c", "trap '' INT; trap - EXIT INT; exec grep SigIgn /proc/self/status"],
                       capture_output=True, text=True, timeout=30)
    assert int(r.stdout.split()[1], 16) & 2 == 0, r.stdout


# Écran impossible à préparer (dossier, clé) : rien de posé, rien de laissé.
def test_preparation_tout_ou_rien(tmp_path):
    corps = _bloc_journal() + ('od() { echo abc; }\nsuivi_preparer; echo "rc=$? [$SUIVI_ACQUIT][$SUIVI_CLE]"\n'
                               'unset -f od; suivi_preparer; echo "rc=$? ${#SUIVI_CLE}"; [ -s "$SUIVI_ACQUIT/cle" ] && echo cle\n')
    r = subprocess.run(["bash", "-c", corps], capture_output=True, text=True, timeout=30,
                       env={**ENV, "TMPDIR": str(tmp_path)})
    assert "rc=1 [][]" in r.stdout and "rc=0 16" in r.stdout and "cle" in r.stdout, r.stdout + r.stderr
    assert len(list(tmp_path.iterdir())) == 1


# Repère collé à une ligne inachevée (Ctrl-C pendant une barre de progression) : reconnu, le début de ligne gardé.
def test_repere_colle_a_une_ligne_inachevee(tmp_path):
    e = _suivi(tmp_path)
    e.ecrire(R("Étapes : Python", "Étape : Python") + "\r━━ 45 %")
    e.attendre(lambda v: "━━ 45 %" in v)
    e.ecrire(R("Fin (1)"))
    e.attendre(lambda v: (tmp_path / "ack-1").exists() and SORTIE in v)
    assert e.fermer() == 0
    fin = _apres(e.vu, SORTIE)
    assert "✗ Python" in fin and "━━ 45 %" in fin and CLE not in e.vu


# Suite en texte (mot de passe que configure écrirait sur /dev/tty) : écran quitté, étapes passées laissées, la suite recopiée sans écran.
def test_suite_en_texte(tmp_path):
    e = _suivi(tmp_path)
    e.ecrire(R("Étapes : Python | Configuration | Démarrage", "Étape : Python", "Étape : Configuration") + "conf\n"
             + R("Texte (1)"))
    e.attendre(lambda v: (tmp_path / "ack-1").exists() and SORTIE in v)
    e.ecrire("Mot de passe affiché\n" + R("Étape : Démarrage") + "services\n" + R("Bilan") + "Installation terminée.\n"
             + R("Fin (2)"))
    e.attendre(lambda v: (tmp_path / "ack-2").exists() and "Installation terminée." in v)
    assert e.fermer() == 0
    fin = _apres(e.vu, SORTIE)
    assert e.vu.count(ENTREE) == 1 and "✓ Python" in fin and "▸ Configuration" in fin and "· Démarrage" in fin
    assert fin.index("▸ Configuration") < fin.index("Mot de passe affiché") < fin.index("── Démarrage ──")
    assert fin.index("── Démarrage ──") < fin.index("services") < fin.index("Installation terminée.") and CLE not in e.vu


# Réponses de l'assistant : mot de passe administrateur connu d'avance (saisi ou généré) ou non (réinstallation, champ vide).
def test_mot_de_passe_connu_exporte(tmp_path):
    for reponses, connu in (({"admin_password": "x" * 12}, "1"), ({}, "0")):
        f = tmp_path / f"r{connu}.json"
        f.write_text(json.dumps({"install": {"DB_MODE": "sqlite"}, "answers": reponses, "admin_generated": ""}),
                     encoding="utf-8")
        f.chmod(0o600)
        r = subprocess.run([sys.executable, str(REPO / "deploy/wizard.py"), "export-sh", str(f)],
                           capture_output=True, text=True, timeout=30)
        assert r.returncode == 0 and f"ADMIN_MDP_CONNU={connu}" in r.stdout.splitlines(), r.stdout + r.stderr
