// SPDX-License-Identifier: MIT
/** apps/core/src/familles/jetons.ts — Paramètres › Connexions : jetons personnels du compte connecté (accounts/routes_tokens.py). */
import {
  creerJeton,
  ErreurJeton,
  listerJetons,
  opencodeActif,
  politique,
  regenererJeton,
  revoquerJeton,
} from "@elpis/auth";
import { estDict, FlottantPy, HttpError, rstripPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { serviceUpstream } from "@elpis/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyRequest } from "fastify";

import { urlDeBase } from "../comptes/aides";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import type { DependancesComptes } from "./comptes";
import { corpsJson, entrees, py } from "@elpis/http";

const TYPES_CREABLES = ["tools", "opencode"];

/** Famille d'outils → catégorie portée par ses outils (`mcp/families.py`, FAMILY_CATEGORY). */
const CATEGORIE_DE_FAMILLE: Readonly<Record<string, string>> = {
  fs: "fs",
  shell: "shell",
  git: "git",
  chart: "chart",
  office: "office",
  memory: "memory",
  skill: "skill",
  skill_run: "skill",
  todo: "task",
  browser: "browser",
  desktop: "desktop",
};

const SCHEMA_TTL_S = 60;
const SCHEMA_DELAI_MS = 15_000;
const SCHEMA_FIN_MS = 2_000;
const CLES_OUTIL = ["name", "title", "description", "inputSchema", "outputSchema", "annotations"];
const schemas = new Map<string, [number, Dict[]]>();

/** `list_family_tools` : `tools/list` de `/mcp/<famille>` avec le jeton de service, session close par DELETE comme `async with Client`, 15 s, cache 60 s. */
async function outilsDeFamille(family: string): Promise<Dict[]> {
  const deja = schemas.get(family);
  if (deja && deja[0] > performance.now() / 1000) return deja[1];
  const [base, jeton] = serviceUpstream();
  if (!base || !jeton) throw new HttpError(503, "Service d'outils partagé non configuré.");
  const transport = new StreamableHTTPClientTransport(new URL(`${rstripPy(base, "/")}/${family}`), {
    requestInit: { headers: { Authorization: `Bearer ${jeton}` } },
  });
  const client = new Client({ name: "elpis-tokens-schema", version: "1.0.0" });
  let minuterie: NodeJS.Timeout | undefined;
  let outils: unknown[];
  try {
    const delai = new Promise<never>((_, echec) => {
      minuterie = setTimeout(() => echec(new Error("délai dépassé")), SCHEMA_DELAI_MS);
    });
    outils = await Promise.race([
      (async () => {
        await client.connect(transport);
        return (await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema))
          .tools as unknown[];
      })(),
      delai,
    ]);
  } catch {
    throw new HttpError(502, "Service d'outils injoignable.");
  } finally {
    clearTimeout(minuterie);
    let borne: NodeJS.Timeout | undefined;
    await Promise.race([
      transport.terminateSession().catch(() => undefined),
      new Promise<void>((fin) => {
        borne = setTimeout(fin, SCHEMA_FIN_MS);
      }),
    ]);
    clearTimeout(borne);
    await client.close().catch(() => undefined);
  }
  const items = outils
    .map((t) =>
      estDict(t) ? Object.fromEntries(CLES_OUTIL.filter((k) => t[k] != null).map((k) => [k, t[k]])) : {},
    )
    .filter((t) => veritePy(t["name"]));
  schemas.set(family, [performance.now() / 1000 + SCHEMA_TTL_S, items]);
  return items;
}

type DatesJeton = { created_at: number; expires_at: number | null; last_used_at: number | null };

/** `_row` de tokens.py : dates en `float` Python, écrites `1.0` et non `1`. */
function itemPy<T extends DatesJeton>(
  j: T,
): Omit<T, keyof DatesJeton> & Record<keyof DatesJeton, FlottantPy | null> {
  const f = (v: number | null): FlottantPy | null => (v === null ? null : new FlottantPy(v));
  return {
    ...j,
    created_at: new FlottantPy(j.created_at),
    expires_at: f(j.expires_at),
    last_used_at: f(j.last_used_at),
  };
}

/** `_json` : un corps illisible ou qui n'est pas un objet vaut `{}`. */
function corpsTolerant(requete: FastifyRequest): Record<string, unknown> {
  try {
    const v = corpsJson(requete);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function creerFamilleJetons(dep: DependancesComptes): Famille {
  const base = dep.auth.base;
  return {
    nom: "jetons",
    routes: [
      {
        methode: "GET",
        chemin: "/api/tokens",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const tokens = await listerJetons(base, uid);
          const config = dep.auth.config();
          const pol = politique(config);
          const url = urlDeBase(req);
          let libelles: Readonly<Record<string, string>> = {};
          try {
            libelles = dep.libellesCategories?.() ?? {};
          } catch {
            libelles = {};
          }
          return {
            tokens: tokens.map(itemPy),
            policy: {
              ...pol,
              families: pol.tools_families.map((f) => ({
                name: f,
                label: libelles[CATEGORIE_DE_FAMILLE[f] ?? f] || f,
              })),
            },
            opencode_enabled: opencodeActif(config),
            bridge_url: `${url}/api/mcp-bridge`,
            tools_url: `${url}/api/tools`,
          };
        },
      },
      {
        methode: "POST",
        chemin: "/api/tokens",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const corps = corpsTolerant(req);
          const type = strPy(veritePy(corps["kind"]) ? corps["kind"] : "tools");
          if (!TYPES_CREABLES.includes(type)) throw new HttpError(422, "Type de jeton inconnu.");
          const familles = Array.isArray(corps["families"]) ? corps["families"] : [];
          const jours = corps["days"];
          try {
            const [token, item] = await creerJeton(
              dep.auth,
              uid,
              type,
              strPy(veritePy(corps["name"]) ? corps["name"] : ""),
              familles,
              jours === "" || jours === null || jours === undefined ? undefined : jours,
            );
            return { token, item: itemPy(item) };
          } catch (e) {
            if (e instanceof ErreurJeton) throw new HttpError(422, e.message);
            throw e;
          }
        },
      },
      {
        methode: "POST",
        chemin: "/api/tokens/:token_id/regenerate",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const { token_id } = entrees(req, { path: { token_id: py.int() } }).path;
          let sortie: Awaited<ReturnType<typeof regenererJeton>>;
          try {
            sortie = await regenererJeton(dep.auth, uid, token_id);
          } catch (e) {
            if (e instanceof ErreurJeton) throw new HttpError(422, e.message);
            throw e;
          }
          if (!sortie) throw new HttpError(404, "Jeton introuvable.");
          return { token: sortie[0], item: itemPy(sortie[1]) };
        },
      },
      {
        methode: "GET",
        chemin: "/api/tokens/schema/:family",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          utilisateur(req);
          const { family } = req.params as { family: string };
          if (!politique(dep.auth.config()).tools_families.includes(family))
            throw new HttpError(404, "Famille d'outils inconnue.");
          return { family, tools: await outilsDeFamille(family) };
        },
      },
      {
        methode: "DELETE",
        chemin: "/api/tokens/:token_id",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const { token_id } = entrees(req, { path: { token_id: py.int() } }).path;
          if (!(await revoquerJeton(base, uid, token_id))) throw new HttpError(404, "Jeton introuvable.");
          return { ok: true };
        },
      },
    ],
  };
}
