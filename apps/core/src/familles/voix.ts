// SPDX-License-Identifier: MIT
/** apps/core/src/familles/voix.ts — `/api/voice/*` : état pour le front, dictée (WAV → texte) et lecture (texte → WAV), créneaux, débit par compte, petit cache (shared_infra/voice/routes.py). */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { getUserSettings } from "@elpis/auth";
import {
  arrondiEntierPy,
  encoderUtf8Py,
  estDict,
  fixePy,
  FlottantPy,
  getPy,
  HttpError,
  longueurPy,
  reprFlottant,
  splitPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Executeur } from "@elpis/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { journal } from "../journal";
import type { Famille } from "../routes";
import { AudioInvalide, DUREE_MINIMALE_MS, dureeMs, valideWavDictee } from "../voix/audio";
import type { EnTeteWav } from "../voix/audio";
import { synthesize, transcribe } from "../voix/client";
import type { SectionVoix, Transcription } from "../voix/client";
import { configVoix, drapeauxVoix } from "../voix/config";
import { VoiceError } from "../voix/erreurs";
import { estBruit } from "../voix/filtre";
import { estPrononcable, pourLaVoix } from "../voix/texte";
import { utilisateur } from "./comptes";
import { corpsJsonValeurs, lireFormulaire, reponseJsonPy, valeursFormulaire } from "@elpis/http";

const log = journal("voice");

/** Moteur appelé par les routes : remplaçable dans les tests (`_TRANSPORT` de Python). */
export interface MoteurVoix {
  transcribe(wav: Uint8Array, cfg: SectionVoix, dureeMs: number): Promise<Transcription>;
  synthesize(texte: string, cfg: SectionVoix): Promise<[Uint8Array, string]>;
}

export interface DependancesVoix {
  readonly base: Executeur;
  readonly moteur?: MoteurVoix;
}

/** Réglages des gardes (attente d'un créneau, fenêtre et plafonds de débit), modifiables par les tests comme en Python. */
export const REGLAGES_VOIX = {
  attenteCreneauMaxSec: 15,
  fenetreSec: 60.0,
  debitMax: { transcribe: 60, speak: 120 } as Record<"transcribe" | "speak", number>,
  cacheMaxEntrees: 8,
  cacheMaxOctets: 16 * 1024 * 1024,
};

/** Délai d'attente d'un créneau dépassé (`asyncio.TimeoutError`). */
export class AttenteDepassee extends Error {
  override name = "TimeoutError";
}

/** Sémaphore dont le plafond change sans perdre ses détenteurs : la baisse crée une dette remboursée par les `rendre()`. */
export class Jauge {
  capacite: number;
  private libres: number;
  private dette = 0;
  private readonly attentes: (() => void)[] = [];

  constructor(capacite: number) {
    this.capacite = capacite;
    this.libres = capacite;
  }

  private verrouillee(): boolean {
    return this.libres <= 0 || this.attentes.length > 0;
  }

  private liberer(): void {
    const suivant = this.attentes.shift();
    if (suivant) suivant();
    else this.libres++;
  }

  private ajuster(capacite: number): void {
    const ecart = capacite - this.capacite;
    this.capacite = capacite;
    if (ecart > 0) {
      const rembourse = Math.min(ecart, this.dette);
      this.dette -= rembourse;
      for (let i = 0; i < ecart - rembourse; i++) this.liberer();
    } else if (ecart < 0) {
      this.dette += -ecart;
      while (this.dette && !this.verrouillee()) {
        this.libres--;
        this.dette--;
      }
    }
  }

  /** Prend un créneau ; `AttenteDepassee` si aucun ne se libère avant `attenteSec`. */
  async prendre(capacite: number, attenteSec: number): Promise<void> {
    if (capacite !== this.capacite) this.ajuster(capacite);
    if (!this.verrouillee()) {
      this.libres--;
      return;
    }
    await new Promise<void>((ok, ko) => {
      const reveil = (): void => {
        clearTimeout(minuterie);
        ok();
      };
      const minuterie = setTimeout(
        () => {
          const i = this.attentes.indexOf(reveil);
          if (i >= 0) this.attentes.splice(i, 1);
          ko(new AttenteDepassee());
        },
        Math.max(0, attenteSec * 1000),
      );
      this.attentes.push(reveil);
    });
  }

  rendre(): void {
    if (this.dette) this.dette--;
    else this.liberer();
  }
}

const jauges = new Map<string, Jauge>();
const debits = new Map<string, number[]>();
const cacheTts = new Map<string, [Uint8Array, string]>();
let horloge: () => number = () => performance.now() / 1000;

/** Tests : vide créneaux, débits et cache ; horloge monotone remplaçable. */
export function reinitialiserVoix(h?: () => number): void {
  jauges.clear();
  debits.clear();
  cacheTts.clear();
  horloge = h ?? (() => performance.now() / 1000);
}

export function jaugeVoix(nom: string, capacite: number): Jauge {
  let j = jauges.get(nom);
  if (j === undefined) {
    j = new Jauge(capacite);
    jauges.set(nom, j);
  }
  return j;
}

/** Exécute `appel` dans un créneau du moteur, ou 503 si aucun ne se libère à temps (attente ≤ 15 s). */
async function sousPlafond<T>(
  nom: string,
  capacite: number,
  attenteSec: number,
  message: string,
  appel: () => Promise<T>,
): Promise<T> {
  const jauge = jaugeVoix(nom, capacite);
  try {
    await jauge.prendre(capacite, Math.min(attenteSec, REGLAGES_VOIX.attenteCreneauMaxSec));
  } catch (e) {
    if (!(e instanceof AttenteDepassee)) throw e;
    log.info(`[voice] ${nom} : aucun créneau libre (plafond ${capacite})`);
    throw new HttpError(503, message);
  }
  try {
    return await appel();
  } finally {
    jauge.rendre();
  }
}

/** Fenêtre glissante d'une minute par (route, compte), en mémoire ; au-delà de 1024 entrées, les inactifs sont purgés. */
export function controleDebit(route: "transcribe" | "speak", uid: number): void {
  const maintenant = horloge();
  const cle = `${route}\u0000${uid}`;
  let file = debits.get(cle);
  if (file === undefined) {
    file = [];
    debits.set(cle, file);
  }
  while (file.length && maintenant - (file[0] ?? 0) > REGLAGES_VOIX.fenetreSec) file.shift();
  if (file.length >= REGLAGES_VOIX.debitMax[route])
    throw new HttpError(429, "Trop de requêtes vocales en une minute : patientez un instant.");
  file.push(maintenant);
  if (debits.size > 1024)
    for (const [c, f] of [...debits])
      if (!f.length || maintenant - (f[f.length - 1] ?? 0) > REGLAGES_VOIX.fenetreSec) debits.delete(c);
}

/** `_cle_cache` : tout ce qui change le son (moteur, format, modèle, voix, débit) et le texte, haché. */
export function cleCache(texte: string, tts: SectionVoix): string {
  const vitesse = veritePy(tts["speed"]) ? Number(tts["speed"]) : 1.0;
  const parties = [
    strPy(tts.endpoint_url ?? ""),
    strPy(tts["format"] ?? ""),
    strPy(tts["model"] ?? ""),
    strPy(tts["voice"] ?? ""),
    reprFlottant(vitesse),
    texte,
  ];
  return createHash("sha256")
    .update(encoderUtf8Py(parties.join("\x1f")))
    .digest("hex")
    .slice(0, 32);
}

function cacheLit(cle: string): [Uint8Array, string] | undefined {
  const valeur = cacheTts.get(cle);
  if (valeur !== undefined) {
    cacheTts.delete(cle);
    cacheTts.set(cle, valeur);
  }
  return valeur;
}

function cacheEcrit(cle: string, audio: Uint8Array, mime: string): void {
  if (audio.length > Math.floor(REGLAGES_VOIX.cacheMaxOctets / 2)) return;
  cacheTts.set(cle, [audio, mime]);
  const total = (): number => [...cacheTts.values()].reduce((s, [a]) => s + a.length, 0);
  while (cacheTts.size > REGLAGES_VOIX.cacheMaxEntrees || total() > REGLAGES_VOIX.cacheMaxOctets)
    cacheTts.delete(cacheTts.keys().next().value as string);
}

/** Réglages du compte ; illisibles = `{}` (journalisé). */
async function reglages(base: Executeur, uid: number): Promise<Dict> {
  try {
    return (await getUserSettings(base, uid)) ?? {};
  } catch {
    log.warn(`[voice] réglages illisibles pour uid=${uid}`);
    return {};
  }
}

/** Panne du moteur → HTTP ; le détail (machine du LAN, classe d'erreur) reste au journal. */
function erreurHttp(e: VoiceError): HttpError {
  if (e.detail) log.warn(`[voice] ${e.message} — ${e.detail}`);
  return new HttpError(e.statut, e.message);
}

/** Réponse d'une route annotée (`-> Dict[str, Any]`) : NaN et ±inf écrits `null` comme FastAPI. */
function repondreAnnotee(rep: FastifyReply, valeur: Dict): FastifyReply {
  const propre: Dict = {};
  for (const [k, v] of Object.entries(valeur))
    propre[k] =
      (typeof v === "number" && !Number.isFinite(v)) ||
      (v instanceof FlottantPy && !Number.isFinite(v.valeur))
        ? null
        : v;
  return reponseJsonPy(rep, propre);
}

export function creerFamilleVoix(dep: DependancesVoix): Famille {
  const moteur: MoteurVoix = dep.moteur ?? { transcribe, synthesize: (t, cfg) => synthesize(t, cfg) };

  const statut = async (req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> => {
    const uid = utilisateur(req);
    const cfg = configVoix();
    const [stt, tts] = drapeauxVoix(cfg);
    const r = await reglages(dep.base, uid);
    return repondreAnnotee(rep, {
      stt,
      tts,
      dictation: stt && veritePy(getPy(r, "voice_input_enabled")),
      reply: tts && veritePy(getPy(r, "voice_reply_enabled")),
      language: cfg.stt["language"],
      sample_rate: 16000,
      max_utterance_sec: cfg.stt["max_utterance_sec"],
      max_upload_mb: cfg.stt["max_upload_mb"],
      max_chars: cfg.tts["max_chars"],
      voice: cfg.tts["voice"],
    });
  };

  const transcrire = async (req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> => {
    const uid = utilisateur(req);
    const { file } = valeursFormulaire(await lireFormulaire(req), {
      file: { type: "fichier", requis: true },
    });
    const cfg = configVoix();
    const [sttActif] = drapeauxVoix(cfg);
    if (!sttActif) throw new HttpError(403, "La dictée est désactivée sur cette instance.");
    if (!veritePy(getPy(await reglages(dep.base, uid), "voice_input_enabled")))
      throw new HttpError(403, "La dictée est désactivée dans vos paramètres.");
    controleDebit("transcribe", uid);
    const stt = cfg.stt;
    const max = Math.trunc(Number(stt["max_upload_mb"])) * 1024 * 1024;
    if (file.taille > max)
      throw new HttpError(413, `Fichier trop volumineux (plafond : ${Math.floor(max / (1024 * 1024))} Mo).`);
    const wav = new Uint8Array(await readFile(file.chemin));
    let entete: EnTeteWav;
    try {
      entete = valideWavDictee(wav, Math.trunc(Number(stt["max_utterance_sec"])));
    } catch (e) {
      if (e instanceof AudioInvalide) throw new HttpError(415, e.message);
      throw e;
    }
    const duree = dureeMs(entete);
    if (duree < DUREE_MINIMALE_MS) return repondreAnnotee(rep, { text: "", rejected: "trop court" });
    let resultat: Transcription;
    try {
      resultat = await sousPlafond(
        "stt",
        Math.trunc(Number(stt["max_concurrent"])),
        Number(stt["timeout_sec"]),
        "Moteur de dictée occupé : réessayez dans un instant.",
        () => moteur.transcribe(wav, stt, duree),
      );
    } catch (e) {
      if (e instanceof VoiceError) throw erreurHttp(e);
      throw e;
    }
    const texte = stripPy(resultat.text || "");
    const logprob = resultat.avg_logprob;
    const rejet = (raison: string): FastifyReply => {
      log.info(
        `[voice] énoncé écarté (${raison}) — ${fixePy(duree, 0)} ms, ${splitPy(texte).length} mot(s), ` +
          `logprob=${logprob === null ? "n/a" : fixePy(logprob, 2)}`,
      );
      return repondreAnnotee(rep, { text: "", rejected: raison, duration_ms: arrondiEntierPy(duree) });
    };
    if (!texte || estBruit(texte, logprob, resultat.no_speech_prob)) return rejet("bruit");
    if (logprob !== null && logprob < Number(stt["logprob_min"])) return rejet("confiance insuffisante");
    return repondreAnnotee(rep, { text: texte, duration_ms: arrondiEntierPy(duree) });
  };

  const parler = async (req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> => {
    const uid = utilisateur(req);
    const cfg = configVoix();
    const [, ttsActif] = drapeauxVoix(cfg);
    if (!ttsActif) throw new HttpError(403, "La synthèse vocale est désactivée sur cette instance.");
    let corps: unknown;
    try {
      corps = corpsJsonValeurs(req);
    } catch {
      corps = {};
    }
    if (!estDict(corps)) throw new HttpError(400, "Le payload doit être un objet JSON.");
    if (
      getPy(corps, "auto") === true &&
      !veritePy(getPy(await reglages(dep.base, uid), "voice_reply_enabled"))
    )
      throw new HttpError(403, "La réponse vocale est désactivée dans vos paramètres.");
    controleDebit("speak", uid);
    const tts = cfg.tts;
    const brut = getPy(corps, "text");
    const texte = pourLaVoix(veritePy(brut) ? strPy(brut) : "", Math.trunc(Number(tts["max_chars"])));
    if (!estPrononcable(texte)) throw new HttpError(400, "Rien à lire dans ce texte.");
    const cle = cleCache(texte, tts);
    let audio: Uint8Array;
    let mime: string;
    const enCache = cacheLit(cle);
    if (enCache !== undefined) [audio, mime] = enCache;
    else {
      try {
        [audio, mime] = await sousPlafond(
          "tts",
          Math.trunc(Number(tts["max_concurrent"])),
          Number(tts["timeout_sec"]),
          "Moteur de synthèse occupé : réessayez dans un instant.",
          () => moteur.synthesize(texte, tts),
        );
      } catch (e) {
        if (e instanceof VoiceError) throw erreurHttp(e);
        throw e;
      }
      cacheEcrit(cle, audio, mime);
    }
    return rep
      .code(200)
      .headers({
        "content-type": mime,
        "cache-control": "no-store",
        "x-elpis-voice": strPy(tts["voice"]),
        "x-elpis-chars": String(longueurPy(texte)),
      })
      .send(Buffer.from(audio));
  };

  return {
    nom: "voix",
    routes: [
      { methode: "GET", chemin: "/api/voice/status", processus: ["main"], acces: "session", traiter: statut },
      {
        methode: "POST",
        chemin: "/api/voice/transcribe",
        processus: ["main"],
        acces: "session",
        traiter: transcrire,
      },
      { methode: "POST", chemin: "/api/voice/speak", processus: ["main"], acces: "session", traiter: parler },
    ],
  };
}
