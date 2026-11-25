# SPDX-License-Identifier: MIT
"""deploy/suivi.py — sortie d'install.sh vers le terminal : recopiée octet pour octet, ou écran de suivi (étapes, barre, dernières lignes) entre ses repères « == … == [clé] »."""
from __future__ import annotations

import argparse
import hmac
import os
import re
import select
import signal
import sys
import termios
import time
from collections import deque
from pathlib import Path
from typing import Deque, List, Optional, Tuple

# En fin de chemin : la bibliothèque standard d'abord (deploy/ revient au compte de l'application en cours d'installation).
sys.path.append(str(Path(__file__).resolve().parent))
import tui as T  # noqa: E402

REPERE = re.compile(r"== (.*) == \[([0-9a-f]{16})\]")
PLAN, ETAPE = re.compile(r"Étapes : (.*)"), re.compile(r"Étape : (.*)")
PAUSE, FIN = re.compile(r"Question à l'écran \((\d+)\)"), re.compile(r"Fin \((\d+)\)")
SUITE, BILAN = "Suite de l'installation", "Bilan"
ALERTE = re.compile(r"\[ *(warn|erreur) *\]")
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
LIGNE_MAX = 65536


def duree(s: float) -> str:
    """Durée lisible : 38 s, 2 min 05 s, 1 h 03 min."""
    s = int(s)
    if s < 60:
        return f"{s} s"
    if s < 3600:
        return f"{s // 60} min {s % 60:02d} s"
    return f"{s // 3600} h {s % 3600 // 60:02d} min"


def visible(ligne: bytes) -> str:
    """Texte affiché d'une ligne : sans séquences, après son dernier retour chariot, tabulations en espaces."""
    return ANSI.sub("", ligne.decode("utf-8", "replace")).rstrip("\r").rsplit("\r", 1)[-1].expandtabs(4)


def lire(dossier: str, nom: str) -> str:
    try:
        return Path(dossier, nom).read_text(encoding="utf-8").strip() if dossier else ""
    except (OSError, UnicodeDecodeError):
        return ""


class Etape:
    def __init__(self, nom: str) -> None:
        self.nom, self.etat, self.debut, self.fin, self.alertes = nom, "attente", 0.0, 0.0, 0


class Suivi:
    """Flux d'install.sh : recopié (copie), dessiné sur /dev/tty (ecran, bilan) ou gardé le temps d'une question (pause)."""

    def __init__(self, journal: str, acquit: str) -> None:
        self.journal, self.acquit = journal, acquit
        self.cle = lire(acquit, "cle")                 # sans clé lisible, aucun repère : tout est recopié
        self.mode = "copie"
        self.secours = False                           # écran impossible : lignes recopiées, repères appliqués
        self.etapes: List[Etape] = []
        self.courante: Optional[Etape] = None
        self.lignes: Deque[bytes] = deque(maxlen=400)
        self.bilan: List[bytes] = []
        self.debut = 0.0
        self.term: Optional[T.Terminal] = None
        self.g, self.color, self.unicode = T.Glyphs(True), "NO_COLOR" not in os.environ, True
        self.reste = b""
        self.dessin, self.sale = 0.0, True

    # ── flux ─────────────────────────────────────────────────────────────────
    def morceau(self, d: bytes) -> None:
        """Lignes complètes traitées ; une fin de ligne passe aussitôt en copie (invite), sauf si elle peut être un repère ; LIGNE_MAX en attente au plus."""
        d, self.reste = self.reste + d, b""
        *completes, fin = d.split(b"\n")
        for ligne in completes:
            self.ligne(ligne)
        if not fin:
            return
        if self.recopie() and not b"== ".startswith(fin[:3]):
            self.sortie(fin)
        elif len(fin) > LIGNE_MAX:
            self.ligne(fin)
        else:
            self.reste = fin

    def recopie(self) -> bool:
        return self.mode == "copie" or (self.secours and self.mode != "pause")

    def repere(self, ligne: bytes) -> Optional[str]:
        """Contenu d'un repère d'install.sh (avec la clé de cette installation), sinon None."""
        if not self.cle or not ligne.startswith(b"== "):
            return None
        m = REPERE.fullmatch(visible(ligne))
        return m.group(1) if m and hmac.compare_digest(m.group(2), self.cle) else None

    def ligne(self, ligne: bytes) -> None:
        """Une ligne : repère appliqué, sinon recopiée ou gardée pour l'écran."""
        r = self.repere(ligne)
        if r is None:
            return self.texte(ligne)
        if m := PLAN.fullmatch(r):
            return self.planifier([n for n in m.group(1).split(" | ") if n])
        if self.mode == "copie":
            return None
        if m := ETAPE.fullmatch(r):
            return self.etape(m.group(1))
        if m := PAUSE.fullmatch(r):
            self.quitter_ecran()
            self.mode = "pause"
            return self.acquitter(m.group(1))
        if r == SUITE:
            self.mode = "ecran"
            return self.entrer_ecran()
        if r == BILAN:
            self.terminer_courante("ok")
            self.mode = "bilan"
        elif m := FIN.fullmatch(r):
            self.finir(echec=self.mode != "bilan")
            self.acquitter(m.group(1))
        return None

    def texte(self, ligne: bytes) -> None:
        if self.mode == "copie":
            return self.sortie(ligne + b"\n")
        (self.bilan if self.mode == "bilan" else self.lignes).append(ligne)
        if self.courante and ALERTE.match(visible(ligne)):
            self.courante.alertes += 1
        if self.recopie():
            self.sortie(ligne + b"\n")
        self.sale = True
        return None

    def sortie(self, d: "bytes | str") -> None:
        """Vers le terminal : octets tels quels, texte dans l'encodage du terminal (caractère impossible remplacé)."""
        if isinstance(d, str):
            d = d.encode(sys.stdout.encoding or "utf-8", "replace")
        try:
            sys.stdout.buffer.write(d)
            sys.stdout.buffer.flush()
        except (OSError, ValueError):
            pass

    def acquitter(self, n: str) -> None:
        """Repère attendu par install.sh : fichier ack-N dans son dossier."""
        if self.acquit:
            try:
                Path(self.acquit, f"ack-{n}").touch()
            except OSError:
                pass

    # ── étapes ───────────────────────────────────────────────────────────────
    def planifier(self, plan: List[str]) -> None:
        """Plan annoncé : écran ouvert ; plan revu (réglages changés en route) : étapes déjà passées gardées."""
        anciennes = {e.nom: e for e in self.etapes}
        self.etapes = [anciennes.get(n) or Etape(n) for n in plan]
        self.etapes += [e for e in anciennes.values() if e not in self.etapes and e.debut]
        self.journal = lire(self.acquit, "journal") or self.journal
        self.sale = True
        if self.mode == "copie":
            self.debut, self.mode = time.monotonic(), "ecran"
            self.entrer_ecran()

    def etape(self, nom: str) -> None:
        """Étape suivante : la courante finie, celles du plan passées sans repère marquées sautées."""
        self.terminer_courante("ok")
        e = next((x for x in self.etapes if x.nom == nom), None)
        if e is None:
            e = Etape(nom)
            self.etapes.append(e)
        for avant in self.etapes[:self.etapes.index(e)]:
            if avant.etat == "attente":
                avant.etat = "sautee"
        e.etat, e.debut = "cours", time.monotonic()
        self.courante = e
        self.lignes.clear()
        self.sale = True
        if self.secours:
            self.sortie(T.render_line([(f"── {nom} ──", "b")], 200, self.color) + "\n")

    def terminer_courante(self, etat: str) -> None:
        if self.courante and self.courante.etat == "cours":
            self.courante.etat, self.courante.fin = etat, time.monotonic()
        self.courante = None if etat == "ok" else self.courante

    def finir(self, echec: bool) -> None:
        """Fin du suivi : écran quitté ; dans le terminal, les étapes puis le bilan, ou en échec les dernières lignes et le journal."""
        if echec:
            self.terminer_courante("echec")
        self.quitter_ecran()
        if self.etapes:
            self.sortie("\n" + "\n".join(self.recap(200)) + "\n")
        if not self.secours:
            if echec:
                self.sortie(b"\n" + b"\n".join(list(self.lignes)[-30:] + ([self.reste] if self.reste else [])) + b"\n")
                if self.journal:
                    self.sortie(f"\n  Journal complet : {self.journal}\n")
            elif self.bilan:
                self.sortie(b"\n".join(self.bilan) + b"\n")
        self.etapes, self.courante, self.mode = [], None, "copie"

    def recap(self, w: int) -> List[str]:
        """Étapes, une par ligne : icône, nom, durée, avertissements."""
        out = []
        for e in self.etapes:
            icone, style = self.icone(e)
            fin = e.fin or time.monotonic()
            temps = duree(fin - e.debut) if e.debut else ""
            alerte = f"   {e.alertes} avertissement{'s' if e.alertes > 1 else ''}" if e.alertes else ""
            out.append(T.render_line([(f"  {icone} ", style), (f"{e.nom:<30} ", "" if e.debut else "d"),
                                      (temps, "d"), (alerte, "w")], w, self.color))
        return out

    def icone(self, e: Etape) -> Tuple[str, str]:
        g = self.g
        if e.etat == "cours":
            return g.spin[int(time.monotonic() * 8) % len(g.spin)], "a"
        return {"ok": (g.done, "g"), "echec": (g.bad, "e"),
                "sautee": ("–" if self.unicode else "-", "d")}.get(e.etat, (g.todo, "d"))

    # ── écran ────────────────────────────────────────────────────────────────
    def entrer_ecran(self) -> None:
        """Écran alternatif sur /dev/tty (écho coupé, Ctrl-C gardé), une fois ; impossible, les lignes sont recopiées."""
        if self.secours or self.term:
            return
        try:
            term = T.Terminal()
            term.__enter__()
        except Exception:
            self.secours = True
            return
        self.term, self.unicode, self.color = term, term.unicode, term.color
        self.g, self.sale = T.Glyphs(term.unicode), True

    def quitter_ecran(self) -> None:
        """Terminal rendu tel qu'il était ; les touches tapées sous l'écran sont jetées (elles répondraient à la question suivante)."""
        if self.term:
            term, self.term = self.term, None
            try:
                termios.tcflush(term.fd, termios.TCIFLUSH)
                term.__exit__(None, None, None)
            except Exception:
                pass

    def suspendre(self, *_a) -> None:
        """Ctrl-Z : terminal rendu avant l'arrêt, écran rouvert à la reprise."""
        ouvert = self.term is not None
        self.quitter_ecran()
        signal.signal(signal.SIGTSTP, signal.SIG_DFL)
        os.kill(os.getpid(), signal.SIGTSTP)
        signal.signal(signal.SIGTSTP, self.suspendre)
        if ouvert and self.mode in ("ecran", "bilan"):
            self.entrer_ecran()

    def dessiner(self) -> None:
        """Image complète, huit fois par seconde au plus (taille inconnue, 0×0 : 80×24) ; un dessin en panne rend la main à la copie."""
        if not self.term:
            return
        maintenant = time.monotonic()
        if maintenant - self.dessin < 0.12 or not (self.sale or maintenant - self.dessin >= 0.25):
            return
        try:
            w, h = self.term.size()
            w, h = w or 80, h or 24
            efface = "\x1b[2J" if self.term.resized else ""
            self.term.resized = False
            self.term.write(efface + "\x1b[H" + "\x1b[K\r\n".join(self.image(w, h)) + "\x1b[K\x1b[J")
        except Exception:
            self.quitter_ecran()
            self.secours = True
            self.sortie(b"\n".join(list(self.lignes)[-30:]) + b"\n")
        self.dessin, self.sale = maintenant, False

    def image(self, w: int, h: int) -> List[str]:
        """Titre et barre, étapes (fenêtre autour de la courante si la place manque), dernières lignes, pied."""
        c, r = self.color, T.render_line
        faites = sum(e.etat in ("ok", "sautee") for e in self.etapes)
        total = max(1, len(self.etapes))
        compte = f" {faites}/{total} · {duree(time.monotonic() - self.debut)} "
        if h < 6 or w < 30:
            return [r([(" Elpis —" + compte, "b")], w, c)]
        large = max(10, w - len(compte) - 3)
        plein = large * faites // total
        barre = ("█" * plein + "░" * (large - plein)) if self.unicode else ("#" * plein + "-" * (large - plein))
        tete = [r([(" Elpis — installation", "b")], w, c), r([("  " + barre, "a"), (compte, "d")], w, c), ""]
        pied = [r([(" Journal : " + self.journal + "  ·  " if self.journal else " ", "d"), ("Ctrl+C : interrompre", "d")], w, c)]
        place = h - len(tete) - len(pied)
        etapes = self.recap(w)
        rang = min(len(etapes), max(1, place - 4))
        if len(etapes) > rang:
            i = next((k for k, e in enumerate(self.etapes) if e.etat == "cours"), faites)
            haut = max(0, min(i - rang // 2, len(etapes) - rang))
            etapes = etapes[haut:haut + rang]
        corps = etapes + [""]
        reste = place - len(corps) - 1
        if reste > 0:
            nom = self.courante.nom if self.courante else ("Bilan" if self.mode == "bilan" else "")
            corps.append(r([(f"  {nom}", "d")], w, c))
            source = list(self.bilan if self.mode == "bilan" else self.lignes) + ([self.reste] if self.reste else [])
            for ligne in source[-reste:]:
                corps.append(r([("    " + visible(ligne), "d")], w, c))
        corps = corps[:place]
        return tete + corps + [""] * (place - len(corps)) + pied


def main(argv: Optional[List[str]] = None) -> int:
    """Entrée lue jusqu'à sa fin, Ctrl-C ignoré (install.sh dit lui-même comment il s'arrête) ; fin sans repère : étape en échec."""
    ap = argparse.ArgumentParser(prog="deploy/suivi.py")
    ap.add_argument("--journal", default="")
    ap.add_argument("--acquit", default="")
    a = ap.parse_args(argv)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    s = Suivi(a.journal, a.acquit)
    signal.signal(signal.SIGTSTP, s.suspendre)
    while True:
        prets = select.select([0], [], [], 0.25 if s.term else None)[0]
        if prets:
            d = os.read(0, 65536)
            if not d:
                break
            s.morceau(d)
        s.dessiner()
    if s.reste:
        s.ligne(s.reste)
        s.reste = b""
    if s.mode != "copie":
        s.finir(echec=s.mode != "bilan")
    return 0


if __name__ == "__main__":
    sys.exit(main())
