// SPDX-License-Identifier: MIT
/** apps/core/src/rag/service.ts — service d'indexation RAG pour les routes (L4) et la console (L8) : dépôt, import, réindexation, migration, suspension, annulation, suppressions ; branché au cycle de vie, travailleur dans main seul. */
import { configRag } from "@elpis/config";
import type { Base } from "@elpis/db";

import type { CycleDeVie } from "../cycle";
import { journal } from "../journal";
import type { ModeApp } from "../mode";
import { accesCollection, collectionGeleeRag, supprimerCollectionRag } from "./acces";
import { avertirLecteursRag } from "./avis";
import { getServiceUrl } from "./client";
import { decoupageDuDocumentRag, lireDecoupageCollectionRag } from "./decoupage";
import {
  deposerFichierRag,
  diffuserSansEchec,
  exigerProprietaire,
  importerDepuisSandboxRag,
  messageTravailRag,
  ragActif,
} from "./depot";
import type {
  DependancesDepotRag,
  FichierDeposeRag,
  PublierRag,
  ResultatDepotRag,
  ResultatImportRag,
} from "./depot";
import { effacerFichiersDocumentRag } from "./entretien";
import { RefusIndexationRag } from "./erreurs-indexation";
import {
  estUuidRag,
  nomQdrantRag,
  supprimerDossierCollectionRag,
  supprimerDossierCompteRag,
} from "./magasin";
import { inscrireNettoyageRag } from "./nettoyage";
import type { CollectionPartieRag } from "./nettoyage";
import { clientQdrantRag, effacerCollectionQdrant, effacerDocumentQdrant, effacerNomQdrant } from "./qdrant";
import type { PortQdrantRag } from "./qdrant";
import {
  assurerMigration,
  DOCUMENT_A_TRAITER,
  ETATS_DOCUMENT_A_TRAITER,
  ETATS_TRAVAIL_ACTIFS,
  lireCollection,
  lireDocument,
  lireTravail,
  rafraichirCollection,
  rejoindreTravail,
  travailDocumentsActif,
  travailPublic,
  travauxDuCompte,
} from "./travaux";
import type { LigneTravailRag, TravailRagPublic } from "./travaux";
import { TravailleurRag } from "./travailleur";
import type { LeaderRag, ReglagesTravailleurRag } from "./travailleur";

const log = journal("rag");

/** Compte demandeur, ou la console d'administration (droit vérifié par la route) pour les travaux et les collections de tous. */
export type DemandeurRag = number | "admin";

export interface OptionsReindexationRag {
  /** Documents à reprendre (identifiants de la collection) ; absent : toute la collection. */
  readonly documents?: readonly string[] | undefined;
  /** Reprend aussi les documents dont l'empreinte de découpage n'a pas changé. */
  readonly force?: boolean | undefined;
  /** Refait l'extraction (OCR activé, nouvel extracteur) au lieu de relire `extraits/`. */
  readonly reextraire?: boolean | undefined;
}

export interface EtatIndexationRag {
  /** Serveur d'embeddings configuré : sans lui, le RAG est désactivé (dépôts refusés, travailleur au repos). */
  readonly actif: boolean;
  readonly extracteur_configure: boolean;
  readonly concurrence: number;
  readonly par_compte: number;
  readonly travaux: { readonly queued: number; readonly running: number; readonly paused: number };
  /** Dernier battement d'un travail en cours (secondes), `null` sans travail en cours. */
  readonly dernier_battement: number | null;
  /** Travailleur de CE process (main) : leadership, documents en cours, services en attente. */
  readonly travailleur: {
    readonly leader: boolean;
    readonly en_cours: number;
    readonly attentes: { service: string; jusqua: number; message: string }[];
  } | null;
}

export interface DependancesServiceRag extends DependancesDepotRag {
  readonly travailleur?: TravailleurRag | null | undefined;
  readonly qdrant?: (() => PortQdrantRag) | undefined;
}

const LOT_SQL = 500;
const maintenant = (): number => Date.now() / 1000;

export class ServiceIndexationRag {
  private readonly base: Base;
  private readonly diffuser: PublierRag | undefined;
  private readonly qdrant: () => PortQdrantRag;
  private readonly depot: DependancesDepotRag;
  readonly travailleur: TravailleurRag | null;

  constructor(dep: DependancesServiceRag) {
    this.base = dep.base;
    this.diffuser = dep.diffuser;
    this.qdrant = dep.qdrant ?? clientQdrantRag;
    this.travailleur = dep.travailleur ?? null;
    this.depot = { ...dep, reveiller: dep.reveiller ?? (() => this.travailleur?.reveiller()) };
  }

  /** Le RAG est-il utilisable (serveur d'embeddings configuré) ? */
  actif(): boolean {
    return ragActif();
  }

  /** Dépose un fichier (flux) dans une collection du compte ; lève `RefusIndexationRag`. */
  deposer(
    uid: number,
    collectionId: string,
    fichier: FichierDeposeRag,
    signal?: AbortSignal,
  ): Promise<ResultatDepotRag> {
    return deposerFichierRag(this.depot, uid, collectionId, fichier, signal);
  }

  /** Importe des fichiers du bac du compte (hôte d'outils, identité relayée) ; un résultat par chemin. */
  importerDepuisSandbox(
    uid: number,
    collectionId: string,
    chemins: readonly string[],
    signal?: AbortSignal,
  ): Promise<ResultatImportRag[]> {
    return importerDepuisSandboxRag(this.depot, uid, collectionId, chemins, signal);
  }

  /** Remet en file les documents dont le découpage a changé, ceux en échec, ou tous (`force`) ; `null` s'il n'y a rien à faire. */
  async reindexer(
    uid: number,
    collectionId: string,
    o: OptionsReindexationRag = {},
  ): Promise<TravailRagPublic | null> {
    if (!ragActif()) throw new RefusIndexationRag("rag_desactive");
    await exigerProprietaire(this.base, uid, collectionId);
    const demandes = o.documents === undefined ? null : [...new Set(o.documents)];
    if (demandes !== null && !demandes.every(estUuidRag))
      throw new RefusIndexationRag("document_introuvable");
    const travail = await this.base.ecriture(async (x) => {
      const coll = await lireCollection(x, collectionId);
      if (coll === null || coll.owner_user_id !== uid) throw new RefusIndexationRag("collection_introuvable");
      const decoupage = lireDecoupageCollectionRag(coll.chunk_json);
      const lignes = await x.valeurs<[unknown, unknown, unknown, unknown, unknown]>(
        "SELECT id, status, chunk_params_hash, ext, sha256 FROM rag_documents WHERE collection_id=? ORDER BY created_at, id",
        [collectionId],
      );
      const connus = new Map(
        lignes.map(([id, s, h, ext, sha]) => [
          String(id),
          { status: String(s), hash: String(h ?? ""), ext: String(ext), sha256: String(sha ?? "") },
        ]),
      );
      if (demandes !== null && demandes.some((d) => !connus.has(d)))
        throw new RefusIndexationRag("document_introuvable");
      const cibles = (demandes ?? [...connus.keys()]).filter((id) => {
        const d = connus.get(id);
        if (d === undefined || DOCUMENT_A_TRAITER.has(d.status)) return false;
        if (o.force || o.reextraire || d.status === "error") return true;
        return (
          d.hash !== decoupageDuDocumentRag(coll, { id, ext: d.ext, sha256: d.sha256 }, decoupage).empreinte
        );
      });
      if (!cibles.length) return null;
      for (let i = 0; i < cibles.length; i += LOT_SQL) {
        const lot = cibles.slice(i, i + LOT_SQL);
        await x.run(
          `UPDATE rag_documents SET status='pending', error_code=NULL, error_message=NULL WHERE id IN (${lot.map(() => "?").join(",")})`,
          lot,
        );
      }
      const t = await rejoindreTravail(x, {
        collectionId,
        uid,
        genre: "reindex",
        n: cibles.length,
        reextraire: o.reextraire === true,
        t: maintenant(),
      });
      await rafraichirCollection(x, collectionId);
      return t;
    });
    if (travail === null) return null;
    await diffuserSansEchec(this.diffuser, messageTravailRag(uid, travail));
    this.travailleur?.reveiller();
    return travailPublic(travail);
  }

  /** Migration vers le modèle d'embedding configuré d'une collection déjà indexée avec un autre (console) ; `null` si rien à migrer. */
  async migrerCollection(
    collectionId: string,
    o: { force?: boolean } = {},
  ): Promise<TravailRagPublic | null> {
    if (!ragActif()) throw new RefusIndexationRag("rag_desactive");
    if (!estUuidRag(collectionId)) throw new RefusIndexationRag("collection_introuvable");
    const modele = configRag().embed.model;
    const issue = await this.base.ecriture(async (x) => {
      const coll = await lireCollection(x, collectionId);
      if (coll === null) throw new RefusIndexationRag("collection_introuvable");
      if (coll.embed_model === "" || (!o.force && coll.embed_model === modele)) return null;
      const m = await assurerMigration(x, { collection: coll, modele, t: maintenant() });
      await rafraichirCollection(x, collectionId);
      return m;
    });
    if (issue === null) return null;
    if (issue.cree)
      await diffuserSansEchec(this.diffuser, messageTravailRag(issue.travail.owner_user_id, issue.travail));
    this.travailleur?.reveiller();
    return travailPublic(issue.travail);
  }

  /** Migrations de toutes les collections indexées avec un autre modèle que celui configuré (« Réindexer toutes les collections », `force` : aussi celles du même modèle) ; rend leur nombre. */
  async migrerTout(o: { force?: boolean } = {}): Promise<number> {
    if (!ragActif()) throw new RefusIndexationRag("rag_desactive");
    const ids = o.force
      ? await this.base.valeurs<[unknown, unknown, unknown]>(
          "SELECT id, owner_user_id, visibility FROM rag_collections WHERE embed_model <> '' ORDER BY id",
        )
      : await this.base.valeurs<[unknown, unknown, unknown]>(
          "SELECT id, owner_user_id, visibility FROM rag_collections WHERE embed_model <> '' AND embed_model <> ? ORDER BY id",
          [configRag().embed.model],
        );
    let n = 0;
    for (const [id, auteur, visibilite] of ids) {
      if (await collectionGeleeRag(this.base, Number(auteur), String(visibilite))) continue;
      if ((await this.migrerCollection(String(id), o.force ? { force: true } : {})) !== null) n++;
    }
    return n;
  }

  /** Travail du demandeur (propriétaire, ou la console), sinon `travail_introuvable` sans rien révéler. */
  private async travailDe(qui: DemandeurRag, jobId: string): Promise<LigneTravailRag> {
    if (!estUuidRag(jobId)) throw new RefusIndexationRag("travail_introuvable");
    const t = await lireTravail(this.base, jobId);
    if (t === null) throw new RefusIndexationRag("travail_introuvable");
    if (qui !== "admin") {
      if (
        t.owner_user_id !== qui ||
        (await accesCollection(this.base, qui, t.collection_id)) !== "proprietaire"
      )
        throw new RefusIndexationRag("travail_introuvable");
    }
    return t;
  }

  private async annoncer(jobId: string): Promise<TravailRagPublic> {
    const t = await lireTravail(this.base, jobId);
    if (t === null) throw new RefusIndexationRag("travail_introuvable");
    await diffuserSansEchec(this.diffuser, messageTravailRag(t.owner_user_id, t));
    return travailPublic(t);
  }

  /** Suspend un travail (les documents en cours retournent en file) ; sans effet s'il l'est déjà. */
  async suspendre(qui: DemandeurRag, jobId: string): Promise<TravailRagPublic> {
    const t = await this.travailDe(qui, jobId);
    const r = await this.base.run(
      "UPDATE rag_jobs SET status='paused' WHERE id=? AND status IN ('queued', 'running')",
      [jobId],
    );
    if (r.changes === 0 && t.status !== "paused") throw new RefusIndexationRag("travail_termine");
    this.travailleur?.interrompre({ jobId }, "pause");
    return this.annoncer(jobId);
  }

  /** Reprend un travail suspendu ; sans effet s'il est déjà en file ou en cours. */
  async reprendre(qui: DemandeurRag, jobId: string): Promise<TravailRagPublic> {
    const t = await this.travailDe(qui, jobId);
    const r = await this.base.run(
      "UPDATE rag_jobs SET status='queued', worker_boot_id=NULL WHERE id=? AND status='paused'",
      [jobId],
    );
    if (r.changes === 0 && t.status !== "queued" && t.status !== "running")
      throw new RefusIndexationRag("travail_termine");
    this.travailleur?.reveiller();
    return this.annoncer(jobId);
  }

  /** Annule un travail : documents déjà indexés auparavant gardés tels quels, les autres en échec « annulé » ; une migration annulée laisse servir l'ancienne génération. */
  async annuler(qui: DemandeurRag, jobId: string): Promise<TravailRagPublic> {
    const t = await this.travailDe(qui, jobId);
    const fait = await this.base.ecriture(async (x) => {
      const j = await lireTravail(x, jobId);
      if (j === null) throw new RefusIndexationRag("travail_introuvable");
      if (j.status === "cancelled") return null;
      if (!["queued", "running", "paused"].includes(j.status))
        throw new RefusIndexationRag("travail_termine");
      await x.run("UPDATE rag_jobs SET status='cancelled', finished_at=?, error=NULL WHERE id=?", [
        maintenant(),
        jobId,
      ]);
      if (j.kind === "migrate")
        await x.run(
          "UPDATE rag_documents SET chunk_params_hash='' WHERE collection_id=? AND status='ready' AND indexed_at >= ?",
          [j.collection_id, j.params.debut ?? j.created_at],
        );
      else {
        await x.run(
          `UPDATE rag_documents SET status='ready', error_code=NULL, error_message=NULL WHERE collection_id=? ` +
            `AND status IN ${ETATS_DOCUMENT_A_TRAITER} AND indexed_at IS NOT NULL`,
          [j.collection_id],
        );
        await x.run(
          `UPDATE rag_documents SET status='error', error_code='cancelled', error_message=? WHERE collection_id=? AND status IN ${ETATS_DOCUMENT_A_TRAITER}`,
          ["Indexation annulée : relancez-la pour indexer ce document.", j.collection_id],
        );
      }
      await rafraichirCollection(x, j.collection_id);
      return j;
    });
    this.travailleur?.interrompre({ jobId }, "annulation");
    if (fait !== null && fait.kind === "migrate") {
      const coll = await lireCollection(this.base, t.collection_id);
      const generation = fait.params.generation ?? (coll === null ? 0 : coll.meta.generation + 1);
      if (coll === null || generation !== coll.meta.generation)
        await effacerNomQdrant(this.qdrant(), nomQdrantRag(t.collection_id, generation));
    }
    this.travailleur?.reveiller();
    return this.annoncer(jobId);
  }

  /** Supprime un document du propriétaire : ligne, fichiers et passages (toutes générations) ; son traitement en cours est interrompu. */
  async supprimerDocument(uid: number, collectionId: string, docId: string): Promise<void> {
    await exigerProprietaire(this.base, uid, collectionId);
    if (!estUuidRag(docId)) throw new RefusIndexationRag("document_introuvable");
    const issue = await this.base.ecriture(async (x) => {
      const doc = await lireDocument(x, docId);
      const coll = await lireCollection(x, collectionId);
      if (doc === null || coll === null || doc.collection_id !== collectionId || coll.owner_user_id !== uid)
        return null;
      await x.run("DELETE FROM rag_documents WHERE id=?", [docId]);
      let travail: LigneTravailRag | null = null;
      const actif = DOCUMENT_A_TRAITER.has(doc.status) ? await travailDocumentsActif(x, collectionId) : null;
      if (actif !== null) {
        await x.run("UPDATE rag_jobs SET total=? WHERE id=?", [
          Math.max(actif.total - 1, actif.done + actif.failed),
          actif.id,
        ]);
        travail = await lireTravail(x, actif.id);
      }
      await rafraichirCollection(x, collectionId);
      return { doc, owner: coll.owner_user_id, travail };
    });
    if (issue === null) throw new RefusIndexationRag("document_introuvable");
    this.travailleur?.interrompre({ docId }, "suppression");
    try {
      await effacerFichiersDocumentRag(issue.owner, collectionId, docId, issue.doc.ext);
    } catch (e) {
      log.warn({ err: e }, `fichiers du document ${docId} non effacés`);
    }
    await effacerDocumentQdrant(this.qdrant(), collectionId, docId);
    if (issue.travail !== null) await diffuserSansEchec(this.diffuser, messageTravailRag(uid, issue.travail));
    this.travailleur?.reveiller();
  }

  /** Supprime une collection du propriétaire avec tout ce qu'elle contient. */
  async supprimerCollection(uid: number, collectionId: string): Promise<void> {
    await exigerProprietaire(this.base, uid, collectionId);
    if ((await lireCollection(this.base, collectionId))?.owner_user_id !== uid)
      throw new RefusIndexationRag("collection_introuvable");
    await this.supprimerCollectionParAdmin(collectionId);
  }

  /** Supprime une collection sans contrôle de propriété (la console a vérifié le rôle et la saisie du nom) : ligne, travaux, Qdrant de toutes générations, dossier. */
  async supprimerCollectionParAdmin(collectionId: string): Promise<CollectionPartieRag> {
    if (!estUuidRag(collectionId)) throw new RefusIndexationRag("collection_introuvable");
    const partie = await supprimerCollectionRag(this.base, collectionId);
    if (partie === null) throw new RefusIndexationRag("collection_introuvable");
    this.travailleur?.interrompre({ collectionId }, "suppression");
    await effacerCollectionQdrant(this.qdrant(), collectionId);
    try {
      await supprimerDossierCollectionRag(partie.owner_user_id, collectionId);
    } catch (e) {
      log.warn({ err: e }, `dossier de la collection ${collectionId} non effacé`);
    }
    return partie;
  }

  /** Rappel `nettoyerRagCompte` : avis aux lecteurs, collections Qdrant et dossier d'un compte supprimé (ses lignes sont déjà parties). */
  async nettoyerCompte(uid: number, collections: readonly CollectionPartieRag[]): Promise<void> {
    await avertirLecteursRag(this.base, uid, collections);
    this.travailleur?.interrompre({ uid }, "suppression");
    for (const c of collections) await effacerCollectionQdrant(this.qdrant(), c.id);
    await supprimerDossierCompteRag(uid);
  }

  /** Travaux du compte, les plus récents d'abord (`actifs` : en file, en cours, suspendus). */
  async travauxDu(
    uid: number,
    o: { actifs?: boolean; collectionId?: string; limite?: number } = {},
  ): Promise<TravailRagPublic[]> {
    return (await travauxDuCompte(this.base, uid, o)).map(travailPublic);
  }

  /** État de l'indexation (console, santé) : configuration, file, battement, travailleur local. */
  async etat(): Promise<EtatIndexationRag> {
    const conf = configRag();
    const compte = { queued: 0, running: 0, paused: 0 };
    for (const [s, n] of await this.base.valeurs<[unknown, unknown]>(
      `SELECT status, COUNT(*) FROM rag_jobs WHERE status IN ${ETATS_TRAVAIL_ACTIFS} GROUP BY status`,
    ))
      if (s === "queued" || s === "running" || s === "paused") compte[s] = Number(n);
    const [b] = await this.base.valeurs<[unknown]>(
      "SELECT MAX(heartbeat_at) FROM rag_jobs WHERE status='running'",
    );
    const w = this.travailleur;
    return {
      actif: conf.embed.url !== "",
      extracteur_configure: getServiceUrl() !== "",
      concurrence: conf.indexation.concurrence,
      par_compte: conf.indexation.par_compte,
      travaux: compte,
      dernier_battement: b?.[0] === null || b?.[0] === undefined ? null : Number(b[0]),
      travailleur:
        w === null ? null : { leader: w.estLeader, en_cours: w.enCours, attentes: w.pausesServices() },
    };
  }
}

let serviceDuProcess: ServiceIndexationRag | null = null;
let nettoyageInscrit = false;

/** Posé par la composition ; `null` le retire. */
export function installerServiceIndexationRag(s: ServiceIndexationRag | null): void {
  serviceDuProcess = s;
}

/** Service d'indexation du process (routes L4, console L8), `null` avant la composition. */
export function serviceIndexationRag(): ServiceIndexationRag | null {
  return serviceDuProcess;
}

/** Service dans tous les process (la console supprime aussi des comptes et des collections), travailleur dans main seul, au repos tant que le RAG n'est pas configuré. */
export function brancherIndexationRag(
  mode: ModeApp,
  base: Base,
  cycle: CycleDeVie,
  o: { diffuser?: PublierRag; meneur?: LeaderRag | null; reglages?: Partial<ReglagesTravailleurRag> } = {},
): ServiceIndexationRag {
  const travailleur =
    mode === "main" && o.meneur
      ? new TravailleurRag({ base, meneur: o.meneur, diffuser: o.diffuser, reglages: o.reglages })
      : null;
  const service = new ServiceIndexationRag({ base, diffuser: o.diffuser, travailleur });
  installerServiceIndexationRag(service);
  if (!nettoyageInscrit) {
    nettoyageInscrit = true;
    inscrireNettoyageRag((uid, collections) => serviceIndexationRag()?.nettoyerCompte(uid, collections));
  }
  if (travailleur !== null) {
    cycle.auDemarrage("indexation RAG", () => travailleur.demarrer(cycle.signalArret), {
      modes: ["main"],
      arrierePlan: true,
    });
    cycle.alArret("indexation RAG", () => travailleur.arreter());
  }
  return service;
}
