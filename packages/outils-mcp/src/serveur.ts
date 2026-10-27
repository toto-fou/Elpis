// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/serveur.ts — serveur MCP des familles d'outils (server/local_mcp_server.py) : registre, liste paginée, appel et pile des middlewares, sur le `Server` bas niveau du SDK. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  clesOrdonnees,
  estDict,
  FlottantPy,
  intPy,
  journalDe,
  messageErreurOs,
  noterOrdreDesCles,
  pyJsonDumps,
  pyJsonLoads,
  reprPy,
  strPy,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { racineDepot } from "@elpis/config";
import { compilerSchema, FAMILY_NAMES, meilleureErreur, opencodeFamilies } from "@elpis/mcp";
import { avecIdentite, creerIdentite, fromMeta, refusSousAgent, restaurerArgsOutil } from "@elpis/securite";
import type { Identity } from "@elpis/securite";
import { Protocol } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { InitializeRequestSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { ServerNotification, ServerRequest, ServerResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { validerArguments } from "./arguments";
import type { Signature } from "./arguments";
import { avecJeton, NIVEAUX_JOURNAL } from "./contexte";
import type { ContexteAppel, JetonAcces, NiveauJournal, OptionsJournal } from "./contexte";
import { err, tokenIdentity } from "./boite";
import { ErreurOutil, LimiteConcurrence, LimiteDebit } from "./limites";
import { estEnveloppeErreur } from "./modeles";
import { famillesCachees } from "./portee";
import { jsonPydantic, titlePy } from "./texte";

/** `SUPPORTED_PROTOCOL_VERSIONS` du SDK Python (mcp 1.27.1). */
export const VERSIONS_PROTOCOLE: readonly string[] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
export const VERSION_PROTOCOLE_DEFAUT = "2025-03-26";

export const SERVER_INSTRUCTIONS =
  "Elpis tools. Each call runs in the caller's own sandbox (files, shell, git, " +
  "skill scripts) or drives the caller's browser/desktop sessions. Tool failures " +
  "come back as isError results with a JSON envelope (error, message, fix).";

/** Capacités annoncées par FastMCP 3.2.4 après `install_protocol_conformance` (aucune notification de changement). */
export const CAPACITES = {
  experimental: {},
  logging: {},
  prompts: { listChanged: false },
  resources: { subscribe: false, listChanged: false },
  tools: { listChanged: false },
  extensions: { "io.modelcontextprotocol/ui": {} },
} as const;

/** Méthodes de `ClientRequest` (mcp 1.27.1) : connues sans gestionnaire → -32601, inconnues → -32602 (échec d'analyse). */
const METHODES_CONNUES = new Set([
  "ping",
  "initialize",
  "completion/complete",
  "logging/setLevel",
  "prompts/get",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "tools/call",
  "tools/list",
  "tasks/get",
  "tasks/result",
  "tasks/list",
  "tasks/cancel",
]);

/** Erreur JSON-RPC rendue telle quelle (le `McpError` du SDK préfixe son message). */
export class ErreurProtocole extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** Résultat d'outil déjà mis en forme (contenus multimédias, `ToolResult` de FastMCP). */
export class ResultatBrut {
  readonly content: Dict[];
  readonly structuredContent: Dict | null;

  constructor(content: Dict[], structuredContent: Dict | null = null) {
    this.content = content;
    this.structuredContent = structuredContent;
  }
}

/** Un outil d'une famille : définition publiée figée (golden `tools/list`), signature Python, traitement. */
export interface DefinitionOutil {
  readonly nom: string;
  readonly famille: string;
  /** Nom de la fonction Python (`call[<fonction>]` des erreurs de validation) ; défaut : le nom de l'outil. */
  readonly fonction?: string;
  /** Objet `Tool` publié (`name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`, `_meta`). */
  readonly definition: Dict;
  readonly signature: Signature["parametres"];
  /** Paramètres tous déclarés après `*` (`def f(*, a, b)`), comme les outils `chart_<type>`. */
  readonly motsClesSeuls?: boolean;
  /** `brut` : arguments tels que reçus (flottants `1.0` et entiers longs gardés), pour les paramètres `Any` dont la forme compte. */
  readonly traiter: (args: Dict, ctx: ContexteAppel, brut: Dict) => unknown;
}

/** Ressource à gabarit d'URI d'une famille (`@mcp.resource("chart://{username}/{chart_id}")`) : lue en texte. */
export interface DefinitionRessource {
  readonly nom: string;
  readonly modele: string;
  readonly description: string;
  readonly mimeType: string;
  readonly tags: readonly string[];
  readonly lire: (params: Readonly<Record<string, string>>) => string | Promise<string>;
}

/** Une famille d'une vague d'enregistrement : nom, outils et ressources à gabarit d'URI (facultatives). */
export type FamilleAEnregistrer = readonly [
  string,
  readonly DefinitionOutil[],
  (readonly DefinitionRessource[])?,
];

/** Ce que l'hôte sait du compte quand le `_meta` n'a pas d'id (rappel `/api/internal/identity`). */
export interface IdentiteDistante {
  user_id: number;
  username: string;
  network_profile_id: string;
  is_admin: boolean;
}

export interface PortRappelIdentite {
  readonly actif: boolean;
  identityForUsername(username: string): Promise<IdentiteDistante | null>;
}

export interface OptionsServeur {
  readonly nom?: string;
  readonly version?: string;
  readonly instructions?: string;
  readonly taillePage?: number;
  readonly famillesOpencode?: Iterable<string>;
  readonly limiteDebit?: LimiteDebit | null;
  readonly limiteConcurrence?: LimiteConcurrence | null;
  /** `CTX.disabled_tools()` : outils éteints par `tools.<nom>.enabled=false`. */
  readonly outilsEteints?: () => Iterable<string>;
  readonly rappel?: PortRappelIdentite | null;
}

/** Ce que la requête en cours sait de son client : jeton d'accès et portée de la session. */
export interface ContexteRequete {
  readonly jeton: JetonAcces | null;
  readonly famille: string | null;
}

/** État d'une session MCP : portée fixée à sa création (comme le ContextVar du GET/POST initial), niveau de journal. */
export interface SessionOutils {
  readonly famille: string | null;
  niveau: NiveauJournal | null;
  /** Jeton d'une session sans authentification HTTP (en mémoire : `null`, comme `app_mcp`). */
  readonly jetonDefaut?: JetonAcces | null;
}

const log = (): ReturnType<typeof journalDe> => journalDe("outils-mcp");

/** Version d'Elpis (`pyproject.toml`, sinon `package.json`) annoncée dans `serverInfo`. */
export function versionElpis(): string {
  const racine = racineDepot();
  try {
    const m = /^\[project\][^[]*?^version\s*=\s*"([^"]*)"/msu.exec(
      readFileSync(join(racine, "pyproject.toml"), "utf8"),
    );
    if (m?.[1]) return m[1];
  } catch {
    // pas de pyproject : version du paquet
  }
  try {
    const v = (JSON.parse(readFileSync(join(racine, "package.json"), "utf8")) as { version?: unknown })
      .version;
    return typeof v === "string" && v ? v : "0";
  } catch {
    return "0";
  }
}

function taillePageEnv(): number {
  try {
    return Math.max(1, intPy(process.env["LOCAL_MCP_LIST_PAGE_SIZE"] || 100));
  } catch {
    return 100;
  }
}

/** Curseur opaque de FastMCP : base64 URL (avec `=`) de `{"o": <décalage>}`. */
export function encoderCurseur(decalage: number): string {
  const b = Buffer.from(pyJsonDumps({ o: decalage }), "utf8").toString("base64url");
  return b + "=".repeat((4 - (b.length % 4)) % 4);
}

/** `CursorState.decode` : décalage entier, sinon `Invalid cursor: <curseur>` (-32602) ; les caractères hors alphabet sont ignorés comme par `b64decode`. */
export function decoderCurseur(curseur: string): number {
  const invalide = new ErreurProtocole(-32602, `Invalid cursor: ${curseur}`);
  const propre = curseur.replace(/[^A-Za-z0-9_=-]/gu, "");
  if (propre.length % 4 !== 0 || !/^[A-Za-z0-9_-]*={0,2}$/u.test(propre)) throw invalide;
  let d: unknown;
  try {
    const octets = Buffer.from(propre, "base64url");
    const t = new TextDecoder("utf-8", { fatal: true }).decode(octets);
    d = pyJsonLoads(t);
  } catch {
    throw invalide;
  }
  const o = estDict(d) ? d["o"] : undefined;
  if (typeof o === "boolean") return o ? 1 : 0;
  if (typeof o !== "number" || !Number.isInteger(o)) throw invalide;
  return o;
}

/** Valeur JSON du `structuredContent` : flottants marqués rendus en nombres, entiers longs approchés. */
function jsonable(v: unknown): unknown {
  if (v instanceof FlottantPy) return Number.isFinite(v.valeur) ? v.valeur : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map(jsonable);
  if (estDict(v)) {
    const copie: Dict = {};
    for (const k of clesOrdonnees(v)) copie[k] = jsonable(v[k]);
    return copie;
  }
  return v;
}

/** `model_dump(mode="json")` du SDK Python sur la requête : NaN et ±Infinity deviennent `null` ; ce qui n'en contient pas est rendu tel quel (ordre Python des clés compris). */
function nonFinisEnNul(v: unknown): unknown {
  if (v instanceof FlottantPy) return Number.isFinite(v.valeur) ? v : null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) {
    const copie = v.map(nonFinisEnNul);
    return copie.every((x, i) => x === v[i]) ? v : copie;
  }
  if (estDict(v)) {
    const cles = clesOrdonnees(v);
    const valeurs = cles.map((k) => nonFinisEnNul(v[k]));
    if (valeurs.every((x, i) => x === v[cles[i] as string])) return v;
    const copie: Dict = Object.create(null) as Dict;
    cles.forEach((k, i) => {
      copie[k] = valeurs[i];
    });
    noterOrdreDesCles(copie, cles);
    return copie;
  }
  return v;
}

const texte = (t: string): Dict => ({ type: "text", text: t });

function erreurResultat(message: string): Dict {
  return { content: [texte(message)], isError: true };
}

const CHAMPS_BLOC: Readonly<Record<string, readonly [readonly string[], readonly string[]]>> = {
  text: [["text"], []],
  image: [["data", "mimeType"], []],
  audio: [["data", "mimeType"], []],
  resource: [["resource"], []],
  resource_link: [
    ["uri", "name"],
    ["title", "description", "mimeType", "size", "icons"],
  ],
};

/** Bloc de contenu (instance de `ContentBlock` côté Python) : type connu, champs requis présents, aucun autre champ ; un résultat d'outil qui porte seulement `type` reste un dict. */
function estBloc(v: unknown): boolean {
  if (!estDict(v) || typeof v["type"] !== "string" || !Object.hasOwn(CHAMPS_BLOC, v["type"])) return false;
  const [requis, facultatifs] = CHAMPS_BLOC[v["type"]] as readonly [readonly string[], readonly string[]];
  const permis = new Set(["type", "annotations", "_meta", ...requis, ...facultatifs]);
  return requis.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => permis.has(k));
}

/** `_convert_to_content` : texte brut, octets, blocs, sinon le texte JSON de pydantic_core. */
function contenus(v: unknown): Dict[] {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return [texte(v)];
  if (v instanceof Uint8Array) {
    const s = Buffer.from(v).toString("utf8");
    return [texte(Buffer.from(s, "utf8").equals(Buffer.from(v)) ? s : Buffer.from(v).toString("base64"))];
  }
  if (Array.isArray(v) && v.length > 0 && v.every(estBloc)) return v as Dict[];
  if (estBloc(v)) return [v as Dict];
  return [texte(jsonPydantic(v))];
}

/** Résultat brut de l'outil → `CallToolResult` (enveloppe `result`, validation de la sortie comme le SDK Python). */
function resultatAppel(
  outil: DefinitionOutil,
  valeur: unknown,
  valideur: (sc: unknown) => string | null,
): Dict {
  if (valeur instanceof ResultatBrut)
    return valeur.structuredContent === null
      ? { content: valeur.content, isError: false }
      : { content: valeur.content, structuredContent: valeur.structuredContent, isError: false };
  const schema = outil.definition["outputSchema"];
  const blocs = contenus(valeur);
  if (valeur instanceof Uint8Array) return { content: blocs, isError: false };
  const structure = jsonable(valeur);
  if (!estDict(schema))
    return estDict(structure)
      ? { content: blocs, structuredContent: structure, isError: false }
      : { content: blocs, isError: false };
  if (veritePy(schema["x-fastmcp-wrap-result"]))
    return {
      _meta: { fastmcp: { wrap_result: true } },
      content: blocs,
      structuredContent: { result: structure },
      isError: false,
    };
  if (structure === null || structure === undefined)
    return erreurResultat("Output validation error: outputSchema defined but no structured output returned");
  const erreur = valideur(structure);
  if (erreur !== null) return erreurResultat(`Output validation error: ${erreur}`);
  return { content: blocs, structuredContent: structure as Dict, isError: false };
}

function messageErreur(e: unknown): string {
  if (e instanceof Error) return e.message;
  return strPy(e);
}

const ScUniversel = (methode: string): z.ZodType => z.looseObject({ method: z.literal(methode) });

/** Serveur des familles : un registre partagé par toutes les sessions, un `Server` du SDK par session. */
export class ServeurOutils {
  readonly nom: string;
  readonly version: string;
  readonly instructions: string;
  private readonly taillePage: number;
  private readonly opencode: ReadonlySet<string>;
  private readonly debit: LimiteDebit | null;
  private readonly concurrence: LimiteConcurrence | null;
  private readonly eteintsVoulus: (() => Iterable<string>) | null;
  private readonly rappel: PortRappelIdentite | null;
  private readonly outils = new Map<string, DefinitionOutil>();
  private readonly ressources: DefinitionRessource[] = [];
  private readonly familles = new Set<string>();
  private readonly eteints = new Set<string>();
  private readonly valideurs = new Map<string, (sc: unknown) => string | null>();
  private avertiInconnus = false;

  constructor(options: OptionsServeur = {}) {
    this.nom = options.nom ?? (process.env["MCP_NAME"] || "local-tools");
    this.version = options.version ?? versionElpis();
    this.instructions = options.instructions ?? SERVER_INSTRUCTIONS;
    this.taillePage = options.taillePage ?? taillePageEnv();
    this.opencode = new Set(options.famillesOpencode ?? opencodeFamilies());
    this.debit = options.limiteDebit === undefined ? new LimiteDebit() : options.limiteDebit;
    this.concurrence =
      options.limiteConcurrence === undefined ? new LimiteConcurrence() : options.limiteConcurrence;
    this.eteintsVoulus = options.outilsEteints ?? null;
    this.rappel = options.rappel ?? null;
  }

  get famillesActives(): readonly string[] {
    return [...this.familles];
  }

  /** `register_family_on` : famille connue, une seule fois ; un nom d'outil déjà pris lève (FastMCP refuserait). */
  enregistrerFamille(
    famille: string,
    outils: readonly DefinitionOutil[],
    ressources: readonly DefinitionRessource[] = [],
  ): boolean {
    return this.enregistrerFamilles([[famille, outils, ressources]]).length > 0;
  }

  /** `register_families_on` : une vague de familles dans l'ordre canonique, extinctions de la configuration appliquées une fois à la fin ; rend celles qui viennent d'être enregistrées. */
  enregistrerFamilles(vague: readonly FamilleAEnregistrer[]): string[] {
    const rang = (f: string): number => FAMILY_NAMES.indexOf(f);
    const faites: string[] = [];
    try {
      for (const [famille, outils, ressources] of [...vague].sort((a, b) => rang(a[0]) - rang(b[0])))
        if (this.ajouterFamille(famille, outils, ressources ?? [])) faites.push(famille);
    } finally {
      this.appliquerExtinctions();
    }
    return faites;
  }

  private ajouterFamille(
    famille: string,
    outils: readonly DefinitionOutil[],
    ressources: readonly DefinitionRessource[],
  ): boolean {
    if (!FAMILY_NAMES.includes(famille)) throw new Error(`famille d'outils inconnue : ${famille}`);
    if (this.familles.has(famille)) return false;
    for (const o of outils) if (this.outils.has(o.nom)) throw new Error(`outil déjà enregistré : ${o.nom}`);
    for (const o of outils) this.outils.set(o.nom, { ...o, famille });
    this.ressources.push(...ressources);
    this.familles.add(famille);
    return true;
  }

  /** `apply_config_disables` : outils éteints par la configuration retirés pour tous, noms inconnus signalés une fois. */
  appliquerExtinctions(): string[] {
    if (this.eteintsVoulus === null) return [];
    const voulus = new Set([...this.eteintsVoulus()].map((n) => strPy(n)));
    const nouveaux = [...voulus].filter((n) => this.outils.has(n) && !this.eteints.has(n));
    for (const n of nouveaux) this.eteints.add(n);
    const inconnus = [...voulus].filter((n) => !this.outils.has(n)).sort();
    if (inconnus.length > 0 && !this.avertiInconnus) {
      log().warn(`tools.<nom>.enabled=false sur des outils inconnus : ${inconnus.join(", ")}`);
      this.avertiInconnus = true;
    }
    return nouveaux.sort();
  }

  familleDe(nom: string): string | undefined {
    return this.outils.get(nom)?.famille;
  }

  private cachees(requete: ContexteRequete): Set<string> {
    return famillesCachees(requete.jeton?.claims ?? null, requete.famille, this.opencode);
  }

  /** `_tool_callable` : l'outil existe, n'est pas éteint et sa famille est visible du client. */
  appelable(nom: string, requete: ContexteRequete): boolean {
    const outil = this.outils.get(nom);
    if (outil === undefined || this.eteints.has(nom)) return false;
    return !this.cachees(requete).has(outil.famille);
  }

  /** `tools/list` : outils visibles (extinctions, FamilyVisibility), titre rempli (TitleFiller), puis la page du curseur. */
  lister(requete: ContexteRequete, curseur?: string | null): { tools: Dict[]; nextCursor?: string } {
    const cachees = this.cachees(requete);
    const outils = [...this.outils.values()]
      .filter((o) => !this.eteints.has(o.nom) && !cachees.has(o.famille))
      .map((o) => avecTitre(o.definition));
    const debut = curseur ? decoderCurseur(curseur) : 0;
    const fin = debut + this.taillePage;
    const page = outils.slice(debut, fin);
    return fin < outils.length ? { nextCursor: encoderCurseur(fin), tools: page } : { tools: page };
  }

  /** `resources/templates/list` : gabarits des familles enregistrées (non filtrés par la portée, comme FastMCP), page du curseur. */
  listerModeles(curseur?: string | null): { resourceTemplates: Dict[]; nextCursor?: string } {
    const modeles = this.ressources.map((r): Dict => ({
      name: r.nom,
      uriTemplate: r.modele,
      description: r.description,
      mimeType: r.mimeType,
      _meta: { fastmcp: { tags: [...r.tags].sort() } },
    }));
    const debut = curseur ? decoderCurseur(curseur) : 0;
    const fin = debut + this.taillePage;
    const page = modeles.slice(debut, fin);
    return fin < modeles.length
      ? { nextCursor: encoderCurseur(fin), resourceTemplates: page }
      : { resourceTemplates: page };
  }

  /** `resources/read` : URI normalisée comme `AnyUrl`, premier gabarit qui l'apparie, texte rendu en `text/plain` comme FastMCP. */
  async lireRessource(uri: string): Promise<Dict> {
    const href = normaliserUri(uri);
    if (href === null) throw parametresInvalides();
    const chemin = href.split("?", 1)[0] ?? "";
    for (const r of this.ressources) {
      const params = apparierModele(chemin, r.modele);
      if (params !== null)
        return {
          contents: [{ uri: href, mimeType: "text/plain", text: await lireOuErreur(r, params, href) }],
        };
    }
    throw new ErreurProtocole(-32002, `Resource not found: Unknown resource: ${reprPy(href)}`);
  }

  /** `IdentityCapture` : `_meta` (client de confiance), jeton client qui prime, rappel vers l'app si l'id manque. */
  private async identite(meta: Dict | null): Promise<Identity | null> {
    let ident: Identity | null;
    try {
      ident = fromMeta(meta);
      const tid = tokenIdentity();
      if (tid) ident = creerIdentite({ user_id: 0, username: tid });
    } catch {
      return null;
    }
    if (ident !== null && !ident.user_id && this.rappel?.actif) {
      try {
        const d = await this.rappel.identityForUsername(ident.username);
        if (d)
          ident = creerIdentite({
            user_id: intPy(d.user_id),
            username: ident.username,
            network_profile_id: ident.network_profile_id || strPy(d.network_profile_id || ""),
            chat_id: ident.chat_id,
            is_admin: Boolean(d.is_admin),
            subagent: ident.subagent ?? null,
          });
      } catch {
        // rappel en échec : id inconnu (0), les chemins par nom restent justes
      }
    }
    return ident;
  }

  private valideur(outil: DefinitionOutil): (sc: unknown) => string | null {
    let v = this.valideurs.get(outil.nom);
    if (v === undefined) {
      const schema = outil.definition["outputSchema"];
      let f: (sc: unknown) => string | null;
      try {
        const compile = compilerSchema(schema);
        f = (sc) => meilleureErreur(compile, schema, sc)?.message ?? null;
      } catch (e) {
        const m = messageErreur(e);
        f = () => m;
      }
      v = f;
      this.valideurs.set(outil.nom, v);
    }
    return v;
  }

  /** Cœur de l'appel : validation des arguments, traitement, conversion du résultat (erreurs rendues en `isError`). */
  private async executer(outil: DefinitionOutil, recus: Dict, ctx: ContexteAppel): Promise<Dict> {
    const args = nonFinisEnNul(recus) as Dict;
    const r = validerArguments(
      {
        fonction: outil.fonction ?? outil.nom,
        parametres: outil.signature,
        ...(outil.motsClesSeuls ? { motsClesSeuls: true } : {}),
      },
      args,
    );
    if (!r.ok) throw new ErreurOutil(r.texte);
    let valeur: unknown;
    try {
      valeur = await outil.traiter(restaurerArgsOutil(outil.nom, r.valeurs), ctx, args);
    } catch (e) {
      if (e instanceof ErreurOutil) throw e;
      log().error(`Error calling tool '${outil.nom}'`, e);
      throw new ErreurOutil(`Error calling tool ${reprPy(outil.nom)}: ${messageErreur(e)}`);
    }
    if (estEnveloppeErreur(valeur)) throw new ErreurOutil(pyJsonDumps(valeur, { ensureAscii: false }));
    if (valeur instanceof ResultatBrut && estEnveloppeErreur(valeur.structuredContent))
      throw new ErreurOutil(pyJsonDumps(valeur.structuredContent, { ensureAscii: false }));
    return resultatAppel(outil, valeur, this.valideur(outil));
  }

  /** `tools/call` : conformité (-32602 sans oracle), identité, visibilité, débit, concurrence, `{ok:false}` → `isError`. */
  async appeler(
    nom: string,
    args: Dict,
    requete: ContexteRequete,
    fabriquerCtx: (outil: DefinitionOutil) => ContexteAppel,
  ): Promise<Dict> {
    if (!this.appelable(nom, requete)) throw new ErreurProtocole(-32602, `Unknown tool: ${reprPy(nom)}`);
    const outil = this.outils.get(nom) as DefinitionOutil;
    const ctx = fabriquerCtx(outil);
    return avecJeton(requete.jeton, async () => {
      const ident = await this.identite(ctx.meta);
      const suite = async (): Promise<Dict> => {
        try {
          if (this.cachees(requete).has(outil.famille))
            throw new ErreurOutil(
              `outil ${reprPy(nom)} non exposé à ce client (famille ${reprPy(outil.famille)})`,
            );
          const aExecuter = restaurerArgsOutil(nom, args);
          const refus = refusSousAgent(
            ident?.subagent,
            nom,
            aExecuter,
            lectureSeuleAnnotee(outil),
            outil.famille === "browser",
          );
          if (refus !== null)
            throw new ErreurOutil(
              pyJsonDumps(err(refus.code, refus.message, { fix: refus.fix }), { ensureAscii: false }),
            );
          const compte = compteAppel(ctx.meta);
          this.debit?.verifier(compte, nom);
          const executer = (): Promise<Dict> => this.executer(outil, aExecuter, ctx);
          return this.concurrence
            ? await this.concurrence.executer(compte, executer, ctx.signal)
            : await executer();
        } catch (e) {
          if (e instanceof ErreurOutil) return erreurResultat(e.message);
          log().error(`Error calling tool '${nom}'`, e);
          return erreurResultat(messageErreur(e));
        }
      };
      return avecIdentite(ident, suite);
    });
  }

  /** Branche un `Server` du SDK (une session) sur `transport`, avec ses gestionnaires et la portée `session`. */
  async connecter(transport: Transport, session: SessionOutils): Promise<Server> {
    const serveur = new Server(
      { name: this.nom, version: this.version },
      {
        capabilities: structuredClone(CAPACITES) as Record<string, unknown>,
        instructions: this.instructions,
      },
    );
    const requete = (extra: RequestHandlerExtra<ServerRequest, ServerNotification>): ContexteRequete => ({
      jeton: jetonDeExtra(extra) ?? session.jetonDefaut ?? null,
      famille: session.famille,
    });
    const initialiser = (
      serveur as unknown as { _oninitialize(r: unknown): Promise<Dict> }
    )._oninitialize.bind(serveur);
    serveur.setRequestHandler(InitializeRequestSchema, async (r) => {
      const res = await initialiser(r);
      const voulue = r.params.protocolVersion;
      return {
        ...res,
        protocolVersion: VERSIONS_PROTOCOLE.includes(voulue) ? voulue : LATEST_PROTOCOL_VERSION,
      } as ServerResult;
    });
    serveur.setRequestHandler(
      ScUniversel("tools/list") as never,
      (r: Dict, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        const params = estDict(r["params"]) ? r["params"] : {};
        const curseur = params["cursor"];
        if (curseur !== undefined && curseur !== null && typeof curseur !== "string")
          throw parametresInvalides();
        return this.lister(requete(extra), curseur ?? null) as unknown as ServerResult;
      },
    );
    const appel = async (
      r: Dict,
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ): Promise<ServerResult> => {
      const params = r["params"];
      if (!estDict(params) || typeof params["name"] !== "string") throw parametresInvalides();
      const args = params["arguments"];
      if (args !== undefined && args !== null && !estDict(args)) throw parametresInvalides();
      const meta = estDict(params["_meta"]) ? params["_meta"] : null;
      return (await this.appeler(params["name"], (args ?? {}) as Dict, requete(extra), (outil) =>
        contexteAppel(outil.nom, meta, session, extra),
      )) as ServerResult;
    };
    Protocol.prototype.setRequestHandler.call(serveur, ScUniversel("tools/call") as never, appel as never);
    serveur.setRequestHandler(ScUniversel("resources/list") as never, (r: Dict) => {
      curseurDe(r);
      return { resources: [] } as ServerResult;
    });
    serveur.setRequestHandler(
      ScUniversel("resources/templates/list") as never,
      (r: Dict) => this.listerModeles(curseurDe(r)) as unknown as ServerResult,
    );
    serveur.setRequestHandler(ScUniversel("prompts/list") as never, () => ({ prompts: [] }) as ServerResult);
    serveur.setRequestHandler(
      ScUniversel("resources/read") as never,
      (r: Dict, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        const uri = estDict(r["params"]) ? r["params"]["uri"] : undefined;
        if (typeof uri !== "string") throw parametresInvalides();
        return avecJeton(requete(extra).jeton, () =>
          this.lireRessource(uri),
        ) as unknown as Promise<ServerResult>;
      },
    );
    serveur.setRequestHandler(ScUniversel("prompts/get") as never, (r: Dict) => {
      const nom = estDict(r["params"]) ? r["params"]["name"] : undefined;
      if (typeof nom !== "string") throw parametresInvalides();
      throw new ErreurProtocole(-32602, `Unknown prompt: ${reprPy(nom)}`);
    });
    serveur.setRequestHandler(ScUniversel("logging/setLevel") as never, (r: Dict) => {
      const niveau = estDict(r["params"]) ? r["params"]["level"] : undefined;
      if (!(NIVEAUX_JOURNAL as readonly unknown[]).includes(niveau)) throw parametresInvalides();
      session.niveau = niveau as NiveauJournal;
      return {} as ServerResult;
    });
    serveur.fallbackRequestHandler = (r) => {
      throw METHODES_CONNUES.has(r.method)
        ? new ErreurProtocole(-32601, "Method not found")
        : parametresInvalides();
    };
    await serveur.connect(transport);
    return serveur;
  }
}

function parametresInvalides(): ErreurProtocole {
  return new ErreurProtocole(-32602, "Invalid request parameters", "");
}

/** Curseur d'une requête de liste (texte ou absent) ; décodé pour que « Invalid cursor » soit rendu comme FastMCP. */
function curseurDe(r: Dict): string | null {
  const params = estDict(r["params"]) ? r["params"] : {};
  const curseur = params["cursor"];
  if (curseur === undefined || curseur === null) return null;
  if (typeof curseur !== "string") throw parametresInvalides();
  if (curseur) decoderCurseur(curseur);
  return curseur;
}

/** Lecture d'une ressource ; un échec devient l'erreur 0 « Error reading resource … » de FastMCP, avec le texte d'un `OSError` Python. */
async function lireOuErreur(
  r: DefinitionRessource,
  params: Readonly<Record<string, string>>,
  href: string,
): Promise<string> {
  try {
    return await r.lire(params);
  } catch (e) {
    const { code, path } = e as { code?: unknown; path?: unknown };
    const message =
      e instanceof Error && typeof code === "string" && /^E[A-Z0-9]+$/u.test(code)
        ? messageErreurOs(e, typeof path === "string" ? path : "")
        : messageErreur(e);
    throw new ErreurProtocole(0, `Error reading resource ${reprPy(href)}: ${message}`);
  }
}

/** `str(AnyUrl(uri))` : URL WHATWG normalisée, `null` si elle ne s'analyse pas. */
function normaliserUri(uri: string): string | null {
  if (!uri.isWellFormed()) return null;
  try {
    return new URL(uri).href;
  } catch {
    return null;
  }
}

/** `urllib.parse.unquote` : séquences `%XX` décodées en UTF-8, octets invalides remplacés. */
function depourcenter(texte: string): string {
  return texte.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (m) =>
    Buffer.from(
      m
        .slice(1)
        .split("%")
        .map((h) => parseInt(h, 16)),
    ).toString("utf8"),
  );
}

/** `match_uri_template` (chemin seul) : `{x}` = un segment sans `/`, `{x*}` = tout ; paramètres décodés, `null` sans correspondance. */
function apparierModele(chemin: string, modele: string): Record<string, string> | null {
  const sansRequete = modele.replace(/\{\?[^}]+\}/gu, "");
  const noms: string[] = [];
  let motif = "";
  for (const part of sansRequete.split(/(\{[^}]+\})/u)) {
    if (part.startsWith("{") && part.endsWith("}")) {
      const nom = part.slice(1, -1);
      const joker = nom.endsWith("*");
      noms.push(joker ? nom.slice(0, -1) : nom);
      motif += joker ? "(.+)" : "([^/]+)";
    } else motif += part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  const m = new RegExp(`^${motif}$`, "u").exec(chemin);
  if (m === null) return null;
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  noms.forEach((nom, i) => {
    params[nom] = depourcenter(m[i + 1] ?? "");
  });
  return params;
}

/** Titre d'affichage rempli (TitleFiller) sans écraser `title` ni `annotations.title`, clés dans l'ordre du `Tool` pydantic. */
function avecTitre(definition: Dict): Dict {
  const ann = definition["annotations"];
  if (veritePy(definition["title"]) || (estDict(ann) && veritePy(ann["title"]))) return definition;
  const nom = strPy(definition["name"] ?? "");
  const titre = titlePy(stripPy(nom.replaceAll("_", " "))) || nom;
  const sortie: Dict = { name: definition["name"], title: titre };
  for (const k of clesOrdonnees(definition)) if (k !== "name" && k !== "title") sortie[k] = definition[k];
  return sortie;
}

/** Annotation `readOnlyHint` publiée par l'outil (périmètre d'un sous-agent en lecture seule). */
function lectureSeuleAnnotee(outil: DefinitionOutil): boolean {
  const ann = outil.definition["annotations"];
  return estDict(ann) && ann["readOnlyHint"] === true;
}

/** `_user_from_ctx` : compte du jeton client, sinon `_meta.username` brut, sinon aucun. */
function compteAppel(meta: Dict | null): string | null {
  const tid = tokenIdentity();
  if (tid) return tid;
  const u = meta?.["username"];
  return veritePy(u) ? strPy(u) : null;
}

/** Jeton porté par `authInfo` du transport HTTP (revendications dans `extra.claims`). */
function jetonDeExtra(extra: RequestHandlerExtra<ServerRequest, ServerNotification>): JetonAcces | null {
  const a = extra.authInfo;
  if (!a) return null;
  const claims = estDict(a.extra?.["claims"]) ? (a.extra["claims"] as Dict) : {};
  return { token: a.token, client_id: a.clientId, scopes: a.scopes, expires_at: a.expiresAt ?? null, claims };
}

const RANG = new Map(NIVEAUX_JOURNAL.map((n, i) => [n, i] as const));

/** Contexte d'un appel : notifications liées à la requête (journal filtré par `logging/setLevel`, progression). */
function contexteAppel(
  nomOutil: string,
  meta: Dict | null,
  session: SessionOutils,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): ContexteAppel {
  const log = async (message: string, o: OptionsJournal = {}): Promise<void> => {
    const niveau = o.level ?? "info";
    if (session.niveau !== null && (RANG.get(niveau) ?? 0) < (RANG.get(session.niveau) ?? 0)) return;
    const data: Dict = { msg: message, extra: o.extra ?? null };
    const params: Dict = { level: niveau, ...(o.loggerName ? { logger: o.loggerName } : {}), data };
    await extra.sendNotification({ method: "notifications/message", params } as ServerNotification);
  };
  const avecNiveau =
    (level: NiveauJournal) =>
    (message: string, o: Omit<OptionsJournal, "level"> = {}): Promise<void> =>
      log(message, { ...o, level });
  return {
    nomOutil,
    meta,
    famille: session.famille,
    signal: extra.signal,
    log,
    debug: avecNiveau("debug"),
    info: avecNiveau("info"),
    warning: avecNiveau("warning"),
    error: avecNiveau("error"),
    reportProgress: async (progress, total, message) => {
      const jetonProgression = meta?.["progressToken"];
      if (jetonProgression === undefined || jetonProgression === null) return;
      const params: Dict = { progressToken: jetonProgression, progress };
      if (total !== null && total !== undefined) params["total"] = total;
      if (message !== null && message !== undefined) params["message"] = message;
      await extra.sendNotification({ method: "notifications/progress", params } as ServerNotification);
    },
  };
}
