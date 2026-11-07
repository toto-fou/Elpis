# Elpis voice engine — what runs elsewhere

Elpis does no audio computation. The application host validates, bounds and relays; speech
recognition and synthesis run on dedicated machines.

```
Browser                   Elpis host                    Inference machines
───────                   ──────────                    ──────────────────
mic → 16 kHz WAV    ───▶  POST /api/voice/transcribe ─▶  whisper-server  :8090   (deploy/voice/stt)
playback ← WAV      ◀───  POST /api/voice/speak      ─▶  elpis-tts       :8091   (deploy/voice/tts)
```

**Two services, possibly two machines, two URLs.** whisper uses the GPU in
short bursts; putting it on the machine that serves the LLM would make the
two wait for each other. Piper is light (CPU, 20x real time) and can live anywhere —
it is still a separate service, with its own systemd unit.

## Installation

On the recognition machine:

```bash
sudo bash deploy/voice/stt/build_whisper.sh          # builds whisper.cpp
sudo bash deploy/voice/stt/fetch_models.sh           # small-q5_1; large-v3-turbo-q5_0 with a GPU
sudo systemctl enable --now elpis-whisper
```

On the synthesis machine:

```bash
sudo bash deploy/voice/tts/install_tts.sh            # venv + Piper + voices + unit
sudo systemctl enable --now elpis-tts
```

**Listening.** Both units listen on `127.0.0.1` (Elpis on the same
machine). `install.sh` does not offer to install voice: it is deployed on the
chosen machine with the commands above. For services on a separate machine,
prefix the installation with `ELPIS_VOICE_HOST=<private IP>` (or `0.0.0.0`) —
`sudo ELPIS_VOICE_HOST=10.0.0.12 bash …` — then filter ports 8090/8091 to
the Elpis host only (whisper-server has no authentication).

Details, GPU variants, model sizes and measurements: `stt/README.md` and `tts/README.md`.

## Offline installation (machine without internet)

Same principle as the `caddy` and `libreoffice` bundles: you vendor on a connected
machine, carry the folder by copy, and install without network.

On a **connected** machine:

```bash
bash deploy/voice/fetch_offline.sh                       # small model + siwis voice, CPU
bash deploy/voice/fetch_offline.sh --target cuda \
     --model small-q5_1 --voices fr_FR-siwis-medium,fr_FR-tom-medium
```

It produces `deploy/voice/offline/`: the **compiled** `whisper-server` binary
with its libraries, the ggml model, the Piper voices, the Python wheels of the
synthesis service, the whisper.cpp source as a fallback, and a `MANIFEST.txt`
(sha256 checksums + compiled revision).

Copy `deploy/voice/` to the target machine, then:

```bash
sudo bash deploy/voice/install_offline.sh            # --lan if Elpis runs elsewhere
sudo systemctl enable --now elpis-whisper elpis-tts
```

The target only needs **python3 (with `python3-venv`) and systemd**: no
compiler, no online pip, no curl, no network access at all. These are base
packages that any local Debian repository provides — the bundle carries
only what is not there: the whisper binary, its libraries, and the
`piper` / `onnxruntime` wheels. If the target does not even have those, `--with-debs`
adds `python3` and `python3-venv` to the bundle (14 MB).

### Target on a DIFFERENT distribution than the preparation machine

This is the usual case: you prepare from the development machine and the target
is an older server. glibc is not backward compatible, so a binary
compiled on Debian 13 **does not start** on Debian 12. So you compile *inside*
the target distribution:

```bash
bash deploy/voice/fetch_offline.sh --docker debian:bookworm-slim \
     --model small-q5_1,large-v3-turbo-q5_0 \
     --voices fr_FR-siwis-medium,fr_FR-tom-medium
```

`--docker` makes the container do **two** things, and that is the point: the
compilation **and** the download of the Python wheels. Wheels are tied to the
Python version, and the container's version *is* the target distribution's
(3.11 for Debian 12, 3.13 for Debian 13) — no more risk of a mismatch.

`MANIFEST.txt` records the distribution and the Python version used:
if in doubt about a bundle you received, the answer is in its header.

Two points to know, both checked by the installer:

* **The binary is compiled on the preparation machine**, except with `--docker`.
  Without that option, prepare the bundle on a distribution identical to the target
  or older. `install_offline.sh` runs the binary before concluding and,
  if it does not start, recompiles from the vendored source when `cmake` is
  present — otherwise it stops and says so.
* **The Python wheels are tied to the Python version.** With `--docker`
  this is handled automatically; otherwise, prepare the bundle with the same `x.y` as the target
  (`--python python3.11`). On a mismatch, pip refuses the wheels and the
  message names both versions.

### The bundle in numbers

> The repository does **not** contain a bundle: `deploy/voice/offline/` keeps only
> `MANIFEST.txt` there, the one from the last bundle built (useful to compare the
> checksums of a bundle you received). Binaries, models, voices and wheels are rebuilt
> with `fetch_offline.sh`; `install_offline.sh` refuses to run without them.

Example of a Debian 12 bundle (three models, four voices):

| Part | Size | Content |
|---|---|---|
| `models/` | 1.8 GB | `ggml-small-q5_1` (181 MB) + `ggml-large-v3-turbo-q5_0` (547 MB) + `ggml-large-v3-q5_0` (1.01 GB) |
| `voices/` | 267 MB | `fr_FR-siwis-medium`, `fr_FR-tom-medium`, `fr_FR-upmc-medium`, `fr_FR-mls-medium` |
| `wheels/` | 81 MB | Python 3.11 wheels of the synthesis service |
| `bin/` | 9.2 MB | `whisper-server`, its ggml libraries, and **`libgomp.so.1`** |
| **total** | **~2.2 GB** | |

The three models cover the three uses: `small-q5_1` on a modest machine,
`large-v3-turbo-q5_0` for latency, `large-v3-q5_0` for **maximum quality in
French** — it is the largest model published quantized, and there is no reason
to take the f16 (2.9 GB) for a gain that is inaudible in dictation.

For voices, `medium` **is** the top of Piper's French range: the
`rhasspy/piper-voices` catalog publishes no `fr_FR` voice in `high`. The four
bundled voices are therefore the best available; you choose among them in the
admin console (Models & services › Voice).

`libgomp` (the OpenMP runtime) is bundled on purpose: it comes with
`build-essential` on the build machine, but is **missing on a bare Debian** —
without it the binary refuses to start, and that is exactly the kind of
failure you only discover on the customer's site.

`install_offline.sh` picks **the smallest** model by default (it runs
everywhere) and lists the others; use `--model large-v3-q5_0` on a server that
can handle it.

### Adding a model or voice to an already built bundle

`--skip-build` touches **neither the binary nor the wheels**: it only
completes `models/` and `voices/`, then rebuilds `MANIFEST.txt`.

```bash
bash deploy/voice/fetch_offline.sh --skip-build \
     --model large-v3-q5_0 \
     --voices fr_FR-siwis-medium,fr_FR-tom-medium,fr_FR-upmc-medium,fr_FR-mls-medium
```

This is the only correct way to extend a bundle prepared for an **other**
distribution: running again without this option would recompile the binary here and
overwrite the target's. The manifest header still announces the binary's original
distribution, not that of the machine that ran the script.

### Does the bundle hold up? One command

```bash
bash deploy/voice/essai_lot.sh          # debian:bookworm-slim by default
```

It spins up a **fresh** machine in the target distribution, with only the base
tools and **the network cut**, then installs the bundle, starts both services
as the systemd units would, and runs the full loop: a sentence is
synthesized, resampled to 16 kHz, and fed back to recognition.

Example run (2.2 GB bundle):

```
    synthese : {"ok":true,"voice":"fr_FR-siwis-medium","installed":4,...}
    reconnaissance : HTTP 200
    dit       : Bonjour, ceci est un essai du moteur vocal.
    transcrit : Bonjour, ceci est un essai du moteur vocal.
    LA BOUCLE EST BONNE
```

The test machine has neither compiler nor pip: whatever the bundle is missing shows
up there, not on the production server.

### What the script checks before saying "ready"

With `--docker`, two tests run in the target distribution:

1. the binary is **launched** (`--help`) and the glibc version it actually
   requires is recorded;
2. the wheels are **installed offline** in a fresh venv, then imported.

A bundle that fails either test is not declared ready. That is two minutes
here instead of a round trip to the target machine.

The bundle is **outside git** (`deploy/voice/offline/`); only `MANIFEST.txt`
is versioned. Checksums are re-verified
at installation: a truncated copy is refused immediately, instead of
producing a service that dies three minutes later on an unreadable model.

`--no-stt` / `--no-tts` install only one of the two services.

## Configuration on the Elpis side

Admin console › Models & services › **Voice**, or directly
in `config.json`:

```json
"voice": {
  "enabled": true,
  "stt": { "endpoint_url": "http://machine-stt:8090", "format": "whisper.cpp", "language": "fr" },
  "tts": { "endpoint_url": "http://machine-tts:8091", "format": "elpis-tts",
           "voice": "fr_FR-siwis-medium", "token": "<content of token.env>" }
}
```

Synthesis formats:

| Format | Server | Call |
|---|---|---|
| `elpis-tts` | `deploy/voice/tts` (this repository) | `POST /tts` |
| `piper-http` | `python -m piper.http_server` (Piper 1.x installed by hand) | `POST /synthesize` (Piper ≥ 1.5), fallback `POST /` (1.3–1.4) |
| `openai` | OpenAI, Kokoro-FastAPI, speaches… | `POST /v1/audio/speech` — **`model` required** (e.g. `tts-1`) |

Optional keys per section: `verify` (`false` for an HTTPS engine with a
self-signed certificate), `max_concurrent` (STT: 1 by default, whisper-server
handles one request at a time), `timeout_sec`. `tts.max_chars` is capped at 4000.

The console's **Test** button queries both services without saving anything,
**and** tells you what is still missing for it to work: engine
disabled, configuration not saved, user checkboxes, HTTPS.

## Checking by hand

```bash
# recognition — the WAV must be 16 kHz mono
curl -F file=@essai.wav -F response_format=verbose_json -F language=fr \
     http://machine-stt:8090/inference

# synthesis — elpis-tts (add -H "Authorization: Bearer <token>" if token.env exists)
curl -X POST http://machine-tts:8091/tts -H 'Content-Type: application/json' \
     -d '{"text":"Bonjour, ceci est un essai."}' -o essai.wav
ffprobe essai.wav

# synthesis — piper.http_server installed by hand (port 5000 by default)
curl -X POST http://machine-tts:5000/synthesize -H 'Content-Type: application/json' \
     -d '{"text":"Bonjour, ceci est un essai."}' -o essai.wav

# health
curl http://machine-stt:8090/health           # {"status":"ok"}
curl http://machine-tts:8091/health           # {"ok":true,"service":"elpis-tts",...}
```

**Run these `curl` commands from the Elpis host**, not from the inference machine:
the host is what makes the calls, and a firewall or a `127.0.0.1` listener
is only visible from there.

## Troubleshooting

In the order you meet them:

| Symptom | Cause | Action |
|---|---|---|
| The mic button does not appear, or the Dictation checkbox is greyed out | the application is served over **HTTP on a LAN IP**: browsers only open the mic over **HTTPS or on `localhost`** | enable HTTPS (Caddy): Admin console › System › HTTPS access |
| The mic button does not appear | `voice.enabled` is `false`, or the STT address is empty, or the config is not **saved** | Admin console › Models & services › Voice, check Enable, **Save** |
| Everything is configured, still nothing | "Dictation" and "Voice reply" are **unchecked by default for each user** (`/transcribe` answers 403) | each account: Settings › Chat › Voice › Dictation / Voice reply |
| Nothing after enabling in the console | active features are read when the page loads | **reload the page** (including tabs that are already open) |
| "Token rejected by the voice engine" | the token generated by `install_tts.sh` (`token.env`) was not copied over | `sudo cat /opt/elpis-voice/tts/token.env`, paste the value into the console |
| "Path not found" (formerly "HTTP 404") on synthesis | a hand-installed Piper (`python -m piper.http_server`) has no `/tts` | format **`piper-http`**, address = base (`http://machine:5000`) |
| "Path not found" on recognition | wrong format, or the address points at something other than whisper-server | format `whisper.cpp` + address `http://machine:8090` |
| "Voice engine unreachable" with a hand-installed whisper-server | it listens by default on **`127.0.0.1:8080`** | restart with `--host 0.0.0.0 --port 8090` (and filter the port, see `stt/README.md`) |
| "Voice engine unreachable", voice services on another machine | the units listen on **`127.0.0.1`** by default | reinstall with `install_offline.sh --lan` (or `ELPIS_VOICE_HOST=<private IP>`), or `systemctl edit` (`WHISPER_HOST`, `ELPIS_TTS_HOST`); filter the ports |
| "Voice engine unreachable" | service stopped, or firewall | `systemctl status elpis-whisper` / `elpis-tts`, then the `curl` above **from the Elpis host** |
| `openai` format on synthesis: HTTP 400/422 | `model` field missing | set `tts.model` (e.g. `tts-1`) |
| "Dictation engine busy" (503) | utterances queued beyond 15 s | smaller model, or GPU; `stt.max_concurrent` > 1 does not help whisper-server |
| Long utterances return 504 | CPU too slow for the model | `small-q5_1` on CPU; the timeout already grows with duration (10 s + 3 s per second of audio) |
| Certificate error toward an HTTPS engine | self-signed certificate | `"verify": false` in the relevant section |
| A dictated "Merci." does not appear | whisper was unsure (low score or high `no_speech_prob`): the phrase is treated as a hallucination | speak closer to the mic; long phrases are not affected |
| Latency suddenly tripled | a second `whisper-server` is running with other settings | `pgrep -a whisper-server` |
| Phantom transcriptions during silences | anti-hallucination filter bypassed | check that the STT address points at whisper and not at a chat model |
| The voice reads backticks and URLs | request sent without going through `/api/voice/speak` | markdown cleaning is on the Elpis side, not in the service |

## Windows variant

No Windows script ships in this repository: `whisper-server` and
`tts/tts_service.py` can be launched there by hand, on 8090 / 8091, and then
their addresses entered in the admin console.

## Origin

Recognition and synthesis reuse the engine of an earlier project,
made reachable over HTTP and with no local mic or speaker.
