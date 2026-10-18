// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/boite.ts — boîte à outils commune des familles (llm_core/tools/_toolkit.py) : enveloppes, coupes, tolérance d'entrée, identité, battement, politique. */
import { opendirSync, statSync } from "node:fs";

import {
  arrondiPy,
  casefoldPy,
  comparePointsDeCode,
  ErreurJsonPy,
  ErreurPython,
  estDict,
  estErreurPython,
  FlottantPy,
  floatPy,
  fnmatchPy,
  intPy,
  lowerPy,
  pyJsonLoads,
  reprPy,
  sansAccentsPy,
  splitlinesPy,
  strPy,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { pyJoin, realpathPy, safeSandboxName } from "@elpis/config";

import { getAccessToken } from "./contexte";
import type { ContexteAppel } from "./contexte";

/** `_env_int` : entier ≥ 1 lu dans l'environnement, défaut si illisible. */
function entierEnv(nom: string, defaut: number): number {
  try {
    return Math.max(1, intPy(stripPy(process.env[nom] ?? "") || defaut));
  } catch {
    return defaut;
  }
}

export const TEXT_BUDGET = entierEnv("TOOL_TEXT_BUDGET", 6000);
export const LIST_BUDGET = entierEnv("TOOL_LIST_BUDGET", 50);

export function ok(champs: Dict = {}): Dict {
  return { ok: true, ...champs };
}

export interface OptionsErr {
  fix?: string | null;
  next_action?: string | null;
  retryable?: boolean;
  [contexte: string]: unknown;
}

let surchargesErreurs: ((code: string) => unknown) | null = null;

/** `CTX.get("errors.<code>")` (context_config.json) : message et correctif éditables à froid. */
export function brancherSurchargesErreurs(f: ((code: string) => unknown) | null): void {
  surchargesErreurs = f;
}

/** Échec qui dit au modèle comment se rattraper : code stable, message, correctif, suite, contexte structuré. */
export function err(code: string, message: string, options: OptionsErr = {}): Dict {
  const { fix, next_action: suite, retryable, ...contexte } = options;
  const e: Dict = { ok: false, error: code, message };
  if (veritePy(fix)) e["fix"] = fix;
  if (veritePy(suite)) e["next_action"] = suite;
  if (retryable) e["retryable"] = true;
  for (const [k, v] of Object.entries(contexte)) e[k] = v;
  try {
    const ov = surchargesErreurs?.(code);
    if (estDict(ov)) {
      if (veritePy(ov["message"])) e["message"] = ov["message"];
      if (veritePy(ov["fix"])) e["fix"] = ov["fix"];
    }
  } catch {
    // surcharge illisible : texte d'origine
  }
  return e;
}

/** Coupe un texte en points de code et dit combien a été omis. */
export function clipText(
  texte: unknown,
  maxChars: number | null = null,
  options: { label?: string } = {},
): string {
  if (texte === null || texte === undefined) return "";
  const points = Array.from(strPy(texte));
  const limite = maxChars ?? TEXT_BUDGET;
  if (points.length <= limite) return points.join("");
  const omis = points.length - limite;
  return (
    points.slice(0, limite).join("") +
    `\n…[${options.label ?? "contenu"} tronqué : ${omis} caractères omis sur ` +
    `${points.length} — affine la requête (plage, filtre) pour voir le reste]`
  );
}

/** Garde le début et la fin d'une longue sortie, le milieu est remplacé par un repère. */
export function headTail(
  texte: unknown,
  options: { headLines?: number; tailLines?: number; label?: string } = {},
): string {
  if (texte === null || texte === undefined) return "";
  const tete = options.headLines ?? 40;
  const queue = options.tailLines ?? 20;
  const lignes = splitlinesPy(strPy(texte));
  if (lignes.length <= tete + queue) return strPy(texte);
  const omises = lignes.length - tete - queue;
  return [
    ...lignes.slice(0, tete),
    `…[${options.label ?? "sortie"} : ${omises} lignes du milieu omises sur ${lignes.length}]`,
    ...lignes.slice(-queue),
  ].join("\n");
}

/** Enveloppe de pagination commune : fenêtre, total, décalage, limite et décalage suivant. */
export function page<T>(items: readonly T[], options: { offset?: unknown; limit?: unknown } = {}): Dict {
  const offset = Math.max(0, intPy(veritePy(options.offset) ? options.offset : 0));
  const limit =
    options.limit === null || options.limit === undefined ? LIST_BUDGET : Math.max(1, intPy(options.limit));
  const total = items.length;
  const encore = offset + limit < total;
  return {
    items: items.slice(offset, offset + limit),
    total,
    offset,
    limit,
    has_more: encore,
    next_offset: encore ? offset + limit : null,
  };
}

const PAIRES_GUILLEMETS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
];

/** Retire les guillemets superflus qu'un modèle ajoute, couches imbriquées et typographiques comprises. */
export function unquote(s: unknown): string {
  if (s === null || s === undefined) return "";
  let t = stripPy(strPy(s));
  let change = true;
  while (change && t.length >= 2) {
    change = false;
    for (const [a, b] of PAIRES_GUILLEMETS) {
      if (t.startsWith(a) && t.endsWith(b)) {
        t = stripPy(t.slice(a.length, t.length - b.length));
        change = true;
        break;
      }
    }
  }
  return t;
}

export function asStr(v: unknown, defaut = ""): string {
  return v === null || v === undefined ? defaut : unquote(v);
}

const estEntierPy = (v: unknown): boolean =>
  typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v));

/** `"5"`, `5.0`, `" 5 "`, `'"5"'` → 5 ; `defaut` sur tout ce qui ne se lit pas (`inf` lève comme `int(float)`). */
export function asInt(v: unknown, defaut: number | null = null): number | bigint | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (estEntierPy(v)) return v as number | bigint;
  if (v instanceof FlottantPy && Number.isInteger(v.valeur)) return v.valeur;
  try {
    return intPy(floatPy(unquote(v)));
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return defaut;
    throw e;
  }
}

const VRAIS = new Set(["true", "1", "yes", "y", "on", "oui"]);
const FAUX = new Set(["false", "0", "no", "n", "off", "non", ""]);

export function asBool(v: unknown, defaut = false): boolean {
  if (typeof v === "boolean") return v;
  if (v === null || v === undefined) return defaut;
  const s = lowerPy(unquote(v));
  if (VRAIS.has(s)) return true;
  if (FAUX.has(s)) return false;
  return defaut;
}

/** Liste réelle telle quelle, liste JSON en texte décodée, scalaire enveloppé. */
export function asList(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const s = stripPy(v);
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const lu = pyJsonLoads(s);
        if (Array.isArray(lu)) return lu;
      } catch (e) {
        if (!(e instanceof ErreurJsonPy)) throw e;
      }
    }
    return s ? [v] : [];
  }
  return [v];
}

const normaliserChoix = (s: string): string => lowerPy(s).replaceAll("-", "_").replaceAll(" ", "_");

/** Une des `choix` (casse, tirets et espaces normalisés par défaut), sinon `defaut`. */
export function asEnum(
  v: unknown,
  choix: Iterable<string>,
  defaut: string | null = null,
  options: { normalize?: boolean } = {},
): string | null {
  const liste = [...choix];
  const s = unquote(v);
  if (options.normalize ?? true) {
    const norm = new Map<string, string>();
    for (const c of liste) norm.set(normaliserChoix(c), c);
    return norm.get(normaliserChoix(s)) ?? defaut;
  }
  return liste.includes(s) ? s : defaut;
}

export function safeUsername(username: string | null | undefined): string {
  return safeSandboxName(username);
}

export function safeChatId(chatId: unknown): string {
  if (!veritePy(chatId)) return "default";
  return strPy(chatId).replace(/[^A-Za-z0-9_-]/gu, "") || "default";
}

/** `ctx.request_context.meta[field]` en texte, `null` s'il manque ou est vide. */
export function readMetaField(
  ctx: Pick<ContexteAppel, "meta"> | null | undefined,
  champ: string,
): string | null {
  const meta = ctx?.meta;
  if (!estDict(meta) || !Object.hasOwn(meta, champ)) return null;
  const v = meta[champ];
  return veritePy(v) ? strPy(v) : null;
}

/** Compte lié au jeton Bearer d'un client externe ; `null` hors authentification et pour le jeton de service. */
export function tokenIdentity(): string | null {
  const jeton = getAccessToken();
  if (jeton === null) return null;
  if (veritePy(jeton.claims["trusted_meta"])) return null;
  const u = veritePy(jeton.claims["username"]) ? jeton.claims["username"] : jeton.client_id;
  return veritePy(u) ? strPy(u) : null;
}

/** Jeton client, puis `_meta.username` (client de confiance), puis l'argument hérité, puis `guest`. */
export function getUsername(ctx: Pick<ContexteAppel, "meta"> | null | undefined, repli = "guest"): string {
  const tid = tokenIdentity();
  if (tid) return safeUsername(tid);
  const v = readMetaField(ctx, "username");
  return safeUsername(v ?? repli);
}

export function getChatId(ctx: Pick<ContexteAppel, "meta"> | null | undefined, repli = "default"): string {
  return safeChatId(readMetaField(ctx, "chat_id") ?? repli);
}

export const LIVE_LOGGER_SHELL = "elpis.shell";
export const LIVE_LOGGER_HEARTBEAT = "elpis.heartbeat";
export const LIVE_KIND_SHELL = "shell_output";
export const LIVE_KIND_HEARTBEAT = "heartbeat";

function battementEnv(): number {
  try {
    const brut = process.env["ELPIS_TOOL_HEARTBEAT_S"] ?? "15";
    return brut ? floatPy(brut) : 0;
  } catch {
    return 15;
  }
}

export const HEARTBEAT_S = battementEnv();

/** Notification de journal structurée (`extra.kind`) : la promesse d'envoi, `null` sans contexte. */
export function liveNotify(
  ctx: ContexteAppel | null | undefined,
  kind: string,
  payload: Dict,
  options: { loggerName: string },
): Promise<void> | null {
  if (!ctx) return null;
  return ctx.log(kind, { level: "info", loggerName: options.loggerName, extra: { kind, ...payload } });
}

/** Battement périodique pendant un outil long : garde vivant le flux d'un `tools/call` silencieux. */
export class Heartbeat {
  ticks = 0;
  private readonly ctx: ContexteAppel | null;
  private readonly intervalle: number;
  private readonly t0 = performance.now();
  private readonly callId: string | null;
  private readonly logToken: string | null;
  private minuterie: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: ContexteAppel | null, options: { intervalS?: number | null } = {}) {
    this.ctx = ctx;
    this.intervalle = options.intervalS ?? HEARTBEAT_S;
    this.callId = ctx ? readMetaField(ctx, "call_id") : null;
    this.logToken = ctx ? readMetaField(ctx, "log_token") : null;
  }

  private charge(): Dict {
    const p: Dict = { elapsed_s: arrondiPy((performance.now() - this.t0) / 1000, 1) };
    if (this.callId) p["call_id"] = this.callId;
    if (this.logToken) p["log_token"] = this.logToken;
    return p;
  }

  tick(): void {
    const envoi = liveNotify(this.ctx, LIVE_KIND_HEARTBEAT, this.charge(), {
      loggerName: LIVE_LOGGER_HEARTBEAT,
    });
    if (envoi === null) return;
    envoi.catch(() => undefined);
    this.ticks++;
  }

  start(): this {
    if (this.ctx === null || this.intervalle <= 0 || this.minuterie !== null) return this;
    this.minuterie = setInterval(() => this.tick(), this.intervalle * 1000);
    this.minuterie.unref();
    return this;
  }

  stop(): void {
    if (this.minuterie !== null) clearInterval(this.minuterie);
    this.minuterie = null;
  }

  /** `with Heartbeat(ctx): …` */
  async avec<T>(fn: () => Promise<T>): Promise<T> {
    this.start();
    try {
      return await fn();
    } finally {
      this.stop();
    }
  }
}

export const POLICY_KEYS = ["timeout_s", "serial", "replay_safe", "prune", "deny_for"] as const;

/** Arguments d'enregistrement d'un outil : `tags` (ensemble, trié), `meta`, `annotations`. */
export interface KwOutil {
  tags: string[];
  meta: Dict;
  annotations?: Dict;
}

export type Politique = Partial<Record<(typeof POLICY_KEYS)[number], unknown>> & Record<string, unknown>;

/** Copie de `kw` avec `meta.policy` enrichi ; une clé inconnue lève `ValueError`. */
export function withPolicy(kw: KwOutil, politique: Politique = {}): KwOutil {
  const mauvaises = Object.keys(politique).filter((k) => !(POLICY_KEYS as readonly string[]).includes(k));
  if (mauvaises.length > 0)
    throw new ErreurPython("ValueError", `clé de politique inconnue : ${reprPy(mauvaises)}`);
  const meta: Dict = { ...kw.meta };
  const pol: Dict = estDict(meta["policy"]) ? { ...meta["policy"] } : {};
  for (const [k, brut] of Object.entries(politique)) {
    if (brut === null || brut === undefined) continue;
    pol[k] =
      k === "deny_for" ? [...new Set(iterable(brut).map((x) => strPy(x)))].sort(comparePointsDeCode) : brut;
  }
  if (Object.hasOwn(pol, "serial") && !Object.hasOwn(pol, "replay_safe"))
    pol["replay_safe"] = !veritePy(pol["serial"]);
  meta["policy"] = pol;
  return { ...kw, meta };
}

/** `v or ()` itéré : liste, ensemble, ou caractères d'un texte. */
function iterable(v: unknown): unknown[] {
  if (typeof v === "string") return Array.from(v);
  if (Array.isArray(v) || v instanceof Set) return [...(v as Iterable<unknown>)];
  return [];
}

export type Categorie = Dict & { name: string };

export function toolKw(categorie: Categorie, politique: Politique = {}): KwOutil {
  const base: KwOutil = { tags: [categorie.name], meta: { category: categorie } };
  return Object.keys(politique).length > 0 ? withPolicy(base, politique) : base;
}

interface Indices {
  title?: string | null;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
}

function annote(categorie: Categorie, indices: Indices, politique: Politique): KwOutil {
  const base = toolKw(categorie, politique);
  const annotations: Dict = {
    readOnlyHint: indices.readOnly ?? false,
    destructiveHint: indices.destructive ?? false,
    idempotentHint: indices.idempotent ?? false,
    openWorldHint: indices.openWorld ?? false,
  };
  if (veritePy(indices.title)) annotations["title"] = indices.title;
  return { ...base, annotations };
}

export function toolKwReadonly(
  categorie: Categorie,
  o: { title?: string | null } = {},
  p: Politique = {},
): KwOutil {
  return annote(categorie, { title: o.title ?? null, readOnly: true, idempotent: true }, p);
}

export function toolKwDestructive(
  categorie: Categorie,
  o: { title?: string | null; openWorld?: boolean } = {},
  p: Politique = {},
): KwOutil {
  return annote(categorie, { title: o.title ?? null, destructive: true, openWorld: o.openWorld ?? false }, p);
}

export function toolKwIdempotent(
  categorie: Categorie,
  o: { title?: string | null; openWorld?: boolean } = {},
  p: Politique = {},
): KwOutil {
  return annote(categorie, { title: o.title ?? null, idempotent: true, openWorld: o.openWorld ?? false }, p);
}

export function toolKwMutating(
  categorie: Categorie,
  o: { title?: string | null; openWorld?: boolean } = {},
  p: Politique = {},
): KwOutil {
  return annote(categorie, { title: o.title ?? null, openWorld: o.openWorld ?? false }, p);
}

export function toolKwOpenworld(
  categorie: Categorie,
  o: { title?: string | null; readOnly?: boolean; idempotent?: boolean } = {},
  p: Politique = {},
): KwOutil {
  return annote(
    categorie,
    {
      title: o.title ?? null,
      readOnly: o.readOnly ?? false,
      idempotent: o.idempotent ?? false,
      openWorld: true,
    },
    p,
  );
}

export function tagKw(categorie: Categorie): { tags: string[] } {
  return { tags: [categorie.name] };
}

/** Glob d'un chemin relatif POSIX : sans `/` sur le nom à toute profondeur, sinon segment par segment avec `**`. */
export function globMatch(rel: string, motif: string): boolean {
  if (!motif) return true;
  let pat = stripPy(motif);
  while (pat.startsWith("./")) pat = pat.slice(2);
  if (!pat.includes("/")) return fnmatchPy(rel.slice(rel.lastIndexOf("/") + 1), pat) || fnmatchPy(rel, pat);
  const psegs = pat
    .replace(/^\/+|\/+$/gu, "")
    .split("/")
    .filter((s) => s !== "");
  const rsegs = rel.split("/").filter((s) => s !== "");
  const memo = new Map<string, boolean>();
  const m = (i: number, j: number): boolean => {
    const cle = `${i},${j}`;
    const deja = memo.get(cle);
    if (deja !== undefined) return deja;
    let r: boolean;
    if (i === psegs.length) r = j === rsegs.length;
    else if (psegs[i] === "**") {
      r = false;
      for (let k = j; k <= rsegs.length && !r; k++) r = m(i + 1, k);
    } else r = j < rsegs.length && fnmatchPy(rsegs[j] ?? "", psegs[i] ?? "") && m(i + 1, j + 1);
    memo.set(cle, r);
    return r;
  };
  return m(0, 0);
}

/** Forme canonique insensible aux accents et à la casse. */
export function foldConfusable(s: string): string {
  return casefoldPy(sansAccentsPy(s));
}

/** Avertit si créer `cible` (sous `racine`) ajoute un voisin qui ne diffère que par les accents ou la casse. */
export function unicodeTwinWarning(cible: string, racine: string, maxScan = 500): string | null {
  let rel: string[];
  try {
    const c = realpathPy(cible);
    const r = realpathPy(racine);
    if (c !== r && !c.startsWith(r === "/" ? "/" : r + "/")) return null;
    rel = c === r ? [] : c.slice(r === "/" ? 1 : r.length + 1).split("/");
  } catch {
    return null;
  }
  const jumeaux: [string, string][] = [];
  let parent = racine;
  for (const comp of rel) {
    const cur = pyJoin(parent, comp);
    try {
      if (!existe(cur) && estDossier(parent)) {
        const pli = foldConfusable(comp);
        const dossier = opendirSync(parent);
        try {
          for (let i = 0; i < maxScan; i++) {
            const entree = dossier.readSync();
            if (entree === null) break;
            if (entree.name !== comp && foldConfusable(entree.name) === pli)
              jumeaux.push([entree.name, comp]);
          }
        } finally {
          dossier.closeSync();
        }
      }
    } catch {
      // erreur d'E/S : jamais bloquante
    }
    parent = cur;
  }
  return twinMessage(jumeaux);
}

function existe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function estDossier(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Avertissement pour des paires `(existant, nouveau)`, `null` sans paire. */
export function twinMessage(jumeaux: readonly (readonly [string, string])[]): string | null {
  if (jumeaux.length === 0) return null;
  const paires = jumeaux
    .slice(0, 3)
    .map(([ancien, nouveau]) => `'${nouveau}' ≈ existing '${ancien}'`)
    .join("; ");
  return (
    `Probable unicode twin: ${paires} — the names differ only by accents ` +
    `or case. On accent/case-insensitive filesystems they are the SAME ` +
    `path. Double-check you are not creating a duplicate of the ` +
    `existing file/folder.`
  );
}
