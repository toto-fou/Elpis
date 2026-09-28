# Service de synthèse — Piper

Piper est une bibliothèque, pas un serveur : `tts_service.py` l'enveloppe dans
le strict nécessaire pour qu'Elpis lui demande un WAV.

CPU uniquement, environ ×20 le temps réel sur une machine modeste : une phrase
de trois secondes se synthétise en 150 ms. Aucune carte son n'est requise.

## Installation

```bash
sudo bash install_tts.sh                      # voix fr_FR-siwis-medium
sudo bash install_tts.sh fr_FR-tom-medium     # ou une autre

sudo systemctl enable --now elpis-tts
curl -s http://localhost:8091/health
```

## Les voix

| Voix | Genre | Taux | Poids | Remarque |
|---|---|---|---|---|
| `fr_FR-siwis-medium` | femme | 22 050 Hz | 63 Mo | le défaut : nette, bien articulée |
| `fr_FR-siwis-low` | femme | 16 000 Hz | 28 Mo | deux fois plus rapide, moins définie |
| `fr_FR-upmc-medium` | femme et homme | 22 050 Hz | 77 Mo | deux locuteurs : `jessica`, `pierre` |
| `fr_FR-tom-medium` | homme | 44 100 Hz | 64 Mo | la plus définie du lot |
| `fr_FR-gilles-low` | homme | 16 000 Hz | 63 Mo | timbre plus grave |
| `fr_FR-mls-medium` | variés | 22 050 Hz | 77 Mo | 125 lecteurs, qualité inégale |
| `fr_FR-mls_1840-low` | homme | 16 000 Hz | 63 Mo | un seul lecteur |

```bash
sudo bash fetch_voices.sh fr_FR-tom-medium fr_FR-upmc-medium
sudo systemctl restart elpis-tts
```

Les voix installées apparaissent dans la console admin d'Elpis après un clic sur
**Tester**. Une voix n'est visible que si ses **deux** fichiers sont là
(`.onnx` et `.onnx.json`) — un téléchargement coupé ne se propose jamais.

> Piper ne clone pas une voix. Les moteurs de clonage à la volée demandent un
> GPU et ne tiennent pas la conversation en temps réel sur CPU. Pour une autre
> voix, on change de modèle.

## API

| Route | Corps | Rendu |
|---|---|---|
| `GET /health` | — | `{ok, voice, sample_rate, installed, loaded}` |
| `GET /voices` | — (jeton exigé s'il est configuré) | voix du disque + voix par défaut + catalogue ; alimente la liste déroulante de la console |
| `POST /tts` | `{text, voice?, speed?, pitch?, speaker?}` | `audio/wav` |
| `POST /v1/audio/speech` | `{input, voice?, speed?}` | `audio/wav` — alias OpenAI |

L'alias OpenAI existe pour qu'un autre moteur (Kokoro FastAPI, par exemple)
puisse prendre la place de celui-ci sans rien changer côté Elpis : il suffit de
basculer le champ *Format* de la console admin.

En-têtes de réponse utiles au diagnostic : `X-Elpis-Voice`,
`X-Elpis-Sample-Rate`, `X-Elpis-Synth-Ms`.

## Réglages

| Variable d'unité | Défaut | Rôle |
|---|---|---|
| `ELPIS_TTS_VOICE` | `fr_FR-siwis-medium` | voix par défaut, préchargée au démarrage |
| `ELPIS_TTS_VOICES_DIR` | `/opt/elpis-voice/voices` | où sont les `.onnx` |
| `ELPIS_TTS_HOST` | `127.0.0.1` | adresse d'écoute : Elpis sur cette machine. Elpis ailleurs : IP privée ou `0.0.0.0` (`ELPIS_VOICE_HOST` à l'installation, `install_offline.sh --lan`) |
| `ELPIS_TTS_PORT` | `8091` | à reporter dans la console admin |
| `ELPIS_TTS_MAX_CHARS` | `4000` | plafond par requête — Elpis ne dépasse jamais 4000 (`tts.max_chars`) |
| `ELPIS_TTS_MAX_CONCURRENT` | `2` | synthèses simultanées |
| `ELPIS_TTS_MAX_VOICES` | `2` | voix gardées en mémoire (la plus ancienne est déchargée) |
| `ELPIS_TTS_THREADS` | moitié des cœurs | threads ONNX par synthèse ; `0` = ONNX décide (tous les cœurs, à chaque synthèse) |

Le jeton vit dans `/opt/elpis-voice/tts/token.env`, jamais dans l'unité :
`systemctl cat` est lisible par tout le monde. **Il est généré à l'installation
et doit être recopié** dans la console admin d'Elpis (Moteur vocal › Synthèse ›
Jeton) — sans lui, chaque phrase répond « Jeton refusé par le moteur vocal ».
Supprimez ce fichier pour un service ouvert sur le réseau local.

```bash
sudo cat /opt/elpis-voice/tts/token.env        # ELPIS_TTS_TOKEN=...
```

`ProtectHome=true` dans l'unité : les voix doivent vivre sous
`/opt/elpis-voice/voices`, jamais dans un dossier personnel, invisible au
service.

Trois réglages voyagent par requête et se pilotent depuis Elpis : la vitesse
(0,5 à 2,0), la hauteur (0,7 à 1,4) et le locuteur pour les voix qui en portent
plusieurs. Au-delà de ces bornes Piper produit du bruit — elles sont appliquées
dans le service, pas seulement dans l'interface.

## Ce qui est repris d'un projet antérieur, et pourquoi

* **Voix chargée une fois, gardée chaude.** Le premier appel à ONNX Runtime
  alloue ses arènes et spécialise ses noyaux : ~300 ms, payés au démarrage
  plutôt qu'à la première phrase lue à l'utilisateur.
* **`normalize_audio=False`.** Piper normalise chaque appel indépendamment ;
  comme Elpis synthétise phrase par phrase, la normalisation ferait varier le
  volume d'une phrase à l'autre au milieu d'une réponse.
* **La hauteur par le taux de lecture.** Piper n'a pas de réglage de hauteur :
  on annonce un autre taux d'échantillonnage et on compense la durée par
  `length_scale`, pour que seule la hauteur change, pas le débit.
* **Écrêtage avant conversion 16 bits.** Sans lui, un dépassement repasse par
  zéro et s'entend comme un craquement.

## Dépannage

| Symptôme | Cause | Geste |
|---|---|---|
| `health` rend `ok: false` | voix absente | `sudo bash fetch_voices.sh` |
| Elpis : « Jeton refusé par le moteur vocal » | jeton de `token.env` non recopié dans la console | voir *Réglages* ci-dessus |
| Machine saturée pendant la lecture | `ELPIS_TTS_THREADS=0` avec 2 synthèses simultanées | laisser le défaut (moitié des cœurs) |
| `404 Voix absente du disque` | nom mal orthographié, ou `.onnx.json` manquant | `ls /opt/elpis-voice/voices` |
| `503 piper-tts n'est pas installé` | venv incomplet | relancer `install_tts.sh` |
| Première phrase lente, les suivantes rapides | préchauffage raté au démarrage | `journalctl -u elpis-tts -n 30` |
| Volume qui saute d'une phrase à l'autre | `normalize_audio` réactivé | ne pas y toucher |
| Craquements | écrêtage contourné, ou `pitch` hors bornes | vérifier les réglages côté Elpis |
