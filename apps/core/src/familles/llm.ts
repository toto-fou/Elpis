// SPDX-License-Identifier: MIT
/** apps/core/src/familles/llm.ts — `/api/llm` : connecteurs du compte, modèles et propriétés, santé, chargement, infill sous l'ordonnanceur, file (shared_infra/llm/routes*.py). */

import { ligneUtilisateur, revaliderFlux } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import {
  arrondiPy,
  ErreurPython,
  estDict,
  FlottantPy,
  getPy,
  intPy,
  HttpError,
  nomTypePy,
  prefixePy,
  pyJsonDumps,
  quotePy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { readConfigJson } from "@elpis/config";
import type { Base } from "@elpis/db";
import { auditEvent } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import { ABANDON, DELAI, FileAttente } from "../evenements/file";
import type { Journal } from "../journal";
import {
  BUILTIN_KEY,
  canManageModels,
  connectorKey,
  exigerMoteurOuvert,
  filterSharedConnectors,
} from "../llm/acces-moteurs";
import {
  CURRENT_LOADED_MODELS,
  ensureModelPoller,
  modelCache,
  refreshModelCache,
  refreshModelsEverywhere,
} from "../llm/cache-modeles";
import {
  champsDeCreation,
  compteAdmin,
  createConnector,
  deleteUserConnector,
  getSecretForUser,
  getUserSecret,
  listSharedConnectors,
  listUserConnectors,
  MAX_CHAMP,
  nettoyer,
  presetsPublics,
  typesOuverts,
  updateUserConnector,
} from "../llm/connecteurs";
import type { ChampsMiseAJour } from "../llm/connecteurs";
import { waitForSlotsIdle, loadLlmModel, unloadLlmModel } from "../llm/cycle-modeles";
import { invalidateCache as oublierFenetres } from "../llm/fenetre-contexte";
import { decorate, fetchModels, testConnector } from "../llm/fournisseurs/decouverte";
import { engineCaps } from "../llm/fournisseurs/llama-capacites";
import { invalidateStatuses, modelStatuses, watchLoad } from "../llm/fournisseurs/llama-modeles";
import { llmInfill } from "../llm/infill";
import { getAdminClient, llamaBaseUrl, llamaGet } from "../llm/llama-http";
import { autoloadSuffix } from "../llm/modeles";
import { builtinEngine, resolveEngineForUser, useEngine } from "../llm/moteurs";
import type { EngineRef } from "../llm/moteurs";
import { LLMCircuitOpen, LLMQueueAborted } from "../llm/ordonnanceur";
import { avecLLM, occupation, oublierServeur, ordonnanceur, tenirModele } from "../llm/ordonnanceur/process";
import { describeEffectiveParams, describeEffectiveParamsDegraded } from "../llm/parametres";
import { diffusion, ErreurPortAbsent } from "../llm/ports";
import { profilDe, vuePubliqueProfil } from "../llm/profils";
import { contexteAnnonce, getLlmHealth, setLoadedModelCache } from "../llm/sante";
import { infosServeur } from "../llm/sonde-moteur";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import { corpsJson, entrees, ouvrirFlux, parametreRequete, py, reponseJsonPy } from "@elpis/http";

export interface DependancesLlm {
  readonly base: Base;
  readonly auth: DependancesAuth;
  readonly journal: Journal;
  readonly logMetric?: (nom: string, valeur: number, etiquettes: Record<string, unknown>) => void;
  /** Arrêt du process : les flux se ferment proprement. */
  readonly arret?: AbortSignal;
}

const SANS_CACHE = { "cache-control": "no-cache" } as const;
const TACHES = ["chat", "tools", "thinking", "infill", "debug"];
/** Délais de la famille, réglables par les tests : premier catalogue, attente bornée de l'infill, cadence, keep-alive et revalidation du flux de la file. */
export const reglagesLlm = {
  catalogueInitialMs: 3_000,
  infillAttenteMaxS: 20.0,
  intervalleMs: 4_000,
  keepaliveMs: 30_000,
  revalidationMs: 60_000,
};

function frais(requete: FastifyRequest): boolean {
  const f = parametreRequete(requete, "fresh");
  return f === "1" || f === "true";
}

/** `(data.get(cle) or "").strip()` : un texte, AttributeError (500) pour une autre valeur vraie. */
function texteNettoye(data: unknown, cle: string): string {
  const v = getPy(data, cle);
  const s = veritePy(v) ? v : "";
  if (typeof s !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(s)}' object has no attribute 'strip'`);
  return stripPy(s);
}

/** `key in data` : clé d'un dict, élément d'une liste, sous-chaîne d'un texte ; TypeError sinon. */
function contient(data: unknown, cle: string): boolean {
  if (typeof data === "string") return data.includes(cle);
  if (Array.isArray(data)) return data.includes(cle);
  if (data !== null && typeof data === "object") return Object.hasOwn(data, cle);
  throw new ErreurPython("TypeError", `argument of type '${nomTypePy(data)}' is not iterable`);
}

/** Types permis aux connecteurs personnels de ce compte, liste blanche relue sur la config (`_allowed_provider_types`) ; un administrateur n'y est pas soumis. */
async function autorises(base: Base, uid: number): Promise<string[]> {
  const lue = readConfigJson();
  return typesOuverts(await compteAdmin(base, uid), veritePy(lue) ? lue : {});
}

// ── File : instantané du serveur intégré et diffuseur partagé (routes_queue.py) ─

/** `_build_snapshot` : détenteurs (vus ici ou partagés), capacité (`/props` l'emporte), attentes non annulées, saturation arrondie à 3. */
export function instantaneFile(stats: Dict, maintenant: number): Dict {
  const actifs = (veritePy(stats["active_models"]) ? stats["active_models"] : []) as Dict[];
  const attentes = (veritePy(stats["slot_waiters"]) ? stats["slot_waiters"] : []) as Dict[];
  const totalProps = stats["total_slots_from_props"];
  const repli = veritePy(stats["max_conversations_per_model_config_fallback"])
    ? stats["max_conversations_per_model_config_fallback"]
    : 1;
  const parModele = new Map<unknown, number>();
  for (const w of attentes) {
    if (veritePy(getPy(w, "cancelled"))) continue;
    const m = veritePy(getPy(w, "model")) ? getPy(w, "model") : "";
    parModele.set(m, (parModele.get(m) ?? 0) + 1);
  }
  const modeles: Dict[] = [];
  let enCours = 0;
  let capacite = 0;
  for (const m of actifs) {
    const ent = (v: unknown): number => intPy(veritePy(v) ? v : 0);
    const holders = Math.max(ent(getPy(m, "holders")), ent(getPy(m, "shared_busy")));
    const max = intPy(veritePy(getPy(m, "effective_max_convs")) ? getPy(m, "effective_max_convs") : repli);
    const nom = veritePy(getPy(m, "model")) ? getPy(m, "model") : "";
    modeles.push({ model: nom, holders, max, waiters: parModele.get(nom) ?? 0 });
    enCours += holders;
    capacite += max;
  }
  if (typeof totalProps === "number" && Number.isInteger(totalProps) && totalProps > capacite)
    capacite = totalProps;
  const enAttente = attentes.filter((w) => !veritePy(getPy(w, "cancelled"))).length;
  const saturation = capacite > 0 ? arrondiPy(enCours / capacite, 3) : 0.0;
  return {
    llm: {
      in_flight: enCours,
      waiting: enAttente,
      capacity: capacite,
      saturation_ratio: new FlottantPy(saturation),
      models: modeles,
    },
    chat: { active_estimate: enCours },
    ts: new FlottantPy(maintenant),
  };
}

/** `_QueueStatusBroadcaster` : une boucle d'instantanés par process, lancée au premier abonné, arrêtée après le dernier. */
export class DiffuseurFile {
  private readonly abonnes = new Set<FileAttente<Dict>>();
  private boucle: Promise<void> | null = null;
  private dernier: Dict | null = null;
  private readonly instantane: () => Dict;
  private readonly journal: Journal | undefined;

  constructor(instantane: () => Dict, journal?: Journal) {
    this.instantane = instantane;
    this.journal = journal;
  }

  get actif(): boolean {
    return this.boucle !== null;
  }

  /** File bornée à 4 (les plus anciens tombent) ; le dernier instantané part tout de suite, avant celui d'une boucle relancée. */
  abonner(): FileAttente<Dict> {
    const file = new FileAttente<Dict>(4);
    this.abonnes.add(file);
    if (this.dernier !== null) file.deposer(this.dernier);
    if (this.boucle === null) this.boucle = this.tourner();
    return file;
  }

  desabonner(file: FileAttente<Dict>): void {
    this.abonnes.delete(file);
  }

  /** La référence est effacée dans le `finally`, sans attente : un abonné arrivé juste après relance une boucle vivante (B14). */
  private async tourner(): Promise<void> {
    try {
      for (;;) {
        let charge: Dict | null = null;
        try {
          charge = this.instantane();
        } catch (e) {
          this.journal?.warn(`[queue-status] snapshot error: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (charge !== null) {
          this.dernier = charge;
          for (const f of [...this.abonnes]) {
            if (f.deposer(charge)) continue;
            f.retirer();
            f.deposer(charge);
          }
        }
        await new Promise((ok) => setTimeout(ok, reglagesLlm.intervalleMs).unref());
        if (this.abonnes.size === 0) return;
      }
    } finally {
      this.boucle = null;
    }
  }
}

// ── Serveur visé ────────────────────────────────────────────────────────────

/** `_engine_for` : clé explicite, sinon `?engine=`, sinon l'intégré ; 404 introuvable, 403 refusé par la politique. */
async function moteurPour(
  dep: DependancesLlm,
  requete: FastifyRequest,
  uid: number,
  cle = "",
): Promise<EngineRef> {
  const k = stripPy(cle || parametreRequete(requete, "engine") || BUILTIN_KEY);
  const eng = await resolveEngineForUser(uid, k);
  if (eng === null) throw new HttpError(404, "Serveur introuvable");
  if (!(await exigerMoteurOuvert(dep.base, uid, eng.key))) throw new HttpError(403, "Serveur non autorisé");
  return eng;
}

async function exigerGestion(dep: DependancesLlm, uid: number): Promise<void> {
  if (!(await canManageModels(dep.base, uid))) throw new HttpError(403, "Gestion des modèles non autorisée");
}

async function nomDe(dep: DependancesLlm, uid: number): Promise<string> {
  const moi = await ligneUtilisateur(dep.base, uid);
  return moi?.username ?? "?";
}

/** `system_events.broadcast` : port absent (bus pas encore branché), rien n'est diffusé. */
function diffuserLog(message: string, level: string): void {
  try {
    diffusion().diffuser({ type: "log", message, level });
  } catch (e) {
    if (!(e instanceof ErreurPortAbsent)) throw e;
  }
}

/** `_is_local_model` : servi par le llama-server LOCAL ; ouvert tant que le cache n'est pas peuplé. */
function estModeleLocal(modelId: string): boolean {
  if (!modelId) return false;
  if (CURRENT_LOADED_MODELS.has(modelId)) return true;
  const locaux = modelCache["models"];
  if (!veritePy(locaux)) return true;
  return Array.isArray(locaux) ? locaux.includes(modelId) : false;
}

function auditer(requete: FastifyRequest, uid: number, action: string, details: Dict): void {
  auditEvent({ userId: uid, username: requete.utilisateur?.username ?? null, action, details });
}

// ── Connecteurs du compte (routes_connectors.py) ───────────────────────────

async function listerConnecteurs(dep: DependancesLlm, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const ouverts = await autorises(dep.base, uid);
  const permis = new Set(ouverts);
  const propres = await listUserConnectors(dep.base, uid);
  for (const c of propres) c["provider_allowed"] = permis.has(c["provider_type"] as string);
  return {
    connectors: propres,
    shared: await filterSharedConnectors(dep.base, uid, await listSharedConnectors(dep.base)),
    presets: presetsPublics(),
    allowed_provider_types: ouverts,
    builtin_allowed: await exigerMoteurOuvert(dep.base, uid, BUILTIN_KEY),
    can_manage_models: await canManageModels(dep.base, uid),
  };
}

async function creerConnecteur(dep: DependancesLlm, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const data = corpsJson(req);
  const ouverts = await autorises(dep.base, uid);
  const champs = champsDeCreation(data, false, () => ouverts);
  const apiKey = texteNettoye(data, "api_key");
  if (!apiKey) throw new HttpError(400, "Clé API requise pour un connecteur cloud");
  let cid: number;
  try {
    cid = await createConnector(dep.base, {
      scope: "user",
      owner_user_id: uid,
      api_key: apiKey,
      provider_type: champs["provider_type"] as string,
      wire: champs["wire"] as string,
      base_url: champs["base_url"] as string,
      label: champs["label"] as string,
      default_model: champs["default_model"] as string,
      models_json: champs["models_json"] as string,
    });
  } catch (e) {
    throw new HttpError(
      503,
      `Stockage du connecteur impossible : ${prefixePy(e instanceof Error ? e.message : String(e), 160)}`,
    );
  }
  auditer(req, uid, "llm.connector.create", {
    connector_id: cid,
    provider_type: champs["provider_type"],
    scope: "user",
  });
  oublierFenetres();
  return { ok: true, id: cid };
}

async function modifierConnecteur(dep: DependancesLlm, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const { cid } = entrees(req, { path: { cid: py.int() } }).path;
  const data = corpsJson(req);
  const champs: ChampsMiseAJour = {};
  for (const k of ["label", "default_model", "models_json"] as const)
    if (contient(data, k)) champs[k] = nettoyer(getPy(data, k), k === "models_json" ? 4000 : MAX_CHAMP);
  if (contient(data, "enabled")) champs.enabled = veritePy(getPy(data, "enabled"));
  const cle = texteNettoye(data, "api_key");
  if (cle) champs.api_key = cle;
  let ok: boolean;
  try {
    ok = await updateUserConnector(dep.base, uid, cid, champs);
  } catch (e) {
    throw new HttpError(
      503,
      `Mise à jour impossible : ${prefixePy(e instanceof Error ? e.message : String(e), 160)}`,
    );
  }
  if (!ok) throw new HttpError(404, "Connecteur introuvable ou rien à modifier");
  auditer(req, uid, "llm.connector.update", { connector_id: cid });
  oublierFenetres();
  return { ok: true };
}

async function supprimerConnecteur(dep: DependancesLlm, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const { cid } = entrees(req, { path: { cid: py.int() } }).path;
  if (!(await deleteUserConnector(dep.base, uid, cid))) throw new HttpError(404, "Connecteur introuvable");
  oublierServeur(connectorKey(cid));
  auditer(req, uid, "llm.connector.delete", { connector_id: cid });
  oublierFenetres();
  return { ok: true };
}

async function testerConnecteur(dep: DependancesLlm, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const { cid } = entrees(req, { path: { cid: py.int() } }).path;
  const ligne = await getUserSecret(dep.base, uid, cid);
  if (!ligne) throw new HttpError(404, "Connecteur introuvable");
  const sonde = parametreRequete(req, "sonde");
  const res = await testConnector(ligne, { sonde: sonde === "1" || sonde === "true" });
  auditer(req, uid, "llm.connector.test", {
    connector_id: cid,
    ok: veritePy(res["ok"]),
    status: res["status"] ?? null,
  });
  return res;
}

async function modelesDuConnecteur(dep: DependancesLlm, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const { cid } = entrees(req, { path: { cid: py.int() } }).path;
  const ligne = await getSecretForUser(dep.base, uid, cid);
  if (!ligne || !veritePy(Object.hasOwn(ligne, "enabled") ? ligne["enabled"] : true))
    throw new HttpError(404, "Connecteur introuvable");
  if (!(await exigerMoteurOuvert(dep.base, uid, connectorKey(cid))))
    throw new HttpError(403, "Serveur non autorisé");
  const type = veritePy(ligne["provider_type"]) ? strPy(ligne["provider_type"]) : "";
  const profil = profilDe(type || "generic");
  const out: Dict = {
    connector_id: cid,
    default_model: veritePy(ligne["default_model"]) ? ligne["default_model"] : "",
    provider_type: type,
    router: false,
    statuses: {},
    can_manage: false,
  };
  if (profil.capacites.modelesServisCharges) {
    out["moteur"] = vuePubliqueProfil(profil);
    const servi = await catalogueServi(uid, cid);
    if (servi !== null) return { ...out, ...servi, ...decorate(ligne, servi["models"] as string[]) };
  }
  if (profil.capacites.chargement) {
    const eng = await resolveEngineForUser(uid, connectorKey(cid));
    if (eng !== null) {
      const force = frais(req);
      const caps = await engineCaps("", { engine: eng, force });
      if (caps.known && caps.modelsApi) {
        const st = await modelStatuses("", force, { engine: eng });
        if (st.size > 0)
          return {
            ...out,
            ok: true,
            status: 200,
            router: true,
            statuses: Object.fromEntries(st),
            can_manage: await canManageModels(dep.base, uid),
            ...decorate(ligne, [...st.keys()]),
          };
      }
    }
  }
  return { ...out, ...(await fetchModels(ligne)) };
}

/** Identifiants des modèles annoncés par une santé agrégée (`models_loaded`). */
function idsAnnonces(sante: Dict): string[] {
  const liste = sante["models_loaded"];
  if (!Array.isArray(liste)) return [];
  return liste.map((m) => strPy(getPy(m, "id", ""))).filter((id) => id && id !== "?");
}

/** Modèles d'un connecteur vLLM ou SGLang lus sur le moteur lui-même : tous servis donc en mémoire, fenêtre, cache KV et charge. */
async function catalogueServi(uid: number, cid: number): Promise<Dict | null> {
  const eng = await resolveEngineForUser(uid, connectorKey(cid));
  if (eng === null) return null;
  const sante = await getLlmHealth(eng);
  const ids = idsAnnonces(sante);
  if (!veritePy(sante["server_reachable"]) || ids.length === 0) return null;
  const props = estDict(sante["props"]) ? sante["props"] : {};
  return {
    ok: true,
    status: 200,
    models: ids,
    statuses: Object.fromEntries(ids.map((id) => [id, "loaded"])),
    kv_cache: sante["kv_cache"],
    n_ctx: typeof props["n_ctx"] === "number" ? props["n_ctx"] : 0,
    charge: sante["charge"],
  };
}

// ── Modèles du serveur (routes.py) ───────────────────────────────────────────

const CATALOGUE_REFUSE = {
  models: [],
  models_with_status: [],
  models_loaded: [],
  kv_cache: {},
  server_reachable: false,
  status: "forbidden",
  props: {},
  allowed: false,
  can_manage: false,
};

const CATALOGUE_INJOIGNABLE = {
  models: [],
  models_with_status: [],
  models_loaded: [],
  kv_cache: {},
  server_reachable: false,
  status: "unreachable",
  props: {},
};

async function listerModeles(dep: DependancesLlm, req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
  const uid = utilisateur(req);
  void rep.headers(SANS_CACHE);
  if ((parametreRequete(req, "engine") || "builtin") !== "builtin") return modelesDuServeur(dep, req, uid);
  if (!(await exigerMoteurOuvert(dep.base, uid, BUILTIN_KEY))) return CATALOGUE_REFUSE;
  ensureModelPoller();
  if (Object.keys(modelCache).length > 0) return modelCache;
  let delai: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      refreshModelCache(),
      new Promise((_ok, ko) => {
        delai = setTimeout(() => ko(new Error("délai dépassé")), reglagesLlm.catalogueInitialMs);
      }),
    ]);
  } catch (e) {
    dep.journal.debug(`[models] refresh timeout au premier appel : ${String(e)}`);
    if (Object.keys(modelCache).length === 0) return CATALOGUE_INJOIGNABLE;
  } finally {
    clearTimeout(delai);
  }
  return modelCache;
}

/** `_connector_models_payload` : même forme que `/api/llm/models` pour un serveur llama.cpp nommé. */
async function modelesDuServeur(dep: DependancesLlm, req: FastifyRequest, uid: number): Promise<Dict> {
  const eng = await moteurPour(dep, req, uid);
  const vide: Dict = {
    engine: eng.key,
    models: [],
    models_with_status: [],
    models_loaded: [],
    kv_cache: {},
    props: {},
    server_reachable: false,
    status: "unreachable",
    router: false,
    can_manage: false,
  };
  if (eng.profil.capacites.modelesServisCharges) return catalogueSansChargement(eng, vide);
  if (!eng.profil.capacites.chargement) return { ...vide, status: "unsupported" };
  const force = frais(req);
  const caps = await engineCaps("", { engine: eng, force });
  if (!caps.known) return vide;
  const st = caps.modelsApi ? await modelStatuses("", force, { engine: eng }) : new Map<string, string>();
  const out: Dict = {
    ...vide,
    server_reachable: true,
    status: "ok",
    router: caps.modelsApi,
    can_manage: caps.modelsApi && (await canManageModels(dep.base, uid)),
  };
  if (st.size > 0) {
    out["models"] = [...st.keys()];
    out["models_with_status"] = [...st].map(([id, status]) => ({ id, status }));
    out["models_loaded"] = [...st].filter(([, v]) => v === "loaded").map(([m]) => m);
  }
  return out;
}

/** Même forme que l'intégré pour un moteur qui sert ce qu'il annonce (vLLM, SGLang) : son `/v1/models`, sa santé, ses métriques. */
async function catalogueSansChargement(eng: EngineRef, vide: Dict): Promise<Dict> {
  const sante = await getLlmHealth(eng);
  const ids = idsAnnonces(sante);
  return {
    ...vide,
    server_reachable: veritePy(sante["server_reachable"]),
    status: strPy(sante["status"] ?? "unreachable"),
    models: ids,
    models_with_status: ids.map((id) => ({ id, status: "loaded" })),
    models_loaded: ids,
    kv_cache: sante["kv_cache"],
    props: estDict(sante["props"]) ? sante["props"] : {},
    charge: sante["charge"],
    moteur: sante["moteur"],
  };
}

/** Propriétés d'un modèle d'après `/v1/models` (`max_model_len` de vLLM, SGLang) et les informations du moteur ; jamais la clé d'API. */
async function proprietesAnnoncees(eng: EngineRef, modelId: string): Promise<Dict> {
  const data = await llamaGet(eng.profil.chemins.modeles, 5.0, { engine: eng });
  const entrees = estDict(data) && Array.isArray(data["data"]) ? data["data"].filter(estDict) : [];
  const entree =
    entrees.find((m) => m["id"] === modelId || m["root"] === modelId) ?? (entrees.length ? entrees[0] : null);
  if (!estDict(entree)) throw new HttpError(404, "Could not retrieve model properties");
  const inf = await infosServeur(eng);
  const n = contexteAnnonce(data, modelId);
  return {
    ...entree,
    moteur: eng.profil.libelle,
    ...(inf.version ? { version: inf.version } : {}),
    ...(n > 0 ? { n_ctx: n } : {}),
    ...(inf.maxRequetes ? { max_running_requests: inf.maxRequetes } : {}),
  };
}

/** Les deux routes Starlette derrière le joker `/api/llm/models/*` (`{model_id:path}` = `.*` de Python, saut de ligne exclu). */
const MOTIFS_MODELE: readonly RegExp[] = [
  /^\/api\/llm\/models\/[^\n]*\/props$/,
  /^\/api\/llm\/models\/[^\n]*\/effective-params$/,
];

/** `GET /api/llm/models/{model_id:path}/…` : le joker de Starlette est gourmand, le suffixe se lit à la fin. */
async function routeModele(dep: DependancesLlm, req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
  const { chemin } = entrees(req, { path: { chemin: py.str().alias("*") } }).path;
  if (chemin.endsWith("/props")) return proprietes(dep, req, rep, chemin.slice(0, -"/props".length));
  if (chemin.endsWith("/effective-params"))
    return parametresEffectifs(dep, req, rep, chemin.slice(0, -"/effective-params".length));
  throw new HttpError(404, "Not Found");
}

async function proprietes(
  dep: DependancesLlm,
  req: FastifyRequest,
  rep: FastifyReply,
  modelId: string,
): Promise<unknown> {
  const uid = utilisateur(req);
  const eng = await moteurPour(dep, req, uid);
  void rep.headers(SANS_CACHE);
  if (eng.profil.capacites.contexte === "modeles") return proprietesAnnoncees(eng, modelId);
  if (!eng.isBuiltin) {
    if (!eng.profil.capacites.props) throw new HttpError(404, "Propriétés indisponibles pour ce serveur");
    const props = await llamaGet(`/props?model=${quotePy(modelId, "")}&autoload=false`, 5.0, { engine: eng });
    if (!veritePy(props)) throw new HttpError(404, "Could not retrieve model properties");
    return props;
  }
  if (!estModeleLocal(modelId))
    throw new HttpError(404, "Modèle non local (connecteur) — /props indisponible");
  const base = llamaBaseUrl();
  const client = getAdminClient();
  let resultat: unknown = null;
  const sansCharger = veritePy(await autoloadSuffix());
  const params: Record<string, string> = { model: modelId };
  if (sansCharger) params["autoload"] = "false";
  try {
    const r = await client.get(`${base}/props`, { timeout: 5.0, params });
    if (r.statusCode === 200) resultat = r.json();
    else if (sansCharger && r.statusCode === 400) throw new HttpError(409, "Modèle non chargé");
  } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (!veritePy(resultat)) {
    try {
      const r = await client.get(`${base}/props`, { timeout: 5.0 });
      if (r.statusCode === 200) resultat = r.json();
    } catch {
      resultat = null;
    }
  }
  if (!veritePy(resultat)) {
    try {
      const r = await client.get(`${base}/v1/models`, { timeout: 5.0 });
      if (r.statusCode === 200) {
        const modeles = getPy(r.json(), "data", []);
        for (const m of Array.isArray(modeles) ? modeles : []) {
          if (getPy(m, "id") === modelId) {
            resultat = { openai_compat: true, ...(m as Dict) };
            break;
          }
        }
        if (!veritePy(resultat) && veritePy(modeles)) {
          if (!Array.isArray(modeles)) throw new TypeError("modèles illisibles");
          resultat = { openai_compat: true, ...(modeles[0] as Dict) };
        }
      }
    } catch {
      if (!veritePy(resultat)) resultat = null;
    }
  }
  if (!veritePy(resultat)) throw new HttpError(404, "Could not retrieve model properties");
  return resultat;
}

async function parametresEffectifs(
  dep: DependancesLlm,
  req: FastifyRequest,
  rep: FastifyReply,
  modelId: string,
): Promise<unknown> {
  const uid = utilisateur(req);
  const brute = parametreRequete(req, "task");
  const task = brute === null ? "chat" : brute;
  if (!TACHES.includes(task)) throw new HttpError(400, `task invalide : ${task}`);
  const eng = await moteurPour(dep, req, uid);
  void rep.headers(SANS_CACHE);
  const d = parametreRequete(req, "degraded");
  const degrade = d === "1" || d === "true";
  const resoudre = async (moteur: EngineRef | null): Promise<Dict> => {
    try {
      return await useEngine(moteur, () => describeEffectiveParams(modelId, task));
    } catch (e) {
      throw new HttpError(500, `Erreur résolution params : ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  if (!eng.isBuiltin) {
    if (degrade || !eng.profil.capacites.props)
      return describeEffectiveParamsDegraded(modelId, task, eng.providerType);
    return resoudre(eng);
  }
  if (degrade || !estModeleLocal(modelId))
    return describeEffectiveParamsDegraded(modelId, task, eng.providerType);
  return resoudre(null);
}

// ── Cycle de vie ─────────────────────────────────────────────────────────────

async function chargerModele(dep: DependancesLlm, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const nom = await nomDe(dep, uid);
  const data = corpsJson(req);
  const modelPath = texteNettoye(data, "model_path");
  if (!modelPath) throw new HttpError(400, "model_path requis");
  const eng = await moteurPour(
    dep,
    req,
    uid,
    strPy(veritePy(getPy(data, "engine")) ? getPy(data, "engine") : ""),
  );
  await exigerGestion(dep, uid);
  if (!eng.profil.capacites.chargement) return sansChargement(eng);
  if (!eng.isBuiltin) return chargerSurConnecteur(dep, eng, modelPath, nom);
  diffuserLog(`[LLM] Chargement modèle: ${modelPath} (par ${nom})`, "INFO");
  const tenu = await tenirModele(eng, modelPath);
  let resultat: Dict;
  let message: string;
  let niveau: string;
  try {
    const libre = await waitForSlotsIdle(300.0, 2.0);
    if (!libre)
      diffuserLog(
        `[LLM] Timeout attente slots avant chargement de ${modelPath} — chargement forcé`,
        "WARNING",
      );
    resultat = await loadLlmModel(modelPath);
    if (veritePy(resultat["ok"])) {
      CURRENT_LOADED_MODELS.add(modelPath);
      setLoadedModelCache(modelPath);
      await refreshModelsEverywhere();
      dep.logMetric?.("model_load", 1, { model: modelPath, user: nom });
      [message, niveau] = [`[LLM] Modèle chargé: ${modelPath}`, "INFO"];
    } else [message, niveau] = [`[LLM] Échec: ${strPy(getPy(resultat, "error", "?"))}`, "ERROR"];
  } finally {
    tenu.release();
  }
  diffuserLog(message, niveau);
  return resultat;
}

/** `_connector_load` : exclusivité de modèle DE CE SERVEUR tenue pendant le changement, sans toucher aux miroirs de l'intégré. */
async function chargerSurConnecteur(
  dep: DependancesLlm,
  eng: EngineRef,
  modelPath: string,
  nom: string,
): Promise<Dict> {
  const tenu = await tenirModele(eng, modelPath);
  let resultat: Dict;
  try {
    resultat = await useEngine(eng, async () => {
      await waitForSlotsIdle(300.0, 2.0);
      return loadLlmModel(modelPath);
    });
  } finally {
    tenu.release();
  }
  invalidateStatuses(eng);
  dep.journal.info(
    `[LLM] chargement ${modelPath} sur ${eng.key} (par ${nom}) → ${veritePy(resultat["ok"]) ? "ok" : strPy(resultat["error"] ?? null)}`,
  );
  if (veritePy(resultat["ok"]))
    dep.logMetric?.("model_load", 1, { model: modelPath, user: nom, engine: eng.key });
  return resultat;
}

async function dechargerModele(dep: DependancesLlm, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const nom = await nomDe(dep, uid);
  const data = corpsJson(req);
  const modelId = texteNettoye(data, "model_id");
  if (!modelId) throw new HttpError(400, "model_id requis");
  const eng = await moteurPour(
    dep,
    req,
    uid,
    strPy(veritePy(getPy(data, "engine")) ? getPy(data, "engine") : ""),
  );
  await exigerGestion(dep, uid);
  const force = veritePy(getPy(data, "force"));
  if (!eng.profil.capacites.chargement) return sansChargement(eng);
  if (!eng.isBuiltin) return dechargerSurConnecteur(dep, eng, modelId, nom, force);
  if (!force) {
    const etat = occupation(eng);
    if (etat.active_count > 0) {
      const occupe = etat.current_model || "?";
      dep.journal.warn(
        `[LLM] déchargement de ${modelId} refusé (par ${nom}) : ${etat.active_count} génération(s) en cours sur ${occupe}`,
      );
      return refusOccupe(occupe, etat.active_count);
    }
  }
  diffuserLog(`[LLM] Attente fin des requêtes avant déchargement de ${modelId} (par ${nom})…`, "INFO");
  if (!(await waitForSlotsIdle(300.0, 2.0)))
    diffuserLog(`[LLM] Timeout attente slots pour ${modelId} — déchargement forcé`, "WARNING");
  const resultat = await unloadLlmModel(modelId);
  if (veritePy(resultat["ok"])) {
    CURRENT_LOADED_MODELS.delete(modelId);
    setLoadedModelCache(null);
    await refreshModelsEverywhere();
    dep.logMetric?.("model_unload", 1, { model: modelId, user: nom });
    diffuserLog(`[LLM] Modèle déchargé: ${modelId}`, "WARNING");
  }
  return resultat;
}

/** Chargement demandé à un moteur qui n'en a pas (vLLM, SGLang : modèle choisi au lancement du serveur). */
function sansChargement(eng: EngineRef): Dict {
  if (!eng.profil.capacites.modelesServisCharges)
    return { ok: false, error: "Serveur sans gestion de modèles." };
  return {
    ok: false,
    error: `${eng.profil.libelle} ne charge ni ne décharge de modèle : le modèle est choisi au lancement du serveur.`,
  };
}

function refusOccupe(occupe: string, actifs: number): Dict {
  return {
    ok: false,
    error: `Génération en cours sur « ${occupe} » — déchargement refusé`,
    busy_model: occupe,
    active_count: actifs,
  };
}

async function dechargerSurConnecteur(
  dep: DependancesLlm,
  eng: EngineRef,
  modelId: string,
  nom: string,
  force: boolean,
): Promise<Dict> {
  if (!force) {
    const etat = occupation(eng);
    if (etat.active_count > 0) return refusOccupe(etat.current_model || "?", etat.active_count);
  }
  const resultat = await useEngine(eng, async () => {
    await waitForSlotsIdle(300.0, 2.0);
    return unloadLlmModel(modelId);
  });
  invalidateStatuses(eng);
  dep.journal.info(
    `[LLM] déchargement ${modelId} sur ${eng.key} (par ${nom}) → ${veritePy(resultat["ok"]) ? "ok" : strPy(resultat["error"] ?? null)}`,
  );
  if (veritePy(resultat["ok"]))
    dep.logMetric?.("model_unload", 1, { model: modelId, user: nom, engine: eng.key });
  return resultat;
}

const ENTETES_PROGRESSION = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
};

/** Progression réelle d'un chargement en SSE (décorative) : `{"supported": false}` pour un moteur ancien, sinon les étapes puis `done`. */
async function progressionChargement(
  dep: DependancesLlm,
  req: FastifyRequest,
  rep: FastifyReply,
): Promise<void> {
  const uid = utilisateur(req);
  const modelId = stripPy(parametreRequete(req, "model_id") || "");
  if (!modelId) throw new HttpError(400, "model_id requis");
  const eng = await moteurPour(dep, req, uid);
  const caps = eng.isBuiltin ? await engineCaps() : await engineCaps("", { engine: eng });
  const sortie = ouvrirFlux(rep, ENTETES_PROGRESSION, dep.arret);
  const fin = new AbortController();
  try {
    if (!caps.modelsSse) {
      await sortie.ecrire('data: {"supported": false}\n\n');
      return;
    }
    const file = new FileAttente<Dict | null>(64);
    let charge: boolean | null = null;
    let termine = false;
    const suivi = useEngine(eng.isBuiltin ? null : eng, () =>
      watchLoad(
        modelId,
        "",
        (stage, pct, stages) => {
          file.deposer({
            pct: pct === null ? null : new FlottantPy(pct),
            stage: stage || "",
            stages: stages || [],
          });
        },
        { timeoutS: 600.0, signal: fin.signal },
      ),
    )
      .then((v) => {
        charge = v;
      })
      .catch(() => undefined)
      .finally(() => {
        termine = true;
        file.deposer(null);
      });
    void suivi;
    const debut = performance.now();
    for (;;) {
      if (termine && file.taille === 0) break;
      const element = await file.prendre(15_000, sortie.signal);
      if (element === ABANDON) return;
      if (element === DELAI) {
        if (sortie.signal.aborted) return;
        if (performance.now() - debut > 620_000) break;
        await sortie.ecrire(": ping\n\n");
        continue;
      }
      if (element === null) break;
      await sortie.ecrire(`data: ${pyJsonDumps(element)}\n\n`);
      if (sortie.signal.aborted) return;
    }
    await sortie.ecrire(`data: ${pyJsonDumps({ done: true, loaded: charge })}\n\n`);
  } finally {
    fin.abort();
    sortie.fermer();
  }
}

// ── Infill (sous l'ordonnanceur) et file ────────────────────────────────────

async function infill(dep: DependancesLlm, req: FastifyRequest): Promise<unknown> {
  const uid = utilisateur(req);
  await nomDe(dep, uid);
  await moteurPour(dep, req, uid, BUILTIN_KEY);
  const data = corpsJson(req);
  const prefixe = getPy(data, "input_prefix", "");
  const suffixe = getPy(data, "input_suffix", "");
  const modele = texteNettoye(data, "model") || null;
  if (!veritePy(prefixe) && !veritePy(suffixe))
    throw new HttpError(400, "input_prefix ou input_suffix requis");
  try {
    return await avecLLM(
      builtinEngine(),
      modele,
      "high",
      AbortSignal.timeout(reglagesLlm.infillAttenteMaxS * 1000),
      () => llmInfill(prefixe as string, suffixe as string, modele),
    );
  } catch (e) {
    if (e instanceof LLMCircuitOpen) return { ok: false, error: e.message };
    if (e instanceof LLMQueueAborted)
      return { ok: false, error: "Modèle occupé par une autre génération — réessayez plus tard." };
    throw e;
  }
}

const ENTETES_FILE = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive",
};

/** Instantané de la charge du serveur intégré (`LLM_SEMAPHORE.get_stats()`). */
export function instantaneDuProcess(): Dict {
  return instantaneFile(ordonnanceur().stats(BUILTIN_KEY) as unknown as Dict, Date.now() / 1000);
}

async function fluxFile(
  dep: DependancesLlm,
  diffuseur: DiffuseurFile,
  req: FastifyRequest,
  rep: FastifyReply,
): Promise<void> {
  const uid = utilisateur(req);
  dep.journal.info(`[queue-status/stream] subscribe uid=${uid}`);
  const loginTs = req.session.get("_login_ts");
  const sid = req.session.get("_sid");
  const sortie = ouvrirFlux(rep, ENTETES_FILE, dep.arret);
  const file = diffuseur.abonner();
  let controle = performance.now();
  try {
    while (!sortie.signal.aborted) {
      if (performance.now() - controle >= reglagesLlm.revalidationMs) {
        controle = performance.now();
        let encore = true;
        try {
          encore = await revaliderFlux(dep.auth, uid, loginTs, sid);
        } catch {
          encore = true;
        }
        if (!encore) {
          await sortie.ecrire('data: {"type": "session_expired"}\n\n');
          break;
        }
      }
      const element = await file.prendre(reglagesLlm.keepaliveMs, sortie.signal);
      if (element === ABANDON) break;
      if (element === DELAI) {
        await sortie.ecrire(": keep-alive\n\n");
        continue;
      }
      await sortie.ecrire(`data: ${pyJsonDumps(element, { separators: [",", ":"] })}\n\n`);
    }
  } finally {
    diffuseur.desabonner(file);
    sortie.fermer();
    dep.journal.info(`[queue-status/stream] unsubscribed uid=${uid}`);
  }
}

export function creerFamilleLlm(dep: DependancesLlm): Famille {
  const diffuseur = new DiffuseurFile(instantaneDuProcess, dep.journal);
  const route = (
    methode: "GET" | "POST" | "PUT" | "DELETE",
    chemin: string,
    traiter: (req: FastifyRequest, rep: FastifyReply) => unknown,
    motifsStarlette?: readonly RegExp[],
  ) => ({
    methode,
    chemin,
    processus: ["main"] as const,
    acces: "session" as const,
    traiter,
    ...(motifsStarlette ? { motifsStarlette } : {}),
  });
  return {
    nom: "llm",
    routes: [
      route("GET", "/api/llm/connectors", (req) => listerConnecteurs(dep, req)),
      route("POST", "/api/llm/connectors", (req) => creerConnecteur(dep, req)),
      route("PUT", "/api/llm/connectors/:cid", (req) => modifierConnecteur(dep, req)),
      route("DELETE", "/api/llm/connectors/:cid", (req) => supprimerConnecteur(dep, req)),
      route("POST", "/api/llm/connectors/:cid/test", (req) => testerConnecteur(dep, req)),
      route("GET", "/api/llm/connectors/:cid/models", (req) => modelesDuConnecteur(dep, req)),
      route("GET", "/api/llm/models", (req, rep) => listerModeles(dep, req, rep)),
      route("GET", "/api/llm/models/*", (req, rep) => routeModele(dep, req, rep), MOTIFS_MODELE),
      route("GET", "/api/llm/health", async (req, rep) => {
        utilisateur(req);
        const sante = await getLlmHealth();
        void rep.headers(SANS_CACHE);
        return sante;
      }),
      route("POST", "/api/llm/models/load", (req) => chargerModele(dep, req)),
      route("GET", "/api/llm/models/load-progress", (req, rep) => progressionChargement(dep, req, rep)),
      route("POST", "/api/llm/models/unload", (req) => dechargerModele(dep, req)),
      route("POST", "/api/llm/infill", (req) => infill(dep, req)),
      route("GET", "/api/llm/queue-status", (req, rep) => {
        utilisateur(req);
        return reponseJsonPy(rep, instantaneDuProcess(), SANS_CACHE);
      }),
      route("GET", "/api/llm/queue-status/stream", (req, rep) => fluxFile(dep, diffuseur, req, rep)),
    ],
  };
}
