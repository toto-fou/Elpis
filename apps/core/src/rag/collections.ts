// SPDX-License-Identifier: MIT
/** apps/core/src/rag/collections.ts — collections RAG d'un compte : liste (miennes puis partagées, masquage), vue, création sous quota, mise à jour, groupes de publication, audience d'une publication, masquage. */
import { randomUUID } from "node:crypto";

import { configRag } from "@elpis/config";
import { DECOUPAGE_RAG_DEFAUT } from "@elpis/contracts";
import type { DecoupageRag } from "@elpis/contracts";
import type { Base, Executeur } from "@elpis/db";
import { ErreurIntegrite } from "@elpis/db";

import { accesCollection, collectionsLisibles } from "./acces";
import type { RoleRag } from "./acces";
import { canoniqueDecoupageRag, lireDecoupageCollectionRag } from "./decoupage";
import { ErreurRouteRag } from "./http";
import { creerDossiersCollectionRag, supprimerDossierCollectionRag } from "./magasin";
import { quotasRag } from "./quotas";
import { lireCollection, metaCollectionRag } from "./travaux";

const LOT_SQL = 400;
const ETATS_COLLECTION = new Set(["ready", "indexing", "migrating", "error"]);
const VISIBILITES = new Set(["private", "groups", "all"]);

/** Collection sous la forme du contrat `schemaCollectionVueRag`. */
export interface VueCollectionRag {
  id: string;
  name: string;
  description: string;
  visibility: "private" | "groups" | "all";
  allow_source_open: boolean;
  owner: { id: number; username: string; display_name: string };
  role: RoleRag;
  groups: { id: number; name: string; members: number }[];
  doc_count: number;
  chunk_count: number;
  bytes: number;
  status: "ready" | "indexing" | "migrating" | "error";
  embed_model: string;
  chunking: DecoupageRag;
  ocr: boolean;
  created_at: number;
  updated_at: number;
  hidden: boolean;
}

export interface CorpsMajCollectionRag {
  name?: string | undefined;
  description?: string | undefined;
  chunking?: DecoupageRag | undefined;
  ocr?: boolean | undefined;
}

const nombre = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

function objet(texte: unknown): Record<string, unknown> {
  if (typeof texte !== "string" || texte === "") return {};
  try {
    const v = JSON.parse(texte) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function lots<T>(liste: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < liste.length; i += LOT_SQL) out.push(liste.slice(i, i + LOT_SQL));
  return out;
}

const marques = (n: number): string => Array.from({ length: n }, () => "?").join(",");

/** Lignes des collections demandées, avec leurs auteurs, leurs groupes accordés et le masquage de `uid`. */
async function vues(
  x: Executeur,
  uid: number,
  roles: ReadonlyMap<string, RoleRag>,
): Promise<VueCollectionRag[]> {
  const ids = [...roles.keys()];
  const sortie: VueCollectionRag[] = [];
  const groupes = new Map<string, { id: number; name: string; members: number }[]>();
  const masquees = new Set<string>();
  for (const lot of lots(ids)) {
    const m = marques(lot.length);
    for (const [cid, gid, nom, effectif] of await x.valeurs<[unknown, unknown, unknown, unknown]>(
      `SELECT g.collection_id, gr.id, gr.name, (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = gr.id) ` +
        `FROM rag_grants g JOIN "groups" gr ON gr.id = g.principal_id ` +
        `WHERE g.principal_type = 'group' AND g.collection_id IN (${m})`,
      lot,
    )) {
      const liste = groupes.get(String(cid)) ?? [];
      liste.push({ id: nombre(gid), name: String(nom), members: nombre(effectif) });
      groupes.set(String(cid), liste);
    }
    for (const [cid] of await x.valeurs<[unknown]>(
      `SELECT collection_id FROM rag_hidden WHERE user_id = ? AND collection_id IN (${m})`,
      [uid, ...lot],
    ))
      masquees.add(String(cid));
    for (const r of await x.all(
      `SELECT c.id, c.owner_user_id, c.name, c.description, c.visibility, c.allow_source_open, c.embed_model, ` +
        `c.chunk_json, c.meta_json, c.status, c.doc_count, c.chunk_count, c.bytes, c.created_at, c.updated_at, u.username ` +
        `FROM rag_collections c JOIN users u ON u.id = c.owner_user_id WHERE c.id IN (${m})`,
      lot,
    )) {
      const id = String(r["id"]);
      const role = roles.get(id);
      if (role === undefined) continue;
      const etat = String(r["status"]);
      const visibilite = String(r["visibility"]);
      const auteur = String(r["username"] ?? "");
      sortie.push({
        id,
        name: String(r["name"]),
        description: String(r["description"] ?? ""),
        visibility: (VISIBILITES.has(visibilite) ? visibilite : "private") as VueCollectionRag["visibility"],
        allow_source_open: nombre(r["allow_source_open"]) === 1,
        owner: { id: nombre(r["owner_user_id"]), username: auteur, display_name: auteur },
        role,
        groups:
          role === "proprietaire" ? (groupes.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name)) : [],
        doc_count: nombre(r["doc_count"]),
        chunk_count: nombre(r["chunk_count"]),
        bytes: nombre(r["bytes"]),
        status: (ETATS_COLLECTION.has(etat) ? etat : "ready") as VueCollectionRag["status"],
        embed_model: String(r["embed_model"] ?? ""),
        chunking: lireDecoupageCollectionRag(r["chunk_json"]),
        ocr: metaCollectionRag(r["meta_json"]).ocr,
        created_at: nombre(r["created_at"]),
        updated_at: nombre(r["updated_at"]),
        hidden: role === "lecteur" && masquees.has(id),
      });
    }
  }
  return sortie;
}

const comparer = (a: string, b: string): number => a.localeCompare(b, "fr", { sensitivity: "base" });

/** Les miennes (par nom), puis celles partagées avec moi (par auteur puis nom) ; les masquées seulement sur demande. */
export async function listerCollectionsRag(
  base: Base,
  uid: number,
  o: { masquees?: boolean } = {},
): Promise<VueCollectionRag[]> {
  const lisibles = await collectionsLisibles(base, uid);
  const roles = new Map(lisibles.map((c) => [c.id, c.role] as const));
  const toutes = await vues(base, uid, roles);
  const gardees = toutes.filter((c) => o.masquees === true || !c.hidden);
  const miennes = gardees.filter((c) => c.role === "proprietaire").sort((a, b) => comparer(a.name, b.name));
  const partagees = gardees
    .filter((c) => c.role === "lecteur")
    .sort((a, b) => comparer(a.owner.username, b.owner.username) || comparer(a.name, b.name));
  return [...miennes, ...partagees];
}

/** Collection vue par `uid`, `null` si elle lui est invisible (inconnue ou privée à un autre : même réponse). */
export async function lireVueCollectionRag(
  base: Base,
  uid: number,
  collectionId: string,
): Promise<VueCollectionRag | null> {
  const role = await accesCollection(base, uid, collectionId);
  if (role === null) return null;
  return (await vues(base, uid, new Map([[collectionId, role]])))[0] ?? null;
}

/** Nom normalisé (NFC) ; le même nom à la casse près existe-t-il déjà chez ce propriétaire ? */
async function nomPris(x: Executeur, uid: number, nom: string, sauf?: string): Promise<boolean> {
  const lignes = await x.valeurs<[unknown, unknown]>(
    "SELECT id, name FROM rag_collections WHERE owner_user_id = ? AND LOWER(name) = LOWER(?)",
    [uid, nom],
  );
  return lignes.some(([id]) => String(id) !== sauf);
}

const NOM_PRIS = (): ErreurRouteRag =>
  new ErreurRouteRag(409, "nom_deja_pris", "Vous avez déjà une collection de ce nom.");

/** Crée la collection du compte (quota de collections, nom unique à la casse près) et son dossier du magasin ; rend son identifiant. */
export async function creerCollectionRag(
  base: Base,
  uid: number,
  corps: { name: string; description?: string | undefined },
): Promise<string> {
  const nom = corps.name.normalize("NFC");
  const id = randomUUID();
  try {
    await base.ecriture(async (x) => {
      const quotas = await quotasRag(x, uid);
      const [n] = await x.valeurs<[unknown]>("SELECT COUNT(*) FROM rag_collections WHERE owner_user_id = ?", [
        uid,
      ]);
      if (nombre(n?.[0]) >= quotas.collections)
        throw new ErreurRouteRag(
          409,
          "quota_collections",
          `Quota atteint : ${quotas.collections} collection(s) au plus par compte.`,
        );
      if (await nomPris(x, uid, nom)) throw NOM_PRIS();
      const t = Date.now() / 1000;
      await x.run(
        "INSERT INTO rag_collections(id, owner_user_id, name, description, chunk_json, meta_json, created_at, updated_at) " +
          "VALUES(?, ?, ?, ?, ?, '{}', ?, ?)",
        [id, uid, nom, corps.description?.normalize("NFC") ?? "", JSON.stringify(DECOUPAGE_RAG_DEFAUT), t, t],
      );
    });
  } catch (e) {
    if (e instanceof ErreurIntegrite) throw NOM_PRIS();
    throw e;
  }
  try {
    creerDossiersCollectionRag(uid, id);
  } catch (e) {
    await base.run("DELETE FROM rag_collections WHERE id = ?", [id]);
    await supprimerDossierCollectionRag(uid, id).catch(() => false);
    throw e;
  }
  return id;
}

/** Applique les changements du propriétaire ; dit ce qui demande une réindexation (découpage changé, OCR nouvellement activé). */
export async function mettreAJourCollectionRag(
  base: Base,
  uid: number,
  collectionId: string,
  corps: CorpsMajCollectionRag,
): Promise<{ decoupage: boolean; ocr: boolean }> {
  try {
    return await base.ecriture(async (x) => {
      const ligne = await lireCollection(x, collectionId);
      if (ligne === null || ligne.owner_user_id !== uid)
        throw new ErreurRouteRag(404, "collection_introuvable", "Collection introuvable.");
      const sets: string[] = [];
      const params: (string | number)[] = [];
      if (corps.name !== undefined) {
        const nom = corps.name.normalize("NFC");
        if (nom !== ligne.name) {
          if (await nomPris(x, uid, nom, collectionId)) throw NOM_PRIS();
          sets.push("name = ?");
          params.push(nom);
        }
      }
      if (corps.description !== undefined) {
        sets.push("description = ?");
        params.push(corps.description.normalize("NFC"));
      }
      let decoupage = false;
      if (corps.chunking !== undefined) {
        const nouveau = JSON.stringify(canoniqueDecoupageRag(corps.chunking));
        decoupage = nouveau !== JSON.stringify(lireDecoupageCollectionRag(ligne.chunk_json));
        sets.push("chunk_json = ?");
        params.push(nouveau);
      }
      let ocr = false;
      if (corps.ocr !== undefined) {
        ocr = corps.ocr && !ligne.meta.ocr;
        sets.push("meta_json = ?");
        params.push(JSON.stringify({ ...objet(ligne.meta_json), ocr: corps.ocr }));
      }
      if (sets.length) {
        sets.push("updated_at = ?");
        params.push(Date.now() / 1000);
        await x.run(`UPDATE rag_collections SET ${sets.join(", ")} WHERE id = ?`, [...params, collectionId]);
      }
      return { decoupage, ocr };
    });
  } catch (e) {
    if (e instanceof ErreurIntegrite) throw NOM_PRIS();
    throw e;
  }
}

/** Groupes où le compte peut publier avec leurs effectifs (tous pour un administrateur, qui peut aussi viser tous les comptes). */
export async function groupesDePublicationRag(
  base: Base,
  uid: number,
): Promise<{
  groups: { id: number; name: string; members: number }[];
  can_publish_all: boolean;
  accounts: number;
}> {
  const [moi] = await base.valeurs<[unknown]>("SELECT is_admin FROM users WHERE id = ?", [uid]);
  const admin = nombre(moi?.[0]) === 1;
  const lignes = await base.valeurs<[unknown, unknown, unknown]>(
    `SELECT g.id, g.name, (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id) FROM "groups" g` +
      (admin ? "" : " WHERE g.id IN (SELECT group_id FROM user_groups WHERE user_id = ?)"),
    admin ? [] : [uid],
  );
  const [n] = await base.valeurs<[unknown]>("SELECT COUNT(*) FROM users");
  return {
    groups: lignes
      .map(([id, nom, effectif]) => ({ id: nombre(id), name: String(nom), members: nombre(effectif) }))
      .sort((a, b) => comparer(a.name, b.name)),
    can_publish_all: admin,
    accounts: nombre(n?.[0]),
  };
}

/** Comptes qui lisent (ou liraient) une collection publiée ainsi, hors l'auteur : tous ou les membres des groupes, ayant le droit RAG. */
export async function audiencePublicationRag(
  x: Executeur,
  proprietaire: number,
  visibilite: string,
  groupes: readonly number[],
): Promise<Set<number>> {
  let ids: unknown[][];
  if (visibilite === "all") ids = await x.valeurs("SELECT id FROM users WHERE id <> ?", [proprietaire]);
  else if (visibilite === "groups" && groupes.length)
    ids = await x.valeurs(
      `SELECT DISTINCT user_id FROM user_groups WHERE user_id <> ? AND group_id IN (${marques(groupes.length)})`,
      [proprietaire, ...groupes],
    );
  else return new Set();
  const concernes = new Set(ids.map(([id]) => nombre(id)));
  const autorises = configRag().groups;
  if (!autorises.length || !concernes.size) return concernes;
  const ayants = new Set<number>();
  for (const [id] of await x.valeurs<[unknown]>(
    `SELECT id FROM users WHERE is_admin = 1 OR id IN (SELECT user_id FROM user_groups WHERE group_id IN (${marques(autorises.length)}))`,
    autorises,
  ))
    ayants.add(nombre(id));
  return new Set([...concernes].filter((id) => ayants.has(id)));
}

/** Masque (ou ré-affiche) une collection partagée pour `uid` seulement ; sa liste à lui change, rien d'autre. */
export async function masquerCollectionRag(
  base: Base,
  uid: number,
  collectionId: string,
  masquee: boolean,
): Promise<void> {
  await base.ecriture(async (x) => {
    await x.run("DELETE FROM rag_hidden WHERE user_id = ? AND collection_id = ?", [uid, collectionId]);
    if (masquee)
      await x.run("INSERT INTO rag_hidden(user_id, collection_id, created_at) VALUES(?, ?, ?)", [
        uid,
        collectionId,
        Date.now() / 1000,
      ]);
  });
}
