# Synthesis service — Piper

Piper is a library, not a server: `tts_service.py` wraps it in
the bare minimum so that Elpis can ask it for a WAV.

CPU only, about 20x real time on a modest machine: a three-second sentence
is synthesized in 150 ms. No sound card is required.

## Installation

```bash
sudo bash install_tts.sh                      # voice fr_FR-siwis-medium
sudo bash install_tts.sh fr_FR-tom-medium     # or another one

sudo systemctl enable --now elpis-tts
curl -s http://localhost:8091/health
```

## Voices

| Voice | Gender | Rate | Size | Note |
|---|---|---|---|---|
| `fr_FR-siwis-medium` | female | 22,050 Hz | 63 MB | the default: clear, well articulated |
| `fr_FR-siwis-low` | female | 16,000 Hz | 28 MB | twice as fast, less defined |
| `fr_FR-upmc-medium` | female and male | 22,050 Hz | 77 MB | two speakers: `jessica`, `pierre` |
| `fr_FR-tom-medium` | male | 44,100 Hz | 64 MB | the most defined of the set |
| `fr_FR-gilles-low` | male | 16,000 Hz | 63 MB | deeper timbre |
| `fr_FR-mls-medium` | various | 22,050 Hz | 77 MB | 125 readers, uneven quality |
| `fr_FR-mls_1840-low` | male | 16,000 Hz | 63 MB | a single reader |

```bash
sudo bash fetch_voices.sh fr_FR-tom-medium fr_FR-upmc-medium
sudo systemctl restart elpis-tts
```

Installed voices appear in Elpis's admin console after a click on
**Test**. A voice is visible only if **both** its files are there
(`.onnx` and `.onnx.json`) — an interrupted download is never offered.

> Piper does not clone a voice. On-the-fly cloning engines need a
> GPU and cannot hold a real-time conversation on CPU. For a different
> voice, you change the model.

## API

| Route | Body | Returns |
|---|---|---|
| `GET /health` | — | `{ok, voice, sample_rate, installed, loaded}` |
| `GET /voices` | — (token required if one is configured) | voices on disk + default voice + catalog; feeds the console's drop-down list |
| `POST /tts` | `{text, voice?, speed?, pitch?, speaker?}` | `audio/wav` |
| `POST /v1/audio/speech` | `{input, voice?, speed?}` | `audio/wav` — OpenAI alias |

The OpenAI alias exists so that another engine (Kokoro FastAPI, for example)
can take this one's place without changing anything on the Elpis side: you only need to
switch the *Format* field in the admin console.

Response headers useful for diagnosis: `X-Elpis-Voice`,
`X-Elpis-Sample-Rate`, `X-Elpis-Synth-Ms`.

## Settings

| Unit variable | Default | Role |
|---|---|---|
| `ELPIS_TTS_VOICE` | `fr_FR-siwis-medium` | default voice, preloaded at startup |
| `ELPIS_TTS_VOICES_DIR` | `/opt/elpis-voice/voices` | where the `.onnx` files are |
| `ELPIS_TTS_HOST` | `127.0.0.1` | listen address: Elpis on this machine. Elpis elsewhere: private IP or `0.0.0.0` (`ELPIS_VOICE_HOST` at installation, `install_offline.sh --lan`) |
| `ELPIS_TTS_PORT` | `8091` | to be copied into the admin console |
| `ELPIS_TTS_MAX_CHARS` | `4000` | per-request cap — Elpis never exceeds 4000 (`tts.max_chars`) |
| `ELPIS_TTS_MAX_CONCURRENT` | `2` | simultaneous syntheses |
| `ELPIS_TTS_MAX_VOICES` | `2` | voices kept in memory (the oldest is unloaded) |
| `ELPIS_TTS_THREADS` | half the cores | ONNX threads per synthesis; `0` = ONNX decides (all cores, on every synthesis) |

The token lives in `/opt/elpis-voice/tts/token.env`, never in the unit:
`systemctl cat` is readable by everyone. **It is generated at installation
and must be copied** into Elpis's admin console (Models & services › Voice › Synthesis ›
Token) — without it, every sentence answers "Jeton refusé par le moteur vocal" (the message as printed today; "Token rejected by the voice engine" in the English UI).
Delete this file for a service open on the local network.

```bash
sudo cat /opt/elpis-voice/tts/token.env        # ELPIS_TTS_TOKEN=...
```

`ProtectHome=true` in the unit: voices must live under
`/opt/elpis-voice/voices`, never in a home folder, which the
service cannot see.

Three settings travel with each request and are driven from Elpis: speed
(0.5 to 2.0), pitch (0.7 to 1.4) and the speaker for voices that carry
several. Beyond these bounds Piper produces noise — they are enforced
in the service, not only in the interface.

## What is carried over from an earlier project, and why

* **Voice loaded once, kept warm.** The first call to ONNX Runtime
  allocates its arenas and specializes its kernels: ~300 ms, paid at startup
  rather than on the first sentence read to the user.
* **`normalize_audio=False`.** Piper normalizes each call independently;
  since Elpis synthesizes sentence by sentence, normalization would make the
  volume vary from one sentence to the next in the middle of an answer.
* **Pitch through the playback rate.** Piper has no pitch setting:
  we announce a different sample rate and compensate the duration with
  `length_scale`, so that only the pitch changes, not the speaking rate.
* **Clipping before 16-bit conversion.** Without it, an overflow wraps through
  zero and is heard as a crackle.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `health` returns `ok: false` | voice missing | `sudo bash fetch_voices.sh` |
| Elpis: "Token rejected by the voice engine" (today's UI: "Jeton refusé par le moteur vocal") | the `token.env` token was not copied into the console | see *Settings* above |
| Machine saturated during playback | `ELPIS_TTS_THREADS=0` with 2 simultaneous syntheses | keep the default (half the cores) |
| `404 Voix absente du disque` (service message, printed as is) | misspelled name, or `.onnx.json` missing | `ls /opt/elpis-voice/voices` |
| `503 piper-tts n'est pas installé` (service message, printed as is) | incomplete venv | re-run `install_tts.sh` |
| First sentence slow, the following ones fast | warm-up failed at startup | `journalctl -u elpis-tts -n 30` |
| Volume jumping from one sentence to the next | `normalize_audio` re-enabled | do not touch it |
| Crackling | clipping bypassed, or `pitch` out of bounds | check the settings on the Elpis side |
