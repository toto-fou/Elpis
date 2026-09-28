# SPDX-License-Identifier: MIT
"""
tests/load/metrics.py — collecte et lecture des mesures d'une campagne.

Trois principes :

- **On garde toutes les latences**, pas des moyennes glissantes. Sous charge,
  la moyenne ment : ce sont p95/p99/max qui disent si un utilisateur a attendu.
- **Les échecs sont classés, jamais comptés en bloc.** « 3 % d'erreurs » ne
  se corrige pas ; « 14 × database is locked » se corrige.
- **Les ressources sont échantillonnées pendant la course.** Une fuite de
  descripteurs ou de threads ne se voit pas dans les latences, seulement dans
  la pente entre le début et la fin.
"""
from __future__ import annotations

import math
import statistics
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Optional


def percentile(valeurs: list[float], p: float) -> float:
    """Percentile par interpolation linéaire. ``valeurs`` doit être triée."""
    if not valeurs:
        return float("nan")
    if len(valeurs) == 1:
        return valeurs[0]
    rang = (len(valeurs) - 1) * p
    bas = math.floor(rang)
    haut = math.ceil(rang)
    if bas == haut:
        return valeurs[bas]
    return valeurs[bas] + (valeurs[haut] - valeurs[bas]) * (rang - bas)


def classer_echec(exc: BaseException | None, statut: int | None, corps: str = "") -> str:
    """Range un échec dans une famille ACTIONNABLE.

    Le libellé est ce qu'on lira dans le rapport : il doit désigner une cause,
    pas un symptôme. « database is locked » et « 500 » ne se corrigent pas au
    même endroit, même quand le second est causé par le premier.
    """
    if exc is not None:
        nom = type(exc).__name__
        texte = str(exc).lower()
        if "timeout" in nom.lower() or "timeout" in texte:
            return "délai dépassé (le serveur n'a pas répondu)"
        if "connect" in nom.lower() or "connection" in texte:
            return "connexion refusée/coupée (backlog plein ou worker mort)"
        return f"exception client : {nom}"
    corps_bas = (corps or "").lower()
    if "database is locked" in corps_bas or "database table is locked" in corps_bas:
        return "SQLite : database is locked (contention d'écriture)"
    if statut == 429:
        return "429 (limitation de débit)"
    if statut == 503:
        return "503 (service indisponible / arrêt en cours)"
    if statut and 500 <= statut < 600:
        return f"{statut} (erreur serveur)"
    if statut == 409:
        return "409 (conflit : verrou de présence)"
    if statut and 400 <= statut < 500:
        return f"{statut} (rejet client)"
    return f"statut inattendu : {statut}"


@dataclass
class Serie:
    """Les temps de réponse d'un même geste (ex. « ouvrir un chat »)."""
    nom: str
    latences_ms: list[float] = field(default_factory=list)
    echecs: Counter = field(default_factory=Counter)
    octets: int = 0

    def ajouter(self, debut: float, statut: int | None,
                exc: BaseException | None = None, corps: str = "",
                octets: int = 0) -> None:
        self.latences_ms.append((time.perf_counter() - debut) * 1000.0)
        self.octets += octets
        if exc is not None or statut is None or statut >= 400:
            self.echecs[classer_echec(exc, statut, corps)] += 1

    @property
    def total(self) -> int:
        return len(self.latences_ms)

    @property
    def nb_echecs(self) -> int:
        return sum(self.echecs.values())

    def resume(self, duree_s: float) -> dict:
        v = sorted(self.latences_ms)
        return {
            "nom": self.nom,
            "n": self.total,
            "echecs": self.nb_echecs,
            "taux_echec_pct": round(100 * self.nb_echecs / self.total, 2) if self.total else 0.0,
            "debit_par_s": round(self.total / duree_s, 1) if duree_s > 0 else 0.0,
            "p50_ms": round(percentile(v, 0.50), 1),
            "p95_ms": round(percentile(v, 0.95), 1),
            "p99_ms": round(percentile(v, 0.99), 1),
            "max_ms": round(v[-1], 1) if v else 0.0,
            "moy_ms": round(statistics.fmean(v), 1) if v else 0.0,
            "familles": dict(self.echecs),
        }


@dataclass
class Campagne:
    """L'ensemble des séries d'un scénario, plus les sondes de ressources."""
    scenario: str
    series: dict[str, Serie] = field(default_factory=dict)
    sondes: list[dict] = field(default_factory=list)
    debut: float = field(default_factory=time.perf_counter)
    fin: Optional[float] = None
    notes: list[str] = field(default_factory=list)

    def serie(self, nom: str) -> Serie:
        return self.series.setdefault(nom, Serie(nom))

    def noter(self, texte: str) -> None:
        self.notes.append(texte)

    def echantillonner(self, instance) -> None:
        self.sondes.append({
            "t": round(time.perf_counter() - self.debut, 2),
            **instance.sonde_process(), **instance.sonde_base(),
        })

    def cloturer(self) -> None:
        self.fin = time.perf_counter()

    @property
    def duree_s(self) -> float:
        return (self.fin or time.perf_counter()) - self.debut

    CLES_RESSOURCES = ("rss_mo", "fds", "threads", "db_mo", "wal_mo")

    def _ecart(self, a: dict, b: dict) -> dict:
        return {cle: round(b[cle] - a[cle], 2) for cle in self.CLES_RESSOURCES
                if cle in a and cle in b}

    def derive_ressources(self) -> dict:
        """Pente sur la **seconde moitié** du scénario.

        Surtout pas l'écart entre le premier et le dernier échantillon : la
        montée en charge en fait toujours un gros chiffre. Mesuré ici sur une
        course de 150 s en lecture, le RSS monte de 439 à 507 Mo dans les
        12 premières secondes (pool de threads qui s'étoffe, connexions,
        caches), puis se fige à 541 Mo pour le reste — 76,6 Mo/min sur la
        première moitié, 3,7 Mo/min sur la seconde.

        Prendre l'écart total, c'est donc annoncer une fuite à chaque
        campagne. La seconde moitié, elle, décrit un régime établi : ce qui y
        monte encore monte vraiment.
        """
        if len(self.sondes) < 4:
            return {}
        milieu = self.sondes[len(self.sondes) // 2]
        return self._ecart(milieu, self.sondes[-1])

    def cpu(self) -> dict:
        """Occupation CPU du serveur pendant le scénario. Le premier
        échantillon est jeté : ``cpu_percent`` n'a pas encore de référence."""
        valeurs = [s["cpu_pct"] for s in self.sondes[1:] if "cpu_pct" in s]
        if not valeurs:
            return {}
        return {"median_pct": round(statistics.median(valeurs), 1),
                "max_pct": round(max(valeurs), 1)}

    def montee_en_charge(self) -> dict:
        """Écart sur la première moitié — la mise en régime, pour information."""
        if len(self.sondes) < 4:
            return {}
        return self._ecart(self.sondes[0], self.sondes[len(self.sondes) // 2])

    def json(self) -> dict:
        return {
            "scenario": self.scenario,
            "duree_s": round(self.duree_s, 2),
            "series": [s.resume(self.duree_s) for s in self.series.values()],
            "ressources_debut": self.sondes[0] if self.sondes else {},
            "ressources_fin": self.sondes[-1] if self.sondes else {},
            "montee_en_charge": self.montee_en_charge(),
            "cpu": self.cpu(),
            "derive": self.derive_ressources(),
            "notes": self.notes,
        }


def rendre(campagne: Campagne) -> str:
    """Rapport texte, lisible dans un terminal."""
    d = campagne.json()
    lignes = [f"── {d['scenario']}  ({d['duree_s']} s) " + "─" * 28,
              f"  {'geste':<28} {'n':>6} {'éch.':>5} {'req/s':>7} "
              f"{'p50':>7} {'p95':>8} {'p99':>8} {'max':>8}"]
    for s in d["series"]:
        lignes.append(
            f"  {s['nom']:<28} {s['n']:>6} {s['echecs']:>5} {s['debit_par_s']:>7} "
            f"{s['p50_ms']:>7} {s['p95_ms']:>8} {s['p99_ms']:>8} {s['max_ms']:>8}")
    familles: Counter = Counter()
    for s in d["series"]:
        familles.update(s["familles"])
    if familles:
        lignes.append("  échecs par famille :")
        for nom, n in familles.most_common():
            lignes.append(f"    {n:>6} × {nom}")
    if d.get("montee_en_charge"):
        m = "  ".join(f"{k} {v:+g}" for k, v in d["montee_en_charge"].items())
        lignes.append(f"  montée en régime (1re moitié) : {m}")
    if d["derive"]:
        derive = "  ".join(f"{k} {v:+g}" for k, v in d["derive"].items())
        lignes.append(f"  dérive en régime établi (2e moitié) : {derive}")
    if d["ressources_fin"]:
        f = d["ressources_fin"]
        lignes.append(f"  à la fin : RSS {f.get('rss_mo')} Mo | {f.get('fds')} fd | "
                      f"{f.get('threads')} threads | {f.get('process')} process | "
                      f"WAL {f.get('wal_mo')} Mo")
    if d.get("cpu"):
        c = d["cpu"]
        lignes.append(f"  CPU du serveur : médiane {c['median_pct']} % | "
                      f"pic {c['max_pct']} % (100 % = machine entière)")
    for note in d["notes"]:
        lignes.append(f"  ▸ {note}")
    return "\n".join(lignes)
