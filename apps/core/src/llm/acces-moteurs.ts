// SPDX-License-Identifier: MIT
/** apps/core/src/llm/acces-moteurs.ts — serveurs visibles et droit de gérer les modèles, par compte et par groupe (`engine_access.py`, table `llm_engine_policies`). */
import { closeSync, mkdirSync, openSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

import {
  comparePointsDeCode,
  ErreurPython,
  HttpError,
  intPy,
  pyJsonDumps,
  pyJsonLoads,
  reprPy,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import type { Base, Executeur } from "@elpis/db";
import { estTableAbsente } from "@elpis/db";

import { journal } from "../journal";
import { listSharedConnectors } from "./connecteurs";
import { BUILTIN_KEY, connectorKey } from "./moteurs";
import type { PortAccesMoteurs } from "./ports";

export { BUILTIN_KEY, connectorKey };
export const ALL_KEY = "*";
export const PRINCIPAL_TYPES = ["user", "group"] as const;
export type Principal = (typeof PRINCIPAL_TYPES)[number];

const CONN_RE = /^conn:([0-9]+)$/;
const MAX_KEYS = 200;
/** `_TTL_S` : contexte d'un compte gardé 3 s (réglable par les tests). */
export const reglagesAcces = { ttlS: 3.0 };

const log = journal("engine_access");

export interface Politique {
  engine_keys: string[] | null;
  can_manage_models: boolean | null;
}

export interface Acces {
  /** `null` = tous les serveurs. */
  engine_keys: ReadonlySet<string> | null;
  engine_source: string;
  can_manage_models: boolean;
  manage_source: string;
}

/** `ValueError` de Python : message lisible destiné à un 400. */
export class ValeurInvalide extends Error {
  override name = "ValueError";
}

// ── Empreinte partagée entre processus (main et admin) ───────────────────────

/** `runtime_path` : surcharge du canal, sinon `ELPIS_RUNTIME_DIR/<nom>`, sinon le chemin historique. */
export function cheminExecution(nom: string, surcharge: string, historique: string): string {
  const propre = stripPy(process.env[surcharge] ?? "");
  if (propre) return propre;
  const racine = stripPy(process.env["ELPIS_RUNTIME_DIR"] ?? "");
  if (racine) return join(racine, nom);
  return historique || join("/tmp", nom);
}

function cheminEmpreinte(): string {
  const dossier = cheminExecution("engine_access", "ELPIS_ENGINE_ACCESS_DIR", "/tmp/elpis_engine_access");
  mkdirSync(dossier, { recursive: true });
  return join(dossier, "policies.stamp");
}

/** Version des politiques vue de tous les processus (mtime du témoin) ; 0 = indisponible, le TTL seul s'applique. */
function empreinteCourante(): bigint {
  try {
    return statSync(cheminEmpreinte(), { bigint: true }).mtimeNs;
  } catch (e) {
    log.debug(`[engine_access] empreinte de politiques illisible (${String(e)})`);
    return 0n;
  }
}

/** Signale un changement de politique ou d'appartenance aux groupes ; le mtime avance toujours (deux écritures dans la même milliseconde comprises). */
export function bumpStamp(): void {
  try {
    const p = cheminEmpreinte();
    closeSync(openSync(p, "a"));
    const avant = statSync(p, { bigint: true }).mtimeNs;
    const maintenant = BigInt(Date.now()) * 1_000_000n;
    const cible = Number(maintenant > avant + 1_000n ? maintenant : avant + 1_000n) / 1e9;
    utimesSync(p, cible, cible);
  } catch (e) {
    log.debug(`[engine_access] empreinte de politiques non touchée (${String(e)})`);
  }
}

let dernierAvertissement = Number.NEGATIVE_INFINITY;

function avertir(message: string): void {
  const t = performance.now() / 1000;
  if (t - dernierAvertissement < 60.0) return;
  dernierAvertissement = t;
  log.warn(message);
}

// ── Clés ─────────────────────────────────────────────────────────────────────

/** `["builtin", null]`, `["conn", id]` ou `null` ; chiffres ASCII seulement, `"*"` n'est pas une clé de moteur. */
export function parseKey(key: unknown): ["builtin", null] | ["conn", number] | null {
  if (typeof key !== "string") return null;
  const k = stripPy(key);
  if (k === BUILTIN_KEY) return [BUILTIN_KEY, null];
  const m = CONN_RE.exec(k);
  if (m === null) return null;
  const chiffres = m[1] as string;
  if (chiffres.length > 4300)
    throw new ErreurPython(
      "ValueError",
      `Exceeds the limit (4300 digits) for integer string conversion: value has ${chiffres.length} digits; ` +
        "use sys.set_int_max_str_digits() to increase the limit",
    );
  const cid = intPy(chiffres);
  return cid > 0 ? ["conn", cid] : null;
}

type Entree = { t: number; empreinte: bigint; ctx: Contexte };
type Contexte = { is_admin: boolean; user: Politique | null; groups: Politique[] };
const caches = new WeakMap<Executeur, Map<number, Entree>>();
const enCours = new WeakMap<Executeur, Map<number, Promise<unknown>>>();

function cacheDe(base: Executeur): Map<number, Entree> {
  let c = caches.get(base);
  if (c === undefined) {
    c = new Map();
    caches.set(base, c);
  }
  return c;
}

/** Vide le cache de CE processus et touche l'empreinte : les autres processus relisent à leur prochaine lecture. */
export function invalidateCache(base?: Executeur, userId?: number | null): void {
  bumpStamp();
  if (base === undefined) return;
  if (userId === null || userId === undefined) caches.delete(base);
  else cacheDe(base).delete(intPy(userId));
}

// ── Stockage ─────────────────────────────────────────────────────────────────

/** Ligne → politique ; une liste illisible vaut « aucun serveur », jamais « tout ». */
export function decodeRow(engineKeysRaw: unknown, manageRaw: unknown): Politique {
  let keys: string[] | null = null;
  if (engineKeysRaw !== null && engineKeysRaw !== undefined) {
    try {
      if (typeof engineKeysRaw !== "string") throw new TypeError("JSON object must be str");
      const lu = pyJsonLoads(engineKeysRaw, { mode: "natif" });
      keys = Array.isArray(lu) ? lu.filter((k): k is string => typeof k === "string") : [];
    } catch (e) {
      log.debug(`[engine_access] liste de serveurs illisible, aucun serveur retenu (${String(e)})`);
      keys = [];
    }
  }
  return {
    engine_keys: keys,
    can_manage_models: manageRaw === null || manageRaw === undefined ? null : veritePy(manageRaw),
  };
}

function verifierPrincipal(principalType: unknown): Principal {
  if (principalType !== "user" && principalType !== "group")
    throw new ValeurInvalide(`principal_type invalide : ${reprPy(principalType)}`);
  return principalType;
}

/** Valide et dédoublonne (ordre gardé, `conn:<id>` canonique) ; `checkExists` exige des connecteurs PARTAGÉS existants. */
export async function normalizeEngineKeys(
  base: Executeur | null,
  keys: unknown,
  options: { checkExists?: boolean } = {},
): Promise<string[] | null> {
  if (keys === null || keys === undefined) return null;
  if (!Array.isArray(keys)) throw new ValeurInvalide("engine_keys doit être null ou une liste");
  if (keys.length > MAX_KEYS) throw new ValeurInvalide("engine_keys : trop de clés");
  const out: string[] = [];
  const bad: string[] = [];
  const connIds: number[] = [];
  for (const brute of keys) {
    if (typeof brute !== "string") {
      bad.push(reprPy(brute));
      continue;
    }
    let k = stripPy(brute);
    if (k === ALL_KEY) {
      if (!out.includes(k)) out.push(k);
      continue;
    }
    const p = parseKey(k);
    if (p === null) {
      bad.push(k);
      continue;
    }
    if (p[0] === "conn") {
      connIds.push(p[1]);
      k = connectorKey(p[1]);
    }
    if (!out.includes(k)) out.push(k);
  }
  if (bad.length > 0) throw new ValeurInvalide("Clés de serveur invalides : " + bad.join(", "));
  if ((options.checkExists ?? true) && connIds.length > 0) {
    if (base === null) throw new Error("normalizeEngineKeys : base requise pour vérifier l'existence");
    const lignes = await base.valeurs(
      `SELECT id FROM llm_connectors WHERE scope='shared' AND id IN (${connIds.map(() => "?").join(",")})`,
      connIds,
    );
    const connus = new Set(lignes.map((r) => intPy(r[0])));
    const manquants = [...new Set(connIds.filter((c) => !connus.has(c)).map((c) => connectorKey(c)))];
    if (manquants.length > 0)
      throw new ValeurInvalide("Serveurs inconnus : " + manquants.sort(comparePointsDeCode).join(", "));
  }
  return out;
}

export async function getPolicy(
  base: Executeur,
  principalType: unknown,
  principalId: unknown,
): Promise<Politique> {
  const type = verifierPrincipal(principalType);
  const r = await base.valeurs(
    "SELECT engine_keys, can_manage_models FROM llm_engine_policies WHERE principal_type=? AND principal_id=?",
    [type, intPy(principalId)],
  );
  const ligne = r[0];
  return ligne === undefined ? { engine_keys: null, can_manage_models: null } : decodeRow(ligne[0], ligne[1]);
}

/** Remplace la politique du principal ; tout-`null` supprime la ligne ; clés normalisées sans contrôle d'existence. */
export async function setPolicy(
  base: Executeur,
  principalType: unknown,
  principalId: unknown,
  champs: { engine_keys: unknown; can_manage_models: unknown },
): Promise<Politique> {
  const type = verifierPrincipal(principalType);
  const keys = await normalizeEngineKeys(null, champs.engine_keys, { checkExists: false });
  const gestion = champs.can_manage_models;
  if (gestion !== null && gestion !== undefined && typeof gestion !== "boolean")
    throw new ValeurInvalide("can_manage_models doit être null ou un booléen");
  if (keys === null && (gestion === null || gestion === undefined)) {
    await clearPolicy(base, type, principalId);
    return { engine_keys: null, can_manage_models: null };
  }
  await base.run(
    "INSERT INTO llm_engine_policies(principal_type, principal_id, engine_keys, can_manage_models, updated_at) " +
      "VALUES (?, ?, ?, ?, ?) ON CONFLICT(principal_type, principal_id) DO UPDATE SET " +
      "engine_keys = excluded.engine_keys, can_manage_models = excluded.can_manage_models, " +
      "updated_at = excluded.updated_at",
    [
      type,
      intPy(principalId),
      keys === null ? null : pyJsonDumps(keys),
      gestion === null || gestion === undefined ? null : gestion ? 1 : 0,
      Date.now() / 1000,
    ],
  );
  invalidateCache(base);
  return { engine_keys: keys, can_manage_models: gestion === undefined ? null : (gestion as boolean | null) };
}

export async function clearPolicy(
  base: Executeur,
  principalType: unknown,
  principalId: unknown,
): Promise<void> {
  const type = verifierPrincipal(principalType);
  await base.run("DELETE FROM llm_engine_policies WHERE principal_type=? AND principal_id=?", [
    type,
    intPy(principalId),
  ]);
  invalidateCache(base);
}

/** Purge dans la transaction de l'appelant (compte ou groupe supprimé) ; table absente tolérée. */
export async function deletePrincipalRows(
  x: Executeur,
  principalType: unknown,
  principalId: unknown,
  cache?: Executeur,
): Promise<void> {
  try {
    await x.run("DELETE FROM llm_engine_policies WHERE principal_type=? AND principal_id=?", [
      String(principalType),
      intPy(principalId),
    ]);
  } catch (e) {
    if (!estTableAbsente(e)) throw e;
  }
  invalidateCache(cache ?? x);
}

/** Toutes les politiques en une requête (vue d'administration), clé `"type:id"`. */
export async function listPolicies(
  base: Executeur,
  principalType?: unknown,
): Promise<Map<string, Politique>> {
  let sql = "SELECT principal_type, principal_id, engine_keys, can_manage_models FROM llm_engine_policies";
  const args: (string | number)[] = [];
  if (principalType !== undefined && principalType !== null) {
    sql += " WHERE principal_type=?";
    args.push(verifierPrincipal(principalType));
  }
  const lignes = await base.valeurs(sql, args);
  return new Map(lignes.map((r) => [`${String(r[0])}:${intPy(r[1])}`, decodeRow(r[2], r[3])]));
}

/** Retire `key` de toutes les listes (connecteur supprimé) ; une liste vidée reste `[]` = aucun serveur. */
export async function purgeEngineKey(base: Base, key: unknown): Promise<number> {
  if (parseKey(key) === null) return 0;
  const cle = key as string;
  let changes = 0;
  await base.transaction(async (tx) => {
    const lignes = await tx.valeurs(
      "SELECT principal_type, principal_id, engine_keys FROM llm_engine_policies WHERE engine_keys IS NOT NULL",
    );
    for (const r of lignes) {
      const keys = decodeRow(r[2], null).engine_keys ?? [];
      if (!keys.includes(cle)) continue;
      await tx.run(
        "UPDATE llm_engine_policies SET engine_keys=?, updated_at=? WHERE principal_type=? AND principal_id=?",
        [pyJsonDumps(keys.filter((k) => k !== cle)), Date.now() / 1000, String(r[0]), intPy(r[1])],
      );
      changes += 1;
    }
  });
  invalidateCache(base);
  return changes;
}

// ── Résolution ───────────────────────────────────────────────────────────────

/** Résolution pure : admin = tout ; liste propre, sinon union des groupes, sinon tout ; `"*"` = tout. */
export function resolveAccess(
  userPolicy: Partial<Politique> | null | undefined,
  groupPolicies: readonly (Partial<Politique> | null | undefined)[] | null | undefined,
  options: { isAdmin: boolean },
): Acces {
  const groupes = (groupPolicies ?? []).filter(
    (g): g is Partial<Politique> => g !== null && g !== undefined && Object.keys(g).length > 0,
  );
  if (options.isAdmin)
    return { engine_keys: null, engine_source: "admin", can_manage_models: true, manage_source: "admin" };
  const up = userPolicy ?? {};
  let keys: Set<string> | null;
  let source: string;
  if (up.engine_keys !== null && up.engine_keys !== undefined) {
    keys = new Set(up.engine_keys);
    source = "user";
  } else {
    const listes = groupes
      .map((g) => g.engine_keys)
      .filter((l): l is string[] => l !== null && l !== undefined);
    if (listes.length > 0) {
      keys = new Set(listes.flat());
      source = "groups";
    } else {
      keys = null;
      source = "default";
    }
  }
  if (keys !== null && keys.has(ALL_KEY)) keys = null;
  let gestion: boolean;
  let sourceGestion: string;
  if (up.can_manage_models !== null && up.can_manage_models !== undefined) {
    gestion = veritePy(up.can_manage_models);
    sourceGestion = "user";
  } else {
    const vals = groupes
      .filter((g) => g.can_manage_models !== null && g.can_manage_models !== undefined)
      .map((g) => veritePy(g.can_manage_models));
    if (vals.length > 0) {
      gestion = vals.some((v) => v);
      sourceGestion = "groups";
    } else {
      gestion = true;
      sourceGestion = "default";
    }
  }
  return {
    engine_keys: keys,
    engine_source: source,
    can_manage_models: gestion,
    manage_source: sourceGestion,
  };
}

/** Rôle, politique propre et politiques des groupes, en cache 3 s (et jusqu'au prochain changement d'empreinte) ; `null` sur erreur de lecture. */
async function chargerContexte(base: Executeur, uid: number): Promise<Contexte | null> {
  const t = performance.now() / 1000;
  const empreinte = empreinteCourante();
  const cache = cacheDe(base);
  const hit = cache.get(uid);
  if (hit !== undefined && t - hit.t < reglagesAcces.ttlS && hit.empreinte === empreinte) return hit.ctx;
  let lignes: unknown[][];
  let isAdmin: boolean;
  try {
    const role = await base.valeurs("SELECT is_admin FROM users WHERE id=?", [uid]);
    isAdmin = role[0] !== undefined && role[0][0] === 1;
    lignes = await base.valeurs(
      "SELECT principal_type, engine_keys, can_manage_models FROM llm_engine_policies " +
        "WHERE (principal_type='user' AND principal_id=?) OR (principal_type='group' AND principal_id IN " +
        "(SELECT group_id FROM user_groups WHERE user_id=?))",
      [uid, uid],
    );
  } catch (e) {
    avertir(
      `[engine_access] lecture des politiques impossible (${String(e)}) — accès refusé hors administrateur`,
    );
    return null;
  }
  let user: Politique | null = null;
  const groups: Politique[] = [];
  for (const r of lignes) {
    const pol = decodeRow(r[1], r[2]);
    if (r[0] === "user") user = pol;
    else groups.push(pol);
  }
  const ctx: Contexte = { is_admin: isAdmin, user, groups };
  cache.set(uid, { t, empreinte, ctx });
  return ctx;
}

function uidOuNul(userId: unknown): number | null {
  try {
    return intPy(userId);
  } catch {
    return null;
  }
}

function resoudre(ctx: Contexte | null, isAdmin: boolean | null | undefined): Acces {
  if (ctx === null) return resolveAccess(null, [], { isAdmin: veritePy(isAdmin) });
  const admin = isAdmin === null || isAdmin === undefined ? ctx.is_admin : veritePy(isAdmin);
  return resolveAccess(ctx.user, ctx.groups, { isAdmin: admin });
}

/** Politiques illisibles pour un compte non administrateur : aucun serveur, pas de gestion des modèles. */
const ACCES_REFUSE: Acces = {
  engine_keys: new Set<string>(),
  engine_source: "unreadable",
  can_manage_models: false,
  manage_source: "unreadable",
};

async function resolu(base: Executeur, userId: unknown, isAdmin?: boolean | null): Promise<Acces> {
  const uid = uidOuNul(userId);
  if (uid === null) return resoudre(null, isAdmin);
  const ctx = await chargerContexte(base, uid);
  if (ctx === null && isAdmin !== true) return ACCES_REFUSE;
  return resoudre(ctx, isAdmin);
}

/** Clés autorisées pour ce compte ; `null` = tous les serveurs. */
export async function effectiveEngineKeys(
  base: Executeur,
  userId: unknown,
  options: { isAdmin?: boolean | null } = {},
): Promise<ReadonlySet<string> | null> {
  return (await resolu(base, userId, options.isAdmin)).engine_keys;
}

export async function canManageModels(
  base: Executeur,
  userId: unknown,
  options: { isAdmin?: boolean | null } = {},
): Promise<boolean> {
  return (await resolu(base, userId, options.isAdmin)).can_manage_models;
}

/** Politiques ou connecteur illisibles : le contrôle d'accès n'a pas pu conclure (panne transitoire, pas un refus). */
export class PolitiquesIllisibles extends Error {
  constructor(detail: string) {
    super(`contrôle d'accès au moteur impossible : ${detail}`);
    this.name = "PolitiquesIllisibles";
  }
}

/** Ce compte peut-il utiliser ce moteur (lève `PolitiquesIllisibles` si la lecture échoue) ? Connecteur personnel : son propriétaire seul ; sinon la politique (`enabled` ignoré). */
export async function canUseEngine(
  base: Executeur,
  userId: unknown,
  key: unknown,
  options: { isAdmin?: boolean | null } = {},
): Promise<boolean> {
  const p = parseKey(key);
  if (p === null) return false;
  if (p[0] === "conn") {
    let portee: [unknown, number | null] | null;
    try {
      const r = await base.valeurs("SELECT scope, owner_user_id FROM llm_connectors WHERE id=?", [p[1]]);
      const ligne = r[0];
      portee = ligne === undefined ? null : [ligne[0], ligne[1] === null ? null : intPy(ligne[1])];
    } catch (e) {
      avertir(`[engine_access] lecture du connecteur ${p[1]} impossible (${String(e)})`);
      throw new PolitiquesIllisibles(`connecteur ${p[1]} illisible`);
    }
    if (portee === null) return false;
    const [scope, owner] = portee;
    if (scope === "user") return owner !== null && uidOuNul(userId) === owner;
    if (scope !== "shared") return false;
  }
  const uid = uidOuNul(userId);
  const ctx = uid === null ? null : await chargerContexte(base, uid);
  if (ctx === null && options.isAdmin !== true) {
    avertir("[engine_access] politiques illisibles");
    throw new PolitiquesIllisibles("politiques illisibles");
  }
  const keys = resoudre(ctx, options.isAdmin).engine_keys;
  return keys === null || keys.has(stripPy(key as string));
}

/** `canUseEngine` pour une route : un contrôle qui n'a pas pu conclure rend 503 `access_check_failed` (à réessayer), ni 500 ni refus. */
export async function exigerMoteurOuvert(base: Executeur, userId: unknown, key: unknown): Promise<boolean> {
  try {
    return await canUseEngine(base, userId, key);
  } catch (e) {
    log.warn(`[engine_access] contrôle d'accès au moteur impossible (${String(e)}) — refus`);
    throw new HttpError(503, {
      code: "engine_unavailable",
      reason: "access_check_failed",
      message: "Contrôle d'accès au serveur indisponible, réessayez.",
    });
  }
}

/** Filtre de connecteurs publics : les personnels du compte passent, les partagés selon la politique. */
export async function filterSharedConnectors(
  base: Executeur,
  userId: unknown,
  rows: readonly Dict[] | null | undefined,
  options: { isAdmin?: boolean | null } = {},
): Promise<Dict[]> {
  const keys = await effectiveEngineKeys(base, userId, options);
  return filtrerConnecteurs(keys, userId, rows);
}

/** Cœur pur du filtre (vecteurs). */
export function filtrerConnecteurs(
  keys: ReadonlySet<string> | null,
  userId: unknown,
  rows: readonly Dict[] | null | undefined,
): Dict[] {
  const out: Dict[] = [];
  for (const r of rows ?? []) {
    const scope = Object.hasOwn(r, "scope") ? r["scope"] : null;
    if (scope === "user") {
      const owner = Object.hasOwn(r, "owner_user_id") ? r["owner_user_id"] : null;
      if (owner === null || owner === undefined) out.push(r);
      else {
        const a = uidOuNul(owner);
        const b = uidOuNul(userId);
        if (a !== null && b !== null && a === b) out.push(r);
      }
      continue;
    }
    if (keys === null || keys.has(connectorKey(Object.hasOwn(r, "id") ? r["id"] : null))) out.push(r);
  }
  return out;
}

// ── Vues d'administration ────────────────────────────────────────────────────

/** Serveurs proposables dans une liste : l'intégré puis les connecteurs PARTAGÉS. */
export async function listEngineOptions(base: Executeur): Promise<Dict[]> {
  const out: Dict[] = [
    {
      key: BUILTIN_KEY,
      label: "Serveur intégré",
      kind: "builtin",
      provider_type: config.LLAMA_PROVIDER_TYPE || "llamacpp",
      enabled: true,
    },
  ];
  for (const c of await listSharedConnectors(base)) {
    out.push({
      key: connectorKey(c["id"]),
      label: veritePy(c["label"])
        ? c["label"]
        : veritePy(c["provider_type"])
          ? c["provider_type"]
          : `Connecteur ${String(c["id"])}`,
      kind: "connector",
      provider_type: veritePy(c["provider_type"]) ? c["provider_type"] : "",
      base_url: veritePy(c["base_url"]) ? c["base_url"] : "",
      enabled: veritePy(c["enabled"]),
    });
  }
  return out;
}

/** `_json_keys` : ordre donné d'abord, puis le reste trié ; `null` = tous. */
export function jsonKeys(
  keys: ReadonlySet<string> | null,
  ordre?: readonly string[] | null,
): string[] | null {
  if (keys === null) return null;
  if (ordre && ordre.length > 0)
    return [
      ...ordre.filter((k) => keys.has(k)),
      ...[...keys].filter((k) => !ordre.includes(k)).sort(comparePointsDeCode),
    ];
  return [...keys].sort(comparePointsDeCode);
}

/** `describe_users` sur des politiques déjà lues (une seule requête pour tous les comptes). */
export function decrireComptes(users: Dict[], politiques: ReadonlyMap<string, Politique>): void {
  for (const u of users) {
    const own = politiques.get(`user:${intPy(u["id"])}`) ?? { engine_keys: null, can_manage_models: null };
    const ids = veritePy(u["group_ids"]) ? (u["group_ids"] as unknown[]) : [];
    const groups = ids
      .map((g) => politiques.get(`group:${intPy(g)}`))
      .filter((g): g is Politique => g !== undefined);
    const res = resolveAccess(own, groups, { isAdmin: u["is_admin"] === 1 || u["is_admin"] === true });
    u["llm_engine_keys"] = own.engine_keys;
    u["llm_can_manage_models"] = own.can_manage_models;
    u["llm_effective_engine_keys"] = jsonKeys(res.engine_keys);
    u["llm_engine_source"] = res.engine_source;
    u["llm_effective_can_manage_models"] = res.can_manage_models;
    u["llm_manage_source"] = res.manage_source;
  }
}

/** Complète EN PLACE les lignes de `/api/admin/users-with-groups` ; politiques illisibles = aucune. */
export async function describeUsers(base: Executeur, users: Dict[]): Promise<void> {
  let politiques: Map<string, Politique>;
  try {
    politiques = await listPolicies(base);
  } catch (e) {
    avertir(`[engine_access] politiques illisibles pour la vue admin (${String(e)})`);
    politiques = new Map();
  }
  decrireComptes(users, politiques);
}

// ── Port du moteur (filtre des diffusions `model_status`, synchrone) ─────────

/** Réponse synchrone depuis le contexte en cache (frais ou non) ; absent : rechargé en tâche de fond, ouvert d'ici là. */
export function peutUtiliserMoteurEnCache(base: Executeur, userId: unknown, key: unknown): boolean {
  const p = parseKey(key);
  if (p === null) return false;
  const uid = uidOuNul(userId);
  if (uid === null) return true;
  const hit = cacheDe(base).get(uid);
  const frais =
    hit !== undefined &&
    performance.now() / 1000 - hit.t < reglagesAcces.ttlS &&
    hit.empreinte === empreinteCourante();
  if (!frais) {
    let attente = enCours.get(base);
    if (attente === undefined) {
      attente = new Map();
      enCours.set(base, attente);
    }
    const file = attente;
    if (!file.has(uid))
      file.set(
        uid,
        chargerContexte(base, uid).finally(() => file.delete(uid)),
      );
  }
  if (hit === undefined || p[0] === "conn") return true;
  const keys = resoudre(hit.ctx, null).engine_keys;
  return keys === null || keys.has(stripPy(key as string));
}

export function portAccesMoteurs(base: Executeur): PortAccesMoteurs {
  return { peutUtiliserMoteur: (uid, cle) => peutUtiliserMoteurEnCache(base, uid, cle) };
}
