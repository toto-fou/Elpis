// SPDX-License-Identifier: MIT
/** packages/contracts/src/procedures.ts — procédures du navigateur (arbres de comportement rejoués sans LLM) : schéma Zod versionné, limites dures et validation croisée (origine, paramètres, cibles sémantiques). */
import { z } from "zod";

/** Limites dures du format : un arbre au-delà est refusé à la validation. */
export const LIMITES_PROCEDURE = {
  profondeur: 8,
  noeuds: 80,
  enfants: 30,
  parametres: 12,
  cibles: 5,
  longueurCible: 200,
  longueurValeur: 300,
  longueurUrl: 500,
  longueurDescription: 500,
  /** Intention d'un nœud (champ `note`), lue par le modèle qui répare. */
  longueurNote: 200,
  /** Réparation : octets du nœud de remplacement et nombre de nœuds au plus. */
  octetsReparation: 4096,
  noeudsReparation: 15,
  longueurId: 64,
  attenteMaxMs: 10_000,
  delaiMinMs: 100,
  delaiMaxMs: 30_000,
  retryMax: 3,
  conditionProfondeur: 3,
  /** Profondeur de l'entrée JSON brute, contrôlée avant Zod (garde contre une pile profonde). */
  profondeurBrute: 64,
  /** Valeurs visitées au plus dans l'entrée brute. */
  valeursBrutes: 20_000,
} as const;

export const GESTES_PROCEDURE = [
  "goto",
  "click",
  "fill",
  "select",
  "press",
  "check",
  "uncheck",
  "hover",
  "wait",
] as const;
export type GesteProcedure = (typeof GESTES_PROCEDURE)[number];

export const TYPES_PARAMETRE = ["string", "number", "creds"] as const;
export type TypeParametre = (typeof TYPES_PARAMETRE)[number];

const CLES_CIBLE = [
  "role",
  "name",
  "text",
  "label",
  "placeholder",
  "test_id",
  "alt",
  "title",
  "nth",
] as const;
const CLES_REFUSEES = ["css", "xpath", "ref"] as const;
const CLES_TOUTES = [...CLES_CIBLE, ...CLES_REFUSEES];
/** `|` qui sépare deux clés du DSL (le même motif que l'analyseur de cibles du navigateur). */
const SEPARATEUR = new RegExp(String.raw`(?<!\\)\|(?=\s*(?:${CLES_TOUTES.join("|")})\s*=)`, "iu");
const MODELE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const NOM_PARAMETRE = /^[a-z][a-z0-9_]{0,31}$/u;
const NOMS_RESERVES: ReadonlySet<string> = new Set([
  "constructor",
  "prototype",
  "valueof",
  "tostring",
  "hasownproperty",
]);
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
/** Vrai si la chaîne porte un caractère de contrôle (saut de ligne, tabulation, NUL…). */
export function aControle(s: string): boolean {
  return Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

/** Noms de gabarits `{nom}` d'une chaîne, dans l'ordre. */
export function gabarits(s: string): string[] {
  return [...s.matchAll(MODELE)].map((m) => m[1] as string);
}

/** Message d'une cible refusée, `null` si c'est une cible DSL sémantique valide (gabarits compris). */
export function refusCible(t: string): string | null {
  if (!t.trim()) return "cible vide";
  if (t.length > LIMITES_PROCEDURE.longueurCible) return "cible trop longue";
  if (aControle(t)) return "caractère de contrôle dans la cible";
  let utile = 0;
  for (const morceau of t.split(SEPARATEUR)) {
    const i = morceau.indexOf("=");
    if (i < 0) return `morceau sans clé (« ${morceau.trim().slice(0, 30)} ») : écrire clé=valeur`;
    const cle = morceau.slice(0, i).trim().toLowerCase();
    if ((CLES_REFUSEES as readonly string[]).includes(cle))
      return `${cle}= refusé : seules les cibles sémantiques (${CLES_CIBLE.filter((k) => k !== "nth").join(", ")}) sont admises`;
    if (!(CLES_CIBLE as readonly string[]).includes(cle)) return `clé de cible inconnue : ${cle}`;
    if (cle === "nth") {
      if (!/^\d{1,3}$/u.test(morceau.slice(i + 1).trim())) return "nth= attend un entier";
    } else {
      utile += 1;
      const valeur = morceau.slice(i + 1).trim();
      if (!valeur) return `${cle}= vide`;
      if (/^(css|xpath|ref)\s*[=:]/iu.test(valeur) || valeur.startsWith("//"))
        return `${cle}= : la valeur commence par css=, xpath=, ref= ou // : refusée`;
    }
  }
  return utile > 0 ? null : "cible sans critère (role, name, text, label…)";
}

/** Origine exacte http(s) : schéma, hôte et port seuls, sans chemin ni identifiants. */
export function origineExacte(o: string): string | null {
  let u: URL;
  try {
    u = new URL(o);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.origin !== o) return null;
  return u.origin;
}

/** Message d'un `url` refusé pour une origine donnée (chemin relatif, ou URL de même origine), `null` si valide. */
export function refusUrl(url: string, origin: string): string | null {
  if (!url.trim()) return "url vide";
  if (url.length > LIMITES_PROCEDURE.longueurUrl) return "url trop longue";
  if (aControle(url) || url.includes("\\")) return "caractère interdit dans l'url";
  if (url.startsWith("/")) return url.startsWith("//") ? "url relative à l'hôte (//) refusée" : null;
  if (url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`)) return null;
  return `url hors de l'origine ${origin} : un chemin relatif (/chemin) ou une URL de même origine`;
}

const texteBorne = (max: number) => z.string().max(max);

export interface Condition {
  url_path?: string;
  visible?: string;
  text?: string;
  not?: Condition;
}

const schemaConditionBrute = z.strictObject({
  url_path: texteBorne(LIMITES_PROCEDURE.longueurUrl).optional(),
  visible: texteBorne(LIMITES_PROCEDURE.longueurCible).optional(),
  text: texteBorne(LIMITES_PROCEDURE.longueurValeur).optional(),
  not: z.lazy((): z.ZodType<Condition> => schemaCondition).optional(),
});
export const schemaCondition: z.ZodType<Condition> = schemaConditionBrute.refine(
  (c) => Object.values(c).some((v) => v !== undefined),
  { message: "condition vide : url_path, visible, text ou not" },
) as z.ZodType<Condition>;

export interface Act {
  act: GesteProcedure;
  t?: string[];
  v?: string;
  url?: string;
  expect?: Condition;
  /** `true` : accord à chaque exécution ; `"once"` : accord tant que le geste n'a pas été approuvé puis suivi d'une exécution ok. */
  confirm?: boolean | "once";
  timeout_ms?: number;
  note?: string;
}
/** Vrai si le geste demande un accord (`confirm: true` ou `"once"`). */
export function aConfirm(n: { confirm?: boolean | "once" }): boolean {
  return n.confirm === true || n.confirm === "once";
}

export interface Login {
  creds: string;
  password_target?: string;
  username_target?: string;
  submit_target?: string;
  wait_for: string;
}
export type Noeud =
  | { seq: Noeud[]; note?: string }
  | { sel: Noeud[]; note?: string }
  | { if: Condition; then?: Noeud; else?: Noeud; note?: string }
  | Act
  | { login: Login; note?: string }
  | { retry: Noeud; max: number; note?: string }
  | { wait_ms: number; note?: string };

const noeud = (): z.ZodType<Noeud, unknown> => schemaNoeud;
const enfants = z.lazy(noeud).array().min(1).max(LIMITES_PROCEDURE.enfants);

const schemaAct = z.strictObject({
  act: z.enum(GESTES_PROCEDURE),
  t: z.array(texteBorne(LIMITES_PROCEDURE.longueurCible)).min(1).max(LIMITES_PROCEDURE.cibles).optional(),
  v: texteBorne(LIMITES_PROCEDURE.longueurValeur).optional(),
  url: texteBorne(LIMITES_PROCEDURE.longueurUrl).optional(),
  expect: schemaCondition.optional(),
  confirm: z.union([z.boolean(), z.literal("once")]).optional(),
  timeout_ms: z.number().int().min(LIMITES_PROCEDURE.delaiMinMs).max(LIMITES_PROCEDURE.delaiMaxMs).optional(),
  note: texteBorne(LIMITES_PROCEDURE.longueurNote).optional(),
});
const schemaLogin = z.strictObject({
  creds: texteBorne(LIMITES_PROCEDURE.longueurCible),
  password_target: texteBorne(LIMITES_PROCEDURE.longueurCible).optional(),
  username_target: texteBorne(LIMITES_PROCEDURE.longueurCible).optional(),
  submit_target: texteBorne(LIMITES_PROCEDURE.longueurCible).optional(),
  wait_for: texteBorne(LIMITES_PROCEDURE.longueurCible),
});
const note = texteBorne(LIMITES_PROCEDURE.longueurNote).optional();
const variantes: Record<string, z.ZodType> = {
  seq: z.strictObject({ seq: enfants, note }),
  sel: z.strictObject({ sel: enfants, note }),
  if: z.strictObject({
    if: schemaCondition,
    then: z.lazy(noeud).optional(),
    else: z.lazy(noeud).optional(),
    note,
  }),
  act: schemaAct,
  login: z.strictObject({ login: schemaLogin, note }),
  retry: z.strictObject({
    retry: z.lazy(noeud),
    max: z.number().int().min(1).max(LIMITES_PROCEDURE.retryMax),
    note,
  }),
  wait_ms: z.strictObject({
    wait_ms: z.number().int().min(0).max(LIMITES_PROCEDURE.attenteMaxMs),
    note,
  }),
};

/** Nœud : le type est donné par sa clé (seq, sel, if, act, login, retry, wait_ms), une seule à la fois. */
export const schemaNoeud: z.ZodType<Noeud, unknown> = z.unknown().transform((v, ctx) => {
  const cles = v !== null && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : [];
  const type = Object.keys(variantes).find((k) => cles.includes(k));
  if (type === undefined) {
    ctx.issues.push({
      code: "custom",
      message: "nœud inconnu : une clé parmi seq, sel, if, act, login, retry, wait_ms",
      input: v,
    });
    return z.NEVER;
  }
  const r = (variantes[type] as z.ZodType).safeParse(v);
  if (!r.success) {
    for (const i of r.error.issues)
      ctx.issues.push({ code: "custom", message: i.message, path: i.path, input: v });
    return z.NEVER;
  }
  return r.data as Noeud;
});

export interface Procedure {
  id: string;
  origin: string;
  version: number;
  description: string;
  params: Record<string, TypeParametre>;
  root: Noeud;
}

const schemaBase = z.strictObject({
  id: z
    .string()
    .regex(SLUG, "slug a-z 0-9 _ - : 64 caractères au plus, commence par un caractère alphanumérique"),
  origin: z.string().max(LIMITES_PROCEDURE.longueurUrl),
  version: z.number().int().min(1).max(1_000_000),
  description: texteBorne(LIMITES_PROCEDURE.longueurDescription),
  params: z.record(z.string(), z.enum(TYPES_PARAMETRE)),
  root: schemaNoeud,
});

export interface Mesure {
  noeuds: number;
  profondeur: number;
}

/** Enfants d'un nœud avec leur suffixe de chemin (`0`, `1`… pour seq/sel, `then`, `else`, `retry`). */
function fils(n: Noeud): [string, Noeud][] {
  if ("seq" in n) return n.seq.map((f, i) => [String(i), f]);
  if ("sel" in n) return n.sel.map((f, i) => [String(i), f]);
  if ("if" in n) {
    const r: [string, Noeud][] = [];
    if (n.then !== undefined) r.push(["then", n.then]);
    if (n.else !== undefined) r.push(["else", n.else]);
    return r;
  }
  if ("retry" in n) return [["retry", n.retry]];
  return [];
}

/** Nœuds et profondeur de l'arbre mesurés sans récursion (la racine est à 1). */
export function mesurer(racine: Noeud): Mesure {
  let noeuds = 0;
  let profondeur = 0;
  const pile: [Noeud, number][] = [[racine, 1]];
  for (let e = pile.pop(); e !== undefined; e = pile.pop()) {
    noeuds += 1;
    profondeur = Math.max(profondeur, e[1]);
    for (const [, f] of fils(e[0])) pile.push([f, e[1] + 1]);
  }
  return { noeuds, profondeur };
}

/** Tous les nœuds avec leur chemin (`0`, `0.1`, `0.2.then`…), en profondeur et dans l'ordre d'exécution. */
export function* parcourir(racine: Noeud, chemin = "0"): Generator<[Noeud, string]> {
  const pile: [Noeud, string][] = [[racine, chemin]];
  for (let e = pile.pop(); e !== undefined; e = pile.pop()) {
    yield e;
    for (const [suffixe, f] of fils(e[0]).reverse()) pile.push([f, `${e[1]}.${suffixe}`]);
  }
}

function conditions(c: Condition | undefined, ou: string, profondeur: number, erreurs: string[]): void {
  if (c === undefined) return;
  if (profondeur > LIMITES_PROCEDURE.conditionProfondeur) {
    erreurs.push(
      `${ou} : condition trop imbriquée (not, ${LIMITES_PROCEDURE.conditionProfondeur} niveaux au plus)`,
    );
    return;
  }
  if (c.visible !== undefined) {
    const r = refusCible(c.visible);
    if (r !== null) erreurs.push(`${ou}.visible : ${r}`);
  }
  conditions(c.not, `${ou}.not`, profondeur + 1, erreurs);
}

function chainesDe(c: Condition | undefined): string[] {
  return c === undefined
    ? []
    : [c.url_path, c.text, ...chainesDe(c.not), c.visible].filter((x): x is string => x !== undefined);
}

/** Règles entre champs d'un gestes : champs requis par geste, cibles, URL de l'origine. */
function verifierAct(n: Act, chemin: string, origin: string, erreurs: string[]): void {
  const exige = (champ: "t" | "v" | "url"): void => {
    if (n[champ] === undefined || (champ !== "t" && n[champ] === ""))
      erreurs.push(`${chemin} : ${n.act} exige ${champ}`);
  };
  if (n.act === "goto") exige("url");
  else if (n.act === "press") exige("v");
  else if (n.act === "wait") exige("t");
  else {
    exige("t");
    if (n.act === "fill" || n.act === "select") exige("v");
  }
  if (n.act !== "goto" && n.url !== undefined) erreurs.push(`${chemin} : url ne sert qu'à goto`);
  if (n.act === "goto" && n.t !== undefined) erreurs.push(`${chemin} : goto n'a pas de cible t`);
  for (const t of n.t ?? []) {
    const r = refusCible(t);
    if (r !== null) erreurs.push(`${chemin}.t : ${r}`);
  }
  if (n.url !== undefined) {
    const r = refusUrl(n.url, origin);
    if (r !== null) erreurs.push(`${chemin}.url : ${r}`);
  }
  conditions(n.expect, `${chemin}.expect`, 1, erreurs);
}

/** Validation croisée d'une procédure déjà conforme au schéma : limites, origine, cibles, paramètres. */
export function verifierProcedure(p: Procedure): string[] {
  const erreurs: string[] = [];
  const origin = origineExacte(p.origin);
  if (origin === null)
    erreurs.push("origin : origine exacte http(s) attendue (ex. https://exemple.fr, sans chemin)");
  const noms = Object.keys(p.params);
  if (noms.length > LIMITES_PROCEDURE.parametres)
    erreurs.push(`params : ${LIMITES_PROCEDURE.parametres} au plus`);
  for (const nom of noms)
    if (!NOM_PARAMETRE.test(nom) || NOMS_RESERVES.has(nom))
      erreurs.push(`params.${nom} : nom a-z 0-9 _ (32 au plus), hors noms réservés d'objet`);
  const m = mesurer(p.root);
  if (m.profondeur > LIMITES_PROCEDURE.profondeur)
    erreurs.push(`arbre trop profond : ${m.profondeur} niveaux (${LIMITES_PROCEDURE.profondeur} au plus)`);
  if (m.noeuds > LIMITES_PROCEDURE.noeuds)
    erreurs.push(`arbre trop grand : ${m.noeuds} nœuds (${LIMITES_PROCEDURE.noeuds} au plus)`);
  if (erreurs.length > 0 && m.noeuds > 10 * LIMITES_PROCEDURE.noeuds) return erreurs;
  erreurs.push(...sousRetryInterdit(p.root));
  const utilises = new Map<string, string[]>();
  const noter = (s: string | undefined, ou: string): void => {
    if (s === undefined) return;
    if (s.includes("⟦"))
      erreurs.push(`${ou} : un jeton ⟦creds:…⟧ ne se met jamais dans un nœud (paramètre creds + login)`);
    for (const g of gabarits(s)) utilises.set(g, [...(utilises.get(g) ?? []), ou]);
  };
  const loginsCreds = new Set<string>();
  for (const [n, chemin] of parcourir(p.root)) {
    if ("act" in n) {
      verifierAct(n, chemin, origin ?? p.origin, erreurs);
      noter(n.v, `${chemin}.v`);
      noter(n.url, `${chemin}.url`);
      for (const t of n.t ?? []) noter(t, `${chemin}.t`);
      for (const s of chainesDe(n.expect)) noter(s, `${chemin}.expect`);
    } else if ("if" in n) {
      conditions(n.if, `${chemin}.if`, 1, erreurs);
      for (const s of chainesDe(n.if)) noter(s, `${chemin}.if`);
    } else if ("login" in n) {
      const l = n.login;
      const g = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(l.creds);
      if (g === null)
        erreurs.push(`${chemin}.login.creds : doit être exactement {parametre} (un paramètre de type creds)`);
      else {
        loginsCreds.add(g[1] as string);
        if (!Object.hasOwn(p.params, g[1] as string) || p.params[g[1] as string] !== "creds")
          erreurs.push(`${chemin}.login.creds : le paramètre ${g[1]} doit être déclaré de type creds`);
      }
      if (l.password_target === undefined && l.username_target === undefined)
        erreurs.push(`${chemin}.login : password_target et/ou username_target requis`);
      for (const k of ["password_target", "username_target", "submit_target", "wait_for"] as const) {
        const t = l[k];
        if (t === undefined) continue;
        const r = refusCible(t);
        if (r !== null) erreurs.push(`${chemin}.login.${k} : ${r}`);
        noter(t, `${chemin}.login.${k}`);
      }
    }
  }
  for (const [nom, ou] of utilises) {
    const type = Object.hasOwn(p.params, nom) ? p.params[nom] : undefined;
    if (type === undefined)
      erreurs.push(`paramètre {${nom}} utilisé (${ou[0]}) mais non déclaré dans params`);
    else if (type === "creds")
      erreurs.push(`paramètre creds {${nom}} utilisé hors de login.creds (${ou[0]})`);
  }
  return erreurs;
}

/** Profondeur de l'entrée brute, sans récursion ; au-delà de `valeursBrutes` valeurs visitées elle vaut « trop profonde ». */
function profondeurBrute(v: unknown): number {
  let max = 0;
  let vues = 0;
  const pile: [unknown, number][] = [[v, 1]];
  for (let e = pile.pop(); e !== undefined; e = pile.pop()) {
    vues += 1;
    if (vues > LIMITES_PROCEDURE.valeursBrutes) return LIMITES_PROCEDURE.profondeurBrute + 1;
    if (e[0] === null || typeof e[0] !== "object") continue;
    max = Math.max(max, e[1]);
    if (max > LIMITES_PROCEDURE.profondeurBrute) return max;
    for (const f of Object.values(e[0])) pile.push([f, e[1] + 1]);
  }
  return max;
}

/** Sous un `retry` seuls goto, wait, hover, wait_ms et les conditions sont admis : tout autre geste (fill et select relancent des événements input/change, un clic ou une touche agit) serait rejoué. */
function sousRetryInterdit(racine: Noeud): string[] {
  const erreurs: string[] = [];
  const pile: [Noeud, string, boolean][] = [[racine, "0", false]];
  for (let e = pile.pop(); e !== undefined; e = pile.pop()) {
    const [n, chemin, dedans] = e;
    if (dedans) {
      if ("login" in n)
        erreurs.push(`${chemin} : login interdit sous un retry (un usage du jeton serait rejoué)`);
      else if ("act" in n && (aConfirm(n) || !["goto", "wait", "hover"].includes(n.act)))
        erreurs.push(
          `${chemin} : ${aConfirm(n) ? "confirm" : n.act} interdit sous un retry (seuls goto, wait, hover et les conditions sont rejouables)`,
        );
    }
    for (const [suffixe, f] of fils(n)) pile.push([f, `${chemin}.${suffixe}`, dedans || "retry" in n]);
  }
  return erreurs;
}

export type ResultatProcedure = { ok: true; procedure: Procedure } | { ok: false; erreurs: string[] };

/** Valide une procédure inconnue (JSON reçu) : forme Zod, puis limites et règles croisées ; au plus 10 erreurs rendues. */
export function validerProcedure(entree: unknown): ResultatProcedure {
  if (profondeurBrute(entree) > LIMITES_PROCEDURE.profondeurBrute)
    return { ok: false, erreurs: ["arbre trop profond"] };
  const params = (entree as { params?: unknown } | null)?.params;
  if (params !== null && typeof params === "object" && Object.hasOwn(params, "__proto__"))
    return { ok: false, erreurs: ["params.__proto__ : nom réservé"] };
  const r = schemaBase.safeParse(entree);
  if (!r.success)
    return {
      ok: false,
      erreurs: r.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`),
    };
  const procedure = r.data as unknown as Procedure;
  const erreurs = verifierProcedure(procedure);
  return erreurs.length > 0 ? { ok: false, erreurs: erreurs.slice(0, 10) } : { ok: true, procedure };
}

/** Nœud à un chemin (`0`, `0.2`, `0.1.then`…), `undefined` s'il n'existe pas. */
export function noeudA(racine: Noeud, chemin: string): Noeud | undefined {
  for (const [n, c] of parcourir(racine)) if (c === chemin) return n;
  return undefined;
}

/** Copie de l'arbre dont le nœud au chemin est remplacé, `null` si le chemin n'existe pas. */
export function remplacerNoeud(racine: Noeud, chemin: string, nouveau: Noeud): Noeud | null {
  const segments = chemin.split(".").slice(1);
  const aller = (n: Noeud, reste: string[]): Noeud | null => {
    const [tete, ...suite] = reste;
    if (tete === undefined) return nouveau;
    if ("seq" in n || "sel" in n) {
      const liste = "seq" in n ? n.seq : n.sel;
      const i = Number(tete);
      const enfant = liste[i];
      if (!Number.isInteger(i) || enfant === undefined) return null;
      const r = aller(enfant, suite);
      if (r === null) return null;
      const copie = liste.map((x, k) => (k === i ? r : x));
      return "seq" in n ? { ...n, seq: copie } : { ...n, sel: copie };
    }
    if ("if" in n && (tete === "then" || tete === "else")) {
      const enfant = n[tete];
      if (enfant === undefined) return null;
      const r = aller(enfant, suite);
      return r === null ? null : { ...n, [tete]: r };
    }
    if ("retry" in n && tete === "retry") {
      const r = aller(n.retry, suite);
      return r === null ? null : { ...n, retry: r };
    }
    return null;
  };
  return aller(racine, segments);
}

/** URL d'un goto sans origine ni ancre (chemin + requête à l'identique) : unité de comparaison des goto d'une réparation. */
function urlComplete(url: string): string {
  return (url.replace(/^https?:\/\/[^/?#]+/u, "").split("#")[0] ?? "").trim();
}

const EFFETS: ReadonlySet<string> = new Set(["click", "press", "fill", "select", "check", "uncheck"]);
const actes = (n: Noeud): Act[] => [...parcourir(n)].flatMap(([x]) => ("act" in x ? [x] : []));
const logins = (n: Noeud): string[] =>
  [...parcourir(n)].filter(([x]) => "login" in x).map(([x]) => JSON.stringify(x));
const notesDe = (n: Noeud): Set<string> =>
  new Set(
    [...parcourir(n)].flatMap(([x]) =>
      (x as { note?: string }).note ? [(x as { note?: string }).note as string] : [],
    ),
  );

/** Copie du nœud sans les `note` absentes de l'ancien sous-arbre : une note écrite par une réparation n'est jamais conservée (donnée non fiable relue plus tard comme intention). */
function sansNotesNouvelles(n: Noeud, permises: Set<string>): Noeud {
  const nettoyer = (x: Noeud): Noeud => {
    const { note, ...reste } = x as Noeud & { note?: string };
    const garde = note !== undefined && permises.has(note) ? { note } : {};
    const y = { ...reste, ...garde } as Noeud;
    if ("seq" in y) return { ...y, seq: y.seq.map(nettoyer) };
    if ("sel" in y) return { ...y, sel: y.sel.map(nettoyer) };
    if ("if" in y)
      return {
        ...y,
        ...(y.then !== undefined ? { then: nettoyer(y.then) } : {}),
        ...(y.else !== undefined ? { else: nettoyer(y.else) } : {}),
      };
    if ("retry" in y) return { ...y, retry: nettoyer(y.retry) };
    return y;
  };
  return nettoyer(n);
}

export type ResultatReparation =
  | { ok: true; procedure: Procedure; chemin: string; confirmations: string[] }
  | { ok: false; erreurs: string[] };

/** Ce que la réparation sait de l'exécution qui a échoué : cibles des gestes déjà joués, et si la procédure a déjà réussi une fois. */
export interface ContexteReparation {
  readonly played: readonly string[];
  readonly dejaReussi: boolean;
}

/** Valeur lisible d'une cible DSL (name, text, label, placeholder, title, alt, test_id), sans accents ni casse ni ponctuation. */
function nomNormalise(t: string): string {
  const valeurs: string[] = [];
  for (const morceau of t.split(SEPARATEUR)) {
    const i = morceau.indexOf("=");
    if (i < 0) continue;
    if (
      ["name", "text", "label", "placeholder", "title", "alt", "test_id"].includes(
        morceau.slice(0, i).trim().toLowerCase(),
      )
    )
      valeurs.push(morceau.slice(i + 1));
  }
  return valeurs
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

const motsSignificatifs = (cibles: readonly string[] | undefined): Set<string> =>
  new Set(
    (cibles ?? []).flatMap((t) => nomNormalise(t).split(" ")).filter((m) => m.length > 3 || /\d/.test(m)),
  );

/** Vrai si la nouvelle cible apporte un mot significatif (ou un nombre) absent de l'ancienne, ou change sans mot significatif. */
function cibleElargie(
  ancienne: readonly string[] | undefined,
  nouvelle: readonly string[] | undefined,
): boolean {
  const anciens = motsSignificatifs(ancienne);
  const nouveaux = motsSignificatifs(nouvelle);
  const noms = (c: readonly string[] | undefined): string => (c ?? []).map(nomNormalise).join(" ");
  if (nouveaux.size === 0) return noms(nouvelle) !== noms(ancienne);
  return [...nouveaux].some((mot) => !anciens.has(mot));
}

/** Gestes sous `confirm` de `ancienne` sans équivalent sous `confirm` dans `nouvelle` (même act, `true` resté `true`, même URL pour un goto) : un `save` ne peut pas lever un accord humain. */
export function confirmesAffaiblis(ancienne: Procedure, nouvelle: Procedure): string[] {
  const pris = new Set<Act>();
  const neufs = actes(nouvelle.root);
  const manques: string[] = [];
  for (const o of actes(ancienne.root).filter(aConfirm)) {
    const c = neufs.find(
      (x) =>
        !pris.has(x) &&
        x.act === o.act &&
        aConfirm(x) &&
        (o.confirm !== true || x.confirm === true) &&
        (o.act !== "goto" || urlComplete(x.url ?? "") === urlComplete(o.url ?? "")),
    );
    if (c === undefined)
      manques.push(`${o.act}${o.act === "goto" ? ` ${o.url ?? ""}` : ` ${(o.t ?? [])[0] ?? ""}`}`);
    else pris.add(c);
  }
  return manques;
}

/**
 * Remplace le nœud au chemin par `nouveau` et valide le tout (schéma, limites) avec les règles de réparation :
 * (a) chaque geste sous `confirm` du sous-arbre remplacé a un correspondant (même `act`, confirm conservé : `true` reste `true`, même URL complète pour un goto) ;
 * (b) tout geste à effet ou goto nouveau (sans correspondant de même `act`) reçoit `confirm: "once"` ;
 * (b') un geste à effet apparié dont la cible change reçoit `confirm: "once"` si l'une de trois gardes se déclenche : anti-rejeu (une cible du nouveau geste, ou le même nom accessible, figure dans les gestes déjà joués ou dans un autre geste de l'arbre), ressemblance (aucun mot de plus de 3 lettres en commun avec les cibles de l'ancien geste), historique (la procédure n'a jamais réussi) ;
 * (c) un goto neuf ne peut être qu'une URL déjà présente à l'identique (requête comprise) dans un goto de l'arbre ; remplacer un goto par une autre URL de l'origine est permis avec `confirm: "once"` ;
 * (d) un `retry` neuf n'entoure que wait, wait_ms, hover et des conditions ; aucun login nouveau ; même origine et paramètres ; nœud borné ; notes nouvelles écartées.
 */
export function verifierReparation(
  ancienne: Procedure,
  chemin0: string,
  nouveau: unknown,
  contexte: ContexteReparation = { played: [], dejaReussi: true },
): ResultatReparation {
  const octets = new TextEncoder().encode(JSON.stringify(nouveau ?? null)).length;
  if (octets > LIMITES_PROCEDURE.octetsReparation)
    return {
      ok: false,
      erreurs: [
        `nœud de remplacement trop gros : ${octets} octets (${LIMITES_PROCEDURE.octetsReparation} au plus)`,
      ],
    };
  if (profondeurBrute(nouveau) > LIMITES_PROCEDURE.profondeurBrute)
    return { ok: false, erreurs: ["nœud trop profond"] };
  const r = schemaNoeud.safeParse(nouveau);
  if (!r.success)
    return {
      ok: false,
      erreurs: r.error.issues.slice(0, 10).map((i) => `node.${i.path.join(".")} : ${i.message}`),
    };
  const ancien = noeudA(ancienne.root, chemin0);
  if (ancien === undefined)
    return { ok: false, erreurs: [`le chemin ${chemin0} n'existe plus dans cette version`] };
  const noeud = sansNotesNouvelles(r.data, notesDe(ancien));
  const erreurs: string[] = [];
  const m = mesurer(noeud);
  if (m.noeuds > LIMITES_PROCEDURE.noeudsReparation)
    erreurs.push(
      `nœud de remplacement trop grand : ${m.noeuds} nœuds (${LIMITES_PROCEDURE.noeudsReparation} au plus)`,
    );
  const anciensLogins = new Set(logins(ancien));
  for (const l of logins(noeud))
    if (!anciensLogins.has(l)) erreurs.push("aucun login nouveau ou modifié dans une réparation");
  const vieux = actes(ancien);
  const neufs = actes(noeud);
  const pris = new Set<Act>();
  // (a) chaque geste sous confirm de l'ancien sous-arbre garde un correspondant sous confirm (un `true` reste `true`).
  for (const o of vieux.filter(aConfirm)) {
    const c = neufs.find(
      (x) =>
        !pris.has(x) &&
        x.act === o.act &&
        aConfirm(x) &&
        (o.confirm !== true || x.confirm === true) &&
        (o.act !== "goto" || urlComplete(x.url ?? "") === urlComplete(o.url ?? "")),
    );
    if (c === undefined)
      erreurs.push(
        `le geste ${o.act}${o.act === "goto" ? ` ${o.url ?? ""}` : ""} était sous confirm${o.confirm === true ? " (permanent)" : ""} : la réparation doit garder un ${o.act} identique avec le même confirm`,
      );
    else pris.add(c);
  }
  // Appariement des autres gestes : même cible, puis même expect, puis le premier de même act.
  const restants = neufs.filter((x) => !pris.has(x));
  const sansCorrespondant = new Set<Act>(restants);
  const paires: [Act, Act][] = [];
  const memeCible = (x: Act, y: Act): boolean => JSON.stringify(x.t ?? null) === JSON.stringify(y.t ?? null);
  const memeExpect = (x: Act, y: Act): boolean =>
    JSON.stringify(x.expect ?? null) === JSON.stringify(y.expect ?? null);
  const passes: ((o: Act, x: Act) => boolean)[] = [
    (o, x) => o.act === x.act && memeCible(o, x),
    (o, x) => o.act === x.act && x.expect !== undefined && memeExpect(o, x),
    (o, x) => o.act === x.act,
  ];
  const vieuxLibres = new Set(vieux.filter((x) => !aConfirm(x)));
  for (const accorde of passes)
    for (const o of [...vieuxLibres]) {
      const x = restants.find((y) => sansCorrespondant.has(y) && accorde(o, y));
      if (x === undefined) continue;
      sansCorrespondant.delete(x);
      vieuxLibres.delete(o);
      paires.push([o, x]);
    }
  const aMarquer = new Map<Act, string>();
  for (const x of sansCorrespondant)
    if (EFFETS.has(x.act) || x.act === "goto") aMarquer.set(x, "geste nouveau");
  // (b') geste à effet apparié dont la cible change : trois gardes.
  const dehors = new Set<string>();
  for (const [n, c] of parcourir(ancienne.root))
    if ("act" in n && c !== chemin0 && !c.startsWith(`${chemin0}.`))
      for (const t of n.t ?? []) dehors.add(nomNormalise(t));
  for (const t of contexte.played) dehors.add(nomNormalise(t));
  dehors.delete("");
  for (const [o, x] of paires) {
    if (!EFFETS.has(x.act) || memeCible(o, x)) continue;
    if ((x.t ?? []).some((t) => dehors.has(nomNormalise(t))))
      aMarquer.set(x, "cible déjà jouée ou présente ailleurs dans l'arbre");
    else if (cibleElargie(o.t, x.t))
      aMarquer.set(x, "cible apportant un mot ou un nombre absent de l'ancienne");
    else if (!contexte.dejaReussi) aMarquer.set(x, "la procédure n'a jamais réussi");
  }
  // (c) goto.
  const presentes = new Set(
    actes(ancienne.root).flatMap((x) => (x.act === "goto" ? [urlComplete(x.url ?? "")] : [])),
  );
  const remplaceUnGoto = "act" in ancien && ancien.act === "goto";
  for (const x of neufs.filter((y) => y.act === "goto")) {
    const u = urlComplete(x.url ?? "");
    if (remplaceUnGoto) {
      if (u !== urlComplete(ancien.url ?? "") && !pris.has(x))
        aMarquer.set(x, "goto remplacé par une autre URL");
    } else if (!presentes.has(u))
      erreurs.push(
        `goto ${u} : URL absente de l'arbre (permise seulement à l'identique, requête comprise, ou en remplacement d'un goto)`,
      );
  }
  // (d) retry neuf : seulement autour de wait, wait_ms, hover et conditions.
  const anciensRetry = new Set(
    [...parcourir(ancien)].flatMap(([x]) => ("retry" in x ? [JSON.stringify(x)] : [])),
  );
  for (const [x] of parcourir(noeud)) {
    if (!("retry" in x) || anciensRetry.has(JSON.stringify(x))) continue;
    for (const a of actes(x.retry))
      if (!["wait", "hover"].includes(a.act))
        erreurs.push(`retry nouveau : ${a.act} interdit dedans (seulement wait, hover et conditions)`);
  }
  const confirmations: string[] = [];
  for (const [x, raison] of aMarquer) {
    if (!aConfirm(x)) x.confirm = "once";
    confirmations.push(
      `${x.act}${x.act === "goto" ? ` ${x.url ?? ""}` : ` ${(x.t ?? [])[0] ?? ""}`} : ${raison}`,
    );
  }
  const arbre = remplacerNoeud(ancienne.root, chemin0, noeud);
  if (arbre === null) return { ok: false, erreurs: [`le chemin ${chemin0} ne peut pas être remplacé`] };
  const neuve: Procedure = { ...ancienne, root: arbre };
  const v = validerProcedure(neuve);
  if (!v.ok) erreurs.push(...v.erreurs);
  return erreurs.length > 0
    ? { ok: false, erreurs: erreurs.slice(0, 10) }
    : { ok: true, procedure: neuve, chemin: chemin0, confirmations };
}
