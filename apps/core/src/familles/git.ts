// SPDX-License-Identifier: MIT
/** apps/core/src/familles/git.ts — `/api/git/connectors*` : connecteurs git du compte, jeton en écriture seule, test et dépôts côté serveur sous garde SSRF (shared_infra/git/routes.py). */
import {
  copieDict,
  getPy,
  HttpError,
  inPy,
  lowerPy,
  poserCle,
  prefixePy,
  stripPy,
  strPy,
  urlsplit,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Executeur } from "@elpis/db";
import { auditEvent } from "@elpis/securite";
import type { Resolveur } from "@elpis/securite";
import type { FastifyRequest } from "fastify";

import { textePy } from "../comptes/aides";
import {
  createConnector,
  deleteConnector,
  getConnectorSecret,
  listConnectors,
  PROVIDER_TYPES,
  updateConnector,
} from "../git/connecteurs";
import type { ChampsConnecteur, ConnecteurSecret } from "../git/connecteurs";
import { defaultProviderType, detectProvider, normalizeHost } from "../git/detection";
import { getProvider } from "../git/fournisseurs";
import { gardeGit } from "../git/garde";
import type { Fournisseur, Http } from "../git/fournisseurs";
import { httpJson } from "../git/http";
import type { OptionsHttp } from "../git/http";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import { corpsJsonValeurs, entrees, py, reponseJsonPy } from "@elpis/http";

const MAX = 200;
const CHAMPS_MODIFIABLES = ["provider_type", "host", "api_base", "label", "username"] as const;

export interface DependancesGit {
  readonly base: Executeur;
  /** Client JSON des API git (défaut : `httpJson`). */
  readonly http?: (url: string, options: OptionsHttp) => Promise<Dict>;
  /** Résolution DNS de la garde SSRF (défaut : système). */
  readonly resoudre?: Resolveur;
  readonly auditer?: typeof auditEvent;
}

/** `_clean` : `str(s)` (None = ""), blancs retirés, `n` points de code au plus. */
function nettoyer(s: unknown, n = MAX): string {
  return prefixePy(stripPy(s === null || s === undefined ? "" : strPy(s)), n);
}

function cid(req: FastifyRequest): number {
  return entrees(req, { path: { cid: py.int() } }).path.cid;
}

/** Garde SSRF commune au test et aux dépôts : seul l'hôte ENREGISTRÉ sort du réseau public, jamais vers la boucle ni le lien local ; non résolu, refusé avant toute requête. */
async function preparer(
  dep: DependancesGit,
  ligne: ConnecteurSecret,
): Promise<{ prov: Fournisseur; apiBase: string; motif: string | null; http: Http }> {
  const prov = getProvider(ligne.provider_type);
  const apiBase = prov.apiBase(ligne.host, ligne.api_base || "");
  const resolution = dep.resoudre ? { resoudre: dep.resoudre } : {};
  const options = { ssrfAllowHosts: [ligne.host], ssrfAllowSchemes: ["https"], ...resolution };
  const motif = apiBase
    ? (await gardeGit(apiBase, { allowSchemes: ["https"], allowHosts: [ligne.host], ...resolution })).motif
    : null;
  const client = dep.http ?? httpJson;
  return { prov, apiBase, motif, http: (url, o) => client(url, { ...options, headers: o.headers }) };
}

/** Schéma `http` ou `https` de l'URL collée, `https` à défaut ou si `urlsplit` lève. */
function schemaHttp(url: string): string {
  try {
    const s = lowerPy(urlsplit(url).scheme || "");
    return s === "http" ? s : "https";
  } catch {
    return "https";
  }
}

function poserSiAbsent(d: Dict, cle: string, valeur: unknown): void {
  if (!Object.hasOwn(d, cle)) poserCle(d, cle, valeur);
}

function indice(res: Dict, apiBase: string): string | null {
  const st = Object.hasOwn(res, "status") ? res["status"] : null;
  if (st === 401 || st === 403)
    return "401/403 : identifiants refusés par l'API. Pour GitLab/GitHub un Personal Access Token est OBLIGATOIRE (le mot de passe ne marche pas pour l'API). Pour Gitea, vérifie le login/mot de passe, ou utilise un token si 2FA.";
  if (st === 0 || st === null || st === undefined || st === false)
    return `Pas de réponse de ${apiBase} : host/scheme/port erronés (Gitea en HTTP ? api_base doit être http://host:port/api/v1) ou service injoignable depuis l'app.`;
  if (st === 404) return "404 : api_base probablement faux (vérifie le chemin /api/v1, /api/v4…).";
  return null;
}

export function creerFamilleGit(dep: DependancesGit): Famille {
  const base = dep.base;
  const auditer = (req: FastifyRequest, uid: number, action: string, details: Dict): void =>
    (dep.auditer ?? auditEvent)({
      userId: uid,
      username: req.utilisateur?.username ?? null,
      action,
      details,
    });
  const route = (
    methode: "GET" | "POST" | "PUT" | "DELETE",
    chemin: string,
    traiter: Famille["routes"][number]["traiter"],
  ) => ({
    methode,
    chemin,
    processus: ["main"] as const,
    acces: "session" as const,
    traiter,
  });
  return {
    nom: "git",
    routes: [
      route("GET", "/api/git/connectors", async (req) => {
        const uid = utilisateur(req);
        return { connectors: await listConnectors(base, uid), provider_types: [...PROVIDER_TYPES] };
      }),
      route("POST", "/api/git/connectors/parse", (req) => {
        utilisateur(req);
        const data = corpsJsonValeurs(req);
        const url = nettoyer(getPy(data, "url"), 500);
        if (!url) return { ok: false };
        const info = detectProvider(url);
        const host = lowerPy(info?.host || normalizeHost(url) || "");
        if (!host) return { ok: false };
        const scheme = schemaHttp(url);
        const detecte = defaultProviderType(info?.provider ?? "");
        const type = nettoyer(getPy(data, "provider_type")) || detecte;
        let apiBase = getProvider(type).apiBase(host, "");
        if (scheme === "http" && apiBase && apiBase.includes(`://${host}`))
          apiBase = apiBase.replace("https://", "http://");
        return { ok: true, host, detected_provider_type: detecte, api_base: apiBase, scheme };
      }),
      route("POST", "/api/git/connectors", async (req) => {
        const uid = utilisateur(req);
        const data = corpsJsonValeurs(req);
        const type = nettoyer(getPy(data, "provider_type"));
        const host = normalizeHost(nettoyer(getPy(data, "host"), 400));
        const token = stripPy(textePy(getPy(data, "token")));
        if (!PROVIDER_TYPES.includes(type))
          throw new HttpError(
            400,
            `provider_type invalide (un de [${PROVIDER_TYPES.map((t) => `'${t}'`).join(", ")}])`,
          );
        if (!host) throw new HttpError(400, "host requis (ex. github.com, gitlab.acme.internal)");
        if (!token) throw new HttpError(400, "token requis");
        const id = await createConnector(base, uid, type, host, {
          token,
          apiBase: nettoyer(getPy(data, "api_base"), 400),
          label: nettoyer(getPy(data, "label")),
          username: nettoyer(getPy(data, "username")),
        });
        auditer(req, uid, "git.connector.create", { connector_id: id, provider_type: type, host });
        return { ok: true, id };
      }),
      route("PUT", "/api/git/connectors/:cid", async (req) => {
        const uid = utilisateur(req);
        const id = cid(req);
        const data = corpsJsonValeurs(req);
        const champs: ChampsConnecteur = {};
        for (const k of CHAMPS_MODIFIABLES) {
          if (!inPy(k, data)) continue;
          const v = nettoyer(getPy(data, k), k === "api_base" ? 400 : MAX);
          champs[k] = k === "host" ? normalizeHost(v) : v;
        }
        if (champs.provider_type && !PROVIDER_TYPES.includes(champs.provider_type))
          throw new HttpError(400, "provider_type invalide");
        if (inPy("token", data) && stripPy(textePy(getPy(data, "token"))))
          champs.token = stripPy(getPy(data, "token") as string);
        if (!(await updateConnector(base, uid, id, champs)))
          throw new HttpError(404, "Connecteur introuvable ou rien à modifier");
        auditer(req, uid, "git.connector.update", { connector_id: id });
        return { ok: true };
      }),
      route("DELETE", "/api/git/connectors/:cid", async (req) => {
        const uid = utilisateur(req);
        const id = cid(req);
        if (!(await deleteConnector(base, uid, id))) throw new HttpError(404, "Connecteur introuvable");
        auditer(req, uid, "git.connector.delete", { connector_id: id });
        return { ok: true };
      }),
      route("GET", "/api/git/connectors/:cid/repos", async (req, rep) => {
        const uid = utilisateur(req);
        const id = cid(req);
        const ligne = await getConnectorSecret(base, uid, id);
        if (!ligne) throw new HttpError(404, "Connecteur introuvable");
        const { prov, apiBase, motif, http } = await preparer(dep, ligne);
        if (!apiBase) return { ok: false, error: "no_api", repos: [] };
        if (motif) return { ok: false, error: `blocked: ${motif}`, repos: [] };
        const res = copieDict(await prov.listRepos(http, apiBase, ligne.token, ligne.username || ""));
        poserSiAbsent(res, "host", ligne.host);
        poserSiAbsent(res, "repos", []);
        const depots = res["repos"];
        auditer(req, uid, "git.connector.list_repos", {
          connector_id: id,
          ok: veritePy(res["ok"]),
          count: Array.isArray(depots)
            ? depots.length
            : veritePy(depots)
              ? Object.keys(depots as object).length
              : 0,
        });
        return reponseJsonPy(rep, res);
      }),
      route("POST", "/api/git/connectors/:cid/test", async (req, rep) => {
        const uid = utilisateur(req);
        const id = cid(req);
        const ligne = await getConnectorSecret(base, uid, id);
        if (!ligne) throw new HttpError(404, "Connecteur introuvable");
        const { prov, apiBase, motif, http } = await preparer(dep, ligne);
        if (!apiBase) return { ok: false, error: "no_api" };
        if (motif) return { ok: false, error: `blocked: ${motif}` };
        const res = copieDict(await prov.testConnection(http, apiBase, ligne.token, ligne.username || ""));
        poserSiAbsent(res, "host", ligne.host);
        poserSiAbsent(res, "api_base", apiBase);
        if (!veritePy(res["ok"])) {
          const h = indice(res, apiBase);
          if (h !== null) poserCle(res, "hint", h);
        }
        auditer(req, uid, "git.connector.test", {
          connector_id: id,
          ok: veritePy(res["ok"]),
          status: Object.hasOwn(res, "status") ? res["status"] : null,
        });
        return reponseJsonPy(rep, res);
      }),
    ],
  };
}
