// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-integrations.ts — `/api/admin` des intégrations (tests du service RAG et du moteur vocal), des prompts système et du manifeste MCP (shared_infra/routes/admin/integrations.py, system_prompts.py, shared_infra/mcp/panel.py). */
import {
  encoderUtf8Py,
  ErreurPython,
  estDict,
  estErreurPython,
  FlottantPy,
  floatPy,
  getPy,
  HttpError,
  intPy,
  longueurPy,
  maxPy,
  minPy,
  nomTypePy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { httpsEnabled } from "@elpis/config";
import {
  exportServers,
  invaliderMcp,
  load,
  manifestPath,
  reload,
  ROLE_TOOLHOST,
  schemaPath,
} from "@elpis/mcp";
import type { FastifyRequest } from "fastify";

import {
  ecrirePrompt,
  estFichier,
  lirePrompt,
  listerPromptsSysteme,
  MAX_FILE_BYTES,
  resoudreCategorie,
} from "../administration/prompts-systeme";
import { transportsParFamille } from "../administration/hotes-outils";
import { modelesVoix, testerVoix } from "../administration/voix";
import { countTokensExact, estTokensText } from "../contexte/tokens";
import type { Journal } from "../journal";
import { getToolCategoriesDict } from "../outils/categories";
import { serviceJoignable } from "../outils/mcp/clients";
import { assembleSystemMessages, listKnownCategories, preview } from "../prompts/systeme";
import { ping, RagServiceError } from "../rag/client";
import { hostFromSpec } from "../relais/hotes";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { corpsJsonValeurs, entrees, nonFinisEnNul, py } from "@elpis/http";

export interface DependancesAdminIntegrations {
  readonly journal: Journal;
}

function route(methode: DefinitionRoute["methode"], chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter };
}

function messageDe(e: unknown): string {
  return e instanceof Error ? e.message : strPy(e);
}

/** `await request.json()` sous `except Exception` : corps illisible = `{}`. */
function corpsTolere(req: FastifyRequest): unknown {
  try {
    return corpsJsonValeurs(req);
  } catch {
    return {};
  }
}

// ── Intégrations (integrations.py) ──────────────────────────────────────────

/** `POST /api/admin/rag-service/test` : URL, jeton et délai du formulaire (sinon enregistrés), toujours 200. */
async function testerRag(dep: DependancesAdminIntegrations, req: FastifyRequest): Promise<unknown> {
  const data = corpsTolere(req);
  const brute = getPy(data, "url");
  const url = veritePy(brute) ? brute : "";
  if (typeof url !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(url)}' object has no attribute 'strip'`);
  const jeton = getPy(data, "token");
  let delai = 5.0;
  try {
    const t = getPy(data, "timeout");
    delai = floatPy(veritePy(t) ? t : 5.0);
  } catch (e) {
    if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
  }
  delai = maxPy(0.5, minPy(delai, 30.0));
  try {
    const sante = await ping(
      stripPy(url) || null,
      jeton === null ? null : veritePy(jeton) ? strPy(jeton) : "",
      delai,
    );
    return nonFinisEnNul({ ok: true, status: sante });
  } catch (e) {
    if (e instanceof RagServiceError) return { ok: false, error: e.message };
    dep.journal.error({ err: e }, "[admin/rag-service/test] unexpected error");
    return { ok: false, error: `Erreur interne: ${messageDe(e)}` };
  }
}

/** Corps d'un test vocal : autre chose qu'un objet vaut `{}`. */
function corpsVoix(req: FastifyRequest): Dict {
  const data = corpsTolere(req);
  return estDict(data) ? data : {};
}

// ── Prompts système (system_prompts.py) ─────────────────────────────────────

/** `(nb_tokens, exact)` : `/tokenize` du moteur s'il répond, sinon l'estimation de l'application. */
async function compterJetons(texte: string): Promise<[number, boolean]> {
  try {
    const n = await countTokensExact(texte);
    if (typeof n === "number" && Number.isInteger(n) && n > 0) return [n, true];
  } catch {
    // moteur absent : estimation
  }
  try {
    return [intPy(estTokensText(texte)), false];
  } catch {
    return [0, false];
  }
}

async function apercuPrompt(req: FastifyRequest): Promise<Dict> {
  const { categories, user_prompt, query } = entrees(req, {
    query: {
      categories: py.str().defaut(""),
      user_prompt: py.str().defaut(""),
      query: py.str().defaut(""),
    },
  }).query;
  const actives = categories
    .split(",")
    .map((c) => stripPy(c))
    .filter((c) => c);
  const serveurs = actives.length > 0 ? [{ type: "stdio", name: "Local", filter_categories: actives }] : [];
  const entreesSysteme = { customSys: user_prompt, activeMcpServers: serveurs, lastUserText: query };
  const messages = await assembleSystemMessages(entreesSysteme);
  const texte = await preview(entreesSysteme);
  const [jetons, exact] = await compterJetons(texte);
  return {
    user_prompt,
    active_categories: actives,
    available_categories: await listKnownCategories(),
    assembled: texte,
    messages,
    size_chars: longueurPy(texte),
    approx_tokens: jetons,
    tokens_exact: exact,
  };
}

function lireCategorie(req: FastifyRequest): Dict {
  const { category } = entrees(req, { path: { category: py.str() } }).path;
  const p = resoudreCategorie(category);
  if (!estFichier(p)) throw new HttpError(404, `${category}.md not found`);
  return lirePrompt(p, category);
}

/** `PUT …/{category}` : catégorie existante seulement (404 comme le GET), texte non vide gardé tel que saisi avec un `\n` final, 50 000 octets au plus, écriture atomique sans verrou. */
async function ecrireCategorie(req: FastifyRequest): Promise<Dict> {
  const { category } = entrees(req, { path: { category: py.str() } }).path;
  const p = resoudreCategorie(category);
  if (!estFichier(p)) throw new HttpError(404, `${category}.md not found`);
  const brut = getPy(corpsJsonValeurs(req), "content");
  if (typeof brut !== "string") throw new HttpError(400, "body.content must be a string");
  if (!stripPy(brut))
    throw new HttpError(400, "content is empty — use DELETE if you really want to remove this category");
  if (encoderUtf8Py(brut).length > MAX_FILE_BYTES)
    throw new HttpError(400, `content too large (${longueurPy(brut)} chars > ${MAX_FILE_BYTES} bytes max)`);
  const contenu = brut.endsWith("\n") ? brut : `${brut}\n`;
  await ecrirePrompt(p, contenu);
  return { ok: true, category, size_chars: longueurPy(contenu), path: p };
}

// ── Manifeste MCP (mcp/panel.py) ────────────────────────────────────────────

/** `GET /api/admin/mcp/manifest` : vue publique (jetons masqués), joignabilité TCP des URL réseau, familles vivantes. */
async function vueManifeste(): Promise<Dict> {
  const m = load();
  const vue = m.toPublicDict();
  vue["loaded_at"] = new FlottantPy(m.loaded_at);
  for (const ligne of vue["servers"] as Dict[]) {
    const url = ligne["url"];
    ligne["reachable"] =
      veritePy(url) && (ligne["type"] === "http" || ligne["type"] === "sse")
        ? await serviceJoignable(strPy(url), 400)
        : null;
  }
  try {
    const vivantes: Dict = {};
    for (const [k, v] of Object.entries(getToolCategoriesDict())) if (v.length > 0) vivantes[k] = v.length;
    vue["live_categories"] = vivantes;
  } catch {
    vue["live_categories"] = {};
  }
  vue["manifest_path"] = manifestPath();
  vue["schema_path"] = schemaPath();
  return { ok: true, manifest: vue };
}

/** `GET …/export` : bloc `mcpServers` prêt à coller ; le jeton de service seulement sur `with_token=1` ; `omis` = entrées sans ce transport, en SSE d'après le `/manifest` de l'hôte (écarts : absents en Python). */
async function exporterManifeste(req: FastifyRequest): Promise<Dict> {
  const q = entrees(req, {
    query: {
      transport: py.str().defaut("http"),
      base_url: py.str().defaut(""),
      scope: py.str().defaut("toolhost"),
      with_token: py.int().defaut(0),
      prefix: py.str().defaut(""),
    },
  }).query;
  const m = load();
  const entreesExport = q.scope !== "all" ? m.toolhosts() : m.builtins();
  const base = stripPy(q.base_url) || m.hostBaseUrl();
  const jeton = veritePy(q.with_token) ? m.hostToken() : "";
  const doc = exportServers(entreesExport, {
    baseUrl: base,
    transport: q.transport,
    token: jeton,
    prefix: q.prefix,
  });
  const servis = doc["mcpServers"] as Dict;
  const hote = hostFromSpec("export", { url: m.hostBaseUrl(), token: m.hostToken() });
  const parFamille =
    stripPy(q.transport).toLowerCase() === "sse" && hote !== null && hote.token
      ? await transportsParFamille(hote, req.utilisateur?.id ?? 0)
      : null;
  for (const e of entreesExport)
    if (e.role === ROLE_TOOLHOST && e.families.some((f) => parFamille?.get(f)?.has("sse") === false))
      Reflect.deleteProperty(servis, `${q.prefix}${e.name}`);
  const omis = entreesExport.map((e) => `${q.prefix}${e.name}`).filter((n) => !Object.hasOwn(servis, n));
  return { ok: true, transport: q.transport, base_url: base, with_token: Boolean(jeton), ...doc, omis };
}

/** `POST …/reload` : pool de ce process recyclé (cache du manifeste purgé, échec journalisé) puis relecture forcée de `mcp.json`, gardée en cache. */
async function rechargerManifeste(): Promise<Dict> {
  await invaliderMcp({ type: "manifeste" });
  const m = reload();
  return {
    ok: true,
    source: m.source,
    errors: [...m.errors],
    warnings: [...m.warnings],
    servers: [...m.servers.keys()],
  };
}

export function creerFamilleAdminIntegrations(dep: DependancesAdminIntegrations): Famille {
  return {
    nom: "admin-integrations",
    routes: [
      route("POST", "/api/admin/rag-service/test", (req) => testerRag(dep, req)),
      route("POST", "/api/admin/voice/test", async (req) =>
        nonFinisEnNul(await testerVoix(corpsVoix(req), httpsEnabled(), dep.journal)),
      ),
      route("POST", "/api/admin/voice/models", async (req) =>
        nonFinisEnNul(await modelesVoix(corpsVoix(req), dep.journal)),
      ),
      route("GET", "/api/admin/system-prompts", () => listerPromptsSysteme()),
      route("GET", "/api/admin/system-prompts/_template", () => {
        const p = resoudreCategorie("_TEMPLATE", true);
        if (!estFichier(p)) throw new HttpError(404, "_TEMPLATE.md not found");
        return lirePrompt(p, "_TEMPLATE");
      }),
      route("GET", "/api/admin/system-prompts/_preview", (req) => apercuPrompt(req)),
      route("GET", "/api/admin/system-prompts/:category", (req) => lireCategorie(req)),
      route("PUT", "/api/admin/system-prompts/:category", (req) => ecrireCategorie(req)),
      route("GET", "/api/admin/mcp/manifest", () => vueManifeste()),
      route("GET", "/api/admin/mcp/manifest/export", (req) => exporterManifeste(req)),
      route("POST", "/api/admin/mcp/manifest/reload", () => rechargerManifeste()),
    ],
  };
}
