// SPDX-License-Identifier: MIT
/** apps/core/src/voix/client.ts — seul client des services vocaux du LAN (whisper.cpp, OpenAI, llama-audio ; elpis-tts, piper, OpenAI) : URL venue de la config seule, pannes traduites en messages actionnables. */
import { randomBytes } from "node:crypto";
import * as tls from "node:tls";

import {
  arrondiPy,
  compilerRe,
  ErreurPython,
  estDict,
  FlottantPy,
  getPy,
  iterPy,
  maxPy,
  minPy,
  nomTypePy,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  stripPy,
  strPy,
  texteJsonPy,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { autoritesTls } from "@elpis/http";
import { Agent, request } from "undici";
import type { Dispatcher } from "undici";

import { decoderRemplacement } from "../bureau";
import {
  AGENT_UTILISATEUR,
  HTTPError,
  ReponseHttp,
  TimeoutException,
  TransportError,
  traduireErreur,
} from "../llm/client-http";
import { journal } from "../journal";
import { audioCtxPour } from "./audio";
import { VoiceDesactive, VoiceError, VoiceInjoignable, VoiceRefus, VoiceTimeout } from "./erreurs";
import type { ClientVoix } from "./ports";

const log = journal("voice");

/** Section `stt` ou `tts` coercée par `configVoix`. */
export type SectionVoix = Record<string, unknown> & { endpoint_url: string };

export const STT_DELAI_FIXE_SEC = 10;
export const STT_DELAI_PAR_SEC = 3;
export const STT_DELAI_PLAFOND_SEC = 180;
const DELAI_LISTE_SEC = 5.0;
const ROUTES_CONNUES = [
  "/v1/audio/transcriptions",
  "/v1/audio/speech",
  "/v1/chat/completions",
  "/inference",
  "/synthesize",
  "/tts",
];

/** Schéma absent ou inconnu (`httpx.UnsupportedProtocol`). */
class UnsupportedProtocol extends TransportError {
  override name = "UnsupportedProtocol";
}

function motif(source: string, global = false): RegExp {
  const r = compilerRe(source);
  return global ? new RegExp(r.source, r.flags + "g") : r;
}

const THINK = motif("(?i)<think>[\\s\\S]*?</think>", true);
const FENCES = motif("^```[a-zA-Z]*\\n?|\\n?```$", true);

function texte(v: unknown): string {
  return v === null || v === undefined ? "" : strPy(v);
}

/** `max(timeout_sec, 10 + 3 × durée)`, la part proportionnelle plafonnée à 180 s. */
export function delaiStt(timeoutSec: number, dureeMs: number): number {
  const proportionnel = STT_DELAI_FIXE_SEC + (STT_DELAI_PAR_SEC * maxPy(dureeMs, 0.0)) / 1000.0;
  return Math.trunc(maxPy(Math.trunc(timeoutSec), minPy(proportionnel, STT_DELAI_PLAFOND_SEC)));
}

/** `_url` : base ou route complète, `/v1` jamais doublé ; adresse vide = fonction désactivée. */
export function urlMoteur(base: string | null | undefined, suffixe: string): string {
  const b = (base ?? "").replace(/\/+$/, "");
  if (!b) throw new VoiceDesactive("Aucune adresse configurée pour le moteur vocal.");
  if (b.endsWith(suffixe)) return b;
  if (suffixe.startsWith("/v1/") && b.endsWith("/v1")) return b + suffixe.slice(3);
  return b + suffixe;
}

function entetes(token: unknown): Record<string, string> {
  return veritePy(token) ? { Authorization: `Bearer ${strPy(token)}` } : {};
}

/** `charset` du Content-Type tel que le lit httpx (`email.message`), en minuscules ; `null` s'il manque. */
function charsetHttpx(type: string | null): string | null {
  if (!type) return null;
  for (const p of type.split(";").slice(1)) {
    const i = p.indexOf("=");
    if (i >= 0 && p.slice(0, i).trim().toLowerCase() === "charset")
      return (
        p
          .slice(i + 1)
          .trim()
          .replace(/^"(.*)"$/, "$1")
          .toLowerCase() || null
      );
  }
  return null;
}

/** `.text` de httpx : charset déclaré (codecs de Python), sinon UTF-8, octets invalides remplacés. */
export function texteHttpx(r: ReponseHttp): string {
  return decoderRemplacement(r.content, charsetHttpx(r.headers.get("content-type")) ?? "utf-8");
}

/** `reponse.json()` de httpx : décodage de `json.loads(octets)`, flottants Python gardés. */
function jsonReponse(r: ReponseHttp): unknown {
  return pyJsonLoads(texteJsonPy(r.content));
}

/** `_detail_http` : message d'erreur lisible (`error.message`, `error`, `detail`, sinon le texte), 200 caractères au plus. */
export function detailHttp(r: ReponseHttp): string {
  const lu = ((): string | null => {
    try {
      const corps = jsonReponse(r);
      const err = estDict(corps) ? getPy(corps, "error") : null;
      if (estDict(err))
        return prefixePy(texte(veritePy(getPy(err, "message")) ? getPy(err, "message") : ""), 200);
      if (veritePy(err)) return prefixePy(strPy(err), 200);
      if (estDict(corps) && veritePy(getPy(corps, "detail"))) return prefixePy(strPy(corps["detail"]), 200);
      return null;
    } catch {
      return null;
    }
  })();
  return lu ?? prefixePy(stripPy(texteHttpx(r)), 200);
}

/** `_message_http` : ce que veut dire un code du moteur, et le geste qui le corrige. */
export function messageHttp(code: number): string {
  if (code === 401 || code === 403) return "Jeton refusé par le moteur vocal : vérifiez le jeton.";
  if (code === 404 || code === 405)
    return "Chemin introuvable sur le moteur vocal : vérifiez l'adresse et le format.";
  if (code === 413) return "Envoi trop volumineux pour le moteur vocal (texte ou audio trop long).";
  if (code >= 500) return `Le moteur vocal est en erreur (HTTP ${code}) : consultez son journal.`;
  return `Le moteur vocal a répondu HTTP ${code}.`;
}

const contextes = new WeakMap<readonly string[], tls.SecureContext>();

function contexte(): tls.SecureContext {
  const autorites = autoritesTls();
  let ctx = contextes.get(autorites);
  if (ctx === undefined) {
    ctx = tls.createSecureContext({ ca: [...autorites] });
    contextes.set(autorites, ctx);
  }
  return ctx;
}

type Corps = { octets: Uint8Array; type: string };
type OptionsEnvoi = {
  delai: number;
  connexion: number;
  verify: boolean;
  entetes: Record<string, string>;
  corps?: Corps;
  signal?: AbortSignal;
};

/** Une requête comme un `httpx.AsyncClient` jetable (`trust_env=False`) : délai de lecture et de connexion, `verify` par section, erreurs aux noms de httpx. */
async function envoyer(methode: "GET" | "POST", url: string, o: OptionsEnvoi): Promise<ReponseHttp> {
  let schema: string;
  try {
    schema = new URL(url).protocol;
  } catch {
    throw new UnsupportedProtocol("Request URL is missing an 'http://' or 'https://' protocol.");
  }
  if (schema !== "http:" && schema !== "https:")
    throw new UnsupportedProtocol("Request URL has an unsupported protocol");
  const ms = (s: number): number => Math.max(1, Math.round(s * 1000));
  const agent = new Agent({
    connect: {
      timeout: ms(o.connexion),
      rejectUnauthorized: o.verify,
      ...(o.verify ? { secureContext: contexte() } : {}),
    },
    allowH2: false,
  });
  const tete: Record<string, string> = { accept: "*/*", "user-agent": AGENT_UTILISATEUR };
  if (o.corps) tete["content-type"] = o.corps.type;
  for (const [k, v] of Object.entries(o.entetes)) tete[k.toLowerCase()] = v;
  let recues = false;
  try {
    const rep = await request(url, {
      method: methode,
      headers: tete,
      body: o.corps ? Buffer.from(o.corps.octets) : undefined,
      dispatcher: agent,
      headersTimeout: ms(o.delai),
      bodyTimeout: ms(o.delai),
      ...(o.signal ? { signal: o.signal } : {}),
    });
    recues = true;
    const contenu = new Uint8Array(await rep.body.arrayBuffer());
    const h = new Headers();
    for (const [k, v] of Object.entries(rep.headers as Dispatcher.ResponseData["headers"])) {
      if (Array.isArray(v)) for (const x of v) h.append(k, x);
      else if (v !== undefined) h.set(k, v);
    }
    return new ReponseHttp({
      statusCode: rep.statusCode,
      request: { method: methode, url },
      headers: h,
      content: contenu,
    });
  } catch (e) {
    throw traduireErreur(e, recues);
  } finally {
    void agent.destroy().catch(() => undefined);
  }
}

function enVoice(e: unknown, url: string): unknown {
  const detail = `${url} : ${e instanceof Error ? e.name : "Error"}`;
  if (e instanceof TimeoutException)
    return new VoiceTimeout("Le moteur vocal n'a pas répondu à temps.", { detail });
  if (e instanceof HTTPError) return new VoiceInjoignable("Moteur vocal injoignable.", { detail });
  return e;
}

/** `_poste` : POST traduit ; tout autre statut que 200 = `VoiceRefus` portant le code du moteur. */
async function poste(url: string, o: OptionsEnvoi): Promise<ReponseHttp> {
  let r: ReponseHttp;
  try {
    r = await envoyer("POST", url, o);
  } catch (e) {
    throw enVoice(e, url);
  }
  if (r.statusCode !== 200)
    throw new VoiceRefus(messageHttp(r.statusCode), { detail: detailHttp(r), code: r.statusCode });
  return r;
}

/** `_lit` : GET court (5 s, connexion 3 s), mêmes traductions de panne. */
async function lit(url: string, cfg: SectionVoix): Promise<ReponseHttp> {
  let r: ReponseHttp;
  try {
    r = await envoyer("GET", url, {
      delai: DELAI_LISTE_SEC,
      connexion: 3.0,
      verify: cfg["verify"] !== false,
      entetes: entetes(cfg["token"] ?? ""),
    });
  } catch (e) {
    throw enVoice(e, url);
  }
  if (r.statusCode !== 200)
    throw new VoiceRefus(messageHttp(r.statusCode), { detail: detailHttp(r), code: r.statusCode });
  return r;
}

/** `json=` de httpx : compact, UTF-8 (non ASCII), NaN refusé. */
function corpsJson(valeur: unknown): Corps {
  const texteJson = pyJsonDumps(valeur, { ensureAscii: false, separators: [",", ":"], allowNan: false });
  return { octets: Buffer.from(texteJson, "utf-8"), type: "application/json" };
}

/** `_format_form_param` de httpx : `"` → `%22`, `\\` doublé, contrôles (sauf ESC) en `%XX`. */
function encoderParametre(valeur: string): string {
  let sortie = "";
  for (const c of valeur) {
    const code = c.charCodeAt(0);
    if (c === '"') sortie += "%22";
    else if (c === "\\") sortie += "\\\\";
    else if (code <= 0x1f && code !== 0x1b) sortie += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
    else sortie += c;
  }
  return sortie;
}

/** `files=` + `data=` de httpx : champs puis le fichier, frontière de 32 caractères hexadécimaux. */
export function multipartHttpx(
  champs: readonly (readonly [string, string])[],
  fichier: { champ: string; nom: string; type: string; data: Uint8Array },
  frontiere = randomBytes(16).toString("hex"),
): Corps {
  const param = (nom: string, valeur: string): string => `${nom}="${encoderParametre(valeur)}"`;
  const morceaux: Buffer[] = [];
  for (const [nom, valeur] of champs)
    morceaux.push(
      Buffer.from(`--${frontiere}\r\nContent-Disposition: form-data; ${param("name", nom)}\r\n\r\n`),
      Buffer.from(valeur, "utf-8"),
      Buffer.from("\r\n"),
    );
  morceaux.push(
    Buffer.from(
      `--${frontiere}\r\nContent-Disposition: form-data; ${param("name", fichier.champ)}; ${param("filename", fichier.nom)}\r\nContent-Type: ${fichier.type}\r\n\r\n`,
    ),
    Buffer.from(fichier.data),
    Buffer.from(`\r\n--${frontiere}--\r\n`),
  );
  return { octets: Buffer.concat(morceaux), type: `multipart/form-data; boundary=${frontiere}` };
}

/** Nombre d'un `isinstance(x, (int, float))` (booléen compris), sinon `null`. */
function nombreJson(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof FlottantPy) return v.valeur;
  return null;
}

/** `_confiance` : moyenne des `avg_logprob`, maximum des `no_speech_prob` des segments ; `null` sans score. */
export function confiance(charge: Dict): [number | null, number | null] {
  const brut = veritePy(getPy(charge, "segments")) ? getPy(charge, "segments") : [];
  const segments = iterPy(brut);
  if (segments === null) throw new ErreurPython("TypeError", `'${nomTypePy(brut)}' object is not iterable`);
  const logprobs: number[] = [];
  const silences: number[] = [];
  for (const s of segments) {
    if (!estDict(s)) continue;
    const l = nombreJson(getPy(s, "avg_logprob"));
    if (l !== null) logprobs.push(l);
    const n = nombreJson(getPy(s, "no_speech_prob"));
    if (n !== null) silences.push(n);
  }
  const somme = logprobs.reduce((a, b) => a + b, 0);
  const [premier = 0, ...autres] = silences;
  return [
    logprobs.length ? somme / logprobs.length : null,
    silences.length ? maxPy(premier, ...autres) : null,
  ];
}

function texteTranscrit(charge: unknown): string {
  if (estDict(charge)) return stripPy(texte(veritePy(getPy(charge, "text")) ? getPy(charge, "text") : ""));
  return stripPy(texte(veritePy(charge) ? charge : ""));
}

export type Transcription = { text: string; avg_logprob: number | null; no_speech_prob: number | null };

/** WAV 16 kHz mono → texte et scores, dans le dialecte de la section (`whisper.cpp`, `openai`, `llama-audio`). */
export async function transcribe(wav: Uint8Array, cfg: SectionVoix, dureeMs: number): Promise<Transcription> {
  const fmt = cfg["format"];
  const timeout = delaiStt(Number(cfg["timeout_sec"]), dureeMs);
  const tete = entetes(cfg["token"] ?? "");
  const verify = cfg["verify"] !== false;
  if (fmt === "llama-audio") return transcribeLlama(wav, cfg, timeout, tete);
  let url: string;
  let donnees: [string, string][];
  if (fmt === "openai") {
    url = urlMoteur(cfg.endpoint_url, "/v1/audio/transcriptions");
    donnees = [
      ["response_format", "verbose_json"],
      ["language", texte(cfg["language"])],
      ["temperature", "0"],
    ];
    if (veritePy(cfg["model"])) donnees.push(["model", texte(cfg["model"])]);
    if (veritePy(cfg["prompt"])) donnees.push(["prompt", texte(cfg["prompt"])]);
  } else {
    url = urlMoteur(cfg.endpoint_url, "/inference");
    donnees = [
      ["temperature", "0.0"],
      ["temperature_inc", "0.0"],
      ["audio_ctx", String(audioCtxPour(dureeMs))],
      ["beam_size", "1"],
      ["response_format", "verbose_json"],
      ["language", texte(cfg["language"])],
    ];
    if (veritePy(cfg["prompt"])) donnees.push(["prompt", texte(cfg["prompt"])]);
  }
  const envoie = (champs: [string, string][]): Promise<ReponseHttp> =>
    poste(url, {
      delai: timeout,
      connexion: 5.0,
      verify,
      entetes: tete,
      corps: multipartHttpx(champs, { champ: "file", nom: "dictee.wav", type: "audio/wav", data: wav }),
    });
  let reponse: ReponseHttp;
  try {
    reponse = await envoie(donnees);
  } catch (e) {
    if (fmt !== "openai" || !(e instanceof VoiceRefus) || e.code !== 400) throw e;
    log.info("[voice] verbose_json refusé (HTTP 400) — repli sur json");
    reponse = await envoie(donnees.map(([k, v]) => [k, k === "response_format" ? "json" : v]));
  }
  let charge: unknown;
  try {
    charge = jsonReponse(reponse);
  } catch {
    return { text: stripPy(texteHttpx(reponse)), avg_logprob: null, no_speech_prob: null };
  }
  const [logprob, silence] = confiance(estDict(charge) ? charge : {});
  return { text: texteTranscrit(charge), avg_logprob: logprob, no_speech_prob: silence };
}

/** Voie de dépannage : GGUF audio servi par llama-server, audio en `input_audio` d'un chat, sans score. */
async function transcribeLlama(
  wav: Uint8Array,
  cfg: SectionVoix,
  timeout: number,
  tete: Record<string, string>,
): Promise<Transcription> {
  const url = urlMoteur(cfg.endpoint_url, "/v1/chat/completions");
  const consigne = veritePy(cfg["prompt"])
    ? cfg["prompt"]
    : "Transcris exactement ce qui est dit dans cet audio. " +
      "Ne réponds rien d'autre que la transcription, sans commentaire ni ponctuation ajoutée.";
  const corps: Dict = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: consigne },
          { type: "input_audio", input_audio: { data: Buffer.from(wav).toString("base64"), format: "wav" } },
        ],
      },
    ],
    temperature: 0,
    stream: false,
  };
  if (veritePy(cfg["model"])) corps["model"] = cfg["model"];
  const reponse = await poste(url, {
    delai: timeout,
    connexion: 5.0,
    verify: cfg["verify"] !== false,
    entetes: tete,
    corps: corpsJson(corps),
  });
  let contenu: unknown;
  try {
    const choix = getPy(jsonReponse(reponse), "choices");
    const premier = Array.isArray(choix) ? choix[0] : undefined;
    if (premier === undefined || !estDict(premier) || !Object.hasOwn(premier, "message"))
      throw new Error("forme");
    const message = premier["message"];
    if (!estDict(message) || !Object.hasOwn(message, "content")) throw new Error("forme");
    contenu = message["content"];
  } catch {
    throw new VoiceRefus("Réponse inattendue du moteur audio.", {
      detail: "format chat/completions non reconnu",
    });
  }
  if (Array.isArray(contenu))
    contenu = contenu
      .filter(estDict)
      .map((p, i) => {
        const t = getPy(p, "text", "");
        if (typeof t !== "string")
          throw new ErreurPython(
            "TypeError",
            `sequence item ${i}: expected str instance, ${nomTypePy(t)} found`,
          );
        return t;
      })
      .join(" ");
  let resultat = stripPy(strPy(contenu).replace(THINK, ""));
  if (resultat.startsWith("```")) resultat = stripPy(resultat.replace(FENCES, ""));
  return { text: resultat, avg_logprob: null, no_speech_prob: null };
}

/** Texte → `(octets audio, type MIME)` ; la voix vient de la section, jamais du navigateur. */
export async function synthesize(
  texteADire: string,
  cfg: SectionVoix,
  voix = "",
): Promise<[Uint8Array, string]> {
  const timeout = Math.trunc(Number(cfg["timeout_sec"]));
  const tete = entetes(cfg["token"] ?? "");
  const verify = cfg["verify"] !== false;
  const nomVoix = stripPy(voix || texte(cfg["voice"]));
  const vitesse = versFlottantPy(Number(cfg["speed"]));
  let reponse: ReponseHttp;
  if (cfg["format"] === "piper-http") reponse = await synthesePiper(texteADire, cfg, nomVoix, timeout, tete);
  else {
    let url: string;
    let corps: Dict;
    if (cfg["format"] === "openai") {
      url = urlMoteur(cfg.endpoint_url, "/v1/audio/speech");
      corps = { input: texteADire, voice: nomVoix, response_format: "wav", speed: vitesse };
      if (veritePy(cfg["model"])) corps["model"] = cfg["model"];
    } else {
      url = urlMoteur(cfg.endpoint_url, "/tts");
      corps = { text: texteADire, voice: nomVoix, speed: vitesse };
    }
    reponse = await poste(url, {
      delai: timeout,
      connexion: 5.0,
      verify,
      entetes: tete,
      corps: corpsJson(corps),
    });
  }
  const audio = reponse.content;
  if (audio.length === 0) throw new VoiceRefus("Le moteur de synthèse a rendu un son vide.");
  let mime = stripPy((reponse.headers.get("content-type") || "audio/wav").split(";")[0] ?? "");
  if (!mime.startsWith("audio/")) mime = "audio/wav";
  return [audio, mime];
}

/** `python -m piper.http_server` : `POST /synthesize` (Piper ≥ 1.5), repli sur `POST /` sur 404/405 ; vitesse en `length_scale`. */
async function synthesePiper(
  texteADire: string,
  cfg: SectionVoix,
  nomVoix: string,
  timeout: number,
  tete: Record<string, string>,
): Promise<ReponseHttp> {
  const base = (cfg.endpoint_url || "").replace(/\/+$/, "");
  if (!base) throw new VoiceDesactive("Aucune adresse configurée pour le moteur vocal.");
  const corps: Dict = { text: texteADire };
  if (nomVoix) corps["voice"] = nomVoix;
  const vitesse = veritePy(cfg["speed"]) ? Number(cfg["speed"]) : 1.0;
  if (Math.abs(vitesse - 1.0) > 1e-3) corps["length_scale"] = versFlottantPy(arrondiPy(1.0 / vitesse, 3));
  const o: OptionsEnvoi = {
    delai: timeout,
    connexion: 5.0,
    verify: cfg["verify"] !== false,
    entetes: tete,
    corps: corpsJson(corps),
  };
  if (base.endsWith("/synthesize")) return poste(base, o);
  try {
    return await poste(base + "/synthesize", o);
  } catch (e) {
    if (!(e instanceof VoiceRefus) || (e.code !== 404 && e.code !== 405)) throw e;
  }
  return poste(base + "/", o);
}

/** WAV d'une seconde de silence (16 kHz mono 16 bits), comme le module `wave`. */
export function silenceWav(): Uint8Array {
  const donnees = 16000 * 2;
  const tete = Buffer.alloc(44);
  tete.write("RIFF", 0, "latin1");
  tete.writeUInt32LE(36 + donnees, 4);
  tete.write("WAVEfmt ", 8, "latin1");
  tete.writeUInt32LE(16, 16);
  tete.writeUInt16LE(1, 20);
  tete.writeUInt16LE(1, 22);
  tete.writeUInt32LE(16000, 24);
  tete.writeUInt32LE(32000, 28);
  tete.writeUInt16LE(2, 32);
  tete.writeUInt16LE(16, 34);
  tete.write("data", 36, "latin1");
  tete.writeUInt32LE(donnees, 40);
  return Buffer.concat([tete, Buffer.alloc(donnees)]);
}

/** Bouton « Tester » (reconnaissance) : une seconde de silence ; une transcription vide est un succès. */
export async function sondeStt(cfg: SectionVoix): Promise<Dict> {
  const r = await transcribe(silenceWav(), cfg, 1000.0);
  return { text: r.text, format: cfg["format"] };
}

/** Bouton « Tester » (synthèse) : trois mots, octets rendus et voix installées. */
export async function sondeTts(cfg: SectionVoix): Promise<Dict> {
  const [audio, mime] = await synthesize("Essai du moteur vocal.", cfg);
  return { bytes: audio.length, mime, voices: await voixDisponibles(cfg) };
}

/** Voix installées (`elpis-tts`, `piper-http`) ; `[]` sur toute panne, jamais bloquant. */
export async function voixDisponibles(cfg: SectionVoix): Promise<string[]> {
  if ((cfg["format"] !== "elpis-tts" && cfg["format"] !== "piper-http") || !veritePy(cfg.endpoint_url))
    return [];
  let liste: Dict;
  try {
    liste = await listeModeles("tts", cfg);
  } catch {
    return [];
  }
  return (liste["models"] as Dict[]).filter((m) => veritePy(m["id"])).map((m) => m["id"] as string);
}

/** `_racine` : la base sans une route d'appel collée par l'administrateur. */
export function racineMoteur(base: string | null | undefined): string {
  const b = (base ?? "").replace(/\/+$/, "");
  if (!b) throw new VoiceDesactive("Aucune adresse renseignée.");
  for (const route of ROUTES_CONNUES)
    if (b.endsWith(route)) return b.slice(0, -route.length).replace(/\/+$/, "");
  return b;
}

function jsonAttendu(r: ReponseHttp): unknown {
  try {
    return jsonReponse(r);
  } catch {
    throw new VoiceRefus("Réponse inattendue du moteur vocal (JSON attendu).", {
      detail: prefixePy(texteHttpx(r), 200),
    });
  }
}

/** `_courant` : l'élément annoncé chargé, sinon celui configuré s'il existe, sinon l'unique élément. */
export function courant(
  ids: readonly string[],
  configure: string,
  annonce: string | null = null,
): string | null {
  if (annonce && ids.includes(annonce)) return annonce;
  if (configure && ids.includes(configure)) return configure;
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

function identifiant(m: unknown): string {
  const brut = estDict(m)
    ? ([getPy(m, "id"), getPy(m, "model"), getPy(m, "name")].find((x) => veritePy(x)) ?? getPy(m, "name"))
    : m;
  return stripPy(texte(veritePy(brut) ? brut : ""));
}

async function modelesOpenai(cfg: SectionVoix): Promise<Dict> {
  const racine = racineMoteur(cfg.endpoint_url);
  const urls = racine.endsWith("/v1") ? [racine + "/models"] : [racine + "/v1/models", racine + "/models"];
  let reponse: ReponseHttp | null = null;
  let url = "";
  for (const [n, u] of urls.entries()) {
    url = u;
    try {
      reponse = await lit(u, cfg);
      break;
    } catch (e) {
      if (!(e instanceof VoiceRefus) || e.code !== 404 || n === urls.length - 1) throw e;
    }
  }
  const charge = jsonAttendu(reponse as ReponseHttp);
  let brut: unknown = [];
  if (estDict(charge)) brut = [getPy(charge, "data"), getPy(charge, "models")].find((x) => veritePy(x)) ?? [];
  else if (Array.isArray(charge)) brut = charge;
  const elements = iterPy(brut);
  if (elements === null) throw new ErreurPython("TypeError", `'${nomTypePy(brut)}' object is not iterable`);
  const modeles: Dict[] = [];
  const vus = new Set<string>();
  for (const m of elements) {
    const ident = identifiant(m);
    if (ident && !vus.has(ident)) {
      vus.add(ident);
      modeles.push({ id: ident, label: ident });
    }
  }
  const ids = modeles.map((m) => m["id"] as string);
  return {
    models: modeles,
    current: courant(ids, texte(cfg["model"] ?? "")),
    source: "GET " + (url.startsWith(racine) ? url.slice(racine.length) : url),
  };
}

async function modelesWhisper(cfg: SectionVoix): Promise<Dict> {
  const racine = racineMoteur(cfg.endpoint_url);
  let source = "GET /health";
  try {
    await lit(racine + "/health", cfg);
  } catch (e) {
    if (e instanceof VoiceRefus && e.code === 503)
      throw new VoiceRefus("whisper-server charge encore son modèle : réessayez dans un instant.", {
        code: 503,
      });
    if (!(e instanceof VoiceRefus) || e.code !== 404) throw e;
    await lit(racine + "/", cfg);
    source = "GET /";
  }
  return {
    models: [{ id: "", label: "Modèle chargé par le serveur" }],
    current: "",
    source,
    detail:
      "whisper-server ne publie pas le nom de son modèle ; " +
      "le champ Modèle est ignoré par ce format (choisi par -m au démarrage).",
  };
}

async function voixElpis(cfg: SectionVoix): Promise<Dict> {
  let charge = jsonAttendu(await lit(racineMoteur(cfg.endpoint_url) + "/voices", cfg));
  if (!estDict(charge)) charge = {};
  const installees = veritePy(getPy(charge, "installed")) ? getPy(charge, "installed") : [];
  const elements = iterPy(installees);
  if (elements === null)
    throw new ErreurPython("TypeError", `'${nomTypePy(installees)}' object is not iterable`);
  const modeles: Dict[] = [];
  for (const v of elements) {
    if (!estDict(v) || !veritePy(getPy(v, "name"))) continue;
    const qualite = stripPy(texte(veritePy(getPy(v, "quality")) ? getPy(v, "quality") : ""));
    const nom = strPy(v["name"]);
    modeles.push({ id: nom, label: qualite ? `${nom} (${qualite})` : nom });
  }
  const ids = modeles.map((m) => m["id"] as string);
  const defaut = texte(veritePy(getPy(charge, "default")) ? getPy(charge, "default") : "");
  return { models: modeles, current: courant(ids, texte(cfg["voice"] ?? ""), defaut), source: "GET /voices" };
}

async function voixPiper(cfg: SectionVoix): Promise<Dict> {
  const racine = racineMoteur(cfg.endpoint_url);
  const charge = jsonAttendu(await lit(racine + "/voices", cfg));
  const modeles: Dict[] = [];
  for (const [nom, conf] of estDict(charge) ? Object.entries(charge) : []) {
    let qualite: unknown = "";
    if (estDict(conf)) {
      const audio = veritePy(getPy(conf, "audio")) ? getPy(conf, "audio") : {};
      qualite = getPy(audio, "quality");
    }
    const n = strPy(nom);
    modeles.push({ id: n, label: veritePy(qualite) ? `${n} (${strPy(qualite)})` : n });
  }
  let annonce: string | null = null;
  try {
    const info = jsonAttendu(await lit(racine + "/info", cfg));
    const v = getPy(veritePy(info) ? info : {}, "voice");
    const nom = getPy(veritePy(v) ? v : {}, "name");
    annonce = texte(veritePy(nom) ? nom : "") || null;
  } catch (e) {
    if (!(e instanceof VoiceError) && !(e instanceof ErreurPython && e.type === "AttributeError")) throw e;
  }
  const ids = modeles.map((m) => m["id"] as string);
  return {
    models: modeles,
    current: courant(ids, texte(cfg["voice"] ?? ""), annonce),
    source: "GET /voices",
  };
}

/** `liste_modeles` : `{models, current, source, detail?}` selon la section et son format. */
export async function listeModeles(section: string, cfg: SectionVoix): Promise<Dict> {
  const fmt = cfg["format"] ?? "";
  if (section === "stt") return fmt === "whisper.cpp" ? modelesWhisper(cfg) : modelesOpenai(cfg);
  if (fmt === "elpis-tts") return voixElpis(cfg);
  if (fmt === "piper-http") return voixPiper(cfg);
  return modelesOpenai(cfg);
}

/** Client du moteur vocal pour la console d'administration (port `ClientVoix`), branché par `composer`. */
export const CLIENT_VOIX: ClientVoix = {
  sondeStt: (cfg) => sondeStt(cfg as SectionVoix),
  sondeTts: (cfg) => sondeTts(cfg as SectionVoix),
  listeModeles: (section, cfg) => listeModeles(section, cfg as SectionVoix),
};
