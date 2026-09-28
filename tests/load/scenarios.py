# SPDX-License-Identifier: MIT
"""
tests/load/scenarios.py — ce qu'on met sous pression, et pourquoi.

Chaque scénario cible **un mécanisme partagé** dont on suspecte qu'il se
comporte mal quand plusieurs utilisateurs arrivent en même temps. Un scénario
qui ne cible rien de partagé ne mesure que la vitesse d'un cœur de CPU.

    | scénario | mécanisme partagé mis sous tension |
    |---|---|
    | ``connexion``  | la boucle d'événements du worker (CPU dans un handler async) |
    | ``lecture``    | le cache de config, le pool SQLite, l'assemblage des pages |
    | ``ecriture``   | le verrou d'écriture SQLite — **unique pour tous les workers** |
    | ``fichiers``   | le disque local : parcours d'arborescence, grep, mémoire |
    | ``evenements`` | le bus d'événements sur fichier et ses abonnés SSE |
    | ``mixte``      | tout à la fois, dans des proportions plausibles |

Le témoin
---------
Tous les scénarios font tourner en parallèle un **témoin** : un client déjà
authentifié qui appelle ``/api/me-lite`` toutes les 50 ms. C'est la mesure la
plus importante du harnais. Elle ne dit pas « le geste sous charge est lent »
mais « **les autres utilisateurs ont-ils subi la charge de celui-là** ».

Un p99 témoin qui explose pendant une rafale de connexions, c'est un handler
``async`` qui fait du CPU sur la boucle. Un p99 témoin qui explose pendant des
écritures, c'est une transaction qui tient le verrou trop longtemps. Sans le
témoin, les deux se ressemblent : « ça rame ».
"""
from __future__ import annotations

import asyncio
import json
import random
import time
from typing import Awaitable, Callable, Optional

import httpx

from .instance import MOT_DE_PASSE, Instance
from .metrics import Campagne

# Un client de charge ne doit jamais attendre indéfiniment : un geste qui
# dépasse ce délai est un échec, pas une latence.
DELAI_S = 30.0


async def connecter(inst: Instance, nom: str) -> httpx.AsyncClient:
    """Client authentifié, cookie de session en place."""
    cl = httpx.AsyncClient(base_url=inst.url, timeout=DELAI_S)
    r = await cl.post("/api/login-lite", json={"username": nom, "password": MOT_DE_PASSE})
    if r.status_code != 200:
        await cl.aclose()
        raise RuntimeError(f"connexion impossible pour {nom} : {r.status_code} {r.text[:200]}")
    return cl


async def _mesurer(campagne: Campagne, geste: str, appel: Callable[[], Awaitable]) -> Optional[httpx.Response]:
    """Chronomètre un geste et range son issue dans la bonne famille."""
    serie = campagne.serie(geste)
    debut = time.perf_counter()
    try:
        r = await appel()
    except BaseException as exc:            # noqa: BLE001 — on classe, on ne masque pas
        if isinstance(exc, asyncio.CancelledError):
            raise
        serie.ajouter(debut, None, exc=exc)
        return None
    serie.ajouter(debut, r.status_code, corps=r.text[:400] if r.status_code >= 400 else "",
                  octets=len(r.content))
    return r


async def _temoin(inst: Instance, campagne: Campagne, stop: asyncio.Event) -> None:
    """Un utilisateur ordinaire, qui ne fait rien de lourd, pendant la charge."""
    cl = await connecter(inst, inst.comptes[0])
    try:
        while not stop.is_set():
            await _mesurer(campagne, "témoin /api/me-lite",
                           lambda: cl.get("/api/me-lite"))
            await asyncio.sleep(0.05)
    finally:
        await cl.aclose()


async def _sondeur(inst: Instance, campagne: Campagne, stop: asyncio.Event,
                   periode: float = 1.0) -> None:
    campagne.echantillonner(inst)
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=periode)
        except asyncio.TimeoutError:
            pass
        campagne.echantillonner(inst)


async def _courir(inst: Instance, campagne: Campagne, duree: float,
                  travailleurs: list[Callable[[], Awaitable]],
                  avec_temoin: bool = True) -> Campagne:
    """Lance les travailleurs, le témoin et le sondeur ; arrête tout à l'heure dite."""
    stop = asyncio.Event()
    auxiliaires = [asyncio.create_task(_sondeur(inst, campagne, stop))]
    if avec_temoin:
        auxiliaires.append(asyncio.create_task(_temoin(inst, campagne, stop)))

    async def borne(fn):
        try:
            while not stop.is_set():
                await fn()
        except asyncio.CancelledError:
            raise

    taches = [asyncio.create_task(borne(f)) for f in travailleurs]
    try:
        await asyncio.sleep(duree)
    finally:
        stop.set()
        for t in taches:
            t.cancel()
        await asyncio.gather(*taches, return_exceptions=True)
        await asyncio.gather(*auxiliaires, return_exceptions=True)
    campagne.cloturer()
    return campagne


# ── connexion ───────────────────────────────────────────────────────────────

async def connexion(inst: Instance, *, utilisateurs: int = 12, duree: float = 20.0) -> Campagne:
    """Rafale de connexions — le geste le plus coûteux en CPU de l'application.

    PBKDF2 à 150 000 itérations coûte 87 ms. Tant qu'il s'exécutait sur la
    boucle d'événements, chaque connexion gelait le worker entier : c'est le
    **témoin** qui le montre, pas la latence des connexions elles-mêmes.
    """
    campagne = Campagne("connexion")
    campagne.noter(f"{utilisateurs} clients enchaînent des connexions pendant {duree:.0f} s ; "
                   "le témoin mesure ce que subissent les autres utilisateurs")

    clients = [httpx.AsyncClient(base_url=inst.url, timeout=DELAI_S) for _ in range(utilisateurs)]

    def travail(cl: httpx.AsyncClient, nom: str):
        async def _f():
            await _mesurer(campagne, "POST /api/login-lite",
                           lambda: cl.post("/api/login-lite",
                                           json={"username": nom, "password": MOT_DE_PASSE}))
        return _f

    try:
        return await _courir(inst, campagne, duree,
                             [travail(cl, inst.comptes[i % len(inst.comptes)])
                              for i, cl in enumerate(clients)])
    finally:
        await asyncio.gather(*(c.aclose() for c in clients), return_exceptions=True)


async def connexion_refusee(inst: Instance, *, utilisateurs: int = 12,
                            duree: float = 15.0) -> Campagne:
    """Mêmes rafales, mais avec de **mauvais** mots de passe.

    C'est le cas qui compte pour la disponibilité : la limitation de débit sur
    le login a été retirée volontairement (déléguée à l'ACL réseau), donc rien
    n'empêche un tiers d'envoyer ces requêtes. Un échec d'authentification
    coûte exactement le même PBKDF2 qu'une réussite.
    """
    campagne = Campagne("connexion refusée (bourrage d'identifiants)")
    campagne.noter("mots de passe faux : même coût CPU qu'une connexion valide, "
                   "et aucune limitation de débit devant")
    clients = [httpx.AsyncClient(base_url=inst.url, timeout=DELAI_S) for _ in range(utilisateurs)]

    def travail(cl, nom):
        async def _f():
            r = await _mesurer(campagne, "POST /api/login-lite (401 attendu)",
                               lambda: cl.post("/api/login-lite",
                                               json={"username": nom, "password": "mauvais"}))
            # 401 est le résultat NORMAL ici : on le retire des échecs, sinon
            # le rapport confondrait « rejeté » et « cassé ».
            if r is not None and r.status_code == 401:
                s = campagne.serie("POST /api/login-lite (401 attendu)")
                s.echecs["401 (rejet client)"] -= 1
                if s.echecs["401 (rejet client)"] <= 0:
                    del s.echecs["401 (rejet client)"]
        return _f

    try:
        return await _courir(inst, campagne, duree,
                             [travail(cl, inst.comptes[i % len(inst.comptes)])
                              for i, cl in enumerate(clients)])
    finally:
        await asyncio.gather(*(c.aclose() for c in clients), return_exceptions=True)


# ── lecture ─────────────────────────────────────────────────────────────────

async def lecture(inst: Instance, *, utilisateurs: int = 16, duree: float = 20.0) -> Campagne:
    """Le régime ordinaire : ouvrir l'application, lister, ouvrir un chat."""
    campagne = Campagne("lecture")
    campagne.noter(f"{utilisateurs} utilisateurs enchaînent page d'accueil, liste et ouverture de chat")
    clients = [await connecter(inst, inst.comptes[i % len(inst.comptes)])
               for i in range(utilisateurs)]

    # Chaque utilisateur a besoin d'un chat à ouvrir.
    chats: list[str] = []
    for cl in clients:
        r = await cl.post("/api/saved/chats/new")
        chats.append(r.json()["id"] if r.status_code == 200 else "")

    def travail(cl, cid):
        async def _f():
            await _mesurer(campagne, "GET / (page)", lambda: cl.get("/"))
            await _mesurer(campagne, "GET /api/public-config", lambda: cl.get("/api/public-config"))
            await _mesurer(campagne, "GET /api/saved/chats", lambda: cl.get("/api/saved/chats"))
            if cid:
                await _mesurer(campagne, "GET /api/saved/chats/{id}",
                               lambda: cl.get(f"/api/saved/chats/{cid}"))
        return _f

    try:
        return await _courir(inst, campagne, duree,
                             [travail(cl, cid) for cl, cid in zip(clients, chats)])
    finally:
        await asyncio.gather(*(c.aclose() for c in clients), return_exceptions=True)


# ── ecriture ────────────────────────────────────────────────────────────────

async def ecriture(inst: Instance, *, utilisateurs: int = 12, duree: float = 20.0,
                   messages_par_chat: int = 40) -> Campagne:
    """Écritures concurrentes — le verrou d'écriture SQLite est **unique**.

    ``save-messages`` réécrit le blob ``messages_json`` ENTIER à chaque appel :
    c'est le geste d'écriture le plus lourd de l'application, et le streaming
    l'appelle en continu. On fait grossir les conversations pendant la course
    pour voir si le coût dérive avec la taille.
    """
    campagne = Campagne("écriture")
    campagne.noter(f"{utilisateurs} utilisateurs réécrivent des conversations de "
                   f"{messages_par_chat} messages ; verrou d'écriture SQLite partagé")
    clients = [await connecter(inst, inst.comptes[i % len(inst.comptes)])
               for i in range(utilisateurs)]
    chats = []
    for cl in clients:
        r = await cl.post("/api/saved/chats/new")
        chats.append(r.json()["id"] if r.status_code == 200 else "")

    corpus = ("Réponse de l'assistant. " * 40).strip()

    def travail(cl, cid, graine):
        etat = {"n": 1}

        async def _f():
            if not cid:
                await asyncio.sleep(0.05)
                return
            n = min(etat["n"], messages_par_chat)
            etat["n"] += 1
            msgs = [{"role": "user" if k % 2 == 0 else "assistant",
                     "content": f"[{graine}-{k}] {corpus}"} for k in range(n)]
            await _mesurer(campagne, "PUT save-messages",
                           lambda: cl.put(f"/api/saved/chats/{cid}/save-messages",
                                          json={"messages": msgs, "title": f"charge {graine}"}))
            await _mesurer(campagne, "GET /api/saved/chats",
                           lambda: cl.get("/api/saved/chats"))
        return _f

    try:
        return await _courir(inst, campagne, duree,
                             [travail(cl, cid, i) for i, (cl, cid) in enumerate(zip(clients, chats))])
    finally:
        await asyncio.gather(*(c.aclose() for c in clients), return_exceptions=True)


# ── fichiers ────────────────────────────────────────────────────────────────

async def fichiers(inst: Instance, *, utilisateurs: int = 10, duree: float = 20.0) -> Campagne:
    """Accès au disque local : arborescence, recherche plein texte, mémoire.

    Ces routes sont **synchrones** : elles s'exécutent dans le pool de threads
    d'anyio, dont le plafond par défaut est de 40 jetons pour les 196 routes
    synchrones de l'application. C'est le scénario qui dirait si ce plafond est
    atteint — un p99 qui décroche pendant que le CPU reste bas, c'est une file
    d'attente, pas un calcul.
    """
    campagne = Campagne("fichiers (disque local)")
    campagne.noter(f"{utilisateurs} utilisateurs parcourent l'arborescence, cherchent et "
                   "lisent la mémoire — routes SYNCHRONES, donc pool de threads anyio")
    clients = [await connecter(inst, inst.comptes[i % len(inst.comptes)])
               for i in range(utilisateurs)]

    def travail(cl):
        async def _f():
            await _mesurer(campagne, "GET /api/sandbox/tree", lambda: cl.get("/api/sandbox/tree"))
            await _mesurer(campagne, "GET /api/sandbox/quota", lambda: cl.get("/api/sandbox/quota"))
            await _mesurer(campagne, "POST /api/sandbox/grep",
                           lambda: cl.post("/api/sandbox/grep", json={"query": "def "}))
            await _mesurer(campagne, "GET /api/memory/state", lambda: cl.get("/api/memory/state"))
        return _f

    try:
        return await _courir(inst, campagne, duree, [travail(cl) for cl in clients])
    finally:
        await asyncio.gather(*(c.aclose() for c in clients), return_exceptions=True)


# ── evenements ──────────────────────────────────────────────────────────────

async def evenements(inst: Instance, *, abonnes: int = 20, duree: float = 20.0) -> Campagne:
    """Abonnés SSE au long cours + activité qui produit des événements.

    Un abonné SSE mobilise une connexion et une tâche pour toute sa durée de
    vie. Ce qu'on veut voir : la consommation à vide ne doit pas croître avec
    le nombre d'abonnés, et un abonné ne doit pas empêcher le recyclage des
    workers ni faire enfler le fichier de bus.
    """
    campagne = Campagne("événements (SSE)")
    campagne.noter(f"{abonnes} abonnés SSE tenus ouverts pendant {duree:.0f} s, "
                   "pendant qu'un producteur crée des chats")
    stop = asyncio.Event()
    recus = {"n": 0}

    async def abonne(nom: str):
        cl = await connecter(inst, nom)
        debut = time.perf_counter()
        try:
            async with cl.stream("GET", "/api/system-events", timeout=None) as r:
                campagne.serie("ouverture flux SSE").ajouter(debut, r.status_code)
                async for ligne in r.aiter_lines():
                    if stop.is_set():
                        break
                    if ligne.startswith("data:"):
                        recus["n"] += 1
        except BaseException as exc:                       # noqa: BLE001
            if not isinstance(exc, asyncio.CancelledError):
                campagne.serie("ouverture flux SSE").ajouter(debut, None, exc=exc)
        finally:
            await cl.aclose()

    producteur = await connecter(inst, inst.comptes[0])
    taches = [asyncio.create_task(abonne(inst.comptes[i % len(inst.comptes)]))
              for i in range(abonnes)]
    await asyncio.sleep(1.0)                # laisse les abonnements s'établir

    async def produire():
        r = await _mesurer(campagne, "POST /api/saved/chats/new",
                           lambda: producteur.post("/api/saved/chats/new"))
        if r is not None and r.status_code == 200:
            await _mesurer(campagne, "DELETE /api/saved/chats/{id}",
                           lambda: producteur.delete(f"/api/saved/chats/{r.json()['id']}"))
        await asyncio.sleep(0.2)

    try:
        await _courir(inst, campagne, duree, [produire])
    finally:
        stop.set()
        for t in taches:
            t.cancel()
        await asyncio.gather(*taches, return_exceptions=True)
        await producteur.aclose()
    campagne.noter(f"{recus['n']} messages SSE reçus au total par les {abonnes} abonnés")
    return campagne


# ── mixte ───────────────────────────────────────────────────────────────────

async def mixte(inst: Instance, *, utilisateurs: int = 16, duree: float = 30.0) -> Campagne:
    """Un mélange plausible : beaucoup de lecture, un peu d'écriture, quelques
    connexions, des abonnés SSE en fond. C'est ce scénario qui sert de
    référence de non-régression entre deux versions."""
    campagne = Campagne("mixte")
    campagne.noter(f"{utilisateurs} utilisateurs : 70 % lecture, 20 % écriture, "
                   "10 % connexion, plus des abonnés SSE en fond")
    clients = [await connecter(inst, inst.comptes[i % len(inst.comptes)])
               for i in range(utilisateurs)]
    chats = []
    for cl in clients:
        r = await cl.post("/api/saved/chats/new")
        chats.append(r.json()["id"] if r.status_code == 200 else "")

    stop_sse = asyncio.Event()

    async def abonne(nom):
        cl = await connecter(inst, nom)
        try:
            async with cl.stream("GET", "/api/system-events", timeout=None) as r:
                async for _ in r.aiter_lines():
                    if stop_sse.is_set():
                        break
        except BaseException:                              # noqa: BLE001
            pass
        finally:
            await cl.aclose()

    sse = [asyncio.create_task(abonne(inst.comptes[i % len(inst.comptes)]))
           for i in range(max(2, utilisateurs // 4))]

    corpus = ("Message de conversation. " * 25).strip()

    def travail(cl, cid, graine):
        alea = random.Random(graine)

        async def _f():
            tirage = alea.random()
            if tirage < 0.70:
                await _mesurer(campagne, "lecture : liste + chat",
                               lambda: cl.get("/api/saved/chats"))
                if cid:
                    await _mesurer(campagne, "lecture : liste + chat",
                                   lambda: cl.get(f"/api/saved/chats/{cid}"))
            elif tirage < 0.90 and cid:
                msgs = [{"role": "user", "content": corpus} for _ in range(alea.randint(2, 20))]
                await _mesurer(campagne, "écriture : save-messages",
                               lambda: cl.put(f"/api/saved/chats/{cid}/save-messages",
                                              json={"messages": msgs, "title": "mixte"}))
            else:
                neuf = httpx.AsyncClient(base_url=inst.url, timeout=DELAI_S)
                try:
                    await _mesurer(campagne, "connexion",
                                   lambda: neuf.post("/api/login-lite",
                                                     json={"username": inst.comptes[graine % len(inst.comptes)],
                                                           "password": MOT_DE_PASSE}))
                finally:
                    await neuf.aclose()
        return _f

    try:
        return await _courir(inst, campagne, duree,
                             [travail(cl, cid, i) for i, (cl, cid) in enumerate(zip(clients, chats))])
    finally:
        stop_sse.set()
        for t in sse:
            t.cancel()
        await asyncio.gather(*sse, return_exceptions=True)
        await asyncio.gather(*(c.aclose() for c in clients), return_exceptions=True)


SCENARIOS: dict[str, Callable[..., Awaitable[Campagne]]] = {
    "connexion": connexion,
    "connexion-refusee": connexion_refusee,
    "lecture": lecture,
    "ecriture": ecriture,
    "fichiers": fichiers,
    "evenements": evenements,
    "mixte": mixte,
}
