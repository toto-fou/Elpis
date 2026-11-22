// SPDX-License-Identifier: MIT
/** apps/core/src/ops/securite-gardee.ts — sécurité des comptes gardée à travers une remise de la base (retour de mise à jour, remise à la main) : état vivant lu avant la remise (comptes, suspensions, identités externes, rattachements préparés, fournisseurs testés, adhésions aux groupes, accès aux moteurs et aux collections, profil réseau imposé, jetons, sessions révoquées, sections `security` et `auth` de config.json), reporté sur la base remise sans toucher à son schéma, sessions coupées, administrateurs locaux restants comptés. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import Database from "better-sqlite3";

import {
  aMotDePasseLocal,
  CLAUSE_MOT_DE_PASSE_LOCAL,
  compteSuspendu,
  MOT_DE_PASSE_VERROUILLE,
  reglagesDepuis,
  reglagesEnJson,
} from "@elpis/auth";
import { floatPy, pyJsonDumps, pyJsonLoads, versFlottantPy } from "@elpis/commun";
import { writeTextAtomic } from "@elpis/config";
import { ouvrirBase } from "@elpis/db";
import type { Executeur, Parametres, ReglagesBase } from "@elpis/db";
import { avecVerrou, cheminVerrou } from "@elpis/verrous";

/** Requêtes sur la base vivante ou remise, quel que soit le moteur. */
export interface Requetes {
  readonly dialecte: "sqlite" | "postgres";
  tous<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  executer(sql: string, params?: readonly unknown[]): Promise<number>;
}

/** Administrateur qui mène l'opération depuis la console : seule sa session ouverte à `depuis` (secondes) reste valide. */
export interface Operateur {
  readonly id: number;
  readonly depuis: number;
}

/** Ligne lue telle quelle ; une colonne absente de la base lue n'a pas de clé. */
export type LigneGardee = Record<string, string | number | null>;

/** Ce qui fait foi pour la sécurité, lu sur la base vivante juste avant la remise ; une table absente de ce côté-là est vide. */
export interface EtatSecurite {
  comptes: LigneGardee[];
  jetonsOutils: number[];
  /** Accès OAuth : révocation et consommation (`used_at`, absent si la colonne manque) d'un jeton de rafraîchissement. */
  jetonsOauth: { id: number; revoked_at: number | null; used_at?: number | null }[];
  sessionsRevoquees: LigneGardee[];
  identites: LigneGardee[];
  rattachementsPrepares: LigneGardee[];
  fournisseurs: LigneGardee[];
  /** Adhésions aux groupes ; `null` : table absente de la base vivante (rien n'est alors reporté). */
  adhesions: { user_id: number; group_id: number }[] | null;
  /** Identifiants des groupes ; `null` : table absente. */
  groupes: number[] | null;
  /** Accès aux moteurs (`llm_engine_policies`) ; `null` : table absente. */
  politiquesMoteurs: LigneGardee[] | null;
  /** Accès aux collections (`rag_grants`) ; `null` : table absente. */
  accesCollections: LigneGardee[] | null;
  /** Profil réseau imposé par un administrateur (`forced_network_profile_id` de `settings_json`), comptes qui en ont un ; `null` : colonne absente. */
  profilsImposes: { id: number; profil: string }[] | null;
}

/** Ce que le report ne sait pas seul : profils réseau connus de la configuration remise (un profil imposé inconnu devient « isolated »). */
export interface OptionsReport {
  readonly profilsReseau?: ReadonlySet<string>;
}

/** Comptes reportés (même identifiant, même nom des deux côtés), noms verrouillés ou suspendus par le report, administrateurs actifs à mot de passe local restants (0 : console fermée à tous). */
export interface BilanReport {
  reportes: number;
  verrouilles: string[];
  adminsLocaux: number;
}

export { MOT_DE_PASSE_VERROUILLE };

const COLONNES_COMPTE = [
  "id",
  "username",
  "pass_salt",
  "pass_hash",
  "is_admin",
  "must_change_pwd",
  "session_min_ts",
  "suspended_at",
  "suspended_by",
] as const;
const COLONNES_REPORTEES = [
  "pass_salt",
  "pass_hash",
  "is_admin",
  "must_change_pwd",
  "suspended_at",
  "suspended_by",
] as const;
const COLONNES_REVOCATION = ["sid", "user_id", "revoked_at", "expires_at"] as const;

/** Mise à jour d'une colonne d'un compte, ordre écrit en clair (jamais le nom, jamais une colonne variable). */
const MAJ_COMPTE = {
  pass_salt: "UPDATE users SET pass_salt = ? WHERE id = ?",
  pass_hash: "UPDATE users SET pass_hash = ? WHERE id = ?",
  is_admin: "UPDATE users SET is_admin = ? WHERE id = ?",
  must_change_pwd: "UPDATE users SET must_change_pwd = ? WHERE id = ?",
  session_min_ts: "UPDATE users SET session_min_ts = ? WHERE id = ?",
  suspended_at: "UPDATE users SET suspended_at = ? WHERE id = ?",
  suspended_by: "UPDATE users SET suspended_by = ? WHERE id = ?",
} as const;
type ValeursCompte = Partial<Record<keyof typeof MAJ_COMPTE, string | number | null>>;

/** Ordres de remise des tables du SSO, tables écrites en clair. */
const REMISE = {
  user_identities: { vider: "DELETE FROM user_identities", inserer: "INSERT INTO user_identities" },
  auth_prelinks: { vider: "DELETE FROM auth_prelinks", inserer: "INSERT INTO auth_prelinks" },
  auth_provider_state: {
    vider: "DELETE FROM auth_provider_state",
    inserer: "INSERT INTO auth_provider_state",
  },
} as const;
type TableRemise = keyof typeof REMISE;
const TABLES_VUES = [
  "users",
  "tool_tokens",
  "oauth_tokens",
  "revoked_sessions",
  "user_identities",
  "auth_prelinks",
  "auth_provider_state",
  "user_groups",
  "groups",
  "oauth_codes",
  "llm_engine_policies",
  "rag_grants",
  "rag_collections",
  "sqlite_sequence",
] as const;
type Schema = ReadonlyMap<string, ReadonlySet<string>>;

const nombre = (v: unknown): number => Number(v ?? 0);
const AUCUNE: ReadonlySet<string> = new Set();

const plusGrand = (ids: Iterable<number>): number => {
  let m = 0;
  for (const id of ids) if (id > m) m = id;
  return m;
};

/** Tables vues par la sécurité et leurs colonnes, lues sans rien y changer. */
async function lireSchema(r: Requetes): Promise<Schema> {
  const liste = TABLES_VUES.map(() => "?").join(", ");
  const lignes = await r.tous<{ t: unknown; c: unknown }>(
    r.dialecte === "sqlite"
      ? `SELECT m.name AS t, p.name AS c FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name IN (${liste})`
      : `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN (${liste})`,
    TABLES_VUES,
  );
  const s = new Map<string, Set<string>>();
  for (const l of lignes) {
    const t = String(l.t);
    const cols = s.get(t) ?? new Set<string>();
    cols.add(String(l.c));
    s.set(t, cols);
  }
  return s;
}

/** Sessions d'avant `ts` refusées pour chaque compte ; l'opérateur ne garde que la session ouverte à `depuis` (et les suivantes). */
export async function couperSessions(r: Requetes, ts: number, op: Operateur | null): Promise<void> {
  if (!(await lireSchema(r)).get("users")?.has("session_min_ts")) return;
  const garde = "(session_min_ts IS NULL OR session_min_ts < ?)";
  await r.executer(`UPDATE users SET session_min_ts = ? WHERE ${garde} AND id <> ?`, [ts, ts, op?.id ?? -1]);
  if (op)
    await r.executer(`UPDATE users SET session_min_ts = ? WHERE ${garde} AND id = ?`, [
      op.depuis,
      op.depuis,
      op.id,
    ]);
}

/** Lignes de `table` (colonnes présentes seulement, `*` sans liste) ; table absente : aucune. */
async function lignes(
  r: Requetes,
  s: Schema,
  table: string,
  ordre: string,
  colonnes?: readonly string[],
): Promise<LigneGardee[]> {
  const presentes = s.get(table);
  if (!presentes) return [];
  const liste = colonnes ? colonnes.filter((c) => presentes.has(c)).join(", ") : "*";
  return r.tous<LigneGardee>(`SELECT ${liste} FROM ${table} ORDER BY ${ordre}`);
}

/** État de sécurité de la base vivante. */
export async function lireSecurite(r: Requetes): Promise<EtatSecurite> {
  const s = await lireSchema(r);
  if (!s.has("users")) throw new Error("table users absente : ce n'est pas une base d'Elpis");
  return {
    comptes: await lignes(r, s, "users", "id", COLONNES_COMPTE),
    jetonsOutils: (await lignes(r, s, "tool_tokens", "id", ["id"])).map((x) => nombre(x["id"])),
    jetonsOauth: s.get("oauth_tokens")?.has("revoked_at")
      ? (await lignes(r, s, "oauth_tokens", "id", ["id", "revoked_at", "used_at"])).map((x) => ({
          id: nombre(x["id"]),
          revoked_at: horodatage(x["revoked_at"]),
          ...(Object.hasOwn(x, "used_at") ? { used_at: horodatage(x["used_at"]) } : {}),
        }))
      : [],
    sessionsRevoquees: await lignes(r, s, "revoked_sessions", "sid", COLONNES_REVOCATION),
    identites: await lignes(r, s, "user_identities", "id"),
    rattachementsPrepares: await lignes(r, s, "auth_prelinks", "id"),
    fournisseurs: await lignes(r, s, "auth_provider_state", "provider_id"),
    adhesions: s.has("user_groups")
      ? (await lignes(r, s, "user_groups", "user_id, group_id", ["user_id", "group_id"])).map((x) => ({
          user_id: nombre(x["user_id"]),
          group_id: nombre(x["group_id"]),
        }))
      : null,
    groupes: s.has("groups")
      ? (await lignes(r, s, "groups", "id", ["id"])).map((x) => nombre(x["id"]))
      : null,
    politiquesMoteurs: s.has("llm_engine_policies")
      ? await lignes(r, s, "llm_engine_policies", "principal_type, principal_id")
      : null,
    accesCollections: s.has("rag_grants")
      ? await lignes(r, s, "rag_grants", "collection_id, principal_type, principal_id")
      : null,
    profilsImposes: s.get("users")?.has("settings_json") ? await lireProfilsImposes(r) : null,
  };
}

const horodatage = (v: unknown): number | null => (v === null || v === undefined ? null : nombre(v));
const CLE_PROFIL_IMPOSE = "forced_network_profile_id";

/** Profil réseau imposé de chaque compte qui en a un (réglages illisibles : aucun). */
async function lireProfilsImposes(r: Requetes): Promise<{ id: number; profil: string }[]> {
  const out: { id: number; profil: string }[] = [];
  for (const l of await r.tous<{ id: unknown; settings_json: unknown }>(
    "SELECT id, settings_json FROM users ORDER BY id",
  )) {
    const p = reglagesDepuis(l.settings_json)[CLE_PROFIL_IMPOSE];
    if (typeof p === "string" && p.trim()) out.push({ id: nombre(l.id), profil: p.trim() });
  }
  return out;
}

/** Colonnes données du compte mises à jour une à une. */
async function majCompte(r: Requetes, id: number, valeurs: ValeursCompte): Promise<void> {
  for (const [c, v] of Object.entries(valeurs) as [keyof typeof MAJ_COMPTE, string | number | null][])
    await r.executer(MAJ_COMPTE[c], [v, id]);
}

/** Table remise exactement aux lignes vivantes que retient `garder`, colonnes communes aux deux côtés, compteur poussé au-delà de toutes ; absente de la base remise : rien. */
async function remettreTable(
  r: Requetes,
  s: Schema,
  table: TableRemise,
  vivantes: LigneGardee[],
  garder: (l: LigneGardee) => boolean = () => true,
): Promise<void> {
  const presentes = s.get(table);
  if (!presentes) return;
  await r.executer(REMISE[table].vider);
  for (const l of vivantes.filter(garder)) {
    const cols = Object.keys(l).filter((c) => presentes.has(c));
    await r.executer(
      `${REMISE[table].inserer} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      cols.map((c) => l[c]),
    );
  }
  if (presentes.has("id"))
    await pousserCompteur(r, s, table, plusGrand(vivantes.map((l) => nombre(l["id"]))));
}

/** Comptes de la base remise : gardés (même id, même nom) mis à l'état vivant, les autres verrouillés et suspendus ; sans colonne de suspension, un compte suspendu est verrouillé (son mot de passe local le rouvrirait) ; rend les gardés, les noms verrouillés et les comptes suspendus que la base ne sait pas suspendre. */
async function reporterComptes(
  r: Requetes,
  s: Schema,
  e: EtatSecurite,
  ts: number,
): Promise<{ gardes: Set<number>; verrouilles: string[]; sansSuspension: number[] }> {
  const cu = s.get("users") ?? AUCUNE;
  const vivants = new Map(e.comptes.map((c) => [nombre(c["id"]), c]));
  const gardes = new Set<number>();
  const verrouilles: string[] = [];
  const sansSuspension: number[] = [];
  const coupure = cu.has("session_min_ts");
  for (const c of await r.tous<LigneGardee>(
    `SELECT id, username${coupure ? ", session_min_ts" : ""} FROM users ORDER BY id`,
  )) {
    const id = nombre(c["id"]);
    const v = vivants.get(id);
    const valeurs: ValeursCompte = {};
    if (v !== undefined && v["username"] === c["username"]) {
      gardes.add(id);
      for (const k of COLONNES_REPORTEES) if (cu.has(k) && Object.hasOwn(v, k)) valeurs[k] = v[k] ?? null;
      if (coupure)
        valeurs["session_min_ts"] = Math.max(nombre(v["session_min_ts"]), nombre(c["session_min_ts"]));
      if (!cu.has("suspended_at") && compteSuspendu(v)) {
        if (aMotDePasseLocal(v)) valeurs["pass_hash"] = MOT_DE_PASSE_VERROUILLE;
        if (coupure) valeurs["session_min_ts"] = Math.max(nombre(valeurs["session_min_ts"]), ts);
        verrouilles.push(String(c["username"]));
        sansSuspension.push(id);
      }
    } else {
      valeurs["pass_hash"] = MOT_DE_PASSE_VERROUILLE;
      if (coupure) valeurs["session_min_ts"] = Math.max(ts, nombre(c["session_min_ts"]));
      if (cu.has("suspended_by")) valeurs["suspended_by"] = "admin";
      verrouilles.push(String(c["username"]));
    }
    await majCompte(r, id, valeurs);
    if (!gardes.has(id) && cu.has("suspended_at"))
      await r.executer(
        "UPDATE users SET suspended_at = ? WHERE id = ? AND (suspended_at IS NULL OR suspended_at = 0)",
        [ts, id],
      );
  }
  await pousserCompteur(r, s, "users", plusGrand(vivants.keys()));
  return { gardes, verrouilles, sansSuspension };
}

/** Jetons d'API absents de l'état vivant supprimés, accès OAuth révoqués depuis (ou inconnus) révoqués, consommés depuis marqués consommés, codes OAuth en attente supprimés, comptes de `sansAcces` privés de tout jeton, sessions révoquées ajoutées, compteurs poussés. */
async function reporterJetons(
  r: Requetes,
  s: Schema,
  e: EtatSecurite,
  ts: number,
  sansAcces: readonly number[],
): Promise<void> {
  if (s.has("tool_tokens")) {
    const outils = new Set(e.jetonsOutils);
    for (const j of await r.tous<{ id: unknown }>("SELECT id FROM tool_tokens"))
      if (!outils.has(nombre(j.id))) await r.executer("DELETE FROM tool_tokens WHERE id = ?", [nombre(j.id)]);
    for (const uid of sansAcces) await r.executer("DELETE FROM tool_tokens WHERE user_id = ?", [uid]);
    await pousserCompteur(r, s, "tool_tokens", plusGrand(e.jetonsOutils));
  }
  const co = s.get("oauth_tokens");
  if (co?.has("revoked_at")) {
    const oauth = new Map(e.jetonsOauth.map((j) => [j.id, j]));
    const consommation = co.has("used_at");
    for (const j of await r.tous<{ id: unknown; revoked_at: unknown; used_at?: unknown }>(
      `SELECT id, revoked_at${consommation ? ", used_at" : ""} FROM oauth_tokens`,
    )) {
      const id = nombre(j.id);
      const vivant = oauth.get(id);
      const revoque = vivant === undefined ? ts : vivant.revoked_at;
      if (revoque !== null && j.revoked_at === null)
        await r.executer("UPDATE oauth_tokens SET revoked_at = ? WHERE id = ?", [revoque, id]);
      const consomme = vivant?.used_at ?? null;
      if (consommation && consomme !== null && (j.used_at === null || j.used_at === undefined))
        await r.executer("UPDATE oauth_tokens SET used_at = ? WHERE id = ?", [consomme, id]);
    }
    for (const uid of sansAcces)
      await r.executer("UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [
        ts,
        uid,
      ]);
    await pousserCompteur(r, s, "oauth_tokens", plusGrand(e.jetonsOauth.map((j) => j.id)));
  }
  if (s.has("oauth_codes")) await r.executer("DELETE FROM oauth_codes");
  const cr = s.get("revoked_sessions");
  if (cr)
    for (const l of e.sessionsRevoquees) {
      const cols = COLONNES_REVOCATION.filter((c) => cr.has(c) && Object.hasOwn(l, c));
      await r.executer(
        `INSERT INTO revoked_sessions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(sid) DO NOTHING`,
        cols.map((c) => l[c]),
      );
    }
}

/** Adhésions des comptes gardés remises à l'état vivant, limitées aux groupes de la base remise ; table absente d'un côté : rien. */
async function reporterAdhesions(
  r: Requetes,
  s: Schema,
  vivantes: EtatSecurite["adhesions"],
  gardes: ReadonlySet<number>,
): Promise<void> {
  if (vivantes === null || !s.has("user_groups")) return;
  const groupes = new Set(
    s.has("groups") ? (await r.tous<{ id: unknown }>("SELECT id FROM groups")).map((g) => nombre(g.id)) : [],
  );
  for (const uid of gardes) await r.executer("DELETE FROM user_groups WHERE user_id = ?", [uid]);
  for (const a of vivantes)
    if (gardes.has(a.user_id) && groupes.has(a.group_id))
      await r.executer("INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)", [a.user_id, a.group_id]);
}

/** Principal gardé d'une ligne d'accès : compte gardé, ou groupe présent des deux côtés. */
type Garde = (type: unknown, id: unknown) => boolean;

/** Accès aux moteurs des comptes et groupes gardés remis à l'état vivant ; table absente d'un côté : rien. */
async function reporterPolitiques(
  r: Requetes,
  s: Schema,
  vivantes: LigneGardee[] | null,
  garde: Garde,
): Promise<void> {
  const cols = s.get("llm_engine_policies");
  if (vivantes === null || !cols) return;
  for (const l of await r.tous<{ principal_type: unknown; principal_id: unknown }>(
    "SELECT principal_type, principal_id FROM llm_engine_policies",
  ))
    if (garde(l.principal_type, l.principal_id))
      await r.executer("DELETE FROM llm_engine_policies WHERE principal_type = ? AND principal_id = ?", [
        l.principal_type,
        l.principal_id,
      ]);
  for (const l of vivantes)
    if (garde(l["principal_type"], l["principal_id"])) await inserer(r, "llm_engine_policies", cols, l);
}

/** Accès aux collections des comptes et groupes gardés remis à l'état vivant, limités aux collections de la base remise ; table absente d'un côté : rien. */
async function reporterAccesCollections(
  r: Requetes,
  s: Schema,
  vivantes: LigneGardee[] | null,
  garde: Garde,
): Promise<void> {
  const cols = s.get("rag_grants");
  if (vivantes === null || !cols) return;
  const collections = new Set(
    s.has("rag_collections")
      ? (await r.tous<{ id: unknown }>("SELECT id FROM rag_collections")).map((c) => String(c.id))
      : [],
  );
  for (const l of await r.tous<{ collection_id: unknown; principal_type: unknown; principal_id: unknown }>(
    "SELECT collection_id, principal_type, principal_id FROM rag_grants",
  ))
    if (garde(l.principal_type, l.principal_id))
      await r.executer(
        "DELETE FROM rag_grants WHERE collection_id = ? AND principal_type = ? AND principal_id = ?",
        [l.collection_id, l.principal_type, l.principal_id],
      );
  for (const l of vivantes)
    if (garde(l["principal_type"], l["principal_id"]) && collections.has(String(l["collection_id"])))
      await inserer(r, "rag_grants", cols, l);
}

/** Ordres d'insertion des tables d'accès, tables écrites en clair. */
const INSERTION_ACCES = {
  llm_engine_policies: "INSERT INTO llm_engine_policies",
  rag_grants: "INSERT INTO rag_grants",
} as const;

/** Ligne vivante insérée, colonnes communes aux deux côtés. */
async function inserer(
  r: Requetes,
  table: keyof typeof INSERTION_ACCES,
  presentes: ReadonlySet<string>,
  l: LigneGardee,
): Promise<void> {
  const cols = Object.keys(l).filter((c) => presentes.has(c));
  await r.executer(
    `${INSERTION_ACCES[table]} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    cols.map((c) => l[c]),
  );
}

/** Profil réseau imposé des comptes gardés remis à l'état vivant (seule cette clé des réglages) ; un profil inconnu de la configuration remise devient « isolated ». */
async function reporterProfilsImposes(
  r: Requetes,
  s: Schema,
  vivants: EtatSecurite["profilsImposes"],
  gardes: ReadonlySet<number>,
  profils: ReadonlySet<string> | undefined,
): Promise<void> {
  if (vivants === null || !s.get("users")?.has("settings_json")) return;
  const imposes = new Map(vivants.map((v) => [v.id, v.profil]));
  for (const l of await r.tous<{ id: unknown; settings_json: unknown }>(
    "SELECT id, settings_json FROM users",
  )) {
    const id = nombre(l.id);
    if (!gardes.has(id)) continue;
    const reglages = reglagesDepuis(l.settings_json);
    const actuel =
      typeof reglages[CLE_PROFIL_IMPOSE] === "string" ? String(reglages[CLE_PROFIL_IMPOSE]).trim() : "";
    let voulu = imposes.get(id) ?? "";
    if (voulu && profils !== undefined && !profils.has(voulu)) voulu = "isolated";
    if (voulu === actuel) continue;
    if (voulu) reglages[CLE_PROFIL_IMPOSE] = voulu;
    else delete reglages[CLE_PROFIL_IMPOSE];
    await r.executer("UPDATE users SET settings_json = ? WHERE id = ?", [reglagesEnJson(reglages), id]);
  }
}

/** Administrateurs actifs à mot de passe local (règle de l'invariant, `CLAUSE_MOT_DE_PASSE_LOCAL`), colonnes absentes tenues pour telles. */
async function compterAdminsLocauxRemis(r: Requetes): Promise<number> {
  const cu = (await lireSchema(r)).get("users") ?? AUCUNE;
  if (!cu.has("is_admin")) return 0;
  const actif = cu.has("suspended_at") ? " AND (suspended_at IS NULL OR suspended_at = 0)" : "";
  const [l] = await r.tous<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND ${CLAUSE_MOT_DE_PASSE_LOCAL}${actif}`,
  );
  return nombre(l?.n);
}

/** Tables de la base cible où une ligne est plus récente que `ts` (compte, identité, jeton) : une base qui n'est pas une copie plus ancienne ; colonnes absentes ignorées. */
export async function plusRecentQue(r: Requetes, ts: number): Promise<string[]> {
  const s = await lireSchema(r);
  const out: string[] = [];
  for (const [table, colonne, sql] of [
    ["users", "created_at", "SELECT 1 AS un FROM users WHERE created_at > ? LIMIT 1"],
    ["user_identities", "linked_at", "SELECT 1 AS un FROM user_identities WHERE linked_at > ? LIMIT 1"],
    ["tool_tokens", "created_at", "SELECT 1 AS un FROM tool_tokens WHERE created_at > ? LIMIT 1"],
    ["oauth_tokens", "created_at", "SELECT 1 AS un FROM oauth_tokens WHERE created_at > ? LIMIT 1"],
  ] as const)
    if (s.get(table)?.has(colonne) && (await r.tous(sql, [ts])).length > 0) out.push(table);
  return out;
}

/** Sur la base remise, dans la transaction de l'appelant : report de l'état vivant `e` (s'il a pu être lu), puis coupure des sessions ; le schéma n'est jamais touché ; rend le bilan. */
export async function reporterSecurite(
  r: Requetes,
  e: EtatSecurite | null,
  ts: number,
  op: Operateur | null,
  options: OptionsReport = {},
): Promise<BilanReport> {
  let bilan = { reportes: 0, verrouilles: [] as string[] };
  if (e !== null) {
    const s = await lireSchema(r);
    if (!s.has("users")) throw new Error("table users absente : ce n'est pas une base d'Elpis");
    const { gardes, verrouilles, sansSuspension } = await reporterComptes(r, s, e, ts);
    await reporterJetons(r, s, e, ts, sansSuspension);
    const deGarde = (l: LigneGardee): boolean => gardes.has(nombre(l["user_id"]));
    await remettreTable(r, s, "user_identities", e.identites, deGarde);
    await remettreTable(r, s, "auth_prelinks", e.rattachementsPrepares, deGarde);
    await remettreTable(r, s, "auth_provider_state", e.fournisseurs);
    await reporterAdhesions(r, s, e.adhesions, gardes);
    const groupesRemis = new Set(
      s.has("groups")
        ? (await r.tous<{ id: unknown }>("SELECT id FROM groups")).map((g) => nombre(g.id))
        : [],
    );
    const groupesGardes = new Set((e.groupes ?? []).filter((g) => groupesRemis.has(g)));
    const garde: Garde = (type, id) =>
      type === "user" ? gardes.has(nombre(id)) : type === "group" && groupesGardes.has(nombre(id));
    await reporterPolitiques(r, s, e.politiquesMoteurs, garde);
    await reporterAccesCollections(r, s, e.accesCollections, garde);
    await reporterProfilsImposes(r, s, e.profilsImposes, gardes, options.profilsReseau);
    bilan = { reportes: gardes.size, verrouilles };
  }
  await couperSessions(r, ts, op);
  return { ...bilan, adminsLocaux: await compterAdminsLocauxRemis(r) };
}

/** Les prochaines lignes de `table` ne reprennent aucun identifiant déjà donné (une vieille session ne vaut pas pour un compte neuf). */
async function pousserCompteur(
  r: Requetes,
  s: Schema,
  table: "users" | "tool_tokens" | "oauth_tokens" | TableRemise,
  maxId: number,
): Promise<void> {
  if (maxId <= 0) return;
  if (r.dialecte === "sqlite") {
    if (!s.has("sqlite_sequence")) return;
    await r.executer(
      "INSERT INTO sqlite_sequence (name, seq) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)",
      [table, maxId, table],
    );
    await r.executer("UPDATE sqlite_sequence SET seq = ? WHERE name = ? AND seq < ?", [maxId, table, maxId]);
    return;
  }
  await r.tous(
    `SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST(CAST(? AS BIGINT), (SELECT COALESCE(MAX(id), 1) FROM ${table})))`,
    [maxId],
  );
}

/** Requêtes sur une connexion better-sqlite3 (synchrones, rendues en promesses). */
export function requetesSqlite(db: Database.Database): Requetes {
  return {
    dialecte: "sqlite",
    tous: <T>(sql: string, params: readonly unknown[] = []) =>
      Promise.resolve(db.prepare(sql).all(...params) as T[]),
    executer: (sql, params = []) => Promise.resolve(db.prepare(sql).run(...params).changes),
  };
}

/** Requêtes sur un exécuteur de la base PostgreSQL. */
export function requetesPg(x: Executeur): Requetes {
  return {
    dialecte: "postgres",
    tous: async <T>(sql: string, params: readonly unknown[] = []) =>
      (await x.all(sql, params as Parametres)) as unknown as T[],
    executer: async (sql, params = []) => (await x.run(sql, params as Parametres)).changes,
  };
}

/** Base existante de ces réglages, le temps de `f`, en une transaction (exclusive si `ecriture`) validée à la fin ; rien n'est créé ni migré (PostgreSQL sans table du verrou d'écriture : table des comptes verrouillée). */
export async function avecBaseTelleQuelle<T>(
  reglages: ReglagesBase,
  ecriture: boolean,
  f: (r: Requetes) => Promise<T>,
): Promise<T> {
  if (reglages.backend === "sqlite") {
    if (!existsSync(reglages.path)) throw new Error(`base absente : ${reglages.path}`);
    const db = new Database(reglages.path, { fileMustExist: true, timeout: 15_000 });
    try {
      db.exec(ecriture ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const r = await f(requetesSqlite(db));
        db.exec("COMMIT");
        return r;
      } catch (e) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      db.close();
    }
  }
  const b = ouvrirBase({ ...reglages, poolMax: 1 });
  try {
    if (!ecriture)
      return await b.transaction(async (tx) => {
        await tx.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        return f(requetesPg(tx));
      });
    const verrou = (await b.get<{ t: unknown }>("SELECT to_regclass('elpis_locks') AS t"))?.t ?? null;
    if (verrou !== null) return await b.ecriture((tx) => f(requetesPg(tx)));
    return await b.transaction(async (tx) => {
      await tx.run("LOCK TABLE users IN EXCLUSIVE MODE");
      return f(requetesPg(tx));
    });
  } finally {
    await b.fermer();
  }
}

/** Sections de config.json qu'une remise ne doit pas faire revenir ; une section absente n'a pas de clé. */
export interface SecuriteConfig {
  security?: unknown;
  auth?: unknown;
}

const objet = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** config.json `chemin` relu, modifié par `f` puis réécrit (atomique) sous son verrou ; absent : `{}` ; JSON illisible : erreur. */
async function modifierConfig(chemin: string, f: (cfg: Record<string, unknown>) => void): Promise<void> {
  await avecVerrou(cheminVerrou(chemin), {}, async () => {
    let texte = "";
    try {
      texte = await readFile(chemin, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const cfg = objet(pyJsonLoads(texte.trim() || "{}"));
    f(cfg);
    writeTextAtomic(chemin, pyJsonDumps(cfg, { ensureAscii: false, indent: 2 }));
  });
}

const minGlobal = (securite: unknown): number => {
  try {
    const v = floatPy(objet(objet(securite)["session"])["global_min_ts"] ?? 0);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
};

/** Toute session de l'installation ouverte avant `ts` (secondes) est refusée, sous le verrou de config.json `chemin` ; JSON illisible : erreur. */
export async function fermerToutesSessions(chemin: string, ts: number = Date.now() / 1000): Promise<void> {
  await modifierConfig(chemin, (cfg) => {
    const securite = objet(cfg["security"]);
    const session = objet(securite["session"]);
    session["global_min_ts"] = versFlottantPy(Math.max(minGlobal(securite), ts));
    securite["session"] = session;
    cfg["security"] = securite;
  });
}

/** Sections `security` et `auth` de config.json `chemin` telles qu'elles sont (avant que la remise ne remette les anciennes) ; absent ou illisible : `undefined`. */
export async function lireSecuriteConfig(chemin: string): Promise<SecuriteConfig | undefined> {
  try {
    const cfg = objet(pyJsonLoads((await readFile(chemin, "utf-8")).trim() || "{}"));
    const sc: SecuriteConfig = {};
    if (Object.hasOwn(cfg, "security")) sc.security = cfg["security"];
    if (Object.hasOwn(cfg, "auth")) sc.auth = cfg["auth"];
    return sc;
  } catch {
    return undefined;
  }
}

/** Après la remise : sections `security` et `auth` d'avant reportées sur config.json `chemin` (une section absente d'avant est retirée), coupure globale la plus récente gardée, au moins `ts`. */
export async function reporterSecuriteConfig(
  chemin: string,
  sc: SecuriteConfig | undefined,
  ts = 0,
): Promise<void> {
  if (sc === undefined) return;
  await modifierConfig(chemin, (cfg) => {
    const remise = Math.max(minGlobal(cfg["security"]), minGlobal(sc.security), ts);
    const s = objet(sc.security);
    const session = objet(s["session"]);
    if (remise > 0) session["global_min_ts"] = versFlottantPy(remise);
    s["session"] = session;
    cfg["security"] = s;
    if (sc.auth !== undefined) cfg["auth"] = sc.auth;
    else delete cfg["auth"];
  });
}
