# SPDX-License-Identifier: MIT
"""
gunicorn_conf.py — Configuration multi-worker pour Elpis

Lancement :
    gunicorn -c gunicorn_conf.py app:app
"""
import multiprocessing
import os

# ── Workers ──────────────────────────────────────────────────────
# Jusqu'à 2 cœurs : un worker par cœur. Au-delà : un cœur libre, et 4 au plus
# (4 vCPU → 3, 8 vCPU → 4, 32 vCPU → 4). Sans plafond, une grosse machine
# lançait 31 workers de ~210 Mo chacun, avec leur sous-process MCP, pour un
# service que le GIL et le moteur LLM limitent bien avant. Les créneaux du
# llama-server sont partagés entre tous les process (llm_core/_scheduling/
# _shared_slots.py) : le nombre de workers n'en dépend plus.
_cpu = multiprocessing.cpu_count()
workers = _cpu if _cpu <= 2 else min(4, _cpu - 1)

# ``APP_WORKERS`` — surcharge explicite, sans toucher à ce fichier.
#
# Le calcul ci-dessus suit le nombre de cœurs, plafonné à 4 pour la mémoire.
# Le CPU n'est pourtant pas ce qui sature. Sous charge sur les routes
# SYNCHRONES (tests/load, scénario « fichiers », bac à sable de 500 fichiers,
# VM 4 cœurs), le CPU plafonne à **58 %** et le débit se met à DÉCROÎTRE au
# delà de 16 utilisateurs — ce n'est donc pas le processeur qui sature, mais
# le GIL : chaque worker est un interpréteur unique, et les requêtes
# synchrones s'y sérialisent.
#
#   | workers | 16 util. | 32 util. | 60 util. | RSS |
#   |---|---|---|---|---|
#   | 3 | 121 req/s, témoin p99 339 ms | 116 req/s, 906 ms | 103 req/s, 1040 ms | 664 Mo |
#   | 6 | 153 req/s, témoin p99 204 ms | 155 req/s, 245 ms | 133 req/s, 691 ms | 1280 Mo |
#
# Doubler les workers rend donc +26 à +33 % de débit et divise la latence de
# queue par 2 à 4 — au prix du DOUBLE de mémoire (chaque worker traîne son
# sous-process MCP). C'est un arbitrage qui appartient à l'exploitant, pas à
# ce fichier : la valeur par défaut reste prudente, le levier existe.
_workers_env = os.environ.get("APP_WORKERS", "").strip()
if _workers_env.isdigit() and int(_workers_env) > 0:
    workers = int(_workers_env)

# AUDIT 2026-08-22 (D3) — le nombre de workers est publié dans l'environnement
# des workers eux-mêmes. Un worker ne peut pas le déduire : il ne voit que son
# propre process. Or l'ordonnanceur LLM se dimensionne sur les slots du
# llama-server (``-np``), qui sont une ressource de MACHINE : sans cette
# information, chaque worker s'autorisait la TOTALITÉ des slots et le serveur
# se retrouvait avec trois fois plus de générations que d'emplacements.
os.environ["APP_WORKERS_EFFECTIVE"] = str(workers)

# Classe de worker : uvicorn async, durci (audit 2026-08-02, W1/W2) —
# pose timeout_graceful_shutdown (sinon le recyclage max_requests attendait
# les SSE infinis pour TOUJOURS : worker figé jusqu'au SIGABRT à 600 s,
# sans remplaçant) et annonce le shutdown à sse-starlette/aux clients.
worker_class = "server.uvicorn_worker.ElpisUvicornWorker"

# ── Réseau ───────────────────────────────────────────────────────
# Le host par défaut suit le toggle HTTPS de la console admin
# (config.json › security.https.enabled) : 127.0.0.1 quand le reverse
# proxy Caddy est le seul point d'entrée ; en accès direct,
# security.listen (local → 127.0.0.1, lan → 0.0.0.0). Règle : _bind_host.py.
# Lecture JSON pure (pas d'import shared_infra : le master gunicorn n'a
# pas l'app chargée) ; ce fichier est ré-exécuté à chaque SIGHUP et
# gunicorn re-binde si l'adresse a changé — c'est ce qui permet au
# toggle admin de basculer sans redémarrage manuel.
# Break-glass : l'env BIND reste prioritaire (survit au SIGHUP) —
# BIND=0.0.0.0:8001 redonne l'accès direct quel que soit le toggle.
def _default_host():
    # Chargé par chemin : le master gunicorn exécute ce fichier hors paquet.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "_bind_host", os.path.join(os.path.dirname(os.path.abspath(__file__)), "_bind_host.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.default_host()

_default_host = _default_host()
bind = os.environ.get("BIND", f"{_default_host}:8001")

# INDISPENSABLE au re-bind à chaud (toggle HTTPS) : pendant le reload
# gracieux SIGHUP, les ANCIENS workers détiennent encore l'ancienne socket
# (ex. 0.0.0.0:8001) quand le master tente de binder la nouvelle
# (127.0.0.1:8001) → EADDRINUSE, 5 retries, puis sys.exit(1) du master en
# laissant des workers orphelins. SO_REUSEPORT autorise la coexistence
# transitoire des deux binds (même port, même euid) ; les anciens workers
# ferment leur socket en fin de grâce. Contrepartie assumée : une seconde
# instance lancée par erreur ne recevrait plus EADDRINUSE.
reuse_port = True


def on_reload(server):
    # En mode reuse_port, chaque WORKER crée sa propre socket et le master
    # n'en garde aucune au boot (arbiter.start() saute create_sockets).
    # Mais arbiter.reload() n'a PAS ce garde-fou : au changement d'adresse
    # (toggle HTTPS) il recrée des LISTENERS côté master — socket que
    # personne n'accept()era jamais, vers laquelle le noyau route pourtant
    # ~1/(workers+1) des connexions (requêtes qui pendent indéfiniment,
    # vérifié sur gunicorn 26.0.0). On referme donc ici les listeners du
    # master ; ce hook est appelé par reload() juste après leur recréation.
    if not server.cfg.reuse_port:
        return
    for lnr in server.LISTENERS:
        try:
            lnr.close()
        except Exception:
            pass
    server.LISTENERS = []

# Keep-alive élevé pour les connexions SSE longues
keepalive = 120

# Timeout généreux (LLM peut prendre du temps)
timeout = 600
# AUDIT 2026-08-02 (W2), 2026-08-22 (A1), CORRIGÉ 2026-08-23 — PORTÉE RÉELLE
# de ce réglage, vérifiée sur la gunicorn RÉELLEMENT installée (26.0.0) :
#
#   • ``Arbiter.stop()`` — arrêt franc (systemctl stop, Ctrl-C) : borne
#     l'attente avant le SIGKILL. C'est la portée que tout le monde connaît.
#   • ``Arbiter.reload()`` — SIGHUP, donc le bouton « Redémarrer » de la
#     console admin et le toggle HTTPS. ⚠ La note précédente affirmait que ce
#     chemin « ne consulte JAMAIS graceful_timeout » : c'est FAUX. reload()
#     se termine par une attente BLOQUANTE bornée par graceful_timeout
#     (arbiter.py, « wait for old workers to terminate to prevent double
#     SIGTERM »). Sa sortie anticipée ``oldest > last_worker_age`` ne peut pas
#     se déclencher tant qu'un ANCIEN worker figure dans WORKERS — et avec le
#     drain applicatif (« linger »), il y figure. Le master consomme donc les
#     330 s ENTIÈRES, à l'intérieur de ``handle_hup()`` : pendant ce temps ni
#     ``murder_workers()`` ni ``manage_workers()`` ne tournent et les signaux
#     suivants restent en file. Ensuite, ``manage_workers()`` re-SIGTERM le
#     worker excédentaire à chaque tour de boucle (~1/s) pendant tout son
#     linger — sans effet destructeur (uvicorn ne pose ``force_exit`` que sur
#     SIGINT), mais c'est du bruit.
#
# Ce qui protège réellement un worker qui finit ses runs, ce n'est PAS ce
# réglage : c'est son HEARTBEAT (cf. server/uvicorn_worker.py, maintenu
# pendant tout le drain). Sans lui, ``murder_workers`` SIGABRT à ``timeout``
# (600 s), en plein drain. Le drain LONG (jusqu'à 12 h) est réglé par
# ``APP_DRAIN_MAX_S`` côté worker.
#
# ARBITRAGE, à trancher par l'exploitant : baisser cette valeur (30 s p. ex.)
# rendrait le « Redémarrer » admin immédiat, au prix d'un ``systemctl stop``
# qui SIGKILL un worker en train de drainer au bout de 30 s au lieu de 330.
# Les deux chemins veulent des valeurs différentes et gunicorn n'offre qu'un
# bouton. On garde 330 s : la lenteur du reload ne dégrade pas le service
# (les workers neufs acceptent déjà), une perte de run à l'arrêt, si.
graceful_timeout = 330

# ── Logging ──────────────────────────────────────────────────────
accesslog = "-"
errorlog = "-"
loglevel = "info"

# ── Stabilité ────────────────────────────────────────────────────
# Redémarrer les workers après N requêtes (filet contre une fuite mémoire).
#
# Le seuil était de 2000, ce qui compte des REQUÊTES HTTP, pas des actions
# d'utilisateur — et l'application sert elle-même ses fichiers statiques :
# ``frontend/index.html`` charge **57 sous-ressources**. Un chargement de page
# à froid coûte donc ~60 requêtes, et un worker se recyclait toutes les
# ~30 ouvertures de page.
#
# Mesuré par tests/load (24 utilisateurs en lecture, 3 workers, 42 s) :
#
#   | | max_requests=2000 | recyclage désactivé |
#   |---|---|---|
#   | requêtes perdues | 9 | 0 |
#   | débit | 74,8 req/s | 90,7 req/s |
#   | ``GET /`` p99 | 450,9 ms | 286,0 ms |
#   | ``GET /`` max | 5017,7 ms | 1642,5 ms |
#   | recyclages | 6 | 0 |
#
# Les requêtes perdues sont la course inhérente au keep-alive HTTP/1.1 :
# uvicorn ferme les connexions inactives au shutdown, et un client qui vient
# d'écrire une requête sur l'une d'elles reçoit une coupure. Les navigateurs
# rejouent en général une requête perdue dans ce cas précis (RFC 7230 §6.3.1) ;
# le client du harnais, non — c'est pourquoi il le voit. La course ne se
# supprime pas, elle se **raréfie**.
#
# Le vrai coût est ailleurs : à 2000, un worker était recyclé AVANT même
# d'avoir atteint son régime. La même campagne montre que le RSS se stabilise
# après ~5000 requêtes et ne bouge plus (536 → 541 Mo puis plat sur 80 s) :
# aucun indice de fuite par requête sur le chemin de lecture.
#
# 50 000 gardait le filet (les chemins longs — PTY, MCP, streaming LLM — ne sont
# pas couverts par cette mesure) tout en espaçant le recyclage d'un facteur 25 :
# sous la charge mesurée, une fois par worker toutes les ~9 minutes au lieu de
# toutes les 20 secondes. Réglable sans toucher au fichier.
#
# DÉSACTIVÉ par défaut (2026-08-21) : un recyclage qui tombe pendant un run
# d'agent de plusieurs heures l'ANNULE au bout du drain de 300 s
# (uvicorn_worker.GRACEFUL_SHUTDOWN_S) → partiel + « Continuer » en pleine
# mission autonome — l'exact contraire de la règle « recyclage invisible ».
# La campagne ci-dessus n'a montré AUCUNE fuite par requête (RSS plat après
# ~5000 requêtes) : le filet était devenu purement précautionnel, son coût ne
# l'est pas. Ré-activable via APP_MAX_REQUESTS=N pour une instance qui fuit.
max_requests = max(0, int(os.environ.get("APP_MAX_REQUESTS", "0")))
# ⚠ Le jitter DOIT retomber à 0 si le recyclage est désactivé : gunicorn
# calcule ``max_requests + randint(0, jitter)`` par worker, donc un jitter
# résiduel sur un plafond nul ferait recycler au bout d'UNE requête.
max_requests_jitter = (max_requests // 10) if max_requests else 0

# Ne PAS utiliser preload_app : les ressources asyncio
# (MCP pool, semaphores) ne survivent pas au fork.
preload_app = False
