// SPDX-License-Identifier: MIT
/** apps/core/src/llm/sonde-moteur.ts — sonde du moteur déclaré (démarrage, bouton « Tester ») : adresses du profil, version, modèle servi, contexte, métriques, options manquantes et drapeau exact à ajouter. */
import { stripPy, strPy, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";

import { sonderTokenisation } from "../contexte/tokens";
import { journal } from "../journal";
import { estDict } from "../python";
import { getPy } from "./dict-py";
import { parseBuild } from "./fournisseurs/llama-capacites";
import { getAdminClient, monotonic, perModelPath } from "./llama-http";
import { etatCharge, metriquesReconnues } from "./metriques-moteur";
import type { EtatCharge } from "./metriques-moteur";
import { extractNCtx, extractSlots } from "./modeles";
import { builtinEngine, currentEngine } from "./moteurs";
import type { EngineRef } from "./moteurs";
import type { TypeMoteur } from "./profils";

const log = journal("moteur");

/** Ce qu'un moteur dit de lui-même hors `/v1/models` (`/props`, `/version`, `/server_info`) ; champs choisis, jamais la réponse brute. */
export interface InfosServeur {
  version: string | null;
  contexte: number | null;
  capaciteKv: number | null;
  maxRequetes: number | null;
  metriquesActives: boolean | null;
  jetonsEnCacheActifs: boolean | null;
  /** `undefined` = le moteur ne l'expose pas ; `null` = aucun parseur. */
  parseurReflexion: string | null | undefined;
  parseurOutils: string | null | undefined;
}

export interface AdresseSondee {
  role: string;
  chemin: string;
  statut: number;
  ok: boolean;
}

export interface ConseilMoteur {
  code: string;
  niveau: "erreur" | "avertissement" | "info";
  message: string;
}

export interface RapportMoteur {
  cle: string;
  type: TypeMoteur;
  libelle: string;
  base_url: string;
  joignable: boolean;
  version: string | null;
  modeles: { id: string; max_model_len: number | null }[];
  modele_declare: string;
  modele_servi: string | null;
  contexte: number | null;
  metriques: boolean | null;
  tokenisation: boolean | null;
  jetons_en_cache: boolean | null;
  /** Le moteur dit quels parseurs sont actifs (SGLang) ; sinon `parseur_*` restent `null` sans rien conclure. */
  parseurs_connus: boolean;
  parseur_reflexion: string | null;
  parseur_outils: string | null;
  concurrence: { mode: "file" | "moteur"; max: number | null };
  chargement: boolean;
  cle_api: boolean;
  adresses: AdresseSondee[];
  charge: EtatCharge | null;
  conseils: ConseilMoteur[];
  sonde_a: number;
}

const INFOS_TTL_S = 300.0;
const INFOS_ECHEC_TTL_S = 30.0;
const infos = new Map<string, { t: number; ttl: number; valeur: InfosServeur }>();
const observations = new Map<string, Set<string>>();
let dernierRapport: RapportMoteur | null = null;

const VIDE: InfosServeur = {
  version: null,
  contexte: null,
  capaciteKv: null,
  maxRequetes: null,
  metriquesActives: null,
  jetonsEnCacheActifs: null,
  parseurReflexion: undefined,
  parseurOutils: undefined,
};

function entetes(engine: EngineRef): Record<string, string> | null {
  const h = engine.headerDict();
  return Object.keys(h).length > 0 ? h : null;
}

function entierPositif(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : null;
}

function texteOuNul(v: unknown): string | null {
  return typeof v === "string" && stripPy(v) ? stripPy(v) : null;
}

function booleen(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** Champs utiles d'une réponse d'information selon le type ; tout le reste (clé d'API de SGLang comprise) est ignoré. */
export function lireInfos(type: TypeMoteur, corps: unknown): InfosServeur {
  if (!estDict(corps)) return { ...VIDE };
  if (type === "llamacpp") {
    const build = parseBuild(getPy(corps, "build_info"));
    const n = extractNCtx(corps);
    const slots = extractSlots(corps);
    return {
      ...VIDE,
      version: build > 0 ? `b${build}` : texteOuNul(getPy(corps, "build_info")),
      contexte: n > 0 ? n : null,
      maxRequetes: slots > 0 ? slots : null,
    };
  }
  if (type === "vllm") return { ...VIDE, version: texteOuNul(getPy(corps, "version")) };
  if (type === "sglang") {
    const reflexion = getPy(corps, "reasoning_parser");
    const outils = getPy(corps, "tool_call_parser");
    return {
      version: texteOuNul(getPy(corps, "version")),
      contexte: entierPositif(getPy(corps, "context_length")),
      capaciteKv: entierPositif(getPy(corps, "max_total_num_tokens")),
      maxRequetes: entierPositif(getPy(corps, "max_running_requests")),
      metriquesActives: booleen(getPy(corps, "enable_metrics")),
      jetonsEnCacheActifs: booleen(getPy(corps, "enable_cache_report")),
      parseurReflexion: typeof reflexion === "string" ? texteOuNul(reflexion) : null,
      parseurOutils: typeof outils === "string" ? texteOuNul(outils) : null,
    };
  }
  return { ...VIDE };
}

/** Informations du moteur (`/props`, `/version`, `/server_info`), mémorisées 5 min (30 s après un échec) par serveur. */
export async function infosServeur(
  engine: EngineRef,
  options: { force?: boolean } = {},
): Promise<InfosServeur> {
  const profil = engine.profil;
  const chemin = profil.chemins.infos ?? profil.chemins.version;
  if (chemin === null) return { ...VIDE };
  const cle = `${engine.key}|${engine.baseRoot}`;
  const hit = infos.get(cle);
  if (!options.force && hit !== undefined && monotonic() - hit.t < hit.ttl) return hit.valeur;
  let valeur: InfosServeur = { ...VIDE };
  let ttl = INFOS_ECHEC_TTL_S;
  try {
    const r = await getAdminClient().get(engine.url(chemin), { timeout: 4.0, headers: entetes(engine) });
    if (r.statusCode === 200) {
      valeur = lireInfos(profil.type, r.json());
      ttl = INFOS_TTL_S;
    }
  } catch (e) {
    log.debug(`${chemin} illisible (${String(e).slice(0, 120)})`);
  }
  infos.set(cle, { t: monotonic(), ttl, valeur });
  return valeur;
}

/** Capacité du cache KV en jetons quand le moteur la donne hors métriques (SGLang : `max_total_num_tokens`) ; 0 sinon. */
export async function capaciteKvConnue(engine: EngineRef): Promise<number> {
  if (engine.profil.type !== "sglang") return 0;
  try {
    return (await infosServeur(engine)).capaciteKv ?? 0;
  } catch {
    return 0;
  }
}

/** Ce que le flux révèle d'une option manquante (réflexion en balises, appels d'outils en texte), retenu par serveur. */
export type ObservationMoteur =
  "reflexion_en_ligne" | "outils_en_texte" | "outils_avales" | "jetons_en_cache_absents";

export function noterObservation(engine: EngineRef, code: ObservationMoteur): void {
  if (engine.profil.type !== "vllm" && engine.profil.type !== "sglang") return;
  let s = observations.get(engine.key);
  if (s === undefined) {
    s = new Set();
    observations.set(engine.key, s);
  }
  if (s.has(code)) return;
  s.add(code);
  const d = engine.profil.drapeaux;
  log.warn(
    `[moteur] ${engine.profil.libelle} (${engine.key}) : ` +
      (code === "reflexion_en_ligne"
        ? `réflexion reçue dans la réponse, ${d.reflexion ?? "parseur de réflexion à activer"}`
        : code === "outils_en_texte"
          ? `appels d'outils reçus en texte, ${d.outils ?? "parseur d'outils à activer"}`
          : code === "outils_avales"
            ? "réponse vide après la réflexion alors que des outils étaient offerts : le parseur d'appels d'outils " +
              "ou le parseur de réflexion ne correspond peut-être pas au modèle"
            : `jetons repris du cache non rapportés, ${d.jetonsEnCache ?? "option du serveur à activer"}`),
  );
}

/** Parseurs d'appels d'outils SGLang attendus d'après le nom du modèle, pour les formats sans ambiguïté ; `null` = rien à conclure. */
export function parseursOutilsAttendus(modele: string | null | undefined): string[] | null {
  const m = (modele || "").toLowerCase();
  const coder = (segment: string): boolean => {
    const i = segment.indexOf("qwen3");
    return i >= 0 && segment.indexOf("coder", i) >= 0;
  };
  if (m.split("/").some(coder)) return ["qwen3_coder"];
  if (/glm-?4\.7/u.test(m)) return ["glm47"];
  if (/glm-?4\.[56]/u.test(m)) return ["glm45", "glm"];
  if (/kimi-?k2/u.test(m)) return ["kimi_k2"];
  if (/minimax-?m2/u.test(m)) return ["minimax-m2"];
  if (/gpt-oss/u.test(m)) return ["gpt-oss"];
  return null;
}

/** Usage d'une réponse de vLLM sans `prompt_tokens_details` : serveur lancé sans l'option des jetons en cache (observé une fois). */
export function observerUsage(usage: unknown): void {
  if (!estDict(usage) || Object.keys(usage).length === 0 || estDict(getPy(usage, "prompt_tokens_details")))
    return;
  let engine: EngineRef;
  try {
    engine = currentEngine();
  } catch {
    return;
  }
  if (engine.profil.type === "vllm") noterObservation(engine, "jetons_en_cache_absents");
}

/** Oublie les sondes et observations mémorisées (tests, connecteur modifié). */
export function oublierSondes(): void {
  infos.clear();
  observations.clear();
  dernierRapport = null;
}

/** Dernier rapport du serveur intégré (démarrage ou « Tester »), conseils mis à jour des observations depuis ; `null` avant la première sonde. */
export function dernierRapportIntegre(): RapportMoteur | null {
  if (dernierRapport === null) return null;
  const engine = builtinEngine();
  const observees = observations.get(engine.key) ?? new Set<string>();
  const r = { ...dernierRapport };
  if (r.jetons_en_cache === null && observees.has("jetons_en_cache_absents")) r.jetons_en_cache = false;
  r.conseils = conseils(engine, r, observees);
  return r;
}

function lireModeles(corps: unknown): { id: string; max_model_len: number | null }[] {
  const data = estDict(corps) ? getPy(corps, "data") : null;
  if (!Array.isArray(data)) return [];
  return data
    .filter((m) => estDict(m) && veritePy(getPy(m, "id")))
    .map((m) => ({ id: strPy(getPy(m, "id")), max_model_len: entierPositif(getPy(m, "max_model_len")) }));
}

/** `prompt_tokens_details` présent sur une complétion d'un jeton (vLLM ne le rend qu'avec l'option du serveur). */
async function testerJetonsEnCache(engine: EngineRef, modele: string): Promise<boolean | null> {
  try {
    const r = await getAdminClient().post(engine.url(engine.profil.chemins.chat), {
      json: { model: modele, messages: [{ role: "user", content: "OK" }], max_tokens: 1, stream: false },
      timeout: 60.0,
      headers: entetes(engine),
    });
    if (r.statusCode !== 200) return null;
    const usage = getPy(r.json(), "usage");
    return estDict(usage) && estDict(getPy(usage, "prompt_tokens_details"));
  } catch {
    return null;
  }
}

function conseils(engine: EngineRef, r: RapportMoteur, observees: ReadonlySet<string>): ConseilMoteur[] {
  const profil = engine.profil;
  const d = profil.drapeaux;
  const out: ConseilMoteur[] = [];
  const ajouter = (code: string, niveau: ConseilMoteur["niveau"], message: string): void => {
    out.push({ code, niveau, message });
  };
  const cible = engine.isBuiltin ? "llama.url" : "l'adresse du connecteur";
  if (!r.joignable) {
    const chemin = profil.chemins.sante ?? profil.chemins.modeles;
    ajouter(
      "injoignable",
      "erreur",
      `${profil.libelle} ne répond pas sur ${r.base_url}${chemin} : vérifiez ${cible} et que le serveur est lancé.`,
    );
    return out;
  }
  const refus = r.adresses.find((a) => a.statut === 401 || a.statut === 403);
  if (refus !== undefined)
    ajouter(
      "cle",
      "erreur",
      `Clé refusée (HTTP ${refus.statut} sur ${refus.chemin}) : ` +
        (engine.isBuiltin
          ? `renseignez llama.api_key avec la valeur de ${d.cle ?? "la clé"} du serveur.`
          : "vérifiez la clé du connecteur."),
    );
  for (const a of r.adresses) {
    if (a.ok || a.statut === 401 || a.statut === 403 || a.role === "métriques") continue;
    ajouter(
      "adresse",
      "avertissement",
      `Adresse attendue ${a.chemin} (${a.role}) : ${a.statut ? `HTTP ${a.statut}` : "sans réponse"}.`,
    );
  }
  if (r.metriques === false)
    ajouter(
      "metriques",
      "avertissement",
      `Métriques indisponibles (cache KV, charge du moteur) : ${d.metriques ?? "activez-les sur le serveur"}.`,
    );
  if (r.tokenisation === false)
    ajouter("tokenisation", "info", "Comptage exact des jetons indisponible : Elpis estime les jetons.");
  if (r.jetons_en_cache === false && d.jetonsEnCache)
    ajouter("jetons_en_cache", "info", `Jetons repris du cache non rapportés : ${d.jetonsEnCache}.`);
  if (observees.has("reflexion_en_ligne") && d.reflexion)
    ajouter("reflexion", "avertissement", `Réflexion reçue dans la réponse : ${d.reflexion}.`);
  else if (r.parseurs_connus && r.parseur_reflexion === null && d.reflexion)
    ajouter("reflexion", "info", `Aucun parseur de réflexion : si le modèle réfléchit, ${d.reflexion}.`);
  if (((r.parseurs_connus && r.parseur_outils === null) || observees.has("outils_en_texte")) && d.outils)
    ajouter(
      "outils",
      "avertissement",
      `Appels d'outils non séparés par le serveur : ${d.outils}, sinon le modèle n'appelle pas les outils d'Elpis.`,
    );
  else if (observees.has("outils_avales") && d.outils)
    ajouter(
      "outils",
      "avertissement",
      `Réponse vide après la réflexion alors que des outils étaient offerts : le parseur d'appels d'outils ou le ` +
        `parseur de réflexion ne correspond peut-être pas au modèle (outils : ${d.outils} ; réflexion : ` +
        `${d.reflexion ?? "parseur du modèle"}).`,
    );
  const attendus = r.parseurs_connus && r.parseur_outils ? parseursOutilsAttendus(r.modele_servi) : null;
  if (attendus !== null && r.parseur_outils && !attendus.includes(r.parseur_outils))
    ajouter(
      "parseur_outils",
      "info",
      `Parseur d'appels d'outils « ${r.parseur_outils} » pour ${r.modele_servi ?? "ce modèle"} : son format ` +
        `attend --tool-call-parser ${attendus[0] ?? ""} (un parseur inadapté avale les appels ou les livre en texte).`,
    );
  if (
    profil.capacites.modelesServisCharges &&
    r.modele_declare &&
    r.modeles.length > 0 &&
    !r.modeles.some((m) => m.id === r.modele_declare)
  )
    ajouter(
      "modele",
      "avertissement",
      `Modèle déclaré « ${r.modele_declare} » non servi par ${profil.libelle} (servi : ` +
        `${r.modeles.map((m) => m.id).join(", ")}) : ` +
        (engine.isBuiltin ? "corrigez llama.model." : "corrigez le modèle du connecteur."),
    );
  return out;
}

/** Sonde complète d'un moteur d'après son profil (métriques d'un routeur llama.cpp : celles du modèle chargé) ; `generation` autorise une complétion d'un jeton. */
export async function sonderMoteur(
  engine: EngineRef,
  options: { generation?: boolean; modele?: string } = {},
): Promise<RapportMoteur> {
  const profil = engine.profil;
  const client = getAdminClient();
  const h = entetes(engine);
  const adresses: AdresseSondee[] = [];
  const appeler = async (role: string, chemin: string) => {
    try {
      const r = await client.get(engine.url(chemin), { timeout: 4.0, headers: h });
      adresses.push({ role, chemin, statut: r.statusCode, ok: r.statusCode === 200 });
      return r;
    } catch {
      adresses.push({ role, chemin, statut: 0, ok: false });
      return null;
    }
  };
  const modeleDeclare = stripPy(options.modele ?? (engine.isBuiltin ? config.LLAMA_MODEL || "" : ""));
  const rapport: RapportMoteur = {
    cle: engine.key,
    type: profil.type,
    libelle: profil.libelle,
    base_url: engine.baseRoot,
    joignable: false,
    version: null,
    modeles: [],
    modele_declare: modeleDeclare,
    modele_servi: null,
    contexte: null,
    metriques: profil.chemins.metriques === null ? null : false,
    tokenisation: profil.chemins.tokenisation === null ? null : false,
    jetons_en_cache: profil.capacites.jetonsEnCache === "toujours" ? true : null,
    parseurs_connus: false,
    parseur_reflexion: null,
    parseur_outils: null,
    concurrence: { mode: profil.capacites.file ? "file" : "moteur", max: null },
    chargement: profil.capacites.chargement,
    cle_api: h !== null,
    adresses,
    charge: null,
    conseils: [],
    sonde_a: Date.now() / 1000,
  };
  const sante = await appeler(
    profil.chemins.sante ? "santé" : "modèles",
    profil.chemins.sante ?? profil.chemins.modeles,
  );
  rapport.joignable = sante !== null && sante.statusCode < 500;
  if (rapport.joignable) {
    const cheminInfos = profil.chemins.infos ?? profil.chemins.version;
    const cheminMetriques = profil.chemins.metriques
      ? await perModelPath(profil.chemins.metriques, engine)
      : null;
    if (profil.chemins.metriques && cheminMetriques === null) rapport.metriques = null;
    const [modeles, reponseInfos, metriques, tok] = await Promise.all([
      profil.chemins.sante ? appeler("modèles", profil.chemins.modeles) : Promise.resolve(sante),
      cheminInfos ? appeler("version", cheminInfos) : Promise.resolve(null),
      cheminMetriques ? appeler("métriques", cheminMetriques) : Promise.resolve(null),
      sonderTokenisation(engine),
    ]);
    let inf: InfosServeur = { ...VIDE };
    if (reponseInfos !== null && reponseInfos.statusCode === 200) {
      try {
        inf = lireInfos(profil.type, reponseInfos.json());
        infos.set(`${engine.key}|${engine.baseRoot}`, { t: monotonic(), ttl: INFOS_TTL_S, valeur: inf });
      } catch {
        inf = { ...VIDE };
      }
    }
    let corpsModeles: unknown = null;
    if (modeles !== null && modeles.statusCode === 200) {
      try {
        corpsModeles = modeles.json();
      } catch {
        corpsModeles = null;
      }
    }
    rapport.modeles = lireModeles(corpsModeles);
    rapport.modele_servi =
      rapport.modeles.find((m) => m.id === modeleDeclare)?.id ?? rapport.modeles[0]?.id ?? null;
    rapport.version = inf.version;
    rapport.contexte =
      profil.capacites.contexte === "modeles"
        ? (rapport.modeles.find((m) => m.id === rapport.modele_servi)?.max_model_len ?? inf.contexte)
        : inf.contexte;
    rapport.concurrence.max = inf.maxRequetes;
    if (inf.parseurReflexion !== undefined && inf.parseurOutils !== undefined) {
      rapport.parseurs_connus = true;
      rapport.parseur_reflexion = inf.parseurReflexion;
      rapport.parseur_outils = inf.parseurOutils;
    }
    if (metriques !== null) {
      const texte = metriques.statusCode === 200 ? metriques.text : null;
      rapport.metriques = texte !== null && metriquesReconnues(profil, texte);
      if (rapport.metriques)
        rapport.charge = etatCharge(profil, texte, {
          cle: `sonde|${engine.key}`,
          capaciteKv: inf.capaciteKv ?? 0,
        });
    }
    if (tok !== null) {
      adresses.push({ role: "tokenisation", chemin: profil.chemins.tokenisation ?? "", ...tok });
      rapport.tokenisation = tok.ok;
    }
    if (profil.type === "sglang") rapport.jetons_en_cache = inf.jetonsEnCacheActifs;
    else if (profil.capacites.jetonsEnCache === "option" && options.generation && rapport.modele_servi)
      rapport.jetons_en_cache = await testerJetonsEnCache(engine, rapport.modele_servi);
  }
  const observees = observations.get(engine.key) ?? new Set<string>();
  rapport.conseils = conseils(engine, rapport, observees);
  if (engine.isBuiltin) dernierRapport = rapport;
  return rapport;
}

/** Une ligne lisible du rapport (journal du démarrage). */
export function resumeRapport(r: RapportMoteur): string {
  if (!r.joignable) return `${r.libelle} injoignable sur ${r.base_url}`;
  const morceaux = [
    `${r.libelle}${r.version ? ` ${r.version}` : ""} sur ${r.base_url}`,
    r.modele_servi ? `modèle ${r.modele_servi}` : "aucun modèle annoncé",
    r.contexte ? `contexte ${r.contexte} jetons` : "contexte inconnu",
  ];
  if (r.metriques !== null) morceaux.push(`métriques ${r.metriques ? "oui" : "non"}`);
  if (r.tokenisation !== null) morceaux.push(`tokenisation exacte ${r.tokenisation ? "oui" : "non"}`);
  morceaux.push(
    r.concurrence.mode === "moteur"
      ? `concurrence gérée par le moteur${r.concurrence.max ? ` (${r.concurrence.max} requêtes)` : ""}`
      : `file d'Elpis${r.concurrence.max ? ` (${r.concurrence.max} créneaux)` : ""}`,
  );
  return morceaux.join(", ");
}

/** Sonde du serveur intégré au démarrage : une ligne de résumé, puis chaque conseil au niveau qui lui revient. */
export async function sonderAuDemarrage(): Promise<RapportMoteur> {
  const r = await sonderMoteur(builtinEngine());
  log.info(`[moteur] ${resumeRapport(r)}`);
  for (const c of r.conseils) {
    if (c.niveau === "info") log.info(`[moteur] ${c.message}`);
    else log.warn(`[moteur] ${c.message}`);
  }
  return r;
}
