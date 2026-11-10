// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-images.ts — console du moteur d'images : test et modèles sur les valeurs du formulaire, état et enregistrement de la clé, rangée dans le coffre pour l'origine du moteur (shared_infra/routes/admin/image.py). */
import {
  encoderUtf8Py,
  ErreurJsonPy,
  ErreurLecturePy,
  estDict,
  getOu,
  HttpError,
  intPy,
  longueurPy,
  lowerPy,
  prefixePy,
  pyJsonLoads,
  pyJsonLoadsOctets,
  stripPy,
  strPy,
  texteJsonPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { configView } from "@elpis/config";
import { cleImagesHeritee } from "@elpis/db";
import type { Base } from "@elpis/db";
import type { FastifyRequest } from "fastify";

import { journal } from "../journal";
import { ImageError } from "../images/base";
import { cleImages, enregistrerCleImages, etatCleImages } from "../images/cle";
import { engineOrigin, getImageConfig, imageReady, PROVIDERS, retirerCleHeritee } from "../images/config";
import { forgetCapabilities, getProvider } from "../images/service";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { refusEcritureCle } from "../llm/cle-coffre";
import { origineExacte } from "../secrets/portee";
import type { Acteur } from "../secrets/stockage";
import { acteurDe } from "./secrets";
import { repondreAnnote } from "@elpis/http";

export interface DependancesAdminImages {
  readonly base: Base;
}

const log = journal("admin");

const KEY_MAX = 4096;
const CA_MAX = 64 * 1024;
const SANS_ADRESSE = "Aucune adresse renseignée.";
const ERREUR_INTERNE = "Erreur interne (voir le journal).";

/** `_body` : JSON illisible ou autre chose qu'un objet = `{}`. */
function corpsObjet(req: FastifyRequest): Dict {
  let data: unknown;
  try {
    pyJsonLoadsOctets(req.corpsBrut);
    data = pyJsonLoads(texteJsonPy(req.corpsBrut));
  } catch (e) {
    if (e instanceof ErreurJsonPy || (e instanceof ErreurLecturePy && e.nature !== "RecursionError"))
      return {};
    throw e;
  }
  return estDict(data) ? data : {};
}

/** `str(url or "").strip().rstrip("/")`. */
function normUrl(url: unknown): string {
  return stripPy(strPy(veritePy(url) ? url : "")).replace(/\/+$/, "");
}

const fourni = (data: Dict, cle: string): boolean => getOu(data, cle, null) !== null;

/** Configuration enregistrée + surcharges du formulaire ; la clé saisie, sinon celle du coffre si sa portée couvre l'adresse testée. */
async function merged(data: Dict, base: Base): Promise<Dict> {
  const cfg: Dict = { ...getImageConfig() };
  const choix = getOu(data, "provider", null);
  const provider = lowerPy(stripPy(strPy(veritePy(choix) ? choix : "")));
  if ((PROVIDERS as readonly string[]).includes(provider)) cfg["provider"] = provider;
  if (fourni(data, "url")) cfg["url"] = normUrl(data["url"]);
  if (fourni(data, "model")) cfg["model"] = stripPy(strPy(data["model"]));
  if (fourni(data, "verify"))
    cfg["verify"] =
      data["verify"] !== false && !["false", "0"].includes(lowerPy(stripPy(strPy(data["verify"]))));
  if (fourni(data, "ca_pem")) cfg["ca_pem"] = prefixePy(stripPy(strPy(data["ca_pem"])), CA_MAX);
  const typee = getOu(data, "api_key", null);
  const saisie = stripPy(strPy(veritePy(typee) ? typee : ""));
  cfg["api_key"] = saisie || (await cleImages(cfg, base));
  cfg["timeout_sec"] = Math.min(intPy(veritePy(cfg["timeout_sec"]) ? cfg["timeout_sec"] : 30), 30);
  return cfg;
}

/** Échec du moteur : son message (détail au journal) ; autre erreur : message générique, pile au journal. */
function echec(route: string, e: unknown): string {
  if (e instanceof ImageError) {
    if (e.detail) log.info(`[admin/image/${route}] ${e.message} — ${e.detail}`);
    return e.message;
  }
  log.error({ err: e }, `[admin/image/${route}] erreur inattendue`);
  return ERREUR_INTERNE;
}

async function tester(data: Dict, base: Base): Promise<Dict> {
  const saved = getImageConfig();
  const cfg = await merged(data, base);
  const out: Dict = {
    ok: false,
    provider: cfg["provider"],
    ...(await etatCleImages(saved, base)),
    enabled: saved.enabled,
    ready: imageReady(saved),
  };
  if (!veritePy(cfg["url"])) {
    out["error"] = SANS_ADRESSE;
    return out;
  }
  forgetCapabilities();
  const t0 = performance.now();
  let caps: Dict;
  try {
    caps = await getProvider(cfg).capabilities();
  } catch (e) {
    out["error"] = echec("test", e);
    return out;
  }
  const warnings: string[] = [];
  const val = (cle: string): unknown => getOu(caps, cle, null);
  out["ok"] = true;
  out["latency_ms"] = Math.trunc(performance.now() - t0);
  out["model"] = veritePy(val("model")) ? val("model") : cfg["model"];
  out["mode"] = veritePy(val("mode")) ? val("mode") : "";
  out["limits"] = veritePy(val("limits")) ? val("limits") : {};
  out["defaults"] = veritePy(val("defaults")) ? val("defaults") : {};
  const mode = val("mode");
  if (cfg["provider"] === "sdcpp" && veritePy(mode) && mode !== "img_gen") {
    out["ok"] = false;
    out["error"] = `Ce sd-server est en mode « ${strPy(mode)} » : lancez-le avec un modèle d'images.`;
  }
  if (cfg["provider"] === "openai") {
    const models = val("models");
    if (!veritePy(cfg["model"])) warnings.push("Choisissez un modèle.");
    else if (veritePy(models) && !(models as unknown[]).includes(cfg["model"]))
      warnings.push(`Modèle « ${strPy(cfg["model"])} » absent de la liste du service.`);
  }
  if (!saved.enabled) warnings.push("Génération désactivée.");
  if (cfg["url"] !== saved.url || cfg["provider"] !== saved.provider || cfg["model"] !== saved.model)
    warnings.push("Configuration non enregistrée : le test porte sur le formulaire.");
  out["warnings"] = warnings;
  return out;
}

async function modeles(data: Dict, base: Base): Promise<Dict> {
  const cfg = await merged(data, base);
  if (!veritePy(cfg["url"])) return { ok: false, models: [], error: SANS_ADRESSE };
  try {
    return { ok: true, models: await getProvider(cfg).listModels() };
  } catch (e) {
    return { ok: false, models: [], error: echec("models", e) };
  }
}

/** Ancienne clé de config.json retirée une fois la nouvelle rangée, au mieux (le démarrage de main réessaie). */
async function retirerAncienne(): Promise<void> {
  if (!cleImagesHeritee(configView())) return;
  try {
    await retirerCleHeritee();
  } catch (e) {
    log.warn(
      `[admin/image/key] ancienne clé de config.json non retirée : ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** `{api_key, url?}` : clé rangée dans le coffre pour l'origine de `url` (sinon de l'adresse enregistrée), `""` l'efface. */
async function enregistrerCle(data: Dict, base: Base, acteur: Acteur): Promise<Dict> {
  const brute = getOu(data, "api_key", null);
  const key = stripPy(strPy(veritePy(brute) ? brute : ""));
  if (longueurPy(key) > KEY_MAX) throw new HttpError(400, "Clé trop longue.");
  const url = fourni(data, "url") ? normUrl(data["url"]) : getImageConfig().url;
  if (key && (!engineOrigin(url) || origineExacte(url) === null))
    throw new HttpError(400, "Renseignez d'abord l'adresse du moteur.");
  encoderUtf8Py(key);
  try {
    await enregistrerCleImages(base, key, url, acteur);
  } catch (e) {
    const refus = refusEcritureCle(e);
    if (refus !== null) throw new HttpError(refus.statut, refus.message);
    throw e;
  }
  await retirerAncienne();
  forgetCapabilities();
  return { ok: true, ...(await etatCleImages(getImageConfig(), base)) };
}

function route(methode: DefinitionRoute["methode"], chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter };
}

/** Test et modèles répondent toujours 200 avec `ok` (un test raté n'est pas une requête ratée) ; la clé n'est jamais renvoyée. */
export function creerFamilleAdminImages(dep: DependancesAdminImages): Famille {
  const base = dep.base;
  return {
    nom: "admin-images",
    routes: [
      route("POST", "/api/admin/image/test", async (req, rep) =>
        repondreAnnote(rep, await tester(corpsObjet(req), base)),
      ),
      route("POST", "/api/admin/image/models", async (req, rep) =>
        repondreAnnote(rep, await modeles(corpsObjet(req), base)),
      ),
      route("GET", "/api/admin/image/key", async (_req, rep) =>
        repondreAnnote(rep, await etatCleImages(getImageConfig(), base)),
      ),
      route("PUT", "/api/admin/image/key", async (req, rep) =>
        repondreAnnote(rep, await enregistrerCle(corpsObjet(req), base, acteurDe(req))),
      ),
    ],
  };
}
