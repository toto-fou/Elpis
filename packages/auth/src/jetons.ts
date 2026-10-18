// SPDX-License-Identifier: MIT
/** packages/auth/src/jetons.ts — jetons personnels (accounts/tokens.py) : opencode `pcr_`, outils `ept_`, vision `evt_` ; seule l'empreinte est gardée. */
import { hasTable } from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";
import { tokenDigest, tokenUrlsafe } from "@elpis/securite";

import { arrondiEntierPy, comparePointsDeCode, intPy, stripPy, strPy, veritePy } from "@elpis/commun";

import { valeur } from "./dict";

export const PREFIXES = { opencode: "pcr_", tools: "ept_", vision: "evt_" } as const;
export type TypeJeton = keyof typeof PREFIXES;
export const TYPES: readonly TypeJeton[] = ["opencode", "tools", "vision"];
export const FAMILLES_EXTERNES: readonly string[] = ["fs", "shell", "git", "desktop", "browser", "skill_run"];
const FAMILLES_PAR_DEFAUT = "fs,shell,git,desktop,browser,skill_run";
const JOURS_MAX_PAR_DEFAUT = 90;
const MAX_PAR_COMPTE_PAR_DEFAUT = 20;
export const VISION_TTL_S = 12 * 3600;
const VISION_MAX_PAR_COMPTE = 20;
const TOUCHER_TOUTES_S = 300;
const NOM_MAX = 80;
const COLONNES = "id, user_id, kind, name, token_hash, hint, families, created_at, expires_at, last_used_at";

export class ErreurJeton extends Error {
  override name = "ErreurJeton";
}

export interface Politique {
  tools_enabled: boolean;
  tools_families: string[];
  max_days: number;
  max_per_user: number;
}

export interface Jeton {
  id: number;
  user_id: number;
  kind: string;
  name: string;
  hint: string;
  families: string[];
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
}

export interface JetonResolu {
  id: number;
  user_id: number;
  username: string;
  kind: TypeJeton;
  name: string;
  families: string[];
  expires_at: number | null;
}

export interface DependancesJetons {
  base: Base;
  config(): unknown;
  maintenant?(): number;
  revoquerOauth?(userId: number): Promise<number>;
  avertir?(message: string, erreur: unknown): void;
  informer?(message: string): void;
}

function maintenant(dep: DependancesJetons): number {
  return dep.maintenant ? dep.maintenant() : Date.now() / 1000;
}

function entierBorne(v: unknown, defaut: number, bas: number, haut: number): number {
  let n: number;
  try {
    n = intPy(v);
  } catch {
    return defaut;
  }
  return Math.max(bas, Math.min(haut, n));
}

export function familles(v: unknown): string[] {
  const items = Array.isArray(v) ? v : strPy(veritePy(v) ? v : "").split(",");
  const out: string[] = [];
  for (const brut of items) {
    const f = stripPy(strPy(veritePy(brut) ? brut : ""));
    if (f && FAMILLES_EXTERNES.includes(f) && !out.includes(f)) out.push(f);
  }
  return out;
}

export function politique(config: unknown): Politique {
  const active = valeur(config, "mcp.tokens.tools_enabled", true);
  return {
    tools_enabled: active !== false && !["false", "0", "off"].includes(strPy(active).toLowerCase()),
    tools_families: familles(valeur(config, "mcp.tokens.tools_families", FAMILLES_PAR_DEFAUT)),
    max_days: entierBorne(
      valeur(config, "mcp.tokens.max_days", JOURS_MAX_PAR_DEFAUT),
      JOURS_MAX_PAR_DEFAUT,
      0,
      3650,
    ),
    max_per_user: entierBorne(
      valeur(config, "mcp.tokens.max_per_user", MAX_PAR_COMPTE_PAR_DEFAUT),
      MAX_PAR_COMPTE_PAR_DEFAUT,
      1,
      1000,
    ),
  };
}

/** `feature_enabled("opencode")` sur la config donnée : seul un `false` explicite coupe. */
export function opencodeActif(config: unknown): boolean {
  const f = valeur(config, "features", {});
  const v =
    f !== null && typeof f === "object" && Object.hasOwn(f, "opencode")
      ? (f as Record<string, unknown>).opencode
      : true;
  return v !== false;
}

function typeActif(type: TypeJeton, config: unknown, pol: Politique): boolean {
  if (type === "opencode") return opencodeActif(config);
  if (type === "tools") return pol.tools_enabled;
  return true;
}

export function typeDe(jeton: string): TypeJeton | null {
  const p = strPy(veritePy(jeton) ? jeton : "").slice(0, 4);
  return (TYPES.find((t) => PREFIXES[t] === p) ?? null) as TypeJeton | null;
}

/** `s.split()` de Python : coupe sur les blancs Unicode de `str.isspace`. */
function motsPy(s: string): string[] {
  const mots: string[] = [];
  let mot = "";
  for (const c of s) {
    if (stripPy(c)) {
      mot += c;
    } else if (mot) {
      mots.push(mot);
      mot = "";
    }
  }
  if (mot) mots.push(mot);
  return mots;
}

export function nomPropre(nom: unknown, defaut: string): string {
  const n = Array.from(motsPy(strPy(veritePy(nom) ? nom : "")).join(" "))
    .slice(0, NOM_MAX)
    .join("");
  return n || defaut;
}

export function validerDemandeOutils(
  fams: unknown,
  jours: unknown,
  pol: Politique,
  t: number,
): [string[], number | null] {
  const permises = pol.tools_families;
  const iterable = Array.isArray(fams)
    ? fams
    : typeof fams === "string"
      ? Array.from(fams)
      : fams !== null && typeof fams === "object" && veritePy(fams)
        ? Object.keys(fams)
        : [];
  const demandees = iterable.map((f) => stripPy(strPy(f))).filter(Boolean);
  const refusees = demandees.filter((f) => !permises.includes(f));
  if (refusees.length)
    throw new ErreurJeton(
      `Famille non autorisée : ${[...new Set(refusees)].sort(comparePointsDeCode).join(", ")}.`,
    );
  const retenues = permises.filter((f) => demandees.includes(f));
  if (!retenues.length) throw new ErreurJeton("Cochez au moins une famille d'outils.");
  let d: number;
  try {
    d = jours === null || jours === undefined ? 0 : intPy(jours);
  } catch {
    throw new ErreurJeton("Durée invalide.");
  }
  if (d < 0) throw new ErreurJeton("Durée invalide.");
  if (pol.max_days && (d === 0 || d > pol.max_days)) {
    if (d > pol.max_days) throw new ErreurJeton(`Durée maximale : ${pol.max_days} jours.`);
    d = pol.max_days;
  }
  return [retenues, d ? t + d * 86400 : null];
}

function ligne(r: Record<string, unknown>): Jeton {
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    kind: String(r.kind),
    name: String(r.name ?? ""),
    hint: String(r.hint ?? ""),
    families: String(r.families ?? "")
      .split(",")
      .filter(Boolean),
    created_at: Number(r.created_at ?? 0),
    expires_at: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
    last_used_at: r.last_used_at === null || r.last_used_at === undefined ? null : Number(r.last_used_at),
  };
}

export async function verifierQuota(x: Executeur, userId: number, pol: Politique, t: number): Promise<void> {
  const r = await x.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM tool_tokens WHERE user_id=? AND kind<>'vision' AND (expires_at IS NULL OR expires_at>?)",
    [userId, t],
  );
  if (r && Number(r.n) >= pol.max_per_user) {
    throw new ErreurJeton(`Nombre maximal de jetons atteint (${pol.max_per_user}). Révoquez-en un d'abord.`);
  }
}

const NOMS_PAR_DEFAUT: Readonly<Record<TypeJeton, string>> = {
  opencode: "opencode",
  tools: "outils",
  vision: "vision",
};

/** Crée un jeton ; rend le clair (montré une seule fois) et sa ligne. */
export async function creerJeton(
  dep: DependancesJetons,
  userId: number,
  type: string,
  nom = "",
  fams?: unknown,
  jours?: unknown,
): Promise<[string, Jeton]> {
  if (!(TYPES as readonly string[]).includes(type)) throw new ErreurJeton("Type de jeton inconnu.");
  const t0 = type as TypeJeton;
  const config = dep.config();
  const pol = politique(config);
  let retenues: string[] = [];
  let expire: number | null = null;
  if (t0 === "tools") {
    if (!pol.tools_enabled)
      throw new ErreurJeton("Les jetons d'outils sont désactivés par l'administrateur.");
    [retenues, expire] = validerDemandeOutils(fams, jours, pol, maintenant(dep));
  } else if (t0 === "vision") {
    expire = maintenant(dep) + VISION_TTL_S;
  } else if (!opencodeActif(config)) {
    throw new ErreurJeton("OpenCode est désactivé par l'administrateur.");
  }
  const jeton = PREFIXES[t0] + tokenUrlsafe(30);
  const t = maintenant(dep);
  const propre = nomPropre(nom, NOMS_PAR_DEFAUT[t0]);
  const id = await dep.base.ecriture(async (x) => {
    if (t0 !== "vision") {
      await verifierQuota(x, userId, pol, t);
    } else {
      await x.run("DELETE FROM tool_tokens WHERE kind='vision' AND expires_at<?", [t]);
      const ids = await x.valeurs<[number]>(
        "SELECT id FROM tool_tokens WHERE user_id=? AND kind='vision' ORDER BY created_at DESC, id DESC",
        [userId],
      );
      for (const [ancien] of ids.slice(VISION_MAX_PAR_COMPTE - 1))
        await x.run("DELETE FROM tool_tokens WHERE id=?", [ancien]);
    }
    return x.insertId(
      "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at, expires_at, last_used_at) " +
        "VALUES(?,?,?,?,?,?,?,?,?)",
      [userId, t0, propre, tokenDigest(jeton), jeton.slice(-4), retenues.join(","), t, expire, null],
    );
  });
  return [
    jeton,
    {
      id,
      user_id: userId,
      kind: t0,
      name: propre,
      hint: jeton.slice(-4),
      families: retenues,
      created_at: t,
      expires_at: expire,
      last_used_at: null,
    },
  ];
}

const touches = new Map<number, number>();

/** `last_used_at` au plus toutes les 5 minutes. */
export async function toucherJeton(dep: DependancesJetons, id: number, connu: number | null): Promise<void> {
  const t = maintenant(dep);
  if (t - Math.max(Number(connu ?? 0), touches.get(id) ?? 0) < TOUCHER_TOUTES_S) return;
  touches.set(id, t);
  if (touches.size > 4096) touches.clear();
  await dep.base.run("UPDATE tool_tokens SET last_used_at=? WHERE id=?", [t, id]).catch(() => undefined);
}

/** Jeton en clair → titulaire, ou null (inconnu, expiré, compte supprimé, type non demandé ou désactivé). */
export async function resoudreJeton(
  dep: DependancesJetons,
  jeton: string,
  types: readonly string[] = ["tools"],
  toucher = true,
): Promise<JetonResolu | null> {
  const tok = stripPy(String(jeton ?? ""));
  const type = typeDe(tok);
  if (!type || !types.includes(type) || Array.from(tok).length < 20) return null;
  const config = dep.config();
  const pol = politique(config);
  if (!typeActif(type, config, pol)) return null;
  let r: Record<string, unknown> | undefined;
  try {
    r = await dep.base.get(
      "SELECT t.id, t.user_id, t.kind, t.name, t.token_hash, t.hint, t.families, t.created_at, t.expires_at, " +
        "t.last_used_at, u.username FROM tool_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash=?",
      [tokenDigest(tok)],
    );
  } catch (e) {
    dep.avertir?.("[tokens] vérification impossible", e);
    return null;
  }
  if (!r || String(r.kind) !== type || !veritePy(r.username)) return null;
  const l = ligne(r);
  if (l.expires_at !== null && l.expires_at <= maintenant(dep)) return null;
  let fams = l.families;
  if (type === "tools") {
    fams = fams.filter((f) => pol.tools_families.includes(f));
    if (!fams.length) return null;
  }
  if (toucher) await toucherJeton(dep, l.id, l.last_used_at);
  return {
    id: l.id,
    user_id: l.user_id,
    username: String(r.username),
    kind: type,
    name: l.name,
    families: fams,
    expires_at: l.expires_at,
  };
}

export async function listerJetons(x: Executeur, userId: number, avecMasques = false): Promise<Jeton[]> {
  const sql = `SELECT ${COLONNES} FROM tool_tokens WHERE user_id=?${avecMasques ? "" : " AND kind<>'vision'"}`;
  return (await x.all(`${sql} ORDER BY created_at DESC, id DESC`, [userId])).map(ligne);
}

export async function lireJeton(x: Executeur, userId: number, id: number): Promise<Jeton | null> {
  const r = await x.get(`SELECT ${COLONNES} FROM tool_tokens WHERE id=? AND user_id=? AND kind<>'vision'`, [
    id,
    userId,
  ]);
  return r ? ligne(r) : null;
}

export async function revoquerJeton(x: Executeur, userId: number, id: number): Promise<boolean> {
  return (await x.run("DELETE FROM tool_tokens WHERE id=? AND user_id=?", [id, userId])).changes > 0;
}

export async function revoquerType(x: Executeur, userId: number, type: string): Promise<number> {
  return (await x.run("DELETE FROM tool_tokens WHERE user_id=? AND kind=?", [userId, type])).changes;
}

/** Nouveau jeton de même nom, type et familles ; l'ancien est révoqué dans la même transaction (tout refus le laisse intact). */
export async function regenererJeton(
  dep: DependancesJetons,
  userId: number,
  id: number,
): Promise<[string, Jeton] | null> {
  return dep.base.ecriture(async (x) => {
    const ancien = await lireJeton(x, userId, id);
    if (!ancien) return null;
    const pol = politique(dep.config());
    let jours: number | undefined;
    if (ancien.kind === "tools" && ancien.expires_at) {
      jours = Math.max(1, arrondiEntierPy((ancien.expires_at - ancien.created_at) / 86400));
      if (pol.max_days) jours = Math.min(jours, pol.max_days);
    }
    let fams: string[];
    if (ancien.kind === "tools") {
      if (!pol.tools_enabled)
        throw new ErreurJeton("Les jetons d'outils sont désactivés par l'administrateur.");
      fams = ancien.families.filter((f) => pol.tools_families.includes(f));
      if (!fams.length) throw new ErreurJeton("Aucune des familles de ce jeton n'est encore autorisée.");
    } else {
      if (ancien.kind === "opencode" && !opencodeActif(dep.config()))
        throw new ErreurJeton("OpenCode est désactivé par l'administrateur.");
      fams = ancien.families;
    }
    await x.run("DELETE FROM tool_tokens WHERE id=? AND user_id=?", [id, userId]);
    return creerJeton(dep, userId, ancien.kind, ancien.name, fams, jours);
  });
}

export async function supprimerJetonsCompte(x: Executeur, userId: number): Promise<void> {
  await x.run("DELETE FROM tool_tokens WHERE user_id=?", [userId]);
}

/** Coupe tout accès non interactif d'un compte : jetons personnels et autorisations OAuth. */
export async function revoquerTousAcces(
  dep: DependancesJetons,
  userId: number,
): Promise<{ tokens: number; oauth: number }> {
  const tokens = (await dep.base.run("DELETE FROM tool_tokens WHERE user_id=?", [userId])).changes;
  let oauth: number;
  try {
    oauth = dep.revoquerOauth ? await dep.revoquerOauth(userId) : 0;
  } catch (e) {
    dep.avertir?.(`[tokens] révocation OAuth du compte ${userId} impossible`, e);
    oauth = 0;
  }
  if (tokens || oauth)
    dep.informer?.(`[tokens] compte ${userId} : ${tokens} jeton(s) et ${oauth} application(s) révoqués`);
  return { tokens, oauth };
}

/** `convert_legacy` : anciens jetons opencode en clair (`code_remote_tokens`) → empreintes ; une fois par base au démarrage. */
export async function convertirAnciensJetons(base: Base, t: number): Promise<number> {
  return base.ecriture(async (x) => {
    if (!(await hasTable(x, "code_remote_tokens"))) return 0;
    const lignes = await x.all<{ user_id: number; token: string | null; created_at: number | null }>(
      "SELECT t.user_id, t.token, t.created_at FROM code_remote_tokens t JOIN users u ON u.id = t.user_id",
    );
    let n = 0;
    for (const l of lignes) {
      const tok = String(l.token ?? "");
      if (!tok) continue;
      const h = tokenDigest(tok);
      if (await x.get("SELECT 1 AS un FROM tool_tokens WHERE token_hash=?", [h])) continue;
      await x.run(
        "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
        [Number(l.user_id), "opencode", "opencode", h, tok.slice(-4), "", Number(l.created_at ?? 0) || t],
      );
      n += 1;
    }
    if (!lignes.length && !(await x.get("SELECT 1 AS un FROM code_remote_tokens"))) return 0;
    await x.run("DELETE FROM code_remote_tokens");
    if (await hasTable(x, "code_pairings")) await x.run("DELETE FROM code_pairings WHERE token IS NOT NULL");
    return n;
  });
}
