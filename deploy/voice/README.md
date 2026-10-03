# Moteur vocal Elpis — ce qui tourne ailleurs

Elpis ne fait aucun calcul audio. L'hôte applicatif valide, borne et relaie ; la
reconnaissance et la synthèse tournent sur des machines dédiées.

```
Navigateur                Hôte Elpis                    Machines d'inférence
──────────                ──────────                    ────────────────────
micro → WAV 16 kHz  ───▶  POST /api/voice/transcribe ─▶  whisper-server  :8090   (deploy/voice/stt)
lecture ← WAV       ◀───  POST /api/voice/speak      ─▶  elpis-tts       :8091   (deploy/voice/tts)
```

**Deux services, deux machines possibles, deux URL.** whisper occupe le GPU par
salves courtes ; le mettre sur la machine qui sert le LLM ferait s'attendre les
deux. Piper, lui, est léger (CPU, temps réel ×20) et peut vivre n'importe où —
il reste malgré tout un service distinct, avec sa propre unité systemd.

## Installation

Sur la machine de reconnaissance :

```bash
sudo bash deploy/voice/stt/build_whisper.sh          # compile whisper.cpp
sudo bash deploy/voice/stt/fetch_models.sh           # small-q5_1 ; large-v3-turbo-q5_0 avec GPU
sudo systemctl enable --now elpis-whisper
```

Sur la machine de synthèse :

```bash
sudo bash deploy/voice/tts/install_tts.sh            # venv + Piper + voix + unité
sudo systemctl enable --now elpis-tts
```

**Écoute.** Les deux unités écoutent sur `127.0.0.1` (Elpis sur la même
machine). `install.sh` ne propose pas d'installer la voix : elle se déploie sur
la machine choisie avec les commandes ci-dessus. Services sur une machine à part :
préfixez l'installation de `ELPIS_VOICE_HOST=<IP privée>` (ou `0.0.0.0`) —
`sudo ELPIS_VOICE_HOST=10.0.0.12 bash …` — puis filtrez les ports 8090/8091 à
l'hôte Elpis (whisper-server n'a aucune authentification).

Détails, variantes GPU, tailles de modèles et mesures : `stt/README.md` et `tts/README.md`.

## Installation hors-ligne (machine sans internet)

Même principe que les lots `caddy` et `libreoffice` : on vendorise sur un poste
connecté, on transporte le dossier par copie, on installe sans réseau.

Sur un poste **connecté** :

```bash
bash deploy/voice/fetch_offline.sh                       # modèle small + voix siwis, CPU
bash deploy/voice/fetch_offline.sh --target cuda \
     --model small-q5_1 --voices fr_FR-siwis-medium,fr_FR-tom-medium
```

Il produit `deploy/voice/offline/` : le binaire `whisper-server` **compilé**
avec ses bibliothèques, le modèle ggml, les voix Piper, les roues Python du
service de synthèse, la source whisper.cpp en repli, et un `MANIFEST.txt`
(empreintes sha256 + révision compilée).

Copiez `deploy/voice/` sur la machine cible, puis :

```bash
sudo bash deploy/voice/install_offline.sh            # --lan si Elpis tourne ailleurs
sudo systemctl enable --now elpis-whisper elpis-tts
```

La cible n'a besoin que de **python3 (avec `python3-venv`) et systemd** : ni
compilateur, ni pip en ligne, ni curl, ni le moindre accès réseau. Ce sont des
paquets de base, que n'importe quel dépôt Debian local fournit — le lot ne porte
que ce qui ne s'y trouve pas : le binaire whisper, ses bibliothèques, et les
roues `piper` / `onnxruntime`. Si la cible n'a même pas cela, `--with-debs`
ajoute `python3` et `python3-venv` au lot (14 Mo).

### Cible d'une AUTRE distribution que le poste de préparation

C'est le cas courant : on prépare depuis la machine de développement, la cible
est un serveur plus ancien. La glibc n'étant pas rétro-compatible, un binaire
compilé sur Debian 13 **ne démarre pas** sur Debian 12. On compile donc *dans*
la distribution visée :

```bash
bash deploy/voice/fetch_offline.sh --docker debian:bookworm-slim \
     --model small-q5_1,large-v3-turbo-q5_0 \
     --voices fr_FR-siwis-medium,fr_FR-tom-medium
```

`--docker` fait faire **deux** choses au conteneur, et c'est le point : la
compilation **et** le téléchargement des roues Python. Les roues sont liées à la
version de Python, et celle du conteneur *est* celle de la distribution visée
(3.11 pour Debian 12, 3.13 pour Debian 13) — plus aucun risque de décalage.

Le `MANIFEST.txt` enregistre la distribution et la version de Python employées :
en cas de doute sur un lot reçu, la réponse est dans son en-tête.

Deux points à connaître, tous deux vérifiés par l'installeur :

* **Le binaire est compilé sur le poste de préparation**, sauf avec `--docker`.
  Sans cette option, préparez le lot sur une distribution identique à la cible
  ou plus ancienne. `install_offline.sh` lance le binaire avant de conclure et,
  s'il ne démarre pas, recompile depuis la source vendorisée quand `cmake` est
  présent — sinon il s'arrête en le disant.
* **Les roues Python sont liées à la version de Python.** Avec `--docker`
  c'est réglé d'office ; sinon, préparez le lot avec le même `x.y` que la cible
  (`--python python3.11`). En cas de décalage, pip refuse les roues et le
  message nomme les deux versions.

### Le lot produit, en chiffres

> Le dépôt ne contient **pas** de lot : `deploy/voice/offline/` n'y garde que
> `MANIFEST.txt`, celui du dernier lot construit (utile pour comparer les
> empreintes d'un lot reçu). Binaires, modèles, voix et roues se reconstruisent
> avec `fetch_offline.sh` ; `install_offline.sh` refuse de s'exécuter sans eux.

Exemple de lot Debian 12 (trois modèles, quatre voix) :

| Partie | Taille | Contenu |
|---|---|---|
| `models/` | 1,8 Go | `ggml-small-q5_1` (181 Mo) + `ggml-large-v3-turbo-q5_0` (547 Mo) + `ggml-large-v3-q5_0` (1,01 Go) |
| `voices/` | 267 Mo | `fr_FR-siwis-medium`, `fr_FR-tom-medium`, `fr_FR-upmc-medium`, `fr_FR-mls-medium` |
| `wheels/` | 81 Mo | roues Python 3.11 du service de synthèse |
| `bin/` | 9,2 Mo | `whisper-server`, ses bibliothèques ggml, et **`libgomp.so.1`** |
| **total** | **~2,2 Go** | |

Les trois modèles couvrent les trois usages : `small-q5_1` sur une machine
modeste, `large-v3-turbo-q5_0` pour la latence, `large-v3-q5_0` pour la
**qualité maximale en français** — c'est le plus gros modèle publié en
quantifié, et il n'y a pas de raison de prendre le f16 (2,9 Go) pour un gain
inaudible en dictée.

Côté voix, `medium` **est** le haut de gamme français de Piper : le catalogue
`rhasspy/piper-voices` ne publie aucune voix `fr_FR` en `high`. Les quatre
embarquées sont donc les meilleures disponibles ; elles se choisissent dans la
console admin (Connexions › Moteur vocal › Voix).

`libgomp` (le moteur OpenMP) est embarqué délibérément : il arrive avec
`build-essential` sur la machine de compilation, mais **manque sur une Debian
nue** — sans lui le binaire refuse de démarrer, et c'est exactement le genre de
panne qu'on ne découvre qu'une fois chez le client.

`install_offline.sh` prend **le plus petit** modèle par défaut (il tourne
partout) et affiche les autres ; `--model large-v3-q5_0` sur un serveur qui a
les épaules.

### Ajouter un modèle ou une voix à un lot déjà construit

`--skip-build` ne touche **ni au binaire ni aux roues** : il ne fait que
compléter `models/` et `voices/`, puis refait le `MANIFEST.txt`.

```bash
bash deploy/voice/fetch_offline.sh --skip-build \
     --model large-v3-q5_0 \
     --voices fr_FR-siwis-medium,fr_FR-tom-medium,fr_FR-upmc-medium,fr_FR-mls-medium
```

C'est la seule façon correcte d'enrichir un lot préparé pour une **autre**
distribution : une relance sans cette option recompilerait le binaire ici et
écraserait celui de la cible. L'en-tête du manifeste continue d'annoncer la
distribution d'origine du binaire, pas celle du poste qui a lancé le script.

### Le lot tient-il debout ? Une commande

```bash
bash deploy/voice/essai_lot.sh          # debian:bookworm-slim par défaut
```

Monte une machine **neuve** dans la distribution visée, avec les seuls outils de
base et **le réseau coupé**, puis installe le lot, démarre les deux services
comme le feraient les unités systemd, et fait la boucle complète : une phrase
synthétisée, ramenée à 16 kHz, repassée à la reconnaissance.

Exemple de passage (lot de 2,2 Go) :

```
    synthese : {"ok":true,"voice":"fr_FR-siwis-medium","installed":4,...}
    reconnaissance : HTTP 200
    dit       : Bonjour, ceci est un essai du moteur vocal.
    transcrit : Bonjour, ceci est un essai du moteur vocal.
    LA BOUCLE EST BONNE
```

Ni compilateur ni pip dans la machine d'essai : ce qui manquerait au lot se voit
là, pas sur le serveur de production.

### Ce que le script vérifie avant de dire « prêt »

Avec `--docker`, deux épreuves tournent dans la distribution visée :

1. le binaire est **lancé** (`--help`) et la version de glibc réellement exigée
   est relevée ;
2. les roues sont **installées hors ligne** dans un venv neuf, puis importées.

Un lot qui échoue à l'une des deux n'est pas déclaré prêt. C'est deux minutes
ici contre un aller-retour sur la machine cible.

Le lot est **hors git** (`deploy/voice/offline/`) ; seul le `MANIFEST.txt` est
versionné. Les empreintes sont revérifiées
à l'installation : une copie tronquée est refusée tout de suite, au lieu de
donner un service qui meurt trois minutes plus tard sur un modèle illisible.

`--no-stt` / `--no-tts` n'installent qu'un des deux services.

## Configuration côté Elpis

Console admin › Configuration › Connexions › **Moteur vocal**, ou directement
dans `config.json` :

```json
"voice": {
  "enabled": true,
  "stt": { "endpoint_url": "http://machine-stt:8090", "format": "whisper.cpp", "language": "fr" },
  "tts": { "endpoint_url": "http://machine-tts:8091", "format": "elpis-tts",
           "voice": "fr_FR-siwis-medium", "token": "<contenu de token.env>" }
}
```

Formats de synthèse :

| Format | Serveur | Appel |
|---|---|---|
| `elpis-tts` | `deploy/voice/tts` (ce dépôt) | `POST /tts` |
| `piper-http` | `python -m piper.http_server` (Piper 1.x installé à la main) | `POST /synthesize` (Piper ≥ 1.5), repli `POST /` (1.3–1.4) |
| `openai` | OpenAI, Kokoro-FastAPI, speaches… | `POST /v1/audio/speech` — **`model` obligatoire** (ex. `tts-1`) |

Clés facultatives par section : `verify` (`false` pour un moteur HTTPS à
certificat auto-signé), `max_concurrent` (STT : 1 par défaut, whisper-server
traite une requête à la fois), `timeout_sec`. `tts.max_chars` est borné à 4000.

Le bouton **Tester** de la console interroge les deux services sans rien
enregistrer, **et** dit ce qui manque encore pour que ça marche : moteur
désactivé, configuration non enregistrée, cases utilisateur, HTTPS.

## Vérifier à la main

```bash
# reconnaissance — le WAV doit être en 16 kHz mono
curl -F file=@essai.wav -F response_format=verbose_json -F language=fr \
     http://machine-stt:8090/inference

# synthèse — elpis-tts (ajoutez -H "Authorization: Bearer <jeton>" si token.env existe)
curl -X POST http://machine-tts:8091/tts -H 'Content-Type: application/json' \
     -d '{"text":"Bonjour, ceci est un essai."}' -o essai.wav
ffprobe essai.wav

# synthèse — piper.http_server installé à la main (port 5000 par défaut)
curl -X POST http://machine-tts:5000/synthesize -H 'Content-Type: application/json' \
     -d '{"text":"Bonjour, ceci est un essai."}' -o essai.wav

# santé
curl http://machine-stt:8090/health           # {"status":"ok"}
curl http://machine-tts:8091/health           # {"ok":true,"service":"elpis-tts",...}
```

**Lancez ces `curl` depuis l'hôte Elpis**, pas depuis la machine d'inférence :
c'est lui qui appelle, et un pare-feu ou une écoute sur `127.0.0.1` ne se voit
que de là.

## Dépannage

Dans l'ordre où on les rencontre :

| Symptôme | Cause | Geste |
|---|---|---|
| Le bouton micro n'apparaît pas, ou la case Dictée est grisée | l'application est servie en **HTTP sur une IP du LAN** : les navigateurs n'ouvrent le micro qu'en **HTTPS ou sur `localhost`** | activer HTTPS (Caddy) : Console admin › Sécurité › Accès HTTPS |
| Le bouton micro n'apparaît pas | `voice.enabled` à `false`, ou adresse STT vide, ou config non **enregistrée** | Console admin › Connexions › Moteur vocal, cocher Activer, **Enregistrer** |
| Tout est configuré, toujours rien | « Dictée » et « Réponse vocale » sont **décochées par défaut pour chaque utilisateur** (`/transcribe` répond 403) | chaque compte : Paramètres › Dictée / Réponse vocale |
| Rien après avoir activé dans la console | les fonctions actives sont lues au chargement de la page | **recharger la page** (onglets déjà ouverts compris) |
| « Jeton refusé par le moteur vocal » | le jeton généré par `install_tts.sh` (`token.env`) n'a pas été recopié | `sudo cat /opt/elpis-voice/tts/token.env`, coller la valeur dans la console |
| « Chemin introuvable » (ex-« HTTP 404 ») en synthèse | un Piper installé à la main (`python -m piper.http_server`) n'a pas de `/tts` | format **`piper-http`**, adresse = base (`http://machine:5000`) |
| « Chemin introuvable » en reconnaissance | mauvais format, ou adresse pointant sur autre chose que whisper-server | format `whisper.cpp` + adresse `http://machine:8090` |
| « Moteur vocal injoignable » avec un whisper-server installé à la main | il écoute par défaut sur **`127.0.0.1:8080`** | relancer avec `--host 0.0.0.0 --port 8090` (et filtrer le port, voir `stt/README.md`) |
| « Moteur vocal injoignable », services vocaux sur une autre machine | les unités écoutent sur **`127.0.0.1`** par défaut | réinstaller avec `install_offline.sh --lan` (ou `ELPIS_VOICE_HOST=<IP privée>`), ou `systemctl edit` (`WHISPER_HOST`, `ELPIS_TTS_HOST`) ; filtrer les ports |
| « Moteur vocal injoignable » | service arrêté, ou pare-feu | `systemctl status elpis-whisper` / `elpis-tts`, puis le `curl` ci-dessus **depuis l'hôte Elpis** |
| Format `openai` en synthèse : HTTP 400/422 | champ `model` absent | renseigner `tts.model` (ex. `tts-1`) |
| « Moteur de dictée occupé » (503) | énoncés en file au-delà de 15 s | modèle plus petit, ou GPU ; `stt.max_concurrent` > 1 n'aide pas whisper-server |
| Longs énoncés en 504 | CPU trop lent pour le modèle | `small-q5_1` sur CPU ; le délai grandit déjà avec la durée (10 s + 3 s par seconde d'audio) |
| Erreur de certificat vers un moteur HTTPS | certificat auto-signé | `"verify": false` dans la section concernée |
| « Merci. » dicté n'apparaît pas | whisper doutait (score bas ou `no_speech_prob` haut) : la formule est traitée comme une hallucination | parler plus près du micro ; les formules longues ne sont pas concernées |
| Latence soudainement triplée | un second `whisper-server` tourne avec d'autres réglages | `pgrep -a whisper-server` |
| Transcriptions fantômes pendant les silences | filtre anti-hallucination contourné | vérifier que l'adresse STT pointe bien sur whisper et non sur un modèle de chat |
| La voix lit les backticks et les URL | requête envoyée sans passer par `/api/voice/speak` | le nettoyage markdown est côté Elpis, pas côté service |

## Variante Windows

Aucun script Windows n'est livré dans ce dépôt : `whisper-server` et
`tts/tts_service.py` peuvent y être lancés à la main, sur 8090 / 8091, puis
leurs adresses saisies dans la console d'administration.

## Origine

La reconnaissance et la synthèse reprennent le moteur d'un projet antérieur,
rendu joignable par HTTP et sans micro ni haut-parleur local.
