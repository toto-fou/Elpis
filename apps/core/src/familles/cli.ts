// SPDX-License-Identifier: MIT
/** apps/core/src/familles/cli.ts — distribution LAN d'OpenCode : installeurs, opencode.json généré à chaud, familles MCP, bundles et CA locale (shared_infra/opencode/routes_cli.py). */
import { readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { exigerUtilisateur, getUserSettings, resoudreJeton } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import {
  comparePointsDeCode,
  egalPy,
  ErreurPython,
  estDict,
  FlottantPy,
  getOu,
  getPy,
  HttpError,
  itemPy,
  iterExige,
  lowerPy,
  ouPy,
  poserCle,
  pyJsonDumps,
  reprFlottant,
  rstripPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import {
  config,
  configView,
  featureEnabled,
  httpsEnabled,
  httpsPorts,
  racineDepot,
  realpathPy,
} from "@elpis/config";
import type { Executeur } from "@elpis/db";
import {
  FAMILY_CATEGORY,
  load,
  opencodeEntryFor,
  opencodeFamilies,
  opencodeLocalServers,
  serviceUpstream,
} from "@elpis/mcp";
import type { FastifyReply, FastifyRequest } from "fastify";

import { urlDeBase } from "../comptes/aides";
import { INSTALL_PS1_TEMPLATE, INSTALL_SH_TEMPLATE } from "../code/installeurs";
import { modelCache } from "../llm/cache-modeles";
import { llamaBaseUrl } from "../llm/llama-http";
import { cachedContextSize } from "../llm/modeles";
import { getCategories, getToolCategoriesDict } from "../outils/categories";
import type { Journal } from "../journal";
import type { Famille } from "../routes";
import { MCP_PROXY_PREFIX } from "./pont-mcp";
import { premierEntete, reponseFichier } from "@elpis/http";

export interface DependancesCli {
  readonly base: Executeur;
  readonly auth: DependancesAuth & DependancesJetons;
  readonly journal?: Journal;
}

const OS_ALIASES: Readonly<Record<string, string>> = {
  linux: "linux",
  macos: "macos",
  mac: "macos",
  darwin: "macos",
  osx: "macos",
  windows: "windows",
  win: "windows",
};

export const FALLBACK_MODELS: readonly { id: string; vision: boolean }[] = [
  { id: "qwen3-coder-30b", vision: false },
  { id: "qwen3.6-35B", vision: false },
  { id: "qwen3.6-27b", vision: true },
  { id: "qwen3.6-1m", vision: false },
  { id: "gpt-oss-20b", vision: false },
  { id: "glm-4.7-flash", vision: false },
  { id: "gemma-4-31b", vision: false },
  { id: "gemma4-12b", vision: false },
  { id: "granite-20b", vision: false },
  { id: "default", vision: false },
];

export const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "qwen3-coder-30b": "Qwen3 Coder 30B",
  "qwen3.6-35B": "Qwen3.6 35B",
  "qwen3.6-27b": "Qwen3.6 27B (vision)",
  "qwen3.6-1m": "Qwen3.6 (1M ctx)",
  "gpt-oss-20b": "GPT-OSS 20B",
  "glm-4.7-flash": "GLM 4.7 Flash",
  "gemma-4-31b": "Gemma 4 31B",
  "gemma4-12b": "Gemma 4 12B",
  "granite-20b": "Granite 20B",
  default: "Default (preset llama.cpp)",
};

const DEFAULT_MODEL_FALLBACK = "qwen3-coder-30b";
export const OPENCODE_MCP_PREFIX = "elpis-";
export const TOKEN_PLACEHOLDER = "pcr_REMPLACEZ_PAR_VOTRE_JETON";
const CA_DEFAULT = "/etc/caddy/elpis-pki/ca.crt";
const CA = "/api/cli/ca.crt";
const INACTIF = "OpenCode est désactivé par l'administrateur.";

/** `_dist_dir` : `OPENCODE_DIST_DIR`, sinon `opencode.dist_dir`, sinon `<racine>/cli_dist` ; relatif à la racine, résolu. */
export function distDir(racine: string = racineDepot()): string {
  const env = process.env["OPENCODE_DIST_DIR"];
  const brut = stripPy(
    veritePy(env)
      ? (env as string)
      : strPy(ouPy(getPy(getPy(ouPy(configView(), {}), "opencode", {}), "dist_dir"), "")),
  );
  let base = brut || join(racine, "cli_dist");
  if (!isAbsolute(base)) base = join(racine, base);
  return realpathPy(base);
}

function estFichier(chemin: string): boolean {
  try {
    return statSync(chemin).isFile();
  } catch {
    return false;
  }
}

/** `_resolve_bundle` : alias d'OS en liste blanche, premier `opencode-<os>.*` trié, borné au dossier de distribution. */
export function resoudreBundle(osKey: string, racine?: string): string | null {
  const cle = lowerPy(stripPy(osKey || ""));
  const norme = Object.hasOwn(OS_ALIASES, cle) ? OS_ALIASES[cle] : undefined;
  if (!norme) return null;
  const dist = distDir(racine);
  let noms: string[];
  try {
    noms = readdirSync(dist);
  } catch {
    return null;
  }
  const prefixe = `opencode-${norme}.`;
  const candidats = noms
    .filter((n) => n.startsWith(prefixe))
    .map((n) => join(dist, n))
    .sort(comparePointsDeCode);
  for (const candidat of candidats) {
    const p = realpathPy(candidat);
    if (p !== dist && !p.startsWith(dist === "/" ? "/" : dist + "/")) continue;
    if (estFichier(p)) return p;
  }
  return null;
}

/** `_app_url` : l'URL que le greffon contactera ensuite (frontal https si activé, port `https.main_port`). */
export function urlApplication(req: FastifyRequest): string {
  const base = urlDeBase(req);
  if (!httpsEnabled()) return base;
  const port = httpsPorts().main || 443;
  const hote = (base.split("://")[1] ?? "").split(":")[0] ?? "";
  return port === 443 ? `https://${hote}` : `https://${hote}:${port}`;
}

/** `_render` : seules substitutions, l'origine contactée validée (`__BASE__`) et l'URL de l'app (`__APP_URL__`). */
export function rendreInstalleur(gabarit: string, req: FastifyRequest): string {
  const base = urlDeBase(req);
  return gabarit.split("__BASE__").join(base).split("__APP_URL__").join(urlApplication(req));
}

function nombreSur(v: unknown): number {
  return Number(v instanceof FlottantPy ? v.valeur : v);
}

/** Clé de dict Python écrite par `json.dumps` (clé non textuelle convertie). */
function cleJson(k: unknown): string {
  if (typeof k === "string") return k;
  if (typeof k === "boolean") return k ? "true" : "false";
  if (k === null || k === undefined) return "null";
  if (k instanceof FlottantPy || (typeof k === "number" && !Number.isInteger(k)))
    return reprFlottant(nombreSur(k));
  return strPy(k);
}

/** `_live_models` : modèles du cache chaud (serveur joignable), sinon la liste de repli, hors ligne. */
function modelesVivants(): [Dict[], Set<unknown>] {
  try {
    const cache = veritePy(modelCache) ? modelCache : {};
    const mws = ouPy(getPy(cache, "models_with_status"), []);
    if (veritePy(getPy(cache, "server_reachable")) && veritePy(mws)) {
      const elements = iterExige(mws);
      const modeles = elements
        .filter((m) => veritePy(getPy(m, "id")))
        .map((m) => ({ id: itemPy(m, "id"), vision: veritePy(getPy(m, "vision")) }));
      const charges = new Set(
        elements
          .filter((m) => getPy(m, "status") === "loaded" && veritePy(getPy(m, "id")))
          .map((m) => itemPy(m, "id")),
      );
      if (modeles.length > 0) return [modeles, charges];
    }
  } catch {
    // cache illisible : repli hors ligne
  }
  return [FALLBACK_MODELS.map((m) => ({ ...m })), new Set()];
}

/** `_pick_default_model` : préférence de la config, sinon premier chargé, sinon premier disponible. */
function modeleParDefaut(ids: unknown[], charges: Set<unknown>): unknown {
  const opencode = ouPy(getPy(ouPy(configView(), {}), "opencode"), {});
  const pref = stripPy(strPy(ouPy(getPy(opencode, "default_model"), DEFAULT_MODEL_FALLBACK)));
  if (ids.some((x) => egalPy(x, pref))) return pref;
  for (const id of ids) if (charges.has(id)) return id;
  return ids.length > 0 ? ids[0] : DEFAULT_MODEL_FALLBACK;
}

/** `_output_limit` : un huitième de la fenêtre, borné à [2048, 16384] (opencode le retranche du contexte utile). */
export function limiteSortie(contexte: number): number {
  return Math.max(2048, Math.min(16384, Math.floor(contexte / 8)));
}

/** `_generate_opencode_config` : fournisseur `elpis` assemblé depuis l'état vivant (llama.cpp, modèles, fenêtres connues). */
export function genererConfigOpencode(): Dict {
  const baseUrl = rstripPy(llamaBaseUrl(), "/") + "/v1";
  const [modeles, charges] = modelesVivants();
  const ids = modeles.map((m) => m["id"]);
  const limites = new Map<string, number>();
  for (const [k, v] of cachedContextSize) if (k && v > 0) limites.set(k, v);
  const carte: Dict = {};
  for (const m of modeles) {
    const id = m["id"];
    const nom =
      typeof id === "string" && Object.hasOwn(MODEL_DISPLAY_NAMES, id) ? MODEL_DISPLAY_NAMES[id] : id;
    const entree: Dict = { name: nom, tool_call: true };
    if (veritePy(m["vision"])) entree["attachment"] = true;
    const ctx = typeof id === "string" ? Math.trunc(limites.get(id) ?? 0) : 0;
    if (ctx > 0) entree["limit"] = { context: ctx, output: limiteSortie(ctx) };
    poserCle(carte, cleJson(id), entree);
  }
  const choisi = modeleParDefaut(ids, charges);
  if (typeof choisi !== "string")
    throw new ErreurPython("TypeError", `can only concatenate str (not "${typeof choisi}") to str`);
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    provider: {
      elpis: {
        npm: "@ai-sdk/openai-compatible",
        name: "Elpis llama.cpp (local)",
        options: { baseURL: baseUrl, apiKey: "local-no-key" },
        models: carte,
      },
    },
    model: "elpis/" + choisi,
  };
}

/** `opencode_mcp_server_name` : préfixe du manifeste, stable (il préfixe les noms d'outils vus par le modèle). */
export function nomServeurMcp(famille: string): string {
  let prefixe: string;
  try {
    prefixe = load().opencodePrefix() || OPENCODE_MCP_PREFIX;
  } catch {
    prefixe = OPENCODE_MCP_PREFIX;
  }
  return `${prefixe}${famille}`;
}

/** `_live_families` : familles réellement enregistrées par le service ; `null` = inconnu, rien n'est élagué. */
function famillesVivantes(): Set<string> | null {
  let categories: Set<string>;
  try {
    categories = new Set(
      Object.entries(getToolCategoriesDict())
        .filter(([, outils]) => veritePy(outils))
        .map(([c]) => c),
    );
  } catch {
    return null;
  }
  if (categories.size === 0) return null;
  return new Set(
    Object.entries(FAMILY_CATEGORY)
      .filter(([, cat]) => categories.has(cat))
      .map(([f]) => f),
  );
}

/** `_request_token` : `x-elpis-token`, sinon `Authorization: Bearer …`. */
export function jetonPresente(req: FastifyRequest): string {
  let tok = stripPy(premierEntete(req, "x-elpis-token") ?? "");
  if (!tok) {
    const auth = stripPy(premierEntete(req, "authorization") ?? "");
    if (lowerPy(auth).startsWith("bearer ")) tok = stripPy(auth.slice(7));
  }
  return tok;
}

export function creerFamilleCli(dep: DependancesCli): Famille {
  const racine = racineDepot();

  /** `_client_identity` : jeton opencode valide, sinon session web, sinon anonyme ; un jeton invalide n'identifie personne. */
  const identite = async (req: FastifyRequest): Promise<[string | null, number | null]> => {
    const tok = jetonPresente(req);
    if (tok) {
      const d = await resoudreJeton(dep.auth, tok, ["opencode"]);
      return d ? [tok, d.user_id] : [null, null];
    }
    try {
      return [null, await exigerUtilisateur(req, dep.auth)];
    } catch {
      return [null, null];
    }
  };

  const preferences = async (uid: number | null): Promise<Dict> => {
    if (uid === null) return {};
    let brut: unknown;
    try {
      brut = getOu(await getUserSettings(dep.base, uid), "opencode_mcp_families", null);
    } catch {
      return {};
    }
    const sortie: Dict = {};
    if (estDict(brut)) for (const [k, v] of Object.entries(brut)) poserCle(sortie, strPy(k), veritePy(v));
    return sortie;
  };

  const urlMcp = (req: FastifyRequest): string | null => {
    const publique = stripPy(strPy(ouPy(config.LOCAL_MCP_PUBLIC_URL, "")));
    if (publique) return publique;
    const [url, jeton] = serviceUpstream();
    if (!url || !jeton) return null;
    return rstripPy(urlApplication(req), "/") + MCP_PROXY_PREFIX;
  };

  const entreesMcp = async (req: FastifyRequest, jeton: string, uid: number | null): Promise<Dict> => {
    const base = urlMcp(req);
    if (!base || !jeton) return {};
    let familles = opencodeFamilies();
    const vivantes = famillesVivantes();
    if (vivantes !== null) familles = familles.filter((f) => vivantes.has(f));
    const prefs = await preferences(uid);
    const entrees: Dict = {};
    for (const f of familles)
      poserCle(entrees, nomServeurMcp(f), {
        type: "remote",
        url: `${rstripPy(base, "/")}/${f}`,
        enabled: veritePy(Object.hasOwn(prefs, f) ? prefs[f] : true),
        headers: { Authorization: `Bearer ${jeton}` },
      });
    try {
      for (const d of opencodeLocalServers()) {
        const nom = stripPy(strPy(ouPy(getPy(d, "name"), "")));
        if (nom && !Object.hasOwn(entrees, nom)) poserCle(entrees, nom, opencodeEntryFor(d));
      }
    } catch {
      // serveurs locaux illisibles : seules les familles intégrées sont publiées
    }
    return entrees;
  };

  const servirFichier = (
    req: FastifyRequest,
    rep: FastifyReply,
    chemin: string,
    nom: string,
    type: string,
  ): Promise<FastifyReply> => reponseFichier(req, rep, chemin, { mediaType: type, filename: nom });

  const installeurSh = (req: FastifyRequest, rep: FastifyReply): FastifyReply =>
    rep
      .header("content-type", "text/x-shellscript; charset=utf-8")
      .send(rendreInstalleur(INSTALL_SH_TEMPLATE, req));

  const installeurPs1 = (req: FastifyRequest, rep: FastifyReply): FastifyReply => {
    const script = rendreInstalleur(INSTALL_PS1_TEMPLATE, req);
    if (Array.from(script).some((c) => (c.codePointAt(0) ?? 0) > 127))
      dep.journal?.warn("install.ps1 (opencode) contient des caracteres non-ASCII");
    return rep.header("content-type", "text/plain; charset=utf-8").send(script);
  };

  return {
    nom: "cli",
    contexte: (app) => {
      app.addHook("onRequest", async (requete) => {
        if (requete.routeOptions.url !== CA && !featureEnabled("opencode")) throw new HttpError(404, INACTIF);
      });
    },
    routes: [
      {
        methode: "GET",
        chemin: "/api/cli/install.sh",
        processus: ["main"],
        acces: "public",
        traiter: installeurSh,
      },
      {
        methode: "GET",
        chemin: "/api/cli/install.ps1",
        processus: ["main"],
        acces: "public",
        traiter: installeurPs1,
      },
      { methode: "GET", chemin: "/opencode", processus: ["main"], acces: "public", traiter: installeurSh },
      {
        methode: "GET",
        chemin: "/opencode.ps1",
        processus: ["main"],
        acces: "public",
        traiter: installeurPs1,
      },
      {
        methode: "GET",
        chemin: "/api/cli/opencode.json",
        processus: ["main"],
        acces: "public",
        traiter: async (req, rep) => {
          const cfg = genererConfigOpencode();
          const [tok, uid] = await identite(req);
          const entrees = uid !== null ? await entreesMcp(req, tok || TOKEN_PLACEHOLDER, uid) : {};
          if (veritePy(entrees)) cfg["mcp"] = entrees;
          const texte = pyJsonDumps(cfg, { indent: 2, ensureAscii: false }) + "\n";
          return rep.header("content-type", "application/json").send(Buffer.from(texte, "utf-8"));
        },
      },
      {
        methode: "GET",
        chemin: "/api/cli/opencode/families",
        processus: ["main"],
        acces: "public",
        traiter: async (req) => {
          const [, uid] = await identite(req);
          if (uid === null) throw new HttpError(401, "Authentification requise.");
          const prefs = await preferences(uid);
          const libelles = new Map<unknown, unknown>();
          try {
            for (const c of getCategories(true)) libelles.set(c["name"], ouPy(getPy(c, "label"), c["name"]));
          } catch {
            libelles.clear();
          }
          const vivantes = famillesVivantes();
          const familles: Dict[] = [];
          for (const f of opencodeFamilies()) {
            if (vivantes !== null && !vivantes.has(f)) continue;
            familles.push({
              name: f,
              label: ouPy(libelles.get(FAMILY_CATEGORY[f] ?? f), f),
              server: nomServeurMcp(f),
              enabled: veritePy(Object.hasOwn(prefs, f) ? prefs[f] : true),
            });
          }
          return { families: familles };
        },
      },
      {
        methode: "GET",
        chemin: CA,
        processus: ["main"],
        acces: "public",
        traiter: async (req, rep) => {
          const env = process.env["ELPIS_CA_FILE"];
          const https = ouPy(getPy(ouPy(getPy(ouPy(configView(), {}), "security"), {}), "https"), {});
          const brut = stripPy(veritePy(env) ? (env as string) : strPy(ouPy(getPy(https, "ca_file"), "")));
          const chemin = brut || CA_DEFAULT;
          if (!estFichier(chemin))
            throw new HttpError(404, "Aucune CA locale (HTTPS non déployé sur cette instance).");
          return servirFichier(req, rep, chemin, "ca.crt", "application/x-pem-file");
        },
      },
      {
        methode: "GET",
        chemin: "/api/cli/bundle/:os_key",
        processus: ["main"],
        acces: "public",
        traiter: async (req, rep) => {
          const osKey = (req.params as Record<string, string>)["os_key"] ?? "";
          const p = resoudreBundle(osKey, racine);
          if (p === null)
            throw new HttpError(
              404,
              `Artefact OpenCode introuvable pour « ${osKey} ». ` +
                `Dépose un fichier opencode-<os>.(tar.gz|zip) dans ${distDir(racine)} ` +
                "(os ∈ linux|macos|windows).",
            );
          return servirFichier(req, rep, p, basename(p), "application/octet-stream");
        },
      },
    ],
  };
}
