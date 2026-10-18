// SPDX-License-Identifier: MIT
/** apps/core/src/outils/openapi.ts — façade OpenAPI des outils du service partagé (mcp/openapi.py) : spec tirée de tools/list, appel au nom du propriétaire du jeton. */
import { randomBytes } from "node:crypto";

import {
  comparePointsDeCode,
  copieProfondePy,
  estDict,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import {
  compilerSchema,
  DelaiDepasse,
  erreursSchema,
  estErreurTransport,
  FAMILY_CATEGORY,
  load,
  McpFileSaturee,
  ROLE_TOOLHOST,
} from "@elpis/mcp";
import type { ConfigMcp, PoolMcp } from "@elpis/mcp";

import { journal } from "../journal";
import { extractCategory } from "./categories";
import { toolTimeoutS } from "./delais";
import {
  flattenExceptionMessage,
  pickToolPayload,
  poolMcp,
  resoudreClientMcp,
  TOOL_QUEUE_WAIT_S,
  toolTimeoutJson,
} from "./mcp/clients";

/** Familles du service partagé qui ont déjà un point d'accès externe ; celles du compte (chart, memory, skill, todo) restent dans main. */
export const EXPOSABLE_FAMILIES: readonly string[] = [
  "fs",
  "shell",
  "git",
  "desktop",
  "browser",
  "skill_run",
];
export const OPENAPI_PREFIX = "/api/tools";
const SPEC_TTL_S = 60;

export type PoolOutils = Pick<PoolMcp, "getOrConnect" | "callTool">;

/** La famille n'a pas d'entrée dans le manifeste ou le service ne répond pas. */
export class FamilyUnavailable extends Error {
  constructor(family: string) {
    super(family);
    this.name = "FamilyUnavailable";
  }
}

/** File d'attente du service d'outils pleine : l'outil n'a PAS tourné. */
export class ServiceSaturated extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceSaturated";
  }
}

const log = journal("openapi");
const cache = new Map<string, [number, Dict[]]>();

/** Config de pool de l'entrée intégrée `role: toolhost` qui sert la famille ; jamais une entrée `role: app`. */
export function familyCfg(family: string): ConfigMcp | null {
  let entree: ReturnType<ReturnType<typeof load>["entryForFamily"]>;
  try {
    entree = load().entryForFamily(family);
  } catch (e) {
    log.warn({ err: e }, "manifeste illisible");
    return null;
  }
  if (entree === null || entree.role !== ROLE_TOOLHOST) return null;
  return entree.clientCfg(null);
}

/** `_tool_dict` : `_meta` rendu sous `meta` (placé en dernier, comme `dict.pop` puis affectation). */
function outilVersDict(outil: unknown): Dict {
  const d: Dict = estDict(outil) ? { ...outil } : {};
  if (Object.hasOwn(d, "_meta") && !Object.hasOwn(d, "meta")) {
    const meta = d["_meta"];
    delete d["_meta"];
    d["meta"] = meta;
  }
  return d;
}

function categorie(outil: Dict): string | null {
  try {
    return extractCategory(outil)[0];
  } catch {
    return null;
  }
}

/** Outils de la famille ; une entrée qui en sert plusieurs (manifeste hérité) est filtrée par catégorie, `skill_run` par préfixe. */
function filtrerFamille(family: string, outils: Dict[], cfg: ConfigMcp): Dict[] {
  const fams = Array.isArray(cfg["families"]) ? (cfg["families"] as unknown[]) : [];
  if (fams.length === 1 && fams[0] === family) return outils;
  const voulue = FAMILY_CATEGORY[family] ?? family;
  let gardes = outils.filter((t) => categorie(t) === voulue);
  if (family === "skill_run")
    gardes = gardes.filter((t) => strPy(veritePy(t["name"]) ? t["name"] : "").startsWith("skill_run"));
  return gardes;
}

/** Outils de la famille triés par nom, depuis le pool MCP de l'app, en cache 60 s ; lève `FamilyUnavailable`. */
export async function familyTools(family: string, pool: PoolOutils = poolMcp): Promise<Dict[]> {
  const maintenant = performance.now() / 1000;
  const deja = cache.get(family);
  if (deja && maintenant - deja[0] < SPEC_TTL_S) return deja[1];
  const cfg = familyCfg(family);
  if (cfg === null) throw new FamilyUnavailable(family);
  let brut: unknown[];
  try {
    [, brut] = await pool.getOrConnect(cfg, resoudreClientMcp);
  } catch (e) {
    log.warn({ err: e }, `service d'outils injoignable pour ${family}`);
    throw new FamilyUnavailable(family);
  }
  const nom = (t: Dict): string => strPy(veritePy(t["name"]) ? t["name"] : "");
  const outils = filtrerFamille(family, (brut ?? []).map(outilVersDict), cfg)
    .sort((a, b) => comparePointsDeCode(nom(a), nom(b)))
    .filter((t) => veritePy(t["name"]));
  cache.set(family, [maintenant, outils]);
  return outils;
}

export function clearCache(): void {
  cache.clear();
}

/** Nom de composant sans collision entre outils (`[A-Za-z0-9._-]`). */
function nomComposant(outil: string, genre: string, nom: string): string {
  return (genre ? `${outil}.${genre}.${nom}` : `${outil}.${nom}`).replace(/[^A-Za-z0-9._-]/gu, "_");
}

/** Copie du schéma dont les `$defs` partent dans `components/schemas` (préfixés par l'outil) et dont les `$ref` locaux suivent. */
function remonterDefs(schema: unknown, outil: string, genre: string, composants: Dict): unknown {
  if (!estDict(schema)) return schema;
  const copie = copieProfondePy(schema) as Dict;
  const retirer = (cle: string): unknown => {
    const v = copie[cle];
    delete copie[cle];
    return v;
  };
  let defs = retirer("$defs");
  if (!veritePy(defs)) defs = retirer("definitions");
  if (!veritePy(defs)) defs = {};
  if (!estDict(defs)) throw new TypeError(`'${typeof defs}' object has no attribute 'items'`);
  const table = new Map(Object.keys(defs).map((n) => [n, nomComposant(outil, genre, n)]));
  const reecrire = (noeud: unknown): unknown => {
    if (Array.isArray(noeud)) return noeud.map(reecrire);
    if (!estDict(noeud)) return noeud;
    const sortie: Dict = {};
    for (const [k, brut] of Object.entries(noeud)) {
      if (k === "$ref" && typeof brut === "string") {
        let v = brut;
        for (const pre of ["#/$defs/", "#/definitions/"]) {
          const cible = table.get(v.slice(pre.length));
          if (v.startsWith(pre) && cible !== undefined) v = `#/components/schemas/${cible}`;
        }
        sortie[k] = v;
      } else sortie[k] = reecrire(brut);
    }
    return sortie;
  };
  for (const [n, d] of Object.entries(defs)) composants[table.get(n) as string] = reecrire(d);
  return reecrire(copie);
}

/** Résultat non-objet enveloppé par FastMCP (`x-fastmcp-wrap-result`) : `[schéma interne, true]`. */
function deballerSortie(schema: unknown): [Dict | null, boolean] {
  if (!estDict(schema)) return [null, false];
  if (veritePy(schema["x-fastmcp-wrap-result"])) {
    const props = veritePy(schema["properties"]) ? schema["properties"] : {};
    if (!estDict(props)) throw new TypeError(`'${typeof props}' object has no attribute 'get'`);
    const interne = props["result"];
    if (estDict(interne)) {
      const copie: Dict = { ...interne };
      if (Object.hasOwn(schema, "$defs") && !Object.hasOwn(copie, "$defs")) copie["$defs"] = schema["$defs"];
      return [copie, true];
    }
  }
  return [schema, false];
}

const SCHEMA_ERREUR_OUTIL = {
  type: "object",
  description:
    "Échec de l'outil (argument refusé, fichier absent, délai dépassé…) : l'appel HTTP réussit, l'outil non. " +
    "Le modèle appelant doit lire ``error``/``message`` et ``fix``.",
  properties: {
    ok: { const: false },
    error: { type: "string" },
    message: { type: "string" },
    fix: { type: "string" },
  },
  required: ["ok"],
};

const SCHEMA_ERREUR_HTTP = { type: "object", properties: { detail: {} }, required: ["detail"] };

const REPONSES_ERREUR: readonly (readonly [string, string])[] = [
  ["401", "Jeton d'outils absent, invalide, expiré ou révoqué."],
  ["404", "Famille ou outil hors de la portée du jeton, ou inconnu."],
  ["422", "Arguments non conformes au schéma de l'outil."],
  ["429", "Trop d'appels simultanés pour ce compte (ou service saturé) : réessayer."],
  ["502", "Le service d'outils ne répond pas."],
];

/** Document OpenAPI 3.1 de la famille (pur : aucune E/S). */
export function buildSpec(
  family: string,
  outils: readonly Dict[],
  serverUrl: string,
  version = "1.0.0",
): Dict {
  const composants: Dict = { ToolError: SCHEMA_ERREUR_OUTIL, HTTPError: SCHEMA_ERREUR_HTTP };
  const chemins: Dict = {};
  for (const t of outils) {
    const nom = strPy(t["name"]);
    let entree = remonterDefs(
      veritePy(t["inputSchema"]) ? t["inputSchema"] : { type: "object" },
      nom,
      "",
      composants,
    );
    if (!estDict(entree)) entree = { type: "object" };
    const schemaEntree = entree as Dict;
    if (!Object.hasOwn(schemaEntree, "type")) schemaEntree["type"] = "object";
    if (!Object.hasOwn(schemaEntree, "properties")) schemaEntree["properties"] = {};
    const compEntree = nomComposant(nom, "", "input");
    composants[compEntree] = schemaEntree;

    const [sortieBrute] = deballerSortie(t["outputSchema"]);
    let schemaOk: Dict;
    if (sortieBrute !== null) {
      const compSortie = nomComposant(nom, "out", "output");
      const remontee = remonterDefs(sortieBrute, nom, "out", composants);
      composants[compSortie] = remontee;
      schemaOk = {
        anyOf: [{ $ref: `#/components/schemas/${compSortie}` }, { $ref: "#/components/schemas/ToolError" }],
      };
    } else schemaOk = { description: "Résultat de l'outil (JSON ; texte brut sous « text »)." };

    const annBrute = veritePy(t["annotations"]) ? t["annotations"] : {};
    if (!estDict(annBrute)) throw new TypeError(`'${typeof annBrute}' object has no attribute 'get'`);
    const ann = annBrute;
    const titre = strPy(veritePy(t["title"]) ? t["title"] : veritePy(ann["title"]) ? ann["title"] : nom);
    const op: Dict = {
      operationId: nom,
      summary: titre,
      description: strPy(veritePy(t["description"]) ? t["description"] : titre),
      tags: [family],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${compEntree}` } } },
      },
      responses: {
        "200": {
          description:
            "Résultat de l'outil. Un échec de l'OUTIL répond aussi 200, avec « ok: false » (voir ToolError).",
          content: { "application/json": { schema: schemaOk } },
        },
        ...Object.fromEntries(REPONSES_ERREUR.map(([c]) => [c, { $ref: `#/components/responses/E${c}` }])),
      },
    };
    const indices = Object.fromEntries(
      ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]
        .filter((k) => Object.hasOwn(ann, k))
        .map((k) => [k, ann[k]]),
    );
    if (Object.keys(indices).length > 0) op["x-elpis-annotations"] = indices;
    chemins[`/${nom}`] = { post: op };
  }
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: `Elpis — outils « ${family} »`,
      version,
      description:
        `Outils de la famille « ${family} » d'Elpis, exécutés dans la sandbox du ` +
        "compte propriétaire du jeton. Authentification : « Authorization: Bearer ept_… » " +
        "(jeton d'outils créé dans Paramètres › Connexions).",
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    paths: chemins,
    components: {
      schemas: composants,
      responses: Object.fromEntries(
        REPONSES_ERREUR.map(([c, desc]) => [
          `E${c}`,
          {
            description: desc,
            content: { "application/json": { schema: { $ref: "#/components/schemas/HTTPError" } } },
          },
        ]),
      ),
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "Jeton d'outils Elpis (ept_…)." },
      },
    },
  };
}

/** Écarts des arguments à l'`inputSchema` (JSON Schema 2020-12) : dix au plus ; schéma illisible = aucun (le serveur valide aussi). */
export function validationErrors(outil: Dict, args: unknown): { path: string; message: string }[] {
  const schema = veritePy(outil["inputSchema"]) ? outil["inputSchema"] : { type: "object" };
  try {
    const erreurs = erreursSchema(compilerSchema(schema, "2020-12"), schema, args);
    return erreurs.slice(0, 10).map((e) => ({
      path: e.chemin.map(String).join("/") || "(racine)",
      message: prefixePy(e.message, 300),
    }));
  } catch (e) {
    log.warn({ err: e }, `schéma d'entrée illisible pour ${strPy(outil["name"] ?? null)}`);
    return [];
  }
}

/** `CallToolResult` → corps de la réponse 200 : contenu structuré (déballé s'il était enveloppé), sinon charge utile, texte sous « text ». */
export function responseValue(res: unknown, outil: Dict): unknown {
  if (estDict(res) && veritePy(res["isError"])) return pickToolPayload(res);
  const sc = estDict(res) ? res["structuredContent"] : undefined;
  if (estDict(sc)) {
    const [, enveloppe] = deballerSortie(outil["outputSchema"]);
    if (enveloppe && Object.hasOwn(sc, "result")) return sc["result"];
    return sc;
  }
  const val = pickToolPayload(res);
  if (estDict(val) || Array.isArray(val)) return val;
  return { text: typeof val === "string" ? val : pyJsonDumps(val ?? null, { ensureAscii: false }) };
}

/** Appel au nom du propriétaire du jeton ; un délai dépassé est un échec d'OUTIL, la file pleine `ServiceSaturated`, le transport `FamilyUnavailable`. */
export async function callTool(
  family: string,
  outil: Dict,
  args: Dict,
  qui: { username: string; userId: number },
  pool: PoolOutils = poolMcp,
): Promise<unknown> {
  const cfg = familyCfg(family);
  if (cfg === null) throw new FamilyUnavailable(family);
  const nom = strPy(outil["name"]);
  const meta = {
    username: qui.username,
    user_id: String(Math.trunc(qui.userId)),
    call_id: `openapi-${randomBytes(6).toString("hex")}`,
  };
  const delai = toolTimeoutS(nom);
  let res: unknown;
  try {
    res = await pool.callTool(cfg, nom, args, {
      resolveClient: resoudreClientMcp,
      meta,
      execTimeoutS: delai,
      queueTimeoutS: TOOL_QUEUE_WAIT_S,
    });
  } catch (e) {
    if (e instanceof DelaiDepasse) return pyJsonLoads(toolTimeoutJson(nom, delai), { mode: "valeurs" });
    if (e instanceof McpFileSaturee) throw new ServiceSaturated(e.message);
    if (e instanceof FamilyUnavailable || estErreurTransport(e)) {
      log.warn({ err: e }, `appel ${family}/${nom} en échec de transport`);
      throw new FamilyUnavailable(family);
    }
    return { ok: false, error: prefixePy(flattenExceptionMessage(e), 2000) };
  }
  return responseValue(res, outil);
}
