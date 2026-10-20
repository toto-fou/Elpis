// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-llm.ts — `/api/admin` du moteur LLM : connecteurs partagés et liste blanche, capacités et mode d'ordonnancement, trafic capturé (shared_infra/routes/admin/llm_connectors.py, llm.py, llm_traffic.py). */
import {
  ErreurPython,
  estDict,
  FlottantPy,
  getPy,
  HttpError,
  inPy,
  lowerPy,
  nomTypePy,
  ouPy,
  poserCle,
  prefixePy,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, liveConfigValue, readConfigJson } from "@elpis/config";
import type { Base } from "@elpis/db";
import { auditEvent } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import { modifierConfigJson } from "../administration/config-sous-verrou";
import { clearLlmCalls, getLlmCall, listLlmCalls } from "../administration/trafic-llm";
import type { Journal } from "../journal";
import { connectorKey, purgeEngineKey } from "../llm/acces-moteurs";
import { detectLlamaCapabilities, getLlamaCapabilities, resolveSchedulingMode } from "../llm/capacites";
import {
  allowedProviderTypes,
  champsDeCreation,
  champsDeLimites,
  cloudProviderTypes,
  createConnector,
  deleteSharedConnector,
  getSharedSecret,
  listSharedConnectors,
  nettoyer,
  presetsPublics,
  PROVIDER_PRESETS,
  updateSharedConnector,
} from "../llm/connecteurs";
import type { ChampsMiseAJour } from "../llm/connecteurs";
import { invalidateCache as oublierFenetres } from "../llm/fenetre-contexte";
import { testConnector } from "../llm/fournisseurs/decouverte";
import { invalidate as oublierCapacites } from "../llm/fournisseurs/llama-capacites";
import { invalidateStatuses } from "../llm/fournisseurs/llama-modeles";
import { builtinEngine } from "../llm/moteurs";
import { oublierServeur } from "../llm/ordonnanceur/process";
import { dernierRapportIntegre, sonderMoteur } from "../llm/sonde-moteur";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";
import { corpsJsonValeurs, entrees, parametreRequete, py, reponseJsonPy } from "@elpis/http";

export interface DependancesAdminLlm {
  readonly base: Base;
  readonly journal: Journal;
}

const SANS_CACHE = { "cache-control": "no-cache" } as const;
const MODES = ["auto", "classic", "optimized"];
const COLONNES_REELLES = ["created_at", "updated_at", "last_used"] as const;

function route(
  methode: DefinitionRoute["methode"],
  chemin: string,
  acces: "admin" | "staff",
  traiter: Traitement,
): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces, traiter };
}

function auditer(req: FastifyRequest, uid: number, action: string, details: Dict): void {
  auditEvent({ userId: uid, username: req.utilisateur?.username ?? null, action, details });
}

/** `(data.get("api_key") or "").strip()` : un texte, AttributeError (500) pour une autre valeur vraie. */
function cleApi(data: unknown): string {
  const v = getPy(data, "api_key");
  const s = veritePy(v) ? v : "";
  if (typeof s !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(s)}' object has no attribute 'strip'`);
  return stripPy(s);
}

/** `cfg.setdefault(cle, {})` suivi d'une affectation dedans : TypeError (500) si la section n'est pas un dict. */
function sectionModifiable(cfg: Dict, cle: string): Dict {
  if (!Object.hasOwn(cfg, cle)) poserCle(cfg, cle, {});
  const s = cfg[cle];
  if (!estDict(s))
    throw new ErreurPython("TypeError", `'${nomTypePy(s)}' object does not support item assignment`);
  return s;
}

/** Colonnes REAL d'un connecteur rendues en float Python (`1.0`), comme sqlite3 et psycopg. */
function vueAdmin(c: Dict): Dict {
  const out: Dict = { ...c };
  for (const k of COLONNES_REELLES) {
    const v = out[k];
    if (typeof v === "number") out[k] = new FlottantPy(v);
  }
  return out;
}

/** Liste blanche relue sur la config (`_allowed_provider_types`). */
function autorises(): string[] {
  return allowedProviderTypes(ouPy(readConfigJson(), {}));
}

/** `_forget_engine` : ordonnanceur du serveur, capacités sondées et inventaire des modèles oubliés dans CE process. */
function oublierMoteur(cid: number): void {
  try {
    oublierServeur(connectorKey(cid));
  } catch {
    // best-effort, comme le Python
  }
  oublierCapacites();
  invalidateStatuses();
}

// ── Connecteurs partagés (llm_connectors.py) ────────────────────────────────

async function listerConnecteurs(dep: DependancesAdminLlm): Promise<Dict> {
  return {
    connectors: (await listSharedConnectors(dep.base)).map(vueAdmin),
    presets: presetsPublics(),
    all_provider_types: Object.keys(PROVIDER_PRESETS),
  };
}

async function creerConnecteur(dep: DependancesAdminLlm, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const data = corpsJsonValeurs(req);
  const champs = champsDeCreation(data, true, autorises);
  const apiKey = cleApi(data);
  let cid: number;
  try {
    cid = await createConnector(dep.base, {
      scope: "shared",
      owner_user_id: null,
      api_key: apiKey,
      provider_type: champs["provider_type"] as string,
      wire: champs["wire"] as string,
      base_url: champs["base_url"] as string,
      label: champs["label"] as string,
      default_model: champs["default_model"] as string,
      models_json: champs["models_json"] as string,
      context_window: champs["context_window"],
      max_models: champs["max_models"],
      max_concurrency: champs["max_concurrency"],
    });
  } catch (e) {
    throw new HttpError(
      503,
      `Stockage impossible : ${prefixePy(e instanceof Error ? e.message : String(e), 160)}`,
    );
  }
  auditer(req, uid, "llm.connector.create", {
    connector_id: cid,
    provider_type: champs["provider_type"],
    scope: "shared",
  });
  oublierFenetres();
  return { ok: true, id: cid };
}

async function modifierConnecteur(dep: DependancesAdminLlm, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const { cid } = entrees(req, { path: { cid: py.int() } }).path;
  const data = corpsJsonValeurs(req);
  const champs: ChampsMiseAJour = {};
  for (const k of ["label", "base_url", "default_model", "models_json"] as const)
    if (inPy(k, data)) champs[k] = nettoyer(getPy(data, k), k === "models_json" ? 4000 : 500);
  if (inPy("enabled", data)) champs.enabled = veritePy(getPy(data, "enabled"));
  const cle = cleApi(data);
  if (cle) champs.api_key = cle;
  Object.assign(champs, champsDeLimites(data));
  let ok: boolean;
  try {
    ok = await updateSharedConnector(dep.base, cid, champs);
  } catch (e) {
    throw new HttpError(
      503,
      `Mise à jour impossible : ${prefixePy(e instanceof Error ? e.message : String(e), 160)}`,
    );
  }
  if (!ok) throw new HttpError(404, "Connecteur introuvable ou rien à modifier");
  auditer(req, uid, "llm.connector.update", { connector_id: cid, scope: "shared" });
  oublierFenetres();
  oublierMoteur(cid);
  return { ok: true };
}

async function supprimerConnecteur(dep: DependancesAdminLlm, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const { cid } = entrees(req, { path: { cid: py.int() } }).path;
  if (!(await deleteSharedConnector(dep.base, cid))) throw new HttpError(404, "Connecteur introuvable");
  oublierServeur(connectorKey(cid));
  const purgees = await purgeEngineKey(dep.base, connectorKey(cid));
  auditer(req, uid, "llm.connector.delete", {
    connector_id: cid,
    scope: "shared",
    access_lists_purged: purgees,
  });
  oublierFenetres();
  oublierMoteur(cid);
  return { ok: true };
}

async function testerConnecteur(dep: DependancesAdminLlm, req: FastifyRequest): Promise<Dict> {
  const { cid } = entrees(req, { path: { cid: py.int() } }).path;
  const ligne = await getSharedSecret(dep.base, cid);
  if (!ligne) throw new HttpError(404, "Connecteur introuvable");
  return testConnector(ligne, { sonde: sondeDemandee(req) });
}

async function definirAutorises(req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const data = corpsJsonValeurs(req);
  const brut = getPy(data, "allowed");
  if (!Array.isArray(brut)) throw new HttpError(400, "'allowed' doit être une liste de provider_type");
  const nuage = new Set(cloudProviderTypes());
  const permis = brut.filter((p) => {
    if (Array.isArray(p) || estDict(p))
      throw new ErreurPython("TypeError", `unhashable type: '${nomTypePy(p)}'`);
    return typeof p === "string" && nuage.has(p);
  });
  await modifierConfigJson((cfg) => {
    poserCle(sectionModifiable(cfg, "llm"), "allowed_provider_types", permis);
  });
  auditer(req, uid, "llm.allowed_providers.set", { allowed: permis });
  return { ok: true, allowed: permis };
}

// ── Capacités et mode d'ordonnancement (llm.py) ─────────────────────────────

function capacites(rep: FastifyReply): FastifyReply {
  return reponseJsonPy(
    rep,
    {
      capabilities: getLlamaCapabilities(),
      configured_mode: liveConfigValue("llm.scheduling_mode", config.LLM_SCHEDULING_MODE),
      effective_mode: resolveSchedulingMode(),
    },
    SANS_CACHE,
  );
}

async function sonderCapacites(rep: FastifyReply): Promise<FastifyReply> {
  const caps = await detectLlamaCapabilities(3.0);
  return reponseJsonPy(rep, { capabilities: caps }, SANS_CACHE);
}

/** `?sonde=1` : le test d'un connecteur rend aussi le rapport du profil de son moteur. */
function sondeDemandee(req: FastifyRequest): boolean {
  const v = parametreRequete(req, "sonde");
  return v === "1" || v === "true";
}

/** Moteur intégré : dernier rapport de ce process, sinon une sonde sans génération. */
async function rapportIntegre(rep: FastifyReply): Promise<FastifyReply> {
  const rapport = dernierRapportIntegre() ?? (await sonderMoteur(builtinEngine()));
  return reponseJsonPy(rep, { rapport }, SANS_CACHE);
}

/** Bouton « Tester » : sonde complète du moteur intégré, complétion d'un jeton comprise (jetons en cache de vLLM). */
async function testerIntegre(req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
  const uid = utilisateur(req);
  const rapport = await sonderMoteur(builtinEngine(), { generation: true });
  auditer(req, uid, "llm.engine.test", { type: rapport.type, joignable: rapport.joignable });
  return reponseJsonPy(rep, { rapport }, SANS_CACHE);
}

/** `body.get("mode") or ""` puis `.lower().strip()` : AttributeError (500) hors dict ou pour un mode non textuel. */
function modeDemande(corps: unknown): string {
  const v = getPy(corps, "mode");
  const s = veritePy(v) ? v : "";
  if (typeof s !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(s)}' object has no attribute 'lower'`);
  return stripPy(lowerPy(s));
}

async function changerMode(dep: DependancesAdminLlm, req: FastifyRequest): Promise<Dict> {
  let corps: unknown;
  try {
    corps = corpsJsonValeurs(req);
  } catch {
    throw new HttpError(400, "Body JSON requis");
  }
  const mode = modeDemande(corps);
  if (!MODES.includes(mode)) throw new HttpError(400, "mode doit être auto, classic ou optimized");
  config.LLM_SCHEDULING_MODE = mode;
  try {
    await modifierConfigJson((cfg) => {
      poserCle(sectionModifiable(cfg, "llm"), "scheduling_mode", mode);
    });
  } catch (e) {
    dep.journal.warn(
      `[admin] persist scheduling_mode échoué : ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { configured_mode: mode, effective_mode: resolveSchedulingMode() };
}

// ── Trafic LLM (llm_traffic.py) ──────────────────────────────────────────────

async function trafic(
  dep: DependancesAdminLlm,
  req: FastifyRequest,
  rep: FastifyReply,
): Promise<FastifyReply> {
  const { query } = entrees(req, {
    query: {
      limit: py.int().defaut(100),
      user_id: py.optional(py.int()).defaut(null),
      model: py.optional(py.str()).defaut(null),
      status: py.optional(py.str()).defaut(null),
      chat_id: py.optional(py.str()).defaut(null),
    },
  });
  const appels = await listLlmCalls(dep.base, query);
  return reponseJsonPy(
    rep,
    {
      calls: appels,
      count: appels.length,
      enabled: veritePy(config.LLM_DEBUG_ENABLED),
      max_entries: config.LLM_DEBUG_MAX_ENTRIES,
    },
    SANS_CACHE,
  );
}

async function detailTrafic(
  dep: DependancesAdminLlm,
  req: FastifyRequest,
  rep: FastifyReply,
): Promise<FastifyReply> {
  const { call_id: id } = entrees(req, { path: { call_id: py.int() } }).path;
  const ligne = await getLlmCall(dep.base, id);
  if (ligne === null) throw new HttpError(404, "échange introuvable");
  return reponseJsonPy(rep, ligne, SANS_CACHE);
}

export function creerFamilleAdminLlm(dep: DependancesAdminLlm): Famille {
  return {
    nom: "admin-llm",
    routes: [
      route("GET", "/api/admin/llm/connectors", "admin", () => listerConnecteurs(dep)),
      route("POST", "/api/admin/llm/connectors", "admin", (req) => creerConnecteur(dep, req)),
      route("PUT", "/api/admin/llm/connectors/:cid", "admin", (req) => modifierConnecteur(dep, req)),
      route("DELETE", "/api/admin/llm/connectors/:cid", "admin", (req) => supprimerConnecteur(dep, req)),
      route("POST", "/api/admin/llm/connectors/:cid/test", "admin", (req) => testerConnecteur(dep, req)),
      route("GET", "/api/admin/llm/allowed-providers", "admin", () => ({
        allowed: autorises(),
        cloud_provider_types: cloudProviderTypes(),
        presets: presetsPublics(),
      })),
      route("PUT", "/api/admin/llm/allowed-providers", "admin", (req) => definirAutorises(req)),
      route("GET", "/api/admin/llm/engine", "admin", (_req, rep) => rapportIntegre(rep)),
      route("POST", "/api/admin/llm/engine/test", "admin", (req, rep) => testerIntegre(req, rep)),
      route("GET", "/api/admin/llm-capabilities", "staff", (_req, rep) => capacites(rep)),
      route("POST", "/api/admin/llm-capabilities/probe", "admin", (_req, rep) => sonderCapacites(rep)),
      route("POST", "/api/admin/llm-scheduling-mode", "admin", (req) => changerMode(dep, req)),
      route("GET", "/api/admin/llm-traffic", "admin", (req, rep) => trafic(dep, req, rep)),
      route("GET", "/api/admin/llm-traffic/:call_id([0-9]+)", "admin", (req, rep) =>
        detailTrafic(dep, req, rep),
      ),
      route("DELETE", "/api/admin/llm-traffic", "admin", async () => ({
        ok: true,
        deleted: await clearLlmCalls(dep.base),
      })),
    ],
  };
}
