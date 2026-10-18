// SPDX-License-Identifier: MIT
/** apps/core/src/voix/config.ts — configuration vocale coercée (défauts, bornes) relue à chaque appel, et drapeaux pour le front. */
import { arrondiEntierPy, arrondiPy, floatPy, maxPy, minPy, stripPy, strPy, veritePy } from "@elpis/commun";
import { configView } from "@elpis/config";

const STT_FORMATS = ["whisper.cpp", "openai", "llama-audio"];
const TTS_FORMATS = ["elpis-tts", "piper-http", "openai"];

const BORNES: Readonly<Record<string, readonly [number, number]>> = {
  logprob_min: [-5.0, 0.0],
  timeout_sec: [5, 300],
  max_upload_mb: [1, 50],
  max_utterance_sec: [3, 120],
  max_concurrent: [1, 8],
  speed: [0.5, 2.0],
  max_chars: [200, 4000],
};

export interface ConfigVoix {
  enabled: boolean;
  stt: Record<string, unknown> & { endpoint_url: string };
  tts: Record<string, unknown> & { endpoint_url: string };
}

type Dict = Record<string, unknown>;

function estDict(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function texte(valeur: unknown, defaut: string): string {
  if (valeur === null || valeur === undefined) return defaut;
  return stripPy(strPy(valeur)) || defaut;
}

/** Booléen tolérant du formulaire : `"false"`, `"0"`, `"non"`, `"no"`, `"off"` valent faux. */
function booleen(valeur: unknown, defaut: boolean): boolean {
  if (valeur === null || valeur === undefined) return defaut;
  if (typeof valeur === "boolean") return valeur;
  const t = stripPy(strPy(valeur)).toLowerCase();
  if (!t) return defaut;
  return !["false", "0", "non", "no", "off"].includes(t);
}

/** `float()` puis bornes avec `min`/`max` de Python (NaN donne le plafond), puis `int(round(v))` ou `round(v, 3)`. */
function nombre(cle: string, valeur: unknown, defaut: number, entier: boolean): number {
  const [bas, haut] = BORNES[cle] ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  let v: number;
  try {
    v = valeur === null || valeur === undefined ? defaut : floatPy(valeur);
  } catch {
    v = defaut;
  }
  v = maxPy(bas, minPy(haut, v));
  return entier ? arrondiEntierPy(v) : arrondiPy(v, 3);
}

/** `str(x or "")` : toute valeur fausse au sens de Python donne "". */
function chaineBrute(valeur: unknown): string {
  return veritePy(valeur) ? strPy(valeur) : "";
}

/** `get_voice_config()` : `enabled` strict (`is True`), formats inconnus ramenés au défaut. */
export function configVoix(vue: Dict = configView() as Dict): ConfigVoix {
  const brut = estDict(vue["voice"]) ? vue["voice"] : {};
  const stt = estDict(brut["stt"]) ? brut["stt"] : {};
  const tts = estDict(brut["tts"]) ? brut["tts"] : {};
  let formatStt = texte(stt["format"], "whisper.cpp").toLowerCase();
  if (!STT_FORMATS.includes(formatStt)) formatStt = "whisper.cpp";
  let formatTts = texte(tts["format"], "elpis-tts").toLowerCase();
  if (!TTS_FORMATS.includes(formatTts)) formatTts = "elpis-tts";
  return {
    enabled: brut["enabled"] === true,
    stt: {
      endpoint_url: texte(stt["endpoint_url"], "").replace(/\/+$/, ""),
      format: formatStt,
      model: texte(stt["model"], ""),
      language: texte(stt["language"], "fr"),
      prompt: Array.from(chaineBrute(stt["prompt"])).slice(0, 2000).join(""),
      token: stripPy(chaineBrute(stt["token"])),
      logprob_min: nombre("logprob_min", stt["logprob_min"], -1.0, false),
      timeout_sec: nombre("timeout_sec", stt["timeout_sec"], 30, true),
      max_upload_mb: nombre("max_upload_mb", stt["max_upload_mb"], 10, true),
      max_utterance_sec: nombre("max_utterance_sec", stt["max_utterance_sec"], 30, true),
      max_concurrent: nombre("max_concurrent", stt["max_concurrent"], 1, true),
      verify: booleen(stt["verify"], true),
    },
    tts: {
      endpoint_url: texte(tts["endpoint_url"], "").replace(/\/+$/, ""),
      format: formatTts,
      model: texte(tts["model"], ""),
      token: stripPy(chaineBrute(tts["token"])),
      voice: texte(tts["voice"], "fr_FR-siwis-medium"),
      speed: nombre("speed", tts["speed"], 1.0, false),
      timeout_sec: nombre("timeout_sec", tts["timeout_sec"], 30, true),
      max_chars: nombre("max_chars", tts["max_chars"], 4000, true),
      max_concurrent: nombre("max_concurrent", tts["max_concurrent"], 2, true),
      verify: booleen(tts["verify"], true),
    },
  };
}

/** `(reconnaissance, synthèse)` : une adresse vide vaut « éteint ». */
export function drapeauxVoix(cfg: ConfigVoix = configVoix()): [boolean, boolean] {
  if (!cfg.enabled) return [false, false];
  return [Boolean(cfg.stt.endpoint_url), Boolean(cfg.tts.endpoint_url)];
}
