// SPDX-License-Identifier: MIT
/** apps/core/src/rag/acces.ts — droits RAG : droit du compte, rôle sur une collection (propriétaire, lecteur), collections lisibles, publication ; cache court invalidé entre processus. */
import { closeSync, mkdirSync, openSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";

import { configRag } from "@elpis/config";
import type { Base, Executeur } from "@elpis/db";

import { journal } from "../journal";
import { cheminExecution } from "../llm/acces-moteurs";
import { estUuidRag } from "./magasin";
import type { CollectionPartieRag } from "./nettoyage";

const log = journal("rag");

/** Mêmes valeurs que `ROLES_RAG`, `VISIBILITES_RAG` et `CODES_REFUS_RAG` de @elpis/contracts (vérifié par test). */
export type RoleRag = "proprietaire" | "lecteur";
export const VISIBILITES_ACCES_RAG = ["private", "groups", "all"] as const;
export type VisibiliteAccesRag = (typeof VISIBILITES_ACCES_RAG)[number];
export const GROUPES_PUBLICATION_MAX = 50;

export const MESSAGES_REFUS_RAG = {
  rag_interdit: "Le RAG n'est pas ouvert à votre compte.",
  collection_introuvable: "Collection introuvable.",
  non_proprietaire: "Seul le propriétaire peut publier cette collection.",
  demande_invalide: "Demande de publication invalide.",
  groupes_requis: "Choisissez au moins un groupe.",
  trop_de_groupes: `${GROUPES_PUBLICATION_MAX} groupes au plus.`,
  groupe_inconnu: "Groupe introuvable.",
  groupe_non_membre: "Vous ne pouvez publier qu'aux groupes dont vous êtes membre.",
  tous_reserve_admin: "Seuls les administrateurs publient à tous les comptes.",
} as const;
export type CodeRefusRag = keyof typeof MESSAGES_REFUS_RAG;

const STATUT_REFUS: Readonly<Record<CodeRefusRag, 400 | 403 | 404>> = {
  rag_interdit: 403,
  collection_introuvable: 404,
  non_proprietaire: 403,
  demande_invalide: 400,
  groupes_requis: 400,
  trop_de_groupes: 400,
  groupe_inconnu: 400,
  groupe_non_membre: 403,
  tous_reserve_admin: 403,
};

/** Refus des droits RAG : `code` stable pour l'interface, `statut` HTTP à rendre. */
export class RefusRag extends Error {
  override name = "RefusRag";
  readonly code: CodeRefusRag;
  readonly statut: 400 | 403 | 404;
  constructor(code: CodeRefusRag, detail?: string) {
    super(detail ? `${MESSAGES_REFUS_RAG[code]} ${detail}` : MESSAGES_REFUS_RAG[code]);
    this.code = code;
    this.statut = STATUT_REFUS[code];
  }
}

export interface CollectionLisibleRag {
  readonly id: string;
  readonly role: RoleRag;
  readonly owner_user_id: number;
}

/** Publication validée et normalisée : groupes triés sans doublon, vides hors de `groups`. */
export interface PublicationRag {
  readonly visibility: VisibiliteAccesRag;
  readonly group_ids: readonly number[];
  readonly allow_source_open: boolean;
}

/** Durée de vie du contexte d'un compte en cache (réglable par les tests). */
export const reglagesAccesRag = { ttlS: 3.0 };

interface Contexte {
  readonly droit: boolean;
  readonly roles: ReadonlyMap<string, CollectionLisibleRag>;
}
interface Entree extends Contexte {
  readonly t: number;
  readonly tampon: bigint;
  readonly cle: string;
}

const AUCUN: Contexte = Object.freeze({ droit: false, roles: new Map<string, CollectionLisibleRag>() });
const caches = new WeakMap<Executeur, Map<number, Entree>>();

function cheminTampon(): string {
  return join(cheminExecution("rag_access", "ELPIS_RAG_ACCESS_DIR", "/tmp/elpis_rag_access"), "acces.stamp");
}

/** Version des droits vue de tous les processus (mtime du témoin) ; 0 = indisponible, la durée de vie seule s'applique. */
function tamponCourant(): bigint {
  try {
    return statSync(cheminTampon(), { bigint: true }).mtimeNs;
  } catch {
    return 0n;
  }
}

/** Avance le témoin d'au moins 1 µs : tout cache de tout processus est périmé à sa prochaine lecture. */
function toucherTampon(): void {
  try {
    const p = cheminTampon();
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    closeSync(openSync(p, "a", 0o600));
    const avant = statSync(p, { bigint: true }).mtimeNs;
    const maintenant = BigInt(Date.now()) * 1_000_000n;
    const cible = Number(maintenant > avant + 1_000n ? maintenant : avant + 1_000n) / 1e9;
    utimesSync(p, cible, cible);
  } catch (e) {
    log.warn(`[rag] témoin des droits non touché (${String(e)}) : les autres processus suivront après 3 s`);
  }
}

function cacheDe(x: Executeur): Map<number, Entree> {
  let c = caches.get(x);
  if (c === undefined) {
    c = new Map();
    caches.set(x, c);
  }
  return c;
}

/** Après toute écriture qui change un droit (publication, suppression, groupes, rôle) : à appeler APRÈS la validation de la transaction. */
export function invaliderAccesRag(base?: Executeur): void {
  toucherTampon();
  if (base !== undefined) caches.delete(base);
}

function uidOuNul(uid: unknown): number | null {
  return typeof uid === "number" && Number.isSafeInteger(uid) && uid > 0 ? uid : null;
}

async function groupesDe(x: Executeur, uid: number): Promise<Set<number>> {
  const lignes = await x.valeurs<[unknown]>("SELECT group_id FROM user_groups WHERE user_id=?", [uid]);
  return new Set(lignes.map(([g]) => Number(g)));
}

/** Droit RAG : admin toujours, sinon `rag.groups` vide ou un groupe commun. */
function droitDepuis(admin: boolean, groupes: ReadonlySet<number>, autorises: readonly number[]): boolean {
  return admin || autorises.length === 0 || autorises.some((g) => groupes.has(g));
}

/** Compte et groupes lus en base ; `null` si le compte n'existe pas. */
async function lireCompte(
  x: Executeur,
  uid: number,
): Promise<{ admin: boolean; groupes: Set<number> } | null> {
  const ligne = (await x.valeurs<[unknown]>("SELECT is_admin FROM users WHERE id=?", [uid]))[0];
  if (ligne === undefined) return null;
  return { admin: Number(ligne[0]) === 1, groupes: await groupesDe(x, uid) };
}

/** Miennes, puis publiées pour moi (`all`, ou un de mes groupes) ; une publication survit au départ de l'auteur (droit retiré, groupe quitté, admin rétrogradé) ; l'admin ne lit rien d'office. */
async function charger(x: Executeur, uid: number, autorises: readonly number[]): Promise<Contexte> {
  const compte = await lireCompte(x, uid);
  if (compte === null || !droitDepuis(compte.admin, compte.groupes, autorises)) return AUCUN;
  const roles = new Map<string, CollectionLisibleRag>();
  const miennes = await x.valeurs<[unknown]>(
    "SELECT id FROM rag_collections WHERE owner_user_id=? ORDER BY id",
    [uid],
  );
  for (const [id] of miennes)
    roles.set(String(id), { id: String(id), role: "proprietaire", owner_user_id: uid });
  const publiees = await x.valeurs<[unknown, unknown]>(
    "SELECT c.id, c.owner_user_id FROM rag_collections c " +
      "WHERE c.owner_user_id <> ? AND (c.visibility = 'all' OR " +
      "(c.visibility = 'groups' AND EXISTS (SELECT 1 FROM rag_grants g JOIN user_groups ug ON ug.group_id = g.principal_id " +
      "WHERE g.collection_id = c.id AND g.principal_type = 'group' AND ug.user_id = ?)))" +
      " ORDER BY c.id",
    [uid, uid],
  );
  for (const [id, auteur] of publiees)
    roles.set(String(id), { id: String(id), role: "lecteur", owner_user_id: Number(auteur) });
  return { droit: true, roles };
}

/** Contexte du compte : en cache s'il a moins de 3 s, que le témoin n'a pas bougé et que `rag.groups` est le même ; `frais` relit. */
async function contexte(
  x: Executeur,
  uid: number,
  frais: boolean,
): Promise<{ ctx: Contexte; depuisCache: boolean }> {
  const autorises = configRag().groups;
  const cle = autorises.join(",");
  const tampon = tamponCourant();
  const t = performance.now() / 1000;
  const cache = cacheDe(x);
  const hit = cache.get(uid);
  if (
    !frais &&
    hit !== undefined &&
    t - hit.t < reglagesAccesRag.ttlS &&
    hit.tampon === tampon &&
    hit.cle === cle
  )
    return { ctx: hit, depuisCache: true };
  const ctx = await charger(x, uid, autorises);
  cache.set(uid, { ...ctx, t, tampon, cle });
  return { ctx, depuisCache: false };
}

/** Le compte a-t-il le droit RAG (`rag.groups` vide = tous, l'admin toujours) ? Sans lui, aucun accès, même à ses collections. */
export async function droitRag(x: Executeur, uid: unknown): Promise<boolean> {
  const u = uidOuNul(uid);
  return u !== null && (await contexte(x, u, false)).ctx.droit;
}

/** Collection privée d'un compte sans droit RAG : utilisable par personne, donc ni indexée ni migrée (son texte ne repart pas vers le serveur d'embeddings). */
export async function collectionGeleeRag(
  x: Executeur,
  auteur: unknown,
  visibilite: string,
): Promise<boolean> {
  return visibilite === "private" && !(await droitRag(x, auteur));
}

/** Rôle du compte sur la collection, `null` sinon ; une absence du cache est revérifiée en base, jamais une présence au-delà de 3 s. */
export async function accesCollection(
  x: Executeur,
  uid: unknown,
  collectionId: unknown,
): Promise<RoleRag | null> {
  const u = uidOuNul(uid);
  if (u === null || !estUuidRag(collectionId)) return null;
  const premier = await contexte(x, u, false);
  const trouve = premier.ctx.roles.get(collectionId);
  if (trouve !== undefined || !premier.depuisCache) return trouve?.role ?? null;
  return (await contexte(x, u, true)).ctx.roles.get(collectionId)?.role ?? null;
}

/** Collections lisibles, relues en base : les miennes, puis celles publiées pour moi (par identifiant). */
export async function collectionsLisibles(x: Executeur, uid: unknown): Promise<CollectionLisibleRag[]> {
  const u = uidOuNul(uid);
  if (u === null) return [];
  const { roles } = (await contexte(x, u, true)).ctx;
  const tous = [...roles.values()];
  return [...tous.filter((c) => c.role === "proprietaire"), ...tous.filter((c) => c.role === "lecteur")];
}

function lireDemande(demande: unknown): {
  visibility: VisibiliteAccesRag;
  group_ids: number[];
  allow_source_open: boolean;
} {
  if (demande === null || typeof demande !== "object" || Array.isArray(demande))
    throw new RefusRag("demande_invalide");
  const d = demande as Record<string, unknown>;
  const visibilite = d["visibility"];
  if (typeof visibilite !== "string" || !(VISIBILITES_ACCES_RAG as readonly string[]).includes(visibilite))
    throw new RefusRag("demande_invalide");
  if (typeof d["allow_source_open"] !== "boolean") throw new RefusRag("demande_invalide");
  const brut = d["group_ids"] ?? [];
  if (!Array.isArray(brut) || !brut.every((g) => typeof g === "number" && Number.isSafeInteger(g) && g > 0))
    throw new RefusRag("demande_invalide");
  if (brut.length > GROUPES_PUBLICATION_MAX) throw new RefusRag("trop_de_groupes");
  return {
    visibility: visibilite as VisibiliteAccesRag,
    group_ids: [...new Set(brut as number[])].sort((a, b) => a - b),
    allow_source_open: d["allow_source_open"],
  };
}

/** Publication permise ? Propriétaire avec le droit RAG ; groupes dont il est membre ; `all` et tout groupe réservés à l'admin. Lève `RefusRag`. */
export async function verifierPublication(
  x: Executeur,
  uid: unknown,
  collectionId: unknown,
  demande: unknown,
): Promise<PublicationRag> {
  const u = uidOuNul(uid);
  const compte = u === null ? null : await lireCompte(x, u);
  if (u === null || compte === null || !droitDepuis(compte.admin, compte.groupes, configRag().groups))
    throw new RefusRag("rag_interdit");
  if (!estUuidRag(collectionId)) throw new RefusRag("collection_introuvable");
  const ligne = (
    await x.valeurs<[unknown]>("SELECT owner_user_id FROM rag_collections WHERE id=?", [collectionId])
  )[0];
  if (ligne === undefined) throw new RefusRag("collection_introuvable");
  if (Number(ligne[0]) !== u) {
    const lecteur = (await contexte(x, u, true)).ctx.roles.get(collectionId)?.role === "lecteur";
    throw new RefusRag(lecteur ? "non_proprietaire" : "collection_introuvable");
  }
  const d = lireDemande(demande);
  if (d.visibility === "private")
    return { visibility: "private", group_ids: [], allow_source_open: d.allow_source_open };
  if (d.visibility === "all") {
    if (!compte.admin) throw new RefusRag("tous_reserve_admin");
    return { visibility: "all", group_ids: [], allow_source_open: d.allow_source_open };
  }
  if (!d.group_ids.length) throw new RefusRag("groupes_requis");
  if (!compte.admin) {
    if (d.group_ids.some((g) => !compte.groupes.has(g))) throw new RefusRag("groupe_non_membre");
  } else {
    const marques = d.group_ids.map(() => "?").join(",");
    const connus = new Set(
      (await x.valeurs<[unknown]>(`SELECT id FROM "groups" WHERE id IN (${marques})`, d.group_ids)).map(
        ([g]) => Number(g),
      ),
    );
    const inconnus = d.group_ids.filter((g) => !connus.has(g));
    if (inconnus.length) throw new RefusRag("groupe_inconnu", inconnus.join(", "));
  }
  return { visibility: "groups", group_ids: d.group_ids, allow_source_open: d.allow_source_open };
}

/** Vérifie puis écrit la publication (visibilité, ouverture des sources, groupes accordés) d'un bloc, et invalide les droits. */
export async function appliquerPublication(
  base: Base,
  uid: unknown,
  collectionId: unknown,
  demande: unknown,
): Promise<PublicationRag> {
  const publication = await base.ecriture(async (x) => {
    const p = await verifierPublication(x, uid, collectionId, demande);
    const t = Date.now() / 1000;
    await x.run("UPDATE rag_collections SET visibility=?, allow_source_open=?, updated_at=? WHERE id=?", [
      p.visibility,
      p.allow_source_open ? 1 : 0,
      t,
      collectionId as string,
    ]);
    await x.run("DELETE FROM rag_grants WHERE collection_id=?", [collectionId as string]);
    for (const g of p.group_ids)
      await x.run(
        "INSERT INTO rag_grants(collection_id, principal_type, principal_id, created_at) VALUES(?, 'group', ?, ?)",
        [collectionId as string, g, t],
      );
    return p;
  });
  invaliderAccesRag(base);
  return publication;
}

/** Collections décrites pour le nettoyage (identité, auteur, nom, visibilité, groupes accordés). */
async function decrire(
  x: Executeur,
  ou: string,
  params: readonly (string | number)[],
): Promise<CollectionPartieRag[]> {
  const lignes = await x.valeurs<[unknown, unknown, unknown, unknown]>(
    `SELECT id, owner_user_id, name, visibility FROM rag_collections WHERE ${ou} ORDER BY id`,
    params,
  );
  const out: CollectionPartieRag[] = [];
  for (const [id, auteur, nom, visibilite] of lignes) {
    const groupes = await x.valeurs<[unknown]>(
      "SELECT principal_id FROM rag_grants WHERE collection_id=? AND principal_type='group' ORDER BY principal_id",
      [String(id)],
    );
    out.push({
      id: String(id),
      owner_user_id: Number(auteur),
      name: String(nom),
      visibility: String(visibilite),
      group_ids: groupes.map(([g]) => Number(g)),
    });
  }
  return out;
}

/** Supprime la ligne d'une collection (documents, travaux, accès et masquages en cascade) et invalide les droits ; rend ce qu'il reste à nettoyer. */
export async function supprimerCollectionRag(
  base: Base,
  collectionId: unknown,
): Promise<CollectionPartieRag | null> {
  if (!estUuidRag(collectionId)) return null;
  const partie = await base.ecriture(async (x) => {
    const [p] = await decrire(x, "id = ?", [collectionId]);
    if (p === undefined) return null;
    await x.run("DELETE FROM rag_collections WHERE id=?", [collectionId]);
    return p;
  });
  if (partie !== null) invaliderAccesRag(base);
  return partie;
}

/** Lignes RAG d'un compte supprimé, dans la transaction de l'appelant (qui invalide ensuite) ; rend ses collections pour le nettoyage. */
export async function purgerCompteRag(x: Executeur, uid: number): Promise<CollectionPartieRag[]> {
  const parties = await decrire(x, "owner_user_id = ?", [uid]);
  await x.run("DELETE FROM rag_grants WHERE principal_type='user' AND principal_id=?", [uid]);
  await x.run("DELETE FROM rag_hidden WHERE user_id=?", [uid]);
  await x.run("DELETE FROM rag_jobs WHERE owner_user_id=?", [uid]);
  await x.run("UPDATE rag_documents SET added_by=NULL WHERE added_by=?", [uid]);
  await x.run("DELETE FROM rag_collections WHERE owner_user_id=?", [uid]);
  return parties;
}

/** Accès accordés à un groupe supprimé, dans la transaction de l'appelant (qui invalide ensuite). */
export async function purgerGroupeRag(x: Executeur, groupId: number): Promise<void> {
  await x.run("DELETE FROM rag_grants WHERE principal_type='group' AND principal_id=?", [groupId]);
}
