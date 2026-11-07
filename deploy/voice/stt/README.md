# Recognition service — whisper.cpp

There is **nothing to write**: `whisper-server`, shipped with whisper.cpp, *is* the
service. Elpis talks to it with `POST /inference`, multipart, `verbose_json`.

## Why a separate machine

whisper takes the GPU in short bursts, once per dictated sentence. On the
machine that serves the LLM, every dictation would make the generation in progress wait —
and the other way around. Hence two machines, or at least two GPUs.

> **The llama.cpp binaries you already have installed are of no use.** whisper.cpp is a
> separate project: `llama-server` cannot load a whisper `ggml-*.bin`
> and does not expose `/inference`. You need to build whisper.cpp (below), or
> — another route — point Elpis at a `llama-server` loaded with an audio GGUF
> (Voxtral, Qwen-Audio) by choosing the `llama-audio` format in the admin
> console. This second route reuses your binaries, but it occupies the LLM's
> GPU: it is a workaround, not the target setup.

## Installation

```bash
sudo bash build_whisper.sh          # cpu (default)
sudo bash build_whisper.sh cuda     # NVIDIA
sudo bash build_whisper.sh vulkan   # AMD / Intel, Vulkan driver
sudo bash build_whisper.sh rocm     # AMD, ROCm stack

sudo bash fetch_models.sh                       # small-q5_1 (default, CPU)
sudo bash fetch_models.sh large-v3-turbo-q5_0   # with a GPU

sudo systemctl enable --now elpis-whisper
systemctl status elpis-whisper
```

## Choosing the model

Measurements taken on an earlier project, 5 s utterance in French:

| Model | CPU | GPU | Size |
|---|---|---|---|
| `base-q5_1` | ~1,100 ms | ~150 ms | 57 MB |
| `small-q5_1` | 2,414 ms | 226 ms | 182 MB |
| `medium-q5_0` | 7,656 ms | 461 ms | 515 MB |
| `large-v3-turbo-q5_0` | 12,062 ms | 250 ms | 548 MB |

The default is `small-q5_1`, because the default build is CPU: without a GPU,
do not go beyond `small` — beyond it, the sentence arrives after you have finished speaking
the next one. On a GPU, `large-v3-turbo` costs barely more than `small` and makes far
fewer mistakes: use it, and change `WHISPER_MODEL`.

## Settings

The unit file carries five variables:

| Variable | Default | Note |
|---|---|---|
| `WHISPER_MODEL` | `.../ggml-small-q5_1.bin` | full path, under `/opt` (`ProtectHome=true` hides `/home`) |
| `WHISPER_HOST` | `127.0.0.1` | listen address — see *Security* below |
| `WHISPER_PORT` | `8090` | to be copied into Elpis's admin console |
| `WHISPER_THREADS` | empty = `nproc` | a number forces the value |
| `WHISPER_LANG` | `fr` | Elpis sends the language with each request, this is only the default |

```bash
sudo systemctl edit elpis-whisper      # clean override
sudo systemctl restart elpis-whisper
```

Two settings are deliberately **not** on the command line:
`audio_ctx` and `beam_size` travel in each request. Elpis computes
`audio_ctx` from the utterance duration — it is the number 1 latency lever
on short sentences — and it would be lost if it were frozen at startup.

## Security

whisper-server has **no authentication** and exposes `POST /load`, which
replaces the loaded model: anyone who reaches the port can hijack it or
bring it down. Hence `127.0.0.1` by default: Elpis on the same machine.
Elpis on **another** machine: open
the listener at installation (`ELPIS_VOICE_HOST=<private IP>` or
`install_offline.sh --lan` for `0.0.0.0`), or afterwards with
`systemctl edit elpis-whisper` (`WHISPER_HOST`). Then one or the other:

* listen on the private interface only: `WHISPER_HOST=10.0.0.12`;
* filter the port at the firewall, for the Elpis host only:

```bash
sudo ufw allow from <Elpis-host-IP> to any port 8090 proto tcp
sudo ufw deny 8090/tcp
```

Reinstalling (`build_whisper.sh`, `install_offline.sh`) rewrites the unit: pass
`ELPIS_VOICE_HOST` (or `--lan`) again to keep a network listener.

## Checking

```bash
# a test WAV, 16 kHz mono
ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -ac 1 -ar 16000 essai.wav
curl -F file=@essai.wav -F response_format=verbose_json -F language=fr \
     http://localhost:8090/inference
```

The response must contain `segments[].avg_logprob` and `no_speech_prob`: Elpis
uses them to reject doubtful transcriptions. If `response_format` is
ignored, the server is too old — rebuild.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `whisper-server introuvable après compilation` (the script's message, printed as is) | the binary changed name depending on the version; look in `/opt/elpis-voice/src/whisper.cpp/build/bin` |
| The service starts then stops | model missing or unreadable: `journalctl -u elpis-whisper -n 50` |
| Everything runs on CPU despite `cuda` | the backend library is not next to the binary; check `LD_LIBRARY_PATH` in the unit |
| Empty transcriptions | the WAV is not 16 kHz mono |
| Invented sentences during silences | expected: Elpis filters on the application server side (hallucination list + log-probability threshold) |
