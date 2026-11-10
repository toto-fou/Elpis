// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/stockage.ts — table `vault_secrets` : création, modification (« vide = inchangé »), rotation, vérification, suppression et liste, valeur chiffrée jamais relue par l'API et liée aux colonnes qui décident de son usage ; chaque écriture au journal de sécurité, sans valeur. */
import { POLITIQUE_SECRET_DEFAUT, SECRETS_PAR_PROPRIETAIRE_MAX } from "@elpis/contracts";
import type { EtatSecret, GenreSecret, PolitiqueSecret, PorteeSecret, Secret } from "@elpis/contracts";
import { ErreurIntegrite } from "@elpis/db";
import type { Base, Executeur, Valeur } from "@elpis/db";
import {
  auditEvent,
  chargerCleCoffre,
  chiffrerSecret,
  cleCoffre,
  dechiffrerSecret,
  kidCoffre,
  kidDe,
} from "@elpis/securite";
import type { CleCoffre, IssueAudit } from "@elpis/securite";

import { ErreurSecret, refusDeCle } from "./erreurs";
import {
  aadSecret,
  elargit,
  estGenre,
  exigerPolitiqueApplicable,
  fusionnerPolitique,
  lirePolitique,
  normaliserPortee,
  objetJson,
  validerIdentifiant,
  validerMeta,
  validerNom,
  validerValeur,
} from "./portee";
import type { ColonnesLiees } from "./portee";

/** Propriétaire d'un secret : un compte, ou `null` pour un secret d'instance (connecteurs partagés, moteur d'images). */
export type Proprietaire = number | null;

/** Qui agit, pour le journal de sécurité (compte de la session, de l'enveloppe signée, ou `null` pour la ligne de commande). */
export interface Acteur {
  userId: number | null;
  username: string | null;
  ip?: string | null;
}

export interface LigneSecret {
  id: number;
  user_id: number | null;
  kind: string;
  name: string;
  scope_json: string;
  username: string | null;
  secret_enc: string;
  kid: string;
  version: number;
  state: string;
  policy_json: string;
  meta_json: string;
  created_at: number;
  updated_at: number;
  rotated_at: number | null;
  last_used_at: number | null;
  use_count: number;
}

export const COLONNES_SECRET =
  "id, user_id, kind, name, scope_json, username, secret_enc, kid, version, state, policy_json, meta_json, created_at, updated_at, rotated_at, last_used_at, use_count";

export function maintenant(): number {
  return Date.now() / 1000;
}

/** Clause SQL du propriétaire. */
export function clauseProprietaire(p: Proprietaire): { sql: string; params: Valeur[] } {
  return p === null ? { sql: "user_id IS NULL", params: [] } : { sql: "user_id = ?", params: [p] };
}

/** Une ligne au journal de sécurité ; jamais de valeur ni de chiffré dans `details`. */
export function journaliser(
  acteur: Acteur,
  action: string,
  details: Record<string, unknown>,
  outcome?: IssueAudit,
): void {
  auditEvent({
    userId: acteur.userId,
    username: acteur.username,
    action,
    details,
    ip: acteur.ip ?? null,
    ...(outcome ? { outcome } : {}),
  });
}

/** `kid` de la clé courante, `null` sans clé ou si elle est illisible (la liste reste lisible). */
function kidCourant(): string | null {
  try {
    return kidCoffre();
  } catch {
    return null;
  }
}

const nombreOuNul = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function genreDe(l: LigneSecret): GenreSecret {
  if (!estGenre(l.kind)) throw new ErreurSecret(409, "secret_request_invalid", "Unknown secret kind.");
  return l.kind;
}

/** Portée enregistrée relue selon le genre ; illisible : `{}`. */
export function porteeDe(l: LigneSecret): PorteeSecret {
  try {
    return normaliserPortee(genreDe(l), objetJson(l.scope_json));
  } catch {
    return {};
  }
}

/** Vue publique d'une ligne : métadonnées seules. */
export function vueSecret(l: LigneSecret, kid: string | null = kidCourant()): Secret {
  return {
    id: Number(l.id),
    name: l.name,
    kind: genreDe(l),
    owner: l.user_id === null ? "instance" : "user",
    scope: porteeDe(l),
    username: l.username ?? null,
    state: l.state === "unverified" ? "unverified" : "active",
    version: Number(l.version),
    policy: lirePolitique(l.policy_json),
    meta: objetJson(l.meta_json),
    key_current: kid !== null && l.kid === kid,
    use_count: Number(l.use_count ?? 0),
    last_used_at: nombreOuNul(l.last_used_at),
    created_at: Number(l.created_at),
    updated_at: Number(l.updated_at),
    rotated_at: nombreOuNul(l.rotated_at),
  };
}

export async function lireLigne(x: Executeur, p: Proprietaire, id: number): Promise<LigneSecret | null> {
  const c = clauseProprietaire(p);
  return (
    (await x.get<LigneSecret & Record<string, unknown>>(
      `SELECT ${COLONNES_SECRET} FROM vault_secrets WHERE id = ? AND ${c.sql}`,
      [id, ...c.params],
    )) ?? null
  );
}

export async function lireLigneParNom(
  x: Executeur,
  p: Proprietaire,
  nom: string,
): Promise<LigneSecret | null> {
  const c = clauseProprietaire(p);
  return (
    (await x.get<LigneSecret & Record<string, unknown>>(
      `SELECT ${COLONNES_SECRET} FROM vault_secrets WHERE name = ? AND ${c.sql}`,
      [nom, ...c.params],
    )) ?? null
  );
}

/** Lignes d'un propriétaire, par nom ; les genres inconnus de cette version sont omis. */
export async function lignesDe(x: Executeur, p: Proprietaire, genre?: GenreSecret): Promise<LigneSecret[]> {
  const c = clauseProprietaire(p);
  const lignes = await x.all<LigneSecret & Record<string, unknown>>(
    `SELECT ${COLONNES_SECRET} FROM vault_secrets WHERE ${c.sql}${genre ? " AND kind = ?" : ""} ORDER BY name`,
    genre ? [...c.params, genre] : c.params,
  );
  return lignes.filter((l) => estGenre(l.kind));
}

/** `listerSecrets` : métadonnées des secrets d'un compte (ou de l'instance), sans valeur ni chiffré. */
export async function listerSecrets(x: Executeur, p: Proprietaire): Promise<Secret[]> {
  const kid = kidCourant();
  return (await lignesDe(x, p)).map((l) => vueSecret(l, kid));
}

function introuvable(): ErreurSecret {
  return new ErreurSecret(404, "secret_unknown", "Secret not found.");
}

function nomPris(nom: string): ErreurSecret {
  return new ErreurSecret(
    409,
    "secret_name_taken",
    nom ? `A secret named '${nom}' already exists.` : "This secret name is already taken.",
  );
}

const proprio = (p: Proprietaire): "user" | "instance" => (p === null ? "instance" : "user");

/** AAD d'une ligne telle qu'enregistrée : propriétaire, genre, nom et colonnes liées. */
export function aadLigne(l: LigneSecret): string {
  return aadSecret(l.user_id, genreDe(l), l.name, l);
}

/** Clé pour chiffrer : la courante ; à défaut, la clé de repli n'est posée que sur un coffre vide (secrets de webhook des routines compris), sinon ses secrets resteraient illisibles (refus 503). */
export async function cleDeChiffrement(x: Executeur): Promise<CleCoffre> {
  try {
    const cle = cleCoffre();
    if (cle !== null) return cle;
    const n = await x.get<{ n: number }>(
      "SELECT (SELECT COUNT(*) FROM vault_secrets) + " +
        "(SELECT COUNT(*) FROM editor_routines WHERE webhook_secret_enc IS NOT NULL) AS n",
    );
    if (Number(n?.n ?? 0) > 0)
      throw new ErreurSecret(
        503,
        "secret_key_unavailable",
        "The vault key is missing while secrets exist: restore /etc/elpis/vault.key, " +
          "or run sudo ./elpis vault setup and enter the secrets again.",
      );
    return chargerCleCoffre();
  } catch (e) {
    throw refusDeCle(e) ?? e;
  }
}

/** Chiffrement d'une valeur liée à son propriétaire, son genre, son nom et ses colonnes liées. */
function chiffrer(
  valeur: string,
  cle: CleCoffre,
  p: Proprietaire,
  genre: GenreSecret,
  nom: string,
  liees: ColonnesLiees,
): string {
  try {
    return chiffrerSecret(valeur, aadSecret(p, genre, nom, liees), cle);
  } catch (e) {
    throw refusDeCle(e, nom) ?? e;
  }
}

/** Valeur claire d'une ligne (rechiffrement, résolution) ; une colonne liée changée hors du module, un autre chiffré ou une autre clé : refus `secret_undecryptable` ; sans clé : `secret_key_unavailable`. */
export function dechiffrerLigne(l: LigneSecret): string {
  try {
    return dechiffrerSecret(l.secret_enc, aadLigne(l));
  } catch (e) {
    throw refusDeCle(e, l.name) ?? e;
  }
}

export interface DonneesSecret {
  name: unknown;
  kind: unknown;
  scope?: unknown;
  username?: unknown;
  value: unknown;
  policy?: Partial<PolitiqueSecret> | undefined;
  meta?: unknown;
  /** `unverified` pour un secret importé (reprise des anciens identifiants). */
  state?: EtatSecret;
}

async function exigerNomLibre(x: Executeur, p: Proprietaire, nom: string, saufId?: number): Promise<void> {
  const c = clauseProprietaire(p);
  const pris = await x.get(
    `SELECT id FROM vault_secrets WHERE name = ? AND ${c.sql}${saufId === undefined ? "" : " AND id <> ?"}`,
    saufId === undefined ? [nom, ...c.params] : [nom, ...c.params, saufId],
  );
  if (pris) throw nomPris(nom);
}

/** Violation d'unicité (SQLite ou PostgreSQL 23505). */
function estDoublon(e: unknown): boolean {
  if (!(e instanceof ErreurIntegrite)) return false;
  return (
    e.sqlstate === "23505" || (e.cause as { code?: unknown } | undefined)?.code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/** Écriture en base ; un nom pris entre-temps (index unique) devient `secret_name_taken`. */
async function ecrire<T>(base: Base, nom: string, f: (x: Executeur) => Promise<T>): Promise<T> {
  try {
    return await base.ecriture(f);
  } catch (e) {
    if (estDoublon(e)) throw nomPris(nom);
    throw e;
  }
}

/** `creerSecret` : nom libre, portée normalisée, politique complétée par les défauts, valeur chiffrée (clé de repli posée seulement sur un coffre vide) ; 200 secrets au plus par propriétaire. */
export async function creerSecret(
  base: Base,
  p: Proprietaire,
  d: DonneesSecret,
  acteur: Acteur,
): Promise<Secret> {
  if (!estGenre(d.kind)) throw new ErreurSecret(422, "secret_request_invalid", "Invalid secret kind.");
  const genre = d.kind;
  const nom = validerNom(d.name);
  const portee = normaliserPortee(genre, d.scope);
  const identifiant = validerIdentifiant(d.username);
  const valeur = validerValeur(d.value);
  exigerPolitiqueApplicable(d.policy);
  const politique = fusionnerPolitique(POLITIQUE_SECRET_DEFAUT, d.policy);
  const meta = validerMeta(d.meta);
  const etat: EtatSecret = d.state === "unverified" ? "unverified" : "active";
  const liees: ColonnesLiees = {
    scope_json: JSON.stringify(portee),
    policy_json: JSON.stringify(politique),
    state: etat,
    version: 1,
    username: identifiant,
  };
  const t = maintenant();
  const ligne = await ecrire(base, nom, async (x) => {
    const c = clauseProprietaire(p);
    const n = await x.get<{ n: number }>(`SELECT COUNT(*) AS n FROM vault_secrets WHERE ${c.sql}`, c.params);
    if (Number(n?.n ?? 0) >= SECRETS_PAR_PROPRIETAIRE_MAX)
      throw new ErreurSecret(409, "secret_limit", `${SECRETS_PAR_PROPRIETAIRE_MAX} secrets at most.`);
    await exigerNomLibre(x, p, nom);
    const enc = chiffrer(valeur, await cleDeChiffrement(x), p, genre, nom, liees);
    const id = await x.insertId(
      "INSERT INTO vault_secrets (user_id, kind, name, scope_json, username, secret_enc, kid, version, state, " +
        "policy_json, meta_json, created_at, updated_at, use_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      [
        p,
        genre,
        nom,
        liees.scope_json,
        identifiant,
        enc,
        kidDe(enc) ?? "",
        liees.version,
        etat,
        liees.policy_json,
        JSON.stringify(meta),
        t,
        t,
      ],
    );
    return (await lireLigne(x, p, id)) as LigneSecret;
  });
  journaliser(acteur, "vault.secret.created", {
    secret_id: Number(ligne.id),
    name: nom,
    kind: genre,
    owner: proprio(p),
    scope: portee,
    state: etat,
  });
  return vueSecret(ligne);
}

export interface ModifSecret {
  name?: unknown;
  scope?: unknown;
  username?: unknown;
  /** Absente ou vide : inchangée. */
  value?: unknown;
  policy?: Partial<PolitiqueSecret> | undefined;
  meta?: unknown;
}

/** `modifierSecret` : champs absents inchangés, valeur vide inchangée ; élargir la portée ou passer en TLS non vérifié exige la valeur ; une colonne liée changée (nom, portée, politique, identifiant) rechiffre ; une nouvelle valeur fait passer `version` à n+1. */
export async function modifierSecret(
  base: Base,
  p: Proprietaire,
  id: number,
  m: ModifSecret,
  acteur: Acteur,
): Promise<Secret> {
  const nom = m.name === undefined ? null : validerNom(m.name);
  const identifiant = m.username === undefined ? undefined : validerIdentifiant(m.username);
  const valeur = m.value === undefined || m.value === "" ? null : validerValeur(m.value);
  const meta = m.meta === undefined ? null : validerMeta(m.meta);
  exigerPolitiqueApplicable(m.policy);
  const t = maintenant();
  const r = await ecrire(base, nom ?? "", async (x) => {
    const l = await lireLigne(x, p, id);
    if (l === null) throw introuvable();
    const genre = genreDe(l);
    const portee = m.scope === undefined ? porteeDe(l) : normaliserPortee(genre, m.scope);
    const avant = lirePolitique(l.policy_json);
    const politique = fusionnerPolitique(avant, m.policy);
    const insecure = politique.tls === "insecure" && avant.tls !== "insecure";
    if (valeur === null && (elargit(genre, porteeDe(l), portee) || insecure))
      throw new ErreurSecret(
        422,
        "secret_value_required",
        "Widening the scope or allowing insecure TLS requires re-entering the secret value.",
      );
    const nouveauNom = nom ?? l.name;
    if (nouveauNom !== l.name) await exigerNomLibre(x, p, nouveauNom, id);
    const liees: ColonnesLiees = {
      scope_json:
        JSON.stringify(portee) === JSON.stringify(porteeDe(l)) ? l.scope_json : JSON.stringify(portee),
      policy_json:
        JSON.stringify(politique) === JSON.stringify(avant) ? l.policy_json : JSON.stringify(politique),
      state: l.state,
      version: Number(l.version) + (valeur === null ? 0 : 1),
      username: identifiant === undefined ? (l.username ?? null) : identifiant,
    };
    const champs: string[] = [];
    const sets: string[] = [];
    const params: Valeur[] = [];
    const poser = (champ: string, colonne: string, v: Valeur): void => {
      champs.push(champ);
      sets.push(`${colonne} = ?`);
      params.push(v);
    };
    if (nouveauNom !== l.name) poser("name", "name", nouveauNom);
    if (liees.scope_json !== l.scope_json) poser("scope", "scope_json", liees.scope_json);
    if (liees.username !== (l.username ?? null)) poser("username", "username", liees.username);
    if (liees.policy_json !== l.policy_json) poser("policy", "policy_json", liees.policy_json);
    if (meta !== null && JSON.stringify(meta) !== JSON.stringify(objetJson(l.meta_json)))
      poser("meta", "meta_json", JSON.stringify(meta));
    if (valeur !== null) {
      champs.push("value");
      sets.push("version = ?", "rotated_at = ?");
      params.push(liees.version, t);
    }
    if (champs.some((c) => c !== "meta")) {
      const enc = chiffrer(
        valeur ?? dechiffrerLigne(l),
        await cleDeChiffrement(x),
        p,
        genre,
        nouveauNom,
        liees,
      );
      sets.push("secret_enc = ?", "kid = ?");
      params.push(enc, kidDe(enc) ?? "");
    }
    if (champs.length === 0) return { ligne: l, champs };
    await x.run(`UPDATE vault_secrets SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [
      ...params,
      t,
      id,
    ]);
    return { ligne: (await lireLigne(x, p, id)) as LigneSecret, champs };
  });
  if (r.champs.length > 0)
    journaliser(acteur, "vault.secret.updated", {
      secret_id: id,
      name: r.ligne.name,
      kind: r.ligne.kind,
      owner: proprio(p),
      fields: r.champs,
      version: Number(r.ligne.version),
      ...(r.champs.includes("scope") ? { scope: porteeDe(r.ligne) } : {}),
      ...(r.champs.includes("policy") ? { tls: lirePolitique(r.ligne.policy_json).tls } : {}),
    });
  return vueSecret(r.ligne);
}

/** `rotation` : nouvelle valeur, `version` à n+1, `rotated_at` posé. */
export async function rotation(
  base: Base,
  p: Proprietaire,
  id: number,
  valeur: unknown,
  acteur: Acteur,
): Promise<Secret> {
  const v = validerValeur(valeur);
  const t = maintenant();
  const ligne = await base.ecriture(async (x) => {
    const l = await lireLigne(x, p, id);
    if (l === null) throw introuvable();
    const version = Number(l.version) + 1;
    const enc = chiffrer(v, await cleDeChiffrement(x), p, genreDe(l), l.name, { ...l, version });
    await x.run(
      "UPDATE vault_secrets SET secret_enc = ?, kid = ?, version = ?, rotated_at = ?, updated_at = ? WHERE id = ?",
      [enc, kidDe(enc) ?? "", version, t, t, id],
    );
    return (await lireLigne(x, p, id)) as LigneSecret;
  });
  journaliser(acteur, "vault.secret.rotated", {
    secret_id: id,
    name: ligne.name,
    kind: ligne.kind,
    owner: proprio(p),
    version: Number(ligne.version),
  });
  return vueSecret(ligne);
}

/** `verifierSecret` : un secret importé (`unverified`) devient utilisable (`active`), rechiffré pour son nouvel état ; déjà actif, rien ne change ; illisible : `secret_undecryptable` (le tourner). */
export async function verifierSecret(
  base: Base,
  p: Proprietaire,
  id: number,
  acteur: Acteur,
): Promise<Secret> {
  const r = await base.ecriture(async (x) => {
    const l = await lireLigne(x, p, id);
    if (l === null) throw introuvable();
    if (l.state === "active") return { ligne: l, change: false };
    const clair = dechiffrerLigne(l);
    const enc = chiffrer(clair, await cleDeChiffrement(x), p, genreDe(l), l.name, { ...l, state: "active" });
    await x.run(
      "UPDATE vault_secrets SET state = 'active', secret_enc = ?, kid = ?, updated_at = ? WHERE id = ?",
      [enc, kidDe(enc) ?? "", maintenant(), id],
    );
    return { ligne: (await lireLigne(x, p, id)) as LigneSecret, change: true };
  });
  if (r.change)
    journaliser(acteur, "vault.secret.verified", {
      secret_id: id,
      name: r.ligne.name,
      kind: r.ligne.kind,
      owner: proprio(p),
      scope: porteeDe(r.ligne),
    });
  return vueSecret(r.ligne);
}

/** `supprimerSecret` : la ligne et son chiffré disparaissent. */
export async function supprimerSecret(
  base: Base,
  p: Proprietaire,
  id: number,
  acteur: Acteur,
): Promise<void> {
  const l = await base.ecriture(async (x) => {
    const ligne = await lireLigne(x, p, id);
    if (ligne === null) throw introuvable();
    await x.run("DELETE FROM vault_secrets WHERE id = ?", [id]);
    return ligne;
  });
  journaliser(acteur, "vault.secret.deleted", {
    secret_id: id,
    name: l.name,
    kind: l.kind,
    owner: proprio(p),
  });
}
