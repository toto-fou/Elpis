# Service de reconnaissance — whisper.cpp

Il n'y a **rien à écrire** : `whisper-server`, livré avec whisper.cpp, *est* le
service. Elpis lui parle en `POST /inference`, multipart, `verbose_json`.

## Pourquoi une machine à part

whisper prend le GPU par salves courtes, une fois par phrase dictée. Sur la
machine qui sert le LLM, chaque dictée ferait attendre la génération en cours —
et inversement. D'où deux machines, ou au minimum deux GPU.

> **Les binaires llama.cpp déjà installés ne servent pas.** whisper.cpp est un
> projet distinct : `llama-server` ne sait pas charger un `ggml-*.bin` de whisper
> et n'expose pas `/inference`. Il faut compiler whisper.cpp (ci-dessous), ou
> bien — autre voie — pointer Elpis sur un `llama-server` chargé d'un GGUF audio
> (Voxtral, Qwen-Audio) en choisissant le format `llama-audio` dans la console
> admin. Cette seconde voie réutilise vos binaires, mais elle occupe le GPU du
> LLM : c'est un dépannage, pas la configuration visée.

## Installation

```bash
sudo bash build_whisper.sh          # cpu (défaut)
sudo bash build_whisper.sh cuda     # NVIDIA
sudo bash build_whisper.sh vulkan   # AMD / Intel, pilote Vulkan
sudo bash build_whisper.sh rocm     # AMD, pile ROCm

sudo bash fetch_models.sh                       # small-q5_1 (défaut, CPU)
sudo bash fetch_models.sh large-v3-turbo-q5_0   # avec GPU

sudo systemctl enable --now elpis-whisper
systemctl status elpis-whisper
```

## Choisir le modèle

Mesures relevées sur un projet antérieur, énoncé de 5 s en français :

| Modèle | CPU | GPU | Poids |
|---|---|---|---|
| `base-q5_1` | ~1 100 ms | ~150 ms | 57 Mo |
| `small-q5_1` | 2 414 ms | 226 ms | 182 Mo |
| `medium-q5_0` | 7 656 ms | 461 ms | 515 Mo |
| `large-v3-turbo-q5_0` | 12 062 ms | 250 ms | 548 Mo |

Le défaut est `small-q5_1`, parce que le build par défaut est CPU : sans GPU,
ne dépassez pas `small` — au-delà, la phrase arrive après qu'on a fini de parler
la suivante. Sur GPU, `large-v3-turbo` coûte à peine plus que `small` et se
trompe beaucoup moins : prenez-le, et changez `WHISPER_MODEL`.

## Réglages

Le fichier d'unité porte cinq variables :

| Variable | Défaut | Remarque |
|---|---|---|
| `WHISPER_MODEL` | `.../ggml-small-q5_1.bin` | chemin complet, sous `/opt` (`ProtectHome=true` cache `/home`) |
| `WHISPER_HOST` | `127.0.0.1` | adresse d'écoute — voir *Sécurité* ci-dessous |
| `WHISPER_PORT` | `8090` | à reporter dans la console admin d'Elpis |
| `WHISPER_THREADS` | vide = `nproc` | un nombre force la valeur |
| `WHISPER_LANG` | `fr` | Elpis renvoie la langue par requête, ceci n'est que le défaut |

```bash
sudo systemctl edit elpis-whisper      # surcharge propre
sudo systemctl restart elpis-whisper
```

Deux réglages ne sont **pas** dans la ligne de commande, volontairement :
`audio_ctx` et `beam_size` voyagent dans chaque requête. Elpis calcule
`audio_ctx` en fonction de la durée de l'énoncé — c'est le levier de latence
n°1 sur les phrases courtes — et il serait perdu s'il était figé au démarrage.

## Sécurité

whisper-server n'a **aucune authentification** et expose `POST /load`, qui
remplace le modèle chargé : quiconque joint le port peut le détourner ou le
faire tomber. D'où `127.0.0.1` par défaut : Elpis sur la même machine.
Elpis sur une **autre** machine : ouvrez
l'écoute à l'installation (`ELPIS_VOICE_HOST=<IP privée>` ou
`install_offline.sh --lan` pour `0.0.0.0`), ou après coup par
`systemctl edit elpis-whisper` (`WHISPER_HOST`). Puis l'un ou l'autre :

* écouter sur l'interface privée seulement : `WHISPER_HOST=10.0.0.12` ;
* filtrer le port au pare-feu, pour l'hôte Elpis seul :

```bash
sudo ufw allow from <IP-hôte-Elpis> to any port 8090 proto tcp
sudo ufw deny 8090/tcp
```

Réinstaller (`build_whisper.sh`, `install_offline.sh`) réécrit l'unité : repassez
`ELPIS_VOICE_HOST` (ou `--lan`) pour garder une écoute réseau.

## Vérifier

```bash
# un WAV de test en 16 kHz mono
ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -ac 1 -ar 16000 essai.wav
curl -F file=@essai.wav -F response_format=verbose_json -F language=fr \
     http://localhost:8090/inference
```

La réponse doit contenir `segments[].avg_logprob` et `no_speech_prob` : Elpis
s'en sert pour rejeter les transcriptions douteuses. Si `response_format` est
ignoré, le serveur est trop ancien — recompilez.

## Dépannage

| Symptôme | Cause |
|---|---|
| `whisper-server introuvable après compilation` | le binaire a changé de nom selon la version ; regardez dans `/opt/elpis-voice/src/whisper.cpp/build/bin` |
| Le service démarre puis s'arrête | modèle absent ou illisible : `journalctl -u elpis-whisper -n 50` |
| Tout tourne sur CPU malgré `cuda` | la bibliothèque de backend n'est pas à côté du binaire ; vérifiez `LD_LIBRARY_PATH` dans l'unité |
| Transcriptions vides | le WAV n'est pas en 16 kHz mono |
| Phrases inventées pendant les silences | normal : Elpis filtre côté serveur applicatif (liste d'hallucinations + seuil de log-probabilité) |
